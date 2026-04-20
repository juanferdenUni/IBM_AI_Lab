from pydantic import BaseModel
from backend.models.soap_note import SOAPContent, BillingCode
from backend.services import llm

SOAP_SYSTEM_PROMPT = """
You are a medical scribe. Given the current SOAP note and a new transcript segment
from a physician-patient encounter, return an updated SOAP note.
Rules:
- Update only — do not remove prior content unless directly contradicted.
- Return a JSON object with keys: soap (SOAPContent) and billing_codes (array of BillingCode).
- SOAPContent keys: subjective, objective, assessment, plan (all strings).
- BillingCode keys: code, description, confidence (float 0.0-1.0).
- Return only the JSON object, no prose.
"""


class SOAPUpdateResult(BaseModel):
    soap: SOAPContent
    billing_codes: list[BillingCode]


async def update_soap(
    current_soap: SOAPContent,
    new_segment: str,
    full_transcript: str,
) -> tuple[SOAPContent, list[BillingCode]]:
    result = await llm.generate(
        prompt=(
            f"Current SOAP:\n{current_soap.model_dump_json()}\n\n"
            f"New transcript segment:\n{new_segment}"
        ),
        system=SOAP_SYSTEM_PROMPT,
        response_model=SOAPUpdateResult,
    )
    return result.soap, result.billing_codes
