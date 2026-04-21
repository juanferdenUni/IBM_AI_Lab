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
    """List all patients for the authenticated physician."""
    try:
        client = get_client()
        
        # Query all patients
        response = client.table("patients").select("*").execute()
        
        logger.debug(f"Retrieved {len(response.data)} patients")
        
        return [Patient(**row) for row in response.data]
    
    except Exception as e:
        logger.error(f"Error listing patients: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to list patients")


@router.get("/patients/{patient_id}", response_model=Patient)
async def get_patient(patient_id: UUID, user: dict = Depends(auth_dependency)):
    """Get a specific patient by ID."""
    try:
        client = get_client()
        
        # Convert UUID to string for database query
        patient_id_str = str(patient_id)
        
        logger.debug(f"Fetching patient with ID: {patient_id_str}")
        
        # Use eq() method - this is the correct syntax for Supabase Python SDK
        response = (
            client.table("patients")
            .select("*")
            .eq("id", patient_id_str)
            .execute()
        )
        
        logger.debug(f"Response data: {response.data}")
        
        # Check if we got results
        if not response.data or len(response.data) == 0:
            logger.warning(f"Patient not found: {patient_id_str}")
            raise HTTPException(status_code=404, detail=f"Patient not found: {patient_id_str}")
        
        # Return the first result
        patient_data = response.data[0]
        logger.debug(f"Found patient: {patient_data}")
        
        return Patient(**patient_data)
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting patient: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get patient: {str(e)}")


@router.patch("/patients/{patient_id}/workflow-state")
async def update_patient_workflow_state(
    patient_id: UUID,
    update: PatientUpdate,
    user: dict = Depends(auth_dependency),
):
    """Update a patient's workflow state."""
    try:
        client = get_client()
        
        patient_id_str = str(patient_id)
        
        # Verify patient exists first
        check = (
            client.table("patients")
            .select("*")
            .eq("id", patient_id_str)
            .execute()
        )
        
        if not check.data:
            raise HTTPException(status_code=404, detail="Patient not found")
        
        # Build update data
        update_data = {}
        if update.workflow_state:
            update_data["workflow_state"] = update.workflow_state.value
        if update.display_name:
            update_data["display_name"] = update.display_name
        
        # If nothing to update, return current patient
        if not update_data:
            return Patient(**check.data[0])
        
        # Update the patient
        response = (
            client.table("patients")
            .update(update_data)
            .eq("id", patient_id_str)
            .execute()
        )
        
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to update patient")
        
        return Patient(**response.data[0])
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating patient: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update patient")