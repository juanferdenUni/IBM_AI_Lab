from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    # Supabase
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str

    # IBM Granite / watsonx
    watsonx_api_key: Optional[str] = None
    watsonx_project_id: Optional[str] = None
    watsonx_url: Optional[str] = None
    granite_model_id: str = "ibm/granite-3-8b-instruct"

    # FHIR
    fhir_base_url: str = "https://hapi.fhir.org/baseR4"
    use_fhir_fallback: bool = False

    # Whisper
    whisper_model_size: str = "base.en"

    # Orchestrate
    orchestrate_shared_secret: Optional[str] = None

    # Feature flags
    auth_enabled: bool = False
    confidence_threshold: float = 0.75

    # Deployment
    backend_url: str = "http://localhost:8000"
    frontend_url: str = "http://localhost:5173"

    # Logging
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="allow",
    )


settings = Settings()