import logging
from fastapi import HTTPException, Header
from backend.config import settings

logger = logging.getLogger(__name__)


async def orchestrate_auth_dependency(
    x_orchestrate_secret: str | None = Header(default=None),
) -> None:
    if x_orchestrate_secret != settings.orchestrate_shared_secret:
        logger.warning("Invalid Orchestrate secret")
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing X-Orchestrate-Secret header",
        )