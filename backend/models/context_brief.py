from uuid import UUID
from datetime import datetime
from typing import Any
from pydantic import BaseModel


class LabResult(BaseModel):
    test: str
    value: str
    date: str
    flag: str | None = None


class Correspondence(BaseModel):
    type: str
    date: str
    summary: str


class InboxItem(BaseModel):
    channel: str
    title: str
    date: str
    summary: str
    priority: str = "routine"
    requires_action: bool = False


class BriefContent(BaseModel):
    chronic_conditions: list[str]
    recent_labs: list[LabResult]
    active_medications: list[str]
    recent_correspondence: list[Correspondence]
    inbox_items: list[InboxItem] = []
    missing_data_flags: list[str]


class ContextBriefCreate(BaseModel):
    appointment_id: UUID
    patient_id: UUID


class ContextBrief(BaseModel):
    id: UUID
    appointment_id: UUID
    patient_id: UUID
    brief_json: BriefContent
    fhir_resources_snapshot: dict[str, Any] | None
    version: int
    superseded_by: UUID | None
    approved: bool
    approved_at: datetime | None
    created_by: UUID
    created_at: datetime

    model_config = {"from_attributes": True}
