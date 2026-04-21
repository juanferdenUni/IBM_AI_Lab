import logging
import json
import re
from typing import TypeVar, Type
from pydantic import BaseModel
from backend.config import settings

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

_model = None


def _get_model():
    global _model
    if _model is not None:
        return _model
    try:
        from ibm_watsonx_ai import APIClient, Credentials
        from ibm_watsonx_ai.foundation_models import ModelInference
        from ibm_watsonx_ai.metanames import GenTextParamsMetaNames as GenParams

        credentials = Credentials(url=settings.watsonx_url, api_key=settings.watsonx_api_key)
        client = APIClient(credentials)
        _model = ModelInference(
            model_id=settings.granite_model_id,
            api_client=client,
            project_id=settings.watsonx_project_id,
            params={GenParams.MAX_NEW_TOKENS: 1024, GenParams.TEMPERATURE: 0.1},
        )
        logger.info("Granite model initialized")
        return _model
    except Exception as e:
        logger.error(f"Granite init failed: {e}")
        raise LLMError(f"Model initialization failed: {e}")


async def generate(
    prompt: str,
    system: str = "",
    response_model: Type[T] | None = None,
    max_tokens: int = 1024,
) -> "T | str":
    import asyncio

    if response_model is not None:
        schema = json.dumps(response_model.model_json_schema(), indent=2)
        system = (
            system
            + f"\n\nReturn ONLY a valid JSON object matching this schema. "
            f"No markdown fences, no prose.\nSchema:\n{schema}"
        )

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        model = _get_model()
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, lambda: model.chat(messages=messages))
        raw: str = response["choices"][0]["message"]["content"].strip()
    except Exception as e:
        raise LLMError(f"watsonx call failed: {e}") from e

    if response_model is None:
        return raw

    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        return response_model.model_validate_json(clean)
    except Exception as e:
        raise LLMError(f"Failed to parse Granite response: {e}\nRaw: {raw}") from e


class LLMError(Exception):
    pass