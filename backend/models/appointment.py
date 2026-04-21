from uuid import UUID
from datetime import datetime
from pydantic import BaseModel
from .enums import AppointmentPhase


class AppointmentCreate(BaseModel):
    patient_id: UUID
    physician_id: UUID
    scheduled_at: datetime
    audio_file_path: str | None = None


class Appointment(BaseModel):
    id: UUID
    patient_id: UUID
    physician_id: UUID
    scheduled_at: datetime
    phase: AppointmentPhase
    orchestrate_instance_id: str | None
    audio_file_path: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}