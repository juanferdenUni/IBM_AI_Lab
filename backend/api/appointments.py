import asyncio
import json
import os
import shutil
import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from middleware.auth import auth_dependency
from models.soap_note import SOAPContent, BillingCode
from services.scribe import transcribe_chunks, WhisperError
from services.soap_generator import update_soap
from services.supabase_client import get_client
from services.audit import log_action
from models.enums import AuditAction

logger = logging.getLogger(__name__)
router = APIRouter()

# ── In-memory session state ────────────────────────────────────────────────


@dataclass
class _Session:
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    transcript_parts: list[str] = field(default_factory=list)
    current_soap: SOAPContent = field(default_factory=lambda: SOAPContent(
        subjective="", objective="", assessment="", plan=""
    ))
    billing_codes: list[BillingCode] = field(default_factory=list)
    appointment_id: str = ""
    patient_id: str = ""
    actor_id: str = ""


_sessions: dict[str, _Session] = {}  # keyed by appointment_id


# ── Background transcription task ─────────────────────────────────────────

async def _run_transcription(session: _Session, audio_path: str) -> None:
    chunk_count = 0
    total_chunks = 0

    try:
        async for chunk in transcribe_chunks(audio_path):
            total_chunks += 1
            session.transcript_parts.append(chunk["text"])

            await session.queue.put(("transcript_chunk", chunk))

            chunk_count += 1
            if chunk_count % 5 == 0:
                try:
                    full_transcript = " ".join(session.transcript_parts)
                    updated_soap, new_codes = await update_soap(
                        current_soap=session.current_soap,
                        new_segment=str(chunk["text"]),
                        full_transcript=full_transcript,
                    )
                    session.current_soap = updated_soap
                    # Deduplicate billing codes by code string
                    existing = {c.code for c in session.billing_codes}
                    for code in new_codes:
                        if code.code not in existing:
                            session.billing_codes.append(code)
                            existing.add(code.code)

                    await session.queue.put(("soap_update", {
                        "subjective": updated_soap.subjective,
                        "objective": updated_soap.objective,
                        "assessment": updated_soap.assessment,
                        "plan": updated_soap.plan,
                    }))
                except Exception:
                    await session.queue.put(("error", {"message": "SOAP update failed; continuing transcription"}))

        # Final SOAP update after all chunks
        if session.transcript_parts:
            try:
                full_transcript = " ".join(session.transcript_parts)
                updated_soap, new_codes = await update_soap(
                    current_soap=session.current_soap,
                    new_segment=full_transcript,
                    full_transcript=full_transcript,
                )
                session.current_soap = updated_soap
            except Exception:
                pass

        await session.queue.put(("done", {
            "total_chunks": total_chunks,
            "appointment_id": session.appointment_id,
        }))

    except WhisperError as e:
        await session.queue.put(("error", {"message": str(e)}))
        await session.queue.put(("done", {"total_chunks": total_chunks, "appointment_id": session.appointment_id}))


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.post("/patients/{patient_id}/appointments")
async def create_appointment(
    patient_id: str,
    body: dict,
    user: dict = Depends(auth_dependency),
):
    """Create a new appointment for a patient (used by frontend when Orchestrate is not running)."""
    db = get_client()

    # Validate patient_id is a valid UUID
    try:
        UUID(patient_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid patient_id format: {patient_id}")

    patient = db.table("patients").select("id, physician_id").eq("id", patient_id).execute()
    if not patient.data:
        raise HTTPException(status_code=404, detail="Patient not found")

    physician_id = body.get("physician_id") or patient.data[0]["physician_id"]
    scheduled_at = body.get("scheduled_at") or datetime.now(timezone.utc).isoformat()

    row = {
        "patient_id": patient_id,
        "physician_id": physician_id,
        "scheduled_at": scheduled_at,
        "phase": "pre_appointment",
    }
    result = db.table("appointments").insert(row).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create appointment")

    appointment = result.data[0]
    logger.info(f"Created appointment: {appointment}")
    logger.info(f"Appointment id type: {type(appointment.get('id'))}, value: {appointment.get('id')}")

    return appointment


@router.post("/patients/{patient_id}/appointment/upload-audio")
async def upload_audio(
    patient_id: str,
    appointment_id: str = Query(...),
    file: UploadFile = File(...),
    user: dict = Depends(auth_dependency),
):
    recordings_dir = Path(__file__).parent.parent / "data" / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    save_path = recordings_dir / f"{appointment_id}{suffix}"
    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"audio_file_path": str(save_path.resolve())}


@router.post("/patients/{patient_id}/appointment/start")
async def start_appointment(
    patient_id: str,
    body: dict,
    user: dict = Depends(auth_dependency),
):
    appointment_id = body.get("appointment_id")
    audio_file_path = body.get("audio_file_path")

    if not appointment_id or not audio_file_path:
        raise HTTPException(status_code=422, detail="appointment_id and audio_file_path are required")

    if not os.path.exists(audio_file_path):
        raise HTTPException(status_code=400, detail=f"audio_file_path does not exist on server: {audio_file_path}")

    if appointment_id in _sessions:
        raise HTTPException(status_code=409, detail="Transcription already in progress for this appointment")

    db = get_client()

    patient = db.table("patients").select("id").eq("id", patient_id).execute()
    if not patient.data:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")

    appt = db.table("appointments").select("id").eq("id", appointment_id).eq("patient_id", patient_id).execute()
    if not appt.data:
        raise HTTPException(status_code=404, detail=f"Appointment {appointment_id} not found")

    db.table("appointments").update({"audio_file_path": audio_file_path}).eq("id", appointment_id).execute()

    session = _Session(appointment_id=appointment_id, patient_id=patient_id, actor_id=user["id"])
    _sessions[appointment_id] = session

    asyncio.create_task(_run_transcription(session, audio_file_path))

    await log_action(
        actor_id=UUID(user["id"]),
        action=AuditAction.APPOINTMENT_STARTED,
        resource_type="appointment",
        resource_id=UUID(appointment_id),
        appointment_id=UUID(appointment_id),
    )

    return {
        "appointment_id": appointment_id,
        "stream_url": f"/api/patients/{patient_id}/appointment/stream",
        "status": "transcription_started",
    }


@router.get("/patients/{patient_id}/appointment/stream")
async def stream_appointment(
    patient_id: str,
    appointment_id: str = Query(...),
    token: str = Query(default=""),
):
    if appointment_id not in _sessions:
        raise HTTPException(status_code=404, detail="No active transcription for this patient")

    session = _sessions[appointment_id]

    async def event_generator():
        while True:
            try:
                # Yield a ping every 15s to prevent proxy timeouts
                event_type, data = await asyncio.wait_for(session.queue.get(), timeout=15.0)
                yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
                if event_type == "done":
                    break
            except asyncio.TimeoutError:
                yield ": ping\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/patients/{patient_id}/appointment/end")
async def end_appointment(
    patient_id: str,
    body: dict,
    user: dict = Depends(auth_dependency),
):
    appointment_id = body.get("appointment_id")
    if not appointment_id:
        raise HTTPException(status_code=422, detail="appointment_id is required")

    session = _sessions.get(appointment_id)
    if not session:
        raise HTTPException(status_code=404, detail="No active appointment found")

    db = get_client()

    existing = db.table("soap_notes").select("id").eq("appointment_id", appointment_id).is_("superseded_by", "null").execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="SOAP note already finalised for this appointment")

    full_transcript = " ".join(session.transcript_parts)
    soap = session.current_soap
    billing_codes = [c.model_dump() for c in session.billing_codes]

    result = db.table("soap_notes").insert({
        "appointment_id": appointment_id,
        "patient_id": patient_id,
        "transcript_text": full_transcript,
        "soap_json": soap.model_dump(),
        "billing_codes": billing_codes,
        "approved": False,
        "version": 1,
        "created_by": user["id"],
    }).execute()

    del _sessions[appointment_id]

    await log_action(
        actor_id=UUID(user["id"]),
        action=AuditAction.APPOINTMENT_ENDED,
        resource_type="soap_note",
        resource_id=UUID(result.data[0]["id"]),
        appointment_id=UUID(appointment_id),
    )

    return result.data[0]


@router.get("/patients/{patient_id}/soap-note")
async def get_soap_note(
    patient_id: str,
    user: dict = Depends(auth_dependency),
):
    db = get_client()
    result = (
        db.table("soap_notes")
        .select("*")
        .eq("patient_id", patient_id)
        .is_("superseded_by", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail=f"No SOAP note found for patient {patient_id}")

    return result.data[0]