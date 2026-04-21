import logging
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends

from backend.middleware.auth import auth_dependency

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/patients/{patient_id}/appointment/start")
async def start_appointment(patient_id: UUID, body: dict, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")


@router.get("/patients/{patient_id}/appointment/stream")
async def appointment_stream(patient_id: UUID, token: str = ""):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")


@router.post("/patients/{patient_id}/appointment/end", status_code=201)
async def end_appointment(patient_id: UUID, body: dict, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Sunny owns this")