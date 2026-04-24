import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from config import settings
from middleware.auth import auth_dependency
from models.context_brief import ContextBrief
from models.enums import AuditAction, WorkflowState
from services.audit import log_action
from services.context_engine import build_context_brief
from services.fhir_client import FHIRError
from services.supabase_client import get_client

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_patient_for_user(client, patient_id: UUID, user_id: str) -> dict:
    query = client.table("patients").select("*").eq("id", str(patient_id))
    if settings.auth_enabled:
        query = query.eq("physician_id", user_id)
    response = query.maybe_single().execute()
    if not response or not response.data:
        raise HTTPException(status_code=404, detail="Patient not found")
    return response.data


def _get_appointment_for_user(client, appointment_id: str, patient_id: UUID, user_id: str) -> dict:
    query = (
        client.table("appointments")
        .select("*")
        .eq("id", appointment_id)
        .eq("patient_id", str(patient_id))
    )
    if settings.auth_enabled:
        query = query.eq("physician_id", user_id)
    response = query.maybe_single().execute()
    if not response or not response.data:
        raise HTTPException(status_code=404, detail="Appointment not found")
    return response.data


async def create_context_brief_record(
    *,
    client,
    patient: dict,
    appointment_id: str,
    actor_id: str,
) -> ContextBrief:
    try:
        brief_content, snapshot = await build_context_brief(
            mrn=patient["mrn"],
            fhir_id=patient["fhir_id"],
        )
    except FHIRError as exc:
        logger.error("FHIR context fetch failed for patient %s: %s", patient["id"], exc)
        raise HTTPException(status_code=502, detail=f"FHIR query failed: {exc}") from exc

    current = (
        client.table("context_briefs")
        .select("id, version")
        .eq("appointment_id", appointment_id)
        .is_("superseded_by", "null")
        .execute()
    )

    new_id = str(uuid4())
    version = 1
    if current.data:
        version = int(current.data[0]["version"]) + 1
        (
            client.table("context_briefs")
            .update({"superseded_by": new_id})
            .eq("id", current.data[0]["id"])
            .execute()
        )

    insert_response = (
        client.table("context_briefs")
        .insert(
            {
                "id": new_id,
                "appointment_id": appointment_id,
                "patient_id": str(patient["id"]),
                "brief_json": brief_content.model_dump(),
                "fhir_resources_snapshot": snapshot,
                "version": version,
                "approved": False,
                "created_by": actor_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .execute()
    )
    if not insert_response.data:
        raise HTTPException(status_code=500, detail="Failed to persist context brief")

    (
        client.table("patients")
        .update({"workflow_state": WorkflowState.BRIEF_READY.value})
        .eq("id", str(patient["id"]))
        .execute()
    )

    await log_action(
        actor_id=UUID(actor_id),
        action=AuditAction.CONTEXT_BRIEF_GENERATED,
        resource_type="context_brief",
        resource_id=UUID(new_id),
        appointment_id=UUID(appointment_id),
        metadata={"version": version, "missing_data_flags": len(brief_content.missing_data_flags)},
    )

    return ContextBrief(**insert_response.data[0])


@router.post("/patients/{patient_id}/context-brief", response_model=ContextBrief, status_code=201)
async def generate_context_brief(patient_id: UUID, body: dict, user: dict = Depends(auth_dependency)):
    appointment_id = body.get("appointment_id")
    if not appointment_id:
        raise HTTPException(status_code=422, detail="appointment_id is required")

    client = get_client()
    patient = _get_patient_for_user(client, patient_id, user["id"])
    _get_appointment_for_user(client, appointment_id, patient_id, user["id"])

    actor_id = user["id"] if settings.auth_enabled else patient["physician_id"]
    return await create_context_brief_record(
        client=client,
        patient=patient,
        appointment_id=appointment_id,
        actor_id=actor_id,
    )


@router.get("/patients/{patient_id}/context-brief", response_model=ContextBrief)
async def get_context_brief(
    patient_id: UUID,
    appointment_id: UUID | None = Query(default=None),
    user: dict = Depends(auth_dependency),
):
    client = get_client()
    _get_patient_for_user(client, patient_id, user["id"])

    query = (
        client.table("context_briefs")
        .select("*")
        .eq("patient_id", str(patient_id))
        .is_("superseded_by", "null")
        .order("created_at", desc=True)
    )
    if appointment_id:
        query = query.eq("appointment_id", str(appointment_id))

    response = query.limit(1).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="No context brief found for this patient")
    return ContextBrief(**response.data[0])


@router.get("/patients/{patient_id}/context-brief/history", response_model=list[ContextBrief])
async def get_context_brief_history(patient_id: UUID, user: dict = Depends(auth_dependency)):
    client = get_client()
    _get_patient_for_user(client, patient_id, user["id"])

    response = (
        client.table("context_briefs")
        .select("*")
        .eq("patient_id", str(patient_id))
        .order("created_at", desc=True)
        .execute()
    )
    return [ContextBrief(**row) for row in response.data]


@router.post("/context-briefs/{brief_id}/approve")
async def approve_context_brief(brief_id: UUID, user: dict = Depends(auth_dependency)):
    client = get_client()
    response = (
        client.table("context_briefs")
        .select("*")
        .eq("id", str(brief_id))
        .maybe_single()
        .execute()
    )
    if not response or not response.data:
        raise HTTPException(status_code=404, detail="Context brief not found")

    brief = response.data
    _get_patient_for_user(client, UUID(brief["patient_id"]), user["id"])

    if brief["approved"]:
        raise HTTPException(status_code=409, detail="Context brief already approved")

    approved_at = datetime.now(timezone.utc).isoformat()
    update_response = (
        client.table("context_briefs")
        .update({"approved": True, "approved_at": approved_at})
        .eq("id", str(brief_id))
        .execute()
    )
    if not update_response.data:
        raise HTTPException(status_code=500, detail="Failed to approve context brief")

    (
        client.table("patients")
        .update({"workflow_state": WorkflowState.BRIEF_READY.value})
        .eq("id", brief["patient_id"])
        .execute()
    )

    await log_action(
        actor_id=UUID(user["id"]),
        action=AuditAction.CONTEXT_BRIEF_APPROVED,
        resource_type="context_brief",
        resource_id=brief_id,
        appointment_id=UUID(brief["appointment_id"]),
    )

    return {
        "id": str(brief_id),
        "approved": True,
        "approved_at": approved_at,
    }
