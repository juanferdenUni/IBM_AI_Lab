import sys
from uuid import UUID
from typing import Any

from backend.models.enums import AuditAction
from backend.services.supabase_client import get_client


async def log_action(
    actor_id: UUID,
    action: AuditAction,
    resource_type: str,
    resource_id: UUID,
    appointment_id: UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    try:
        client = get_client()
        client.table("audit_log").insert({
            "actor_id": str(actor_id),
            "event": action.value,
            "resource_type": resource_type,
            "resource_id": str(resource_id),
            "appointment_id": str(appointment_id) if appointment_id else None,
            "metadata": metadata,
        }).execute()
    except Exception as e:
        print(f"[audit] log_action failed silently: {e}", file=sys.stderr)
