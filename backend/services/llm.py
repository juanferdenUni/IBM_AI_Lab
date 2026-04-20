import re
import json
from typing import TypeVar, Type
from pydantic import BaseModel
from ibm_watsonx_ai import APIClient, Credentials
from ibm_watsonx_ai.foundation_models import ModelInference
from ibm_watsonx_ai.metanames import GenTextParamsMetaNames as GenParams
from backend.config import settings

T = TypeVar("T", bound=BaseModel)

_model: ModelInference | None = None


def _get_model() -> ModelInference:
    credentials = Credentials(
        url=settings.watsonx_url,
        api_key=settings.watsonx_api_key,
    )
    client = APIClient(credentials)
    return ModelInference(
        model_id=settings.granite_model_id,
        api_client=client,
        project_id=settings.watsonx_project_id,
        params={
            GenParams.MAX_NEW_TOKENS: 1024,
            GenParams.TEMPERATURE: 0.1,
        },
    )


async def generate(
    prompt: str,
    system: str = "",
    response_model: Type[T] | None = None,
    max_tokens: int = 1024,
) -> T | str:
    global _model
    if _model is None:
        _model = _get_model()

    if response_model is not None:
        schema = json.dumps(response_model.model_json_schema(), indent=2)
        system = (
            system
            + f"\n\nReturn ONLY a valid JSON object matching this schema. "
            f"No markdown fences, no prose, no explanation.\nSchema:\n{schema}"
        )

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        response = _model.chat(
            messages=messages,
            params={GenParams.MAX_NEW_TOKENS: max_tokens},
        )
    except Exception as e:
        raise LLMError(f"watsonx call failed: {e}") from e

    raw: str = response["choices"][0]["message"]["content"].strip()

    if response_model is None:
        return raw

    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()

    try:
        return response_model.model_validate_json(clean)
    except Exception as e:
        raise LLMError(
            f"Failed to parse Granite response into {response_model.__name__}: {e}\nRaw: {raw}"
        ) from e


class LLMError(Exception):
    """Raised on non-2xx watsonx response or unparseable JSON output."""
    ...
