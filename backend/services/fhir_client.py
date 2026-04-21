import logging
import json
from pathlib import Path
from typing import Any
from backend.config import settings

logger = logging.getLogger(__name__)

FALLBACK_DIR = Path(__file__).parent.parent / "data" / "fhir_fallback"

FALLBACK_FILES = {
    "patient": "patient_WARRIOR-001.json",
    "conditions": "conditions_WARRIOR-001.json",
    "observations": "observations_WARRIOR-001.json",
    "medications": "medications_WARRIOR-001.json",
    "communications": "communications_WARRIOR-001.json",
}


def _load_fallback(key: str) -> dict[str, Any]:
    filepath = FALLBACK_DIR / FALLBACK_FILES[key]
    if not filepath.exists():
        raise FHIRError(f"Fallback file not found: {filepath}")
    with open(filepath) as f:
        return json.load(f)


async def _fhir_get(path: str) -> dict[str, Any]:
    import httpx
    url = f"{settings.fhir_base_url}{path}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers={"Accept": "application/fhir+json"})
    if resp.status_code != 200:
        raise FHIRError(f"FHIR GET {url} returned {resp.status_code}")
    return resp.json()


async def _fhir_post(path: str, data: dict[str, Any]) -> dict[str, Any]:
    import httpx
    url = f"{settings.fhir_base_url}{path}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=data, headers={
            "Content-Type": "application/fhir+json",
            "Accept": "application/fhir+json",
        })
    if resp.status_code not in (200, 201):
        raise FHIRError(f"FHIR POST {url} returned {resp.status_code}: {resp.text}")
    return resp.json()


async def get_patient(mrn: str) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        return _load_fallback("patient")
    return await _fhir_get(f"/Patient?identifier={mrn}")


async def get_conditions(fhir_patient_id: str) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        return _load_fallback("conditions")
    return await _fhir_get(f"/Condition?patient={fhir_patient_id}&clinical-status=active")


async def get_observations(fhir_patient_id: str, count: int = 10) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        return _load_fallback("observations")
    return await _fhir_get(f"/Observation?patient={fhir_patient_id}&_sort=-date&_count={count}")


async def get_medications(fhir_patient_id: str) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        return _load_fallback("medications")
    return await _fhir_get(f"/MedicationRequest?patient={fhir_patient_id}&status=active")


async def get_communications(fhir_patient_id: str, count: int = 5) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        return _load_fallback("communications")
    return await _fhir_get(f"/Communication?recipient={fhir_patient_id}&_sort=-sent&_count={count}")


async def write_composition(data: dict[str, Any]) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        logger.warning("Fallback mode: Composition write skipped")
        return {"id": "fallback-composition-id", "resourceType": "Composition"}
    return await _fhir_post("/Composition", data)


async def write_document_reference(data: dict[str, Any]) -> dict[str, Any]:
    if settings.use_fhir_fallback:
        logger.warning("Fallback mode: DocumentReference write skipped")
        return {"id": "fallback-docref-id", "resourceType": "DocumentReference"}
    return await _fhir_post("/DocumentReference", data)


class FHIRError(Exception):
    pass