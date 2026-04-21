import logging
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends

from backend.middleware.auth import auth_dependency

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/patients/{patient_id}/context-brief", status_code=201)
async def generate_context_brief(patient_id: UUID, body: dict, user: dict = Depends(auth_dependency)):
    # Juan implements this
    raise HTTPException(status_code=501, detail="Not implemented yet — Juan owns this")


@router.get("/patients/{patient_id}/context-brief")
async def get_context_brief(patient_id: UUID, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Juan owns this")


@router.get("/patients/{patient_id}/context-brief/history")
async def get_context_brief_history(patient_id: UUID, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Juan owns this")


@router.post("/context-briefs/{brief_id}/approve")
async def approve_context_brief(brief_id: UUID, user: dict = Depends(auth_dependency)):
    raise HTTPException(status_code=501, detail="Not implemented yet — Juan owns this")