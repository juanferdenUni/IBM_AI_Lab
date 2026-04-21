from fastapi import APIRouter
from backend.config import settings

router = APIRouter()

@router.get("/test-supabase")
def test_supabase():
    return {
        "supabase_url": settings.supabase_url,
        "anon_key_loaded": settings.supabase_anon_key is not None,
        "service_key_loaded": settings.supabase_service_role_key is not None,
    }