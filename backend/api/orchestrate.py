import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from backend.api.context_briefs import create_context_brief_record
from backend.middleware.orchestrate_auth import orchestrate_auth_dependency
from backend.models import PhaseAdvanceRequest, PhaseAdvanceResponse
from backend.models.enums import AppointmentPhase, AuditAction
from backend.services.audit import log_action
from backend.services.supabase_client import get_client

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_patient_and_appointment(client, patient_id: str, appointment_id: str) -> tuple[dict, dict]:
    patient_response = (
        client.table("patients")
        .select("*")
        .eq("id", patient_id)
        .single()
        .execute()
    )
    if not patient_response.data:
        raise HTTPException(status_code=404, detail="Patient not found")

    appointment_response = (
        client.table("appointments")
        .select("*")
        .eq("id", appointment_id)
        .eq("patient_id", patient_id)
        .single()
        .execute()
    )
    if not appointment_response.data:
        raise HTTPException(status_code=404, detail="Appointment not found")

    return patient_response.data, appointment_response.data


def _latest_context_brief(client, appointment_id: str, approved_only: bool = False) -> dict | None:
    query = (
        client.table("context_briefs")
        .select("*")
        .eq("appointment_id", appointment_id)
        .is_("superseded_by", "null")
    )
    if approved_only:
        query = query.eq("approved", True)

    response = query.limit(1).execute()
    return response.data[0] if response.data else None


async def _record_phase_advance(actor_id: str, appointment_id: str, previous_phase: str, current_phase: str) -> None:
    await log_action(
        actor_id=UUID(actor_id),
        action=AuditAction.PHASE_ADVANCED,
        resource_type="appointment",
        resource_id=UUID(appointment_id),
        appointment_id=UUID(appointment_id),
        metadata={"previous_phase": previous_phase, "current_phase": current_phase},
    )


@router.post(
    "/orchestrate/advance-phase",
    response_model=PhaseAdvanceResponse,
    dependencies=[Depends(orchestrate_auth_dependency)],
)
async def advance_phase(request: PhaseAdvanceRequest):
    client = get_client()
    patient, appointment = _get_patient_and_appointment(
        client,
        str(request.patient_id),
        str(request.appointment_id),
    )

    previous_phase = appointment["phase"]
    actor_id = appointment["physician_id"]

    if request.target_phase == AppointmentPhase.PRE_APPOINTMENT:
        await create_context_brief_record(
            client=client,
            patient=patient,
            appointment_id=str(request.appointment_id),
            actor_id=actor_id,
        )

        (
            client.table("appointments")
            .update(
                {
                    "phase": AppointmentPhase.PRE_APPOINTMENT.value,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", str(request.appointment_id))
            .execute()
        )

        await _record_phase_advance(
            actor_id=actor_id,
            appointment_id=str(request.appointment_id),
            previous_phase=previous_phase,
            current_phase=AppointmentPhase.PRE_APPOINTMENT.value,
        )

        return PhaseAdvanceResponse(
            appointment_id=request.appointment_id,
            previous_phase=AppointmentPhase(previous_phase),
            current_phase=AppointmentPhase.PRE_APPOINTMENT,
            next_action_url=f"/api/patients/{request.patient_id}/context-brief?appointment_id={request.appointment_id}",
        )

    if request.target_phase == AppointmentPhase.DURING_APPOINTMENT:
        brief = _latest_context_brief(client, str(request.appointment_id), approved_only=True)
        if brief is None:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot advance to during_appointment: no approved context_brief for appointment {request.appointment_id}",
            )

    raise HTTPException(
        status_code=501,
        detail=f"advance-phase for {request.target_phase.value} is not implemented in this pass",
    )
