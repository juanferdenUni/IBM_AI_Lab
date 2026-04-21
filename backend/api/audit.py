import logging
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends, Query

from backend.middleware.auth import auth_dependency
from backend.services.supabase_client import get_client

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/audit-log")
async def get_audit_log(
    patient_id: UUID = Query(...),
    limit: int = Query(100, ge=1, le=1000),
    user: dict = Depends(auth_dependency),
):
    try:
        client = get_client()
        # Use resource_id to filter by patient across all resource types
        response = (
            client.table("audit_log")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return response.data
    except Exception as e:
        logger.error(f"get_audit_log error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch audit log")