import re
import json
from typing import TypeVar, Type
from pydantic import BaseModel
from ibm_watsonx_ai.foundation_models import Model
from ibm_watsonx_ai.metanames import GenTextParamsMetaNames as GenParams
from backend.config import settings

T = TypeVar("T", bound=BaseModel)

_model: Model | None = None


def _get_model() -> Model:
    credentials = {
        "url": settings.watsonx_url,
        "apikey": settings.watsonx_api_key,
    }
    return Model(
        model_id=settings.granite_model_id,
        credentials=credentials,
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
        prompt = f"{system}\n\n{prompt}"

    try:
        response = _model.generate_text(
            prompt=prompt,
            params={GenParams.MAX_NEW_TOKENS: max_tokens},
        )
    except Exception as e:
        raise LLMError(f"watsonx call failed: {e}") from e

    if isinstance(response, str):
        raw = response.strip()
    else:
        raw = response["results"][0]["generated_text"].strip()

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
