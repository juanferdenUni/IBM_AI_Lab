from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field


class SOAPContent(BaseModel):
    subjective: str
    objective: str
    assessment: str
    plan: str


class BillingCode(BaseModel):
    code: str
    description: str
    confidence: float = Field(ge=0.0, le=1.0)


class SOAPNoteCreate(BaseModel):
    appointment_id: UUID
    patient_id: UUID
    transcript_text: str
    soap_json: SOAPContent
    billing_codes: list[BillingCode] = []


class SOAPNoteUpdate(BaseModel):
    subjective: str | None = None
    objective: str | None = None
    assessment: str | None = None
    plan: str | None = None
    billing_codes: list[BillingCode] | None = None


class SOAPNote(BaseModel):
    id: UUID
    appointment_id: UUID
    patient_id: UUID
    transcript_text: str
    soap_json: SOAPContent
    billing_codes: list[BillingCode]
    approved: bool
    approved_at: datetime | None
    version: int
    superseded_by: UUID | None
    created_by: UUID
    created_at: datetime

    model_config = {"from_attributes": True}