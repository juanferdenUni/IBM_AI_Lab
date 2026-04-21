from uuid import UUID
from pydantic import BaseModel, model_validator
from .enums import AppointmentPhase


class PhaseAdvanceRequest(BaseModel):
    patient_id: UUID
    appointment_id: UUID
    target_phase: AppointmentPhase
    triggered_by: str
    audio_file_path: str | None = None

    @model_validator(mode="after")
    def audio_required_for_during(self) -> "PhaseAdvanceRequest":
        if self.target_phase == AppointmentPhase.DURING_APPOINTMENT and not self.audio_file_path:
            raise ValueError("audio_file_path is required when target_phase is during_appointment")
        return self


class PhaseAdvanceResponse(BaseModel):
    appointment_id: UUID
    previous_phase: AppointmentPhase
    current_phase: AppointmentPhase
    next_action_url: str