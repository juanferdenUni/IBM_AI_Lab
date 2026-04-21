import logging
from uuid import UUID
from typing import Any
from datetime import datetime, timezone

from backend.models.enums import AuditAction

logger = logging.getLogger(__name__)


async def log_action(
    actor_id: UUID,
    action: AuditAction,
    resource_type: str,
    resource_id: UUID,
    appointment_id: UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """
    Append-only audit log write. Swallows all exceptions so it never
    blocks a clinical workflow.
    """
    try:
        from backend.services.supabase_client import get_client
        client = get_client()

        insert_data = {
            "event": action.value,
            "actor_id": str(actor_id),
            "resource_type": resource_type,
            "resource_id": str(resource_id),
            "appointment_id": str(appointment_id) if appointment_id else None,
            "metadata": metadata,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        client.table("audit_log").insert(insert_data).execute()
        logger.debug(f"Audit: {action.value} on {resource_type} {resource_id}")

    except Exception as e:
        logger.error(f"Audit log failed (non-fatal): {e}", exc_info=True)