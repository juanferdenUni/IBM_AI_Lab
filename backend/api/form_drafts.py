import logging
import json
from uuid import UUID, uuid4
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends

from backend.models import FormDraft, FormDraftCreate, FormDraftUpdate, FormFieldValue
from backend.models.enums import AuditAction, FormType
from backend.middleware.auth import auth_dependency
from backend.middleware.orchestrate_auth import orchestrate_auth_dependency
from backend.services.supabase_client import get_client
from backend.services.audit import log_action
from backend.services import fhir_client
from backend.services.llm import generate, LLMError
from backend.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

SCHEMA_PATH = Path(__file__).parent.parent / "schemas" / "t2201.json"

FORM_SYSTEM_PROMPT = """
You are a clinical documentation specialist completing a T2201 Disability Tax Credit Certificate.
Given the form schema, an approved SOAP note, and a patient's FHIR history, populate each field.

Return ONLY a JSON object where each key is a form field name and each value is:
{
  "value": <string | boolean | null>,
  "confidence": <float 0.0-1.0>,
  "source": <string describing which FHIR resource or SOAP section the value came from>
}

Rules:
- Set confidence=0.0 and value=null for fields you cannot populate from available data.
- Never invent data not present in the provided FHIR resources or SOAP note.
- For fields the physician must enter (SIN, CPSO number), set value=null and confidence=0.0.
- Return ONLY the JSON object, no markdown, no explanation.
"""


def _load_t2201_schema() -> dict:
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"T2201 schema not found at {SCHEMA_PATH}")
    with open(SCHEMA_PATH) as f:
        return json.load(f)


@router.post(
    "/patients/{patient_id}/form-draft",
    response_model=FormDraft,
    status_code=201,
    dependencies=[Depends(orchestrate_auth_dependency)],
)
async def generate_form_draft(patient_id: UUID, request: FormDraftCreate):
    """
    Called by IBM Orchestrate after SOAP note is approved.
    Fetches FHIR history + approved SOAP, calls Granite, persists form draft.
    """
    client = get_client()

    # 1. Verify patient exists
    patient_resp = client.table("patients").select("*").eq("id", str(patient_id)).single().execute()
    if not patient_resp.data:
        raise HTTPException(status_code=404, detail="Patient not found")
    patient = patient_resp.data

    # 2. Fetch the approved SOAP note
    soap_resp = (
        client.table("soap_notes")
        .select("*")
        .eq("id", str(request.soap_note_id))
        .eq("approved", True)
        .single()
        .execute()
    )
    if not soap_resp.data:
        raise HTTPException(status_code=409, detail="SOAP note not found or not approved")
    soap_note = soap_resp.data

    # 3. Fetch full FHIR history for the patient
    try:
        fhir_patient = await fhir_client.get_patient(patient["mrn"])
        fhir_id = patient.get("fhir_id", "")
        conditions = await fhir_client.get_conditions(fhir_id)
        observations = await fhir_client.get_observations(fhir_id, count=20)
        medications = await fhir_client.get_medications(fhir_id)
        communications = await fhir_client.get_communications(fhir_id)
    except Exception as e:
        logger.error(f"FHIR fetch failed: {e}")
        raise HTTPException(status_code=502, detail=f"FHIR query failed: {e}")

    # 4. Load T2201 schema
    try:
        schema = _load_t2201_schema()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 5. Build Granite prompt
    fhir_context = {
        "patient": fhir_patient,
        "conditions": conditions,
        "observations": observations,
        "medications": medications,
        "communications": communications,
    }
    prompt = (
        f"T2201 Schema:\n{json.dumps(schema, indent=2)}\n\n"
        f"SOAP Note:\n{json.dumps(soap_note['soap_json'], indent=2)}\n\n"
        f"FHIR History:\n{json.dumps(fhir_context, indent=2)}"
    )

    # 6. Call Granite
    try:
        raw_response = await generate(prompt=prompt, system=FORM_SYSTEM_PROMPT)
        # Parse raw JSON response
        clean = raw_response.strip()
        if clean.startswith("```"):
            import re
            clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", clean, flags=re.MULTILINE).strip()
        form_fields_raw = json.loads(clean)
    except LLMError as e:
        raise HTTPException(status_code=503, detail=f"Granite call failed: {e}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=503, detail=f"Granite returned invalid JSON: {e}")

    # 7. Convert to FormFieldValue objects
    form_json = {}
    for field_name, field_data in form_fields_raw.items():
        if isinstance(field_data, dict):
            form_json[field_name] = {
                "value": field_data.get("value"),
                "confidence": float(field_data.get("confidence", 0.0)),
                "source": field_data.get("source", "unknown"),
            }

    # 8. Check for existing draft to handle versioning
    existing_resp = (
        client.table("form_drafts")
        .select("id, version")
        .eq("appointment_id", str(request.appointment_id))
        .is_("superseded_by", "null")
        .execute()
    )

    new_version = 1
    physician_id = patient.get("physician_id", "00000000-0000-0000-0000-000000000000")
    new_id = str(uuid4())

    if existing_resp.data:
        old = existing_resp.data[0]
        new_version = old["version"] + 1
        # Mark old version as superseded
        client.table("form_drafts").update({"superseded_by": new_id}).eq("id", old["id"]).execute()

    # 9. Persist the new draft
    insert_data = {
        "id": new_id,
        "appointment_id": str(request.appointment_id),
        "patient_id": str(patient_id),
        "soap_note_id": str(request.soap_note_id),
        "form_type": "T2201",
        "form_json": form_json,
        "approved": False,
        "version": new_version,
        "created_by": physician_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    insert_resp = client.table("form_drafts").insert(insert_data).execute()
    if not insert_resp.data:
        raise HTTPException(status_code=500, detail="Failed to persist form draft")

    # 10. Audit log
    await log_action(
        actor_id=UUID(physician_id),
        action=AuditAction.FORM_DRAFT_GENERATED,
        resource_type="form_draft",
        resource_id=UUID(new_id),
        appointment_id=request.appointment_id,
        metadata={"version": new_version, "field_count": len(form_json)},
    )

    return insert_resp.data[0]


@router.get("/patients/{patient_id}/form-draft", response_model=FormDraft)
async def get_form_draft(patient_id: UUID, user: dict = Depends(auth_dependency)):
    """Return the current (non-superseded) form draft for this patient's active appointment."""
    try:
        client = get_client()
        response = (
            client.table("form_drafts")
            .select("*")
            .eq("patient_id", str(patient_id))
            .is_("superseded_by", "null")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="No form draft found for this patient")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"get_form_draft error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch form draft")


@router.patch("/form-drafts/{form_id}", response_model=FormDraft)
async def update_form_draft(
    form_id: UUID,
    update: FormDraftUpdate,
    user: dict = Depends(auth_dependency),
):
    """
    Physician edits specific fields. Supplied fields get confidence=1.0, source='physician_edit'.
    Only updates the keys supplied — all other fields unchanged.
    """
    try:
        client = get_client()

        # Fetch current draft
        current_resp = (
            client.table("form_drafts")
            .select("*")
            .eq("id", str(form_id))
            .single()
            .execute()
        )
        if not current_resp.data:
            raise HTTPException(status_code=404, detail="Form draft not found")

        draft = current_resp.data
        if draft["approved"]:
            raise HTTPException(
                status_code=409,
                detail="Draft already approved — create a new version via POST /api/patients/{id}/form-draft",
            )

        # Merge physician edits into existing form_json
        current_form_json = draft.get("form_json", {})
        for field_name, field_value in update.fields.items():
            current_form_json[field_name] = {
                "value": field_value.value,
                "confidence": field_value.confidence,
                "source": field_value.source,
            }

        updated_resp = (
            client.table("form_drafts")
            .update({"form_json": current_form_json})
            .eq("id", str(form_id))
            .execute()
        )

        if not updated_resp.data:
            raise HTTPException(status_code=500, detail="Update failed")
        return updated_resp.data[0]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"update_form_draft error: {e}")
        raise HTTPException(status_code=500, detail="Update failed")


@router.post("/form-drafts/{form_id}/approve-and-sync")
async def approve_and_sync_form(form_id: UUID, user: dict = Depends(auth_dependency)):
    """
    Approve form draft and write FHIR Composition + DocumentReference.
    Atomic: if FHIR write fails, draft remains unapproved — safe to retry.
    """
    client = get_client()

    # 1. Fetch draft
    draft_resp = (
        client.table("form_drafts").select("*").eq("id", str(form_id)).single().execute()
    )
    if not draft_resp.data:
        raise HTTPException(status_code=404, detail="Form draft not found")
    draft = draft_resp.data

    if draft["approved"]:
        raise HTTPException(status_code=409, detail="Already approved")

    # 2. Write FHIR Composition
    try:
        composition_data = {
            "resourceType": "Composition",
            "status": "final",
            "type": {
                "coding": [{"system": "http://loinc.org", "code": "11488-4", "display": "Consult note"}]
            },
            "subject": {"reference": f"Patient/{draft['patient_id']}"},
            "date": datetime.now(timezone.utc).isoformat(),
            "title": "T2201 Disability Tax Credit Certificate",
            "section": [
                {
                    "title": "Form Data",
                    "text": {
                        "status": "generated",
                        "div": f"<div>{json.dumps(draft['form_json'])}</div>",
                    },
                }
            ],
        }
        composition_resp = await fhir_client.write_composition(composition_data)
        composition_id = composition_resp.get("id", "unknown")

        doc_ref_data = {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {
                "coding": [{"system": "http://loinc.org", "code": "11488-4"}]
            },
            "subject": {"reference": f"Patient/{draft['patient_id']}"},
            "content": [
                {
                    "attachment": {
                        "contentType": "application/json",
                        "data": __import__("base64").b64encode(
                            json.dumps(draft["form_json"]).encode()
                        ).decode(),
                        "title": "T2201 Form Draft",
                    }
                }
            ],
        }
        doc_ref_resp = await fhir_client.write_document_reference(doc_ref_data)
        doc_ref_id = doc_ref_resp.get("id", "unknown")

    except Exception as e:
        logger.error(f"FHIR write failed: {e}")
        await log_action(
            actor_id=UUID(user["id"]),
            action=AuditAction.FHIR_WRITE_FAILED,
            resource_type="form_draft",
            resource_id=form_id,
            metadata={"error": str(e)},
        )
        raise HTTPException(status_code=502, detail=f"FHIR write failed: {e}")

    # 3. Mark draft as approved
    now = datetime.now(timezone.utc).isoformat()
    update_resp = (
        client.table("form_drafts")
        .update({
            "approved": True,
            "approved_at": now,
            "fhir_composition_id": composition_id,
            "fhir_doc_ref_id": doc_ref_id,
        })
        .eq("id", str(form_id))
        .execute()
    )

    # 4. Update patient workflow_state to completed
    client.table("patients").update({"workflow_state": "completed"}).eq(
        "id", draft["patient_id"]
    ).execute()

    # 5. Audit log
    await log_action(
        actor_id=UUID(user["id"]),
        action=AuditAction.FHIR_WRITE_SUCCESS,
        resource_type="form_draft",
        resource_id=form_id,
        appointment_id=UUID(draft["appointment_id"]) if draft.get("appointment_id") else None,
        metadata={
            "composition_id": composition_id,
            "document_reference_id": doc_ref_id,
        },
    )

    return {
        "id": str(form_id),
        "approved": True,
        "approved_at": now,
        "fhir_composition_id": composition_id,
        "fhir_doc_ref_id": doc_ref_id,
        "patient_workflow_state": "completed",
    }