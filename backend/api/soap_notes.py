import logging
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends

from backend.middleware.auth import auth_dependency

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/patients/{patient_id}/soap-note")
async def get_soap_note(patient_id: UUID, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")


@router.patch("/soap-notes/{soap_id}")
async def update_soap_note(soap_id: UUID, body: dict, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")


@router.post("/soap-notes/{soap_id}/approve")
async def approve_soap_note(soap_id: UUID, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")