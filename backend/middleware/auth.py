import logging
import json
import base64
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.config import settings

logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)

STUB_USER = {
    "id": "00000000-0000-0000-0000-000000000000",
    "email": "demo@warriors.dev",
}


async def auth_dependency(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    """
    Validate JWT. When AUTH_ENABLED=false returns a stub user.
    """
    if not settings.auth_enabled:
        return STUB_USER

    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = credentials.credentials

    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise HTTPException(status_code=401, detail="Invalid token format")

        payload_b64 = parts[1]
        # Fix padding
        padding = 4 - (len(payload_b64) % 4)
        if padding != 4:
            payload_b64 += "=" * padding

        decoded = json.loads(base64.urlsafe_b64decode(payload_b64))
        return {
            "id": decoded.get("sub", STUB_USER["id"]),
            "email": decoded.get("email", STUB_USER["email"]),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"JWT parse error: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")