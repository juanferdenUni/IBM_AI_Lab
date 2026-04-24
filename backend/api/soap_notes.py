from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from middleware.auth import auth_dependency
from models.soap_note import SOAPNoteUpdate
from services.supabase_client import get_client
from services.audit import log_action
from models.enums import AuditAction

router = APIRouter()


@router.patch("/soap-notes/{soap_note_id}")
async def update_soap_note(
    soap_note_id: str,
    body: SOAPNoteUpdate,
    user: dict = Depends(auth_dependency),
):
    db = get_client()

    existing = db.table("soap_notes").select("*").eq("id", soap_note_id).is_("superseded_by", "null").maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="SOAP note not found")

    if existing.data["approved"]:
        raise HTTPException(status_code=409, detail="Note is already approved; create a new version via appointment/start")

    updates: dict = {}
    current_soap = existing.data["soap_json"]

    if body.subjective is not None:
        current_soap["subjective"] = body.subjective
    if body.objective is not None:
        current_soap["objective"] = body.objective
    if body.assessment is not None:
        current_soap["assessment"] = body.assessment
    if body.plan is not None:
        current_soap["plan"] = body.plan

    updates["soap_json"] = current_soap

    if body.billing_codes is not None:
        updates["billing_codes"] = [c.model_dump() for c in body.billing_codes]

    result = db.table("soap_notes").update(updates).eq("id", soap_note_id).execute()
    return result.data[0]


@router.post("/soap-notes/{soap_note_id}/approve")
async def approve_soap_note(
    soap_note_id: str,
    user: dict = Depends(auth_dependency),
):
    db = get_client()

    existing = db.table("soap_notes").select("*").eq("id", soap_note_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="SOAP note not found")

    if existing.data["approved"]:
        raise HTTPException(status_code=409, detail="Already approved")

    approved_at = datetime.now(timezone.utc).isoformat()
    result = db.table("soap_notes").update({
        "approved": True,
        "approved_at": approved_at,
    }).eq("id", soap_note_id).execute()

    await log_action(
        actor_id=UUID(user["id"]),
        action=AuditAction.SOAP_NOTE_APPROVED,
        resource_type="soap_note",
        resource_id=UUID(soap_note_id),
        appointment_id=UUID(existing.data["appointment_id"]),
    )

    return {
        "id": soap_note_id,
        "approved": True,
        "approved_at": approved_at,
    }
