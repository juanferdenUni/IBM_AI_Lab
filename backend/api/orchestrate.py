import logging
from fastapi import APIRouter, HTTPException, Depends

from backend.models import PhaseAdvanceRequest, PhaseAdvanceResponse
from backend.middleware.orchestrate_auth import orchestrate_auth_dependency

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/orchestrate/advance-phase",
    response_model=PhaseAdvanceResponse,
    dependencies=[Depends(orchestrate_auth_dependency)],
)
async def advance_phase(request: PhaseAdvanceRequest):
    # Juan implements the routing logic
    raise HTTPException(status_code=501, detail="Not implemented yet — Juan owns this")