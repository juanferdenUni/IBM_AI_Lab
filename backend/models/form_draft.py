from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field
from .enums import FormType


class FormFieldValue(BaseModel):
    value: str | bool | None
    confidence: float = Field(ge=0.0, le=1.0)
    source: str


class FormDraftCreate(BaseModel):
    appointment_id: UUID
    patient_id: UUID
    soap_note_id: UUID
    form_type: FormType = FormType.T2201


class FormDraftUpdate(BaseModel):
    fields: dict[str, FormFieldValue]


class FormDraft(BaseModel):
    id: UUID
    appointment_id: UUID
    patient_id: UUID
    soap_note_id: UUID
    form_type: FormType
    form_json: dict[str, FormFieldValue]
    approved: bool
    approved_at: datetime | None
    fhir_composition_id: str | None
    fhir_doc_ref_id: str | None
    version: int
    superseded_by: UUID | None
    created_by: UUID
    created_at: datetime

    model_config = {"from_attributes": True}