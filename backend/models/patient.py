from uuid import UUID
from datetime import date, datetime
from pydantic import BaseModel
from .enums import WorkflowState


class PatientCreate(BaseModel):
    fhir_id: str
    mrn: str
    display_name: str
    date_of_birth: date
    physician_id: UUID


class PatientUpdate(BaseModel):
    display_name: str | None = None
    workflow_state: WorkflowState | None = None


class Patient(BaseModel):
    id: UUID
    fhir_id: str
    mrn: str
    display_name: str
    date_of_birth: date
    physician_id: UUID
    workflow_state: WorkflowState
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}