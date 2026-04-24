import logging
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends

from backend.config import settings
from backend.models import Patient, PatientCreate, PatientUpdate
from backend.middleware.auth import auth_dependency
from backend.services.supabase_client import get_client

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/patients", response_model=list[Patient])
async def list_patients(user: dict = Depends(auth_dependency)):
    try:
        client = get_client()

        query = client.table("patients").select("*")

        if settings.AUTH_ENABLED:
            query = query.eq("physician_id", user["id"])

        response = (
            query
            .order("workflow_state")
            .order("display_name")
            .execute()
        )

        logger.debug(f"Retrieved {len(response.data)} patients")

        return [Patient(**row) for row in response.data]

    except Exception as e:
        logger.error(f"Error listing patients: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to list patients")


@router.get("/patients/{patient_id}", response_model=Patient)
async def get_patient(patient_id: UUID, user: dict = Depends(auth_dependency)):
    try:
        client = get_client()
        patient_id_str = str(patient_id)

        query = client.table("patients").select("*").eq("id", patient_id_str)

        if settings.AUTH_ENABLED:
            query = query.eq("physician_id", user["id"])

        response = query.execute()

        if not response.data:
            raise HTTPException(status_code=404, detail="Patient not found")

        return Patient(**response.data[0])

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting patient: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get patient")


@router.patch("/patients/{patient_id}/workflow-state")
async def update_patient_workflow_state(
    patient_id: UUID,
    update: PatientUpdate,
    user: dict = Depends(auth_dependency),
):
    try:
        client = get_client()
        patient_id_str = str(patient_id)

        # Build base query
        check_query = client.table("patients").select("*").eq("id", patient_id_str)

        if settings.AUTH_ENABLED:
            check_query = check_query.eq("physician_id", user["id"])

        check = check_query.execute()

        if not check.data:
            raise HTTPException(status_code=404, detail="Patient not found")

        update_data = {}
        if update.workflow_state:
            update_data["workflow_state"] = update.workflow_state.value
        if update.display_name:
            update_data["display_name"] = update.display_name

        if not update_data:
            return Patient(**check.data[0])

        update_query = client.table("patients").update(update_data).eq("id", patient_id_str)

        if settings.AUTH_ENABLED:
            update_query = update_query.eq("physician_id", user["id"])

        response = update_query.execute()

        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to update patient")

        return Patient(**response.data[0])

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating patient: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update patient")