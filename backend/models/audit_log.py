from uuid import UUID
from datetime import datetime
from typing import Any
from pydantic import BaseModel
from .enums import AuditAction


class AuditLogEntry(BaseModel):
    id: UUID
    event: AuditAction
    actor_id: UUID
    resource_type: str
    resource_id: UUID
    appointment_id: UUID | None
    metadata: dict[str, Any] | None
    created_at: datetime

    model_config = {"from_attributes": True}