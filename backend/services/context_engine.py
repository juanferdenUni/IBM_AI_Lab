import asyncio
import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from backend.models.context_brief import BriefContent, Correspondence, InboxItem, LabResult
from backend.services.fhir_client import (
    FHIRError,
    get_communications,
    get_conditions,
    get_medications,
    get_observations,
    get_patient,
)
from backend.services.llm import LLMError, generate

logger = logging.getLogger(__name__)
MOCK_PREAPPOINTMENT_DIR = Path(__file__).parent.parent / "data" / "preappointment_mock"

CONTEXT_BRIEF_SYSTEM_PROMPT = """
You are a clinical documentation assistant preparing a concise pre-appointment brief.
Return only structured JSON with these keys:
- chronic_conditions: array of strings
- recent_labs: array of {test, value, date, flag}
- active_medications: array of strings
- recent_correspondence: array of {type, date, summary}
- inbox_items: array of {channel, title, date, summary, priority, requires_action}
- missing_data_flags: array of strings

Rules:
- Use only information present in the provided FHIR resources and mocked pre-appointment inbox sources.
- Be concise and physician-friendly.
- Do not invent diagnoses, dates, values, or summaries.
- If a section has no data, return an empty array for that section.
"""


def _entries(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        entry.get("resource", {})
        for entry in bundle.get("entry", [])
        if isinstance(entry, dict) and isinstance(entry.get("resource"), dict)
    ]


def _coding_text(resource: dict[str, Any], field: str) -> str:
    value = resource.get(field) or {}
    if not isinstance(value, dict):
        return str(value)

    if value.get("text"):
        return str(value["text"])

    for coding in value.get("coding", []) or []:
        if coding.get("display"):
            return str(coding["display"])
        if coding.get("code"):
            return str(coding["code"])

    return "Unknown"


def _resource_date(resource: dict[str, Any], *fields: str) -> str:
    for field in fields:
        value = resource.get(field)
        if value:
            return str(value)[:10]
    return "unknown"


def _observation_value(resource: dict[str, Any]) -> str:
    quantity = resource.get("valueQuantity") or {}
    if quantity.get("value") is not None:
        unit = quantity.get("unit") or ""
        return f"{quantity['value']} {unit}".strip()

    for field in ("valueString", "valueInteger", "valueBoolean"):
        value = resource.get(field)
        if value is not None:
            return str(value)

    value_codeable = resource.get("valueCodeableConcept")
    if isinstance(value_codeable, dict):
        if value_codeable.get("text"):
            return str(value_codeable["text"])
        for coding in value_codeable.get("coding", []) or []:
            if coding.get("display"):
                return str(coding["display"])
            if coding.get("code"):
                return str(coding["code"])

    return "not reported"


def _observation_flag(resource: dict[str, Any]) -> str | None:
    for interpretation in resource.get("interpretation", []) or []:
        for coding in interpretation.get("coding", []) or []:
            code = str(coding.get("code") or "").upper()
            display = str(coding.get("display") or "").lower()
            if code in {"H", "HH", "L", "LL", "A"}:
                return display or code.lower()

    text = json.dumps(resource).lower()
    if "abnormal" in text:
        return "abnormal"
    if "high" in text:
        return "high"
    if "low" in text:
        return "low"
    return None


def _parse_date(date_string: str) -> datetime | None:
    if date_string == "unknown":
        return None
    try:
        parsed = datetime.fromisoformat(date_string.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.combine(date.fromisoformat(date_string[:10]), datetime.min.time())
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_older_than(date_string: str, days: int) -> bool:
    parsed = _parse_date(date_string)
    if parsed is None:
        return False
    return (datetime.now(timezone.utc) - parsed).days > days


def _load_mock_inbox(mrn: str) -> list[dict[str, Any]]:
    filepath = MOCK_PREAPPOINTMENT_DIR / f"inbox_{mrn}.json"
    if not filepath.exists():
        return []

    with open(filepath, encoding="utf-8") as handle:
        data = json.load(handle)

    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def _build_fallback_brief(snapshot: dict[str, Any]) -> BriefContent:
    conditions: list[str] = []
    for resource in _entries(snapshot["conditions"]):
        label = _coding_text(resource, "code")
        onset = _resource_date(resource, "onsetDateTime", "recordedDate")
        conditions.append(f"{label} - {onset}")

    labs: list[LabResult] = []
    for resource in _entries(snapshot["observations"])[:10]:
        labs.append(
            LabResult(
                test=_coding_text(resource, "code"),
                value=_observation_value(resource),
                date=_resource_date(resource, "effectiveDateTime", "issued"),
                flag=_observation_flag(resource),
            )
        )

    medications: list[str] = []
    for resource in _entries(snapshot["medications"]):
        med_name = _coding_text(resource, "medicationCodeableConcept")
        dosage = "; ".join(
            instruction.get("text", "")
            for instruction in resource.get("dosageInstruction", [])
            if isinstance(instruction, dict) and instruction.get("text")
        )
        medications.append(f"{med_name} - {dosage}" if dosage else med_name)

    correspondence: list[Correspondence] = []
    for resource in _entries(snapshot["communications"])[:5]:
        payload = resource.get("payload") or []
        summary = "No summary available"
        if payload and isinstance(payload[0], dict):
            summary = str(
                payload[0].get("contentString")
                or (payload[0].get("contentReference") or {}).get("display")
                or summary
            )

        correspondence.append(
            Correspondence(
                type=_coding_text(resource, "category"),
                date=_resource_date(resource, "sent"),
                summary=summary,
            )
        )

    inbox_items: list[InboxItem] = []
    for item in snapshot.get("mock_inbox", [])[:10]:
        inbox_items.append(
            InboxItem(
                channel=str(item.get("channel", "unknown")),
                title=str(item.get("title", "Untitled inbox item")),
                date=str(item.get("date", "unknown")),
                summary=str(item.get("summary", "No summary available")),
                priority=str(item.get("priority", "routine")),
                requires_action=bool(item.get("requires_action", False)),
            )
        )

    missing_data_flags: list[str] = []
    if not conditions:
        missing_data_flags.append("No active conditions found in the patient record.")
    if not labs:
        missing_data_flags.append("No recent observations or lab results found.")
    if not medications:
        missing_data_flags.append("No active medications found.")
    if not correspondence:
        missing_data_flags.append("No recent correspondence found.")
    if not inbox_items:
        missing_data_flags.append("No mocked inbox items found for pre-appointment triage.")
    elif not any(item.requires_action for item in inbox_items):
        missing_data_flags.append("Inbox contains no items currently marked as requiring follow-up.")

    lipid_result = next(
        (
            lab
            for lab in labs
            if "lipid" in lab.test.lower() or "cholesterol" in lab.test.lower()
        ),
        None,
    )
    if lipid_result is None:
        missing_data_flags.append("No lipid panel found in the available FHIR resources.")
    elif _is_older_than(lipid_result.date, 365):
        missing_data_flags.append(f"Lipid panel is older than 12 months (last on {lipid_result.date}).")

    return BriefContent(
        chronic_conditions=conditions,
        recent_labs=labs,
        active_medications=medications,
        recent_correspondence=correspondence,
        inbox_items=inbox_items,
        missing_data_flags=missing_data_flags,
    )


async def build_fhir_snapshot(mrn: str, fhir_id: str) -> dict[str, Any]:
    try:
        patient, conditions, observations, medications, communications = await asyncio.gather(
            get_patient(mrn),
            get_conditions(fhir_id),
            get_observations(fhir_id, count=10),
            get_medications(fhir_id),
            get_communications(fhir_id, count=5),
        )
    except FHIRError:
        raise
    except Exception as exc:
        raise FHIRError(str(exc)) from exc

    return {
        "patient": patient,
        "conditions": conditions,
        "observations": observations,
        "medications": medications,
        "communications": communications,
        "mock_inbox": _load_mock_inbox(mrn),
    }


async def generate_context_brief_from_snapshot(snapshot: dict[str, Any]) -> BriefContent:
    fallback_brief = _build_fallback_brief(snapshot)

    try:
        return await generate(
            prompt=json.dumps(snapshot, indent=2),
            system=CONTEXT_BRIEF_SYSTEM_PROMPT,
            response_model=BriefContent,
            max_tokens=1200,
        )
    except LLMError as exc:
        logger.warning("Granite context brief generation failed, using fallback summarizer: %s", exc)
        return fallback_brief
    except Exception as exc:
        logger.warning("Context brief generation unavailable, using fallback summarizer: %s", exc)
        return fallback_brief


async def build_context_brief(mrn: str, fhir_id: str) -> tuple[BriefContent, dict[str, Any]]:
    snapshot = await build_fhir_snapshot(mrn=mrn, fhir_id=fhir_id)
    brief = await generate_context_brief_from_snapshot(snapshot)
    return brief, snapshot
