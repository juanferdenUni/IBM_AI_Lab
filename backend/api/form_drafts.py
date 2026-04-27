import logging
import json
from uuid import UUID, uuid4
from datetime import datetime, timezone, date
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends

from models import FormDraft, FormDraftCreate, FormDraftUpdate, FormFieldValue
from models.enums import AuditAction, FormType
from middleware.auth import auth_dependency
from middleware.orchestrate_auth import orchestrate_auth_dependency
from services.supabase_client import get_client
from services.audit import log_action
from services import fhir_client
from services.llm import generate, LLMError, _extract_json_objects
from config import settings

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


def _split_patient_name(display_name: str) -> tuple[str | None, str | None]:
    parts = [part.strip() for part in display_name.split() if part.strip()]
    if not parts:
        return None, None
    if len(parts) == 1:
        return parts[0], None
    return parts[0], " ".join(parts[1:])


def _extract_patient_resource(bundle: dict) -> dict:
    entries = bundle.get("entry") or []
    for entry in entries:
        resource = entry.get("resource") or {}
        if resource.get("resourceType") == "Patient":
            return resource
    return {}


def _build_patient_bundle_override(
    *,
    patient_row: dict,
    fhir_patient_bundle: dict,
) -> dict:
    bundle = json.loads(json.dumps(fhir_patient_bundle))
    resource = _extract_patient_resource(bundle)
    first_name, last_name = _split_patient_name(patient_row.get("display_name", ""))

    if resource:
        resource["identifier"] = [{"system": "MRN", "value": patient_row.get("mrn", "")}]
        if first_name or last_name:
            resource["name"] = [{
                "family": last_name or "",
                "given": [first_name] if first_name else [],
                "text": patient_row.get("display_name", ""),
            }]
        if patient_row.get("date_of_birth"):
            resource["birthDate"] = str(patient_row["date_of_birth"])

    return bundle


def _extract_primary_condition(conditions_bundle: dict) -> tuple[str | None, str | None, str | None]:
    entries = conditions_bundle.get("entry") or []
    if not entries:
        return None, None, None

    resource = (entries[0] or {}).get("resource") or {}
    coding = ((resource.get("code") or {}).get("coding") or [{}])[0] or {}
    return (
        coding.get("code"),
        coding.get("display") or (resource.get("code") or {}).get("text"),
        resource.get("onsetDateTime"),
    )


def _years_since(start_date: str | None, *, today: date | None = None) -> str | None:
    if not start_date:
        return None

    try:
        start = datetime.fromisoformat(start_date.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            start = date.fromisoformat(start_date[:10])
        except ValueError:
            return None

    today = today or datetime.now(timezone.utc).date()
    years = today.year - start.year - ((today.month, today.day) < (start.month, start.day))
    return str(max(years, 0))


def _default_field_value() -> dict:
    return {"value": None, "confidence": 0.0, "source": "not_populated"}


def _set_field(
    overrides: dict[str, dict],
    field_name: str,
    value,
    confidence: float,
    source: str,
) -> None:
    if value is None:
        return
    if isinstance(value, str) and not value.strip():
        return
    overrides[field_name] = {
        "value": value,
        "confidence": confidence,
        "source": source,
    }


def _build_deterministic_fields(
    *,
    patient_row: dict,
    conditions_bundle: dict,
) -> dict[str, dict]:
    first_name, last_name = _split_patient_name(patient_row.get("display_name", ""))
    diagnosis_code, diagnosis_description, onset_date = _extract_primary_condition(conditions_bundle)
    duration_years = _years_since(onset_date)

    overrides: dict[str, dict] = {}

    _set_field(overrides, "patient_first_name", first_name, 1.0, "patients.display_name")
    _set_field(overrides, "patient_last_name", last_name, 1.0, "patients.display_name")
    _set_field(
        overrides,
        "date_of_birth",
        str(patient_row["date_of_birth"]) if patient_row.get("date_of_birth") else None,
        1.0,
        "patients.date_of_birth",
    )

    _set_field(overrides, "sin", patient_row.get("sin"), 1.0, "patients.sin")
    _set_field(overrides, "address", patient_row.get("address"), 1.0, "patients.address")

    _set_field(
        overrides,
        "diagnosis_code",
        patient_row.get("diagnosis_code") or diagnosis_code,
        1.0 if patient_row.get("diagnosis_code") else 0.92,
        "patients.diagnosis_code" if patient_row.get("diagnosis_code") else "FHIR Condition.code",
    )
    _set_field(
        overrides,
        "diagnosis_description",
        patient_row.get("diagnosis_description") or diagnosis_description,
        1.0 if patient_row.get("diagnosis_description") else 0.92,
        "patients.diagnosis_description" if patient_row.get("diagnosis_description") else "FHIR Condition.code.display",
    )

    _set_field(
        overrides,
        "marked_restriction_walking",
        patient_row.get("marked_restriction_walking"),
        1.0,
        "patients.marked_restriction_walking",
    )
    _set_field(
        overrides,
        "marked_restriction_mental",
        patient_row.get("marked_restriction_mental"),
        1.0,
        "patients.marked_restriction_mental",
    )
    _set_field(
        overrides,
        "life_sustaining_therapy",
        patient_row.get("life_sustaining_therapy"),
        1.0,
        "patients.life_sustaining_therapy",
    )

    patient_duration = patient_row.get("duration_years")
    _set_field(
        overrides,
        "duration_years",
        str(patient_duration) if patient_duration is not None else duration_years,
        1.0 if patient_duration is not None else 0.88,
        "patients.duration_years" if patient_duration is not None else "FHIR Condition.onsetDateTime",
    )

    _set_field(
        overrides,
        "certifying_practitioner_name",
        patient_row.get("certifying_practitioner_name"),
        1.0,
        "patients.certifying_practitioner_name",
    )
    _set_field(
        overrides,
        "certifying_practitioner_cpso",
        patient_row.get("certifying_practitioner_cpso"),
        1.0,
        "patients.certifying_practitioner_cpso",
    )
    _set_field(
        overrides,
        "certification_date",
        str(patient_row["certification_date"]) if patient_row.get("certification_date") else datetime.now(timezone.utc).date().isoformat(),
        1.0,
        "patients.certification_date" if patient_row.get("certification_date") else "system.current_date",
    )

    return overrides


def _merge_form_fields(
    *,
    schema: dict,
    llm_fields: dict | None,
    deterministic_fields: dict[str, dict],
) -> dict[str, dict]:
    form_json = {field_name: _default_field_value() for field_name in schema.keys()}

    for field_name, field_data in (llm_fields or {}).items():
        if field_name in form_json and isinstance(field_data, dict):
            form_json[field_name] = {
                "value": field_data.get("value"),
                "confidence": float(field_data.get("confidence", 0.0)),
                "source": field_data.get("source", "unknown"),
            }

    form_json.update(deterministic_fields)
    return form_json


def _load_t2201_schema() -> dict:
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"T2201 schema not found at {SCHEMA_PATH}")
    with open(SCHEMA_PATH) as f:
        return json.load(f)


@router.post(
    "/patients/{patient_id}/form-draft",
    response_model=FormDraft,
    status_code=201,
)
async def generate_form_draft(patient_id: UUID, request: FormDraftCreate, user: dict = Depends(auth_dependency)):
    """
    Called by IBM Orchestrate after SOAP note is approved.
    Fetches FHIR history + approved SOAP, calls Granite, persists form draft.
    """
    client = get_client()

    # 1. Verify patient exists
    patient_resp = client.table("patients").select("*").eq("id", str(patient_id)).maybe_single().execute()
    if not patient_resp or not patient_resp.data:
        raise HTTPException(status_code=404, detail="Patient not found")
    patient = patient_resp.data

    appointment_resp = (
        client.table("appointments")
        .select("*")
        .eq("id", str(request.appointment_id))
        .maybe_single()
        .execute()
    )
    if not appointment_resp or not appointment_resp.data or str(appointment_resp.data.get("patient_id")) != str(patient_id):
        raise HTTPException(status_code=404, detail="Appointment not found")

    # 2. Fetch the SOAP note (approved or finalized)
    soap_resp = (
        client.table("soap_notes")
        .select("*")
        .eq("id", str(request.soap_note_id))
        .maybe_single()
        .execute()
    )
    if not soap_resp or not soap_resp.data:
        raise HTTPException(status_code=409, detail="SOAP note not found")
    soap_note = soap_resp.data

    if str(soap_note.get("patient_id")) != str(patient_id) or str(soap_note.get("appointment_id")) != str(request.appointment_id):
        raise HTTPException(status_code=409, detail="SOAP note does not match the requested patient appointment")

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

    deterministic_fields = _build_deterministic_fields(
        patient_row=patient,
        conditions_bundle=conditions,
    )

    # 5. Build Granite prompt
    resolved_patient_bundle = _build_patient_bundle_override(
        patient_row=patient,
        fhir_patient_bundle=fhir_patient,
    )
    fhir_context = {
        "patient": resolved_patient_bundle,
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
    llm_fallback_used = False
    form_fields_raw: dict = {}

    try:
        raw_response = await generate(prompt=prompt, system=FORM_SYSTEM_PROMPT)
        import re
        clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_response.strip(), flags=re.MULTILINE).strip()
        candidates = _extract_json_objects(clean)
        if not candidates:
            raise json.JSONDecodeError("No JSON object found in response", clean, 0)
        # Take the largest candidate (most complete form output)
        form_fields_raw = json.loads(max(candidates, key=len))
    except LLMError as e:
        llm_fallback_used = True
        logger.warning("Granite call failed during form generation; using deterministic fallback: %s", e)
    except json.JSONDecodeError as e:
        llm_fallback_used = True
        preview = (raw_response[:500] if "raw_response" in locals() else "").replace("\n", " ")
        logger.warning(
            "Granite returned invalid JSON during form generation; using deterministic fallback: %s | raw=%r",
            e,
            preview,
        )

    # 7. Convert to FormFieldValue objects
    form_json = _merge_form_fields(
        schema=schema,
        llm_fields=form_fields_raw,
        deterministic_fields=deterministic_fields,
    )

    # 8. Check for existing draft to handle versioning
    existing_resp = (
        client.table("form_drafts")
        .select("*")
        .eq("appointment_id", str(request.appointment_id))
        .is_("superseded_by", "null")
        .execute()
    )

    if existing_resp.data:
        return existing_resp.data[0]

    new_version = 1
    physician_id = patient.get("physician_id", "00000000-0000-0000-0000-000000000000")
    new_id = str(uuid4())

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
        metadata={
            "version": new_version,
            "field_count": len(form_json),
            "llm_fallback_used": llm_fallback_used,
        },
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
            .maybe_single()
            .execute()
        )
        if not current_resp or not current_resp.data:
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
        client.table("form_drafts").select("*").eq("id", str(form_id)).maybe_single().execute()
    )
    if not draft_resp or not draft_resp.data:
        raise HTTPException(status_code=404, detail="Form draft not found")
    draft = draft_resp.data

    if draft["approved"]:
        raise HTTPException(status_code=409, detail="Already approved")

    # 2. Fetch patient for FHIR ID
    patient_resp = (
        client.table("patients").select("fhir_id").eq("id", draft["patient_id"]).maybe_single().execute()
    )
    if not patient_resp or not patient_resp.data:
        raise HTTPException(status_code=404, detail="Patient not found")

    # 3. Write FHIR Composition
    try:
        fhir_patient_id = patient_resp.data["fhir_id"]
        composition_data = {
            "resourceType": "Composition",
            "status": "final",
            "type": {
                "coding": [{"system": "http://loinc.org", "code": "11488-4", "display": "Consult note"}]
            },
            "subject": {"reference": f"Patient/{fhir_patient_id}"},
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
            "subject": {"reference": f"Patient/{fhir_patient_id}"},
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
