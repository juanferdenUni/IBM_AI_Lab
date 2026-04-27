from pydantic import BaseModel
from models.soap_note import SOAPContent, BillingCode
from services import llm

SOAP_SYSTEM_PROMPT = """
You are a medical scribe. Given the current SOAP note and a new transcript segment
from a physician-patient encounter, return an updated SOAP note.
Rules:
- Update only — do not remove prior content unless directly contradicted.
- All four SOAP sections must be non-empty strings.
- If the transcript does not contain enough detail for Objective, Assessment, or Plan, write a brief clinically cautious summary such as "No objective findings documented in transcript" rather than leaving the section blank.
- Return a JSON object with keys: soap (SOAPContent) and billing_codes (array of BillingCode).
- SOAPContent keys: subjective, objective, assessment, plan (all strings).
- BillingCode keys: code, description, confidence (float 0.0-1.0).
- Return only the JSON object, no prose.
"""


class SOAPUpdateResult(BaseModel):
    soap: SOAPContent
    billing_codes: list[BillingCode]


def _fill_blank_sections(soap: SOAPContent) -> SOAPContent:
    subjective = (soap.subjective or "").strip()
    objective = (soap.objective or "").strip()
    assessment = (soap.assessment or "").strip()
    plan = (soap.plan or "").strip()

    if not objective:
        objective = "No objective findings, examination details, or vital signs were documented in the transcript."
    if not assessment:
        if subjective:
            assessment = f"Symptoms described in the transcript require clinical assessment. {subjective}"
        else:
            assessment = "Clinical assessment not clearly documented in the transcript."
    if not plan:
        plan = "Plan not explicitly documented in the transcript; follow-up evaluation and management to be confirmed by the physician."

    return SOAPContent(
        subjective=subjective,
        objective=objective,
        assessment=assessment,
        plan=plan,
    )


async def update_soap(
    current_soap: SOAPContent,
    new_segment: str,
    full_transcript: str,
) -> tuple[SOAPContent, list[BillingCode]]:
    prompt = f"Current SOAP:\n{current_soap.model_dump_json()}\n\n"
    if full_transcript:
        prompt += f"Full transcript so far:\n{full_transcript}\n\n"
    prompt += f"New transcript segment:\n{new_segment}"

    result = await llm.generate(
        prompt=prompt,
        system=SOAP_SYSTEM_PROMPT,
        response_model=SOAPUpdateResult,
    )
    return _fill_blank_sections(result.soap), result.billing_codes
