import logging

from supabase import create_client, Client

from backend.config import settings

logger = logging.getLogger(__name__)

_client: Client | None = None


def get_client() -> Client:
	global _client
	if _client is None:
		logger.info("Initializing Supabase client")
		_client = create_client(
			supabase_url=settings.supabase_url,
			supabase_key=settings.supabase_service_role_key,
		)
	return _client