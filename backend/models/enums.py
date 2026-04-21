from enum import Enum


class WorkflowState(str, Enum):
    PENDING = "pending"
    BRIEF_READY = "brief_ready"
    IN_APPOINTMENT = "in_appointment"
    APPOINTMENT_COMPLETE = "appointment_complete"
    FORM_READY = "form_ready"
    COMPLETED = "completed"


class AppointmentPhase(str, Enum):
    PRE_APPOINTMENT = "pre_appointment"
    DURING_APPOINTMENT = "during_appointment"
    POST_APPOINTMENT = "post_appointment"
    COMPLETED = "completed"


class FormType(str, Enum):
    T2201 = "T2201"


class AuditAction(str, Enum):
    CONTEXT_BRIEF_GENERATED = "context_brief_generated"
    CONTEXT_BRIEF_APPROVED = "context_brief_approved"
    APPOINTMENT_STARTED = "appointment_started"
    APPOINTMENT_ENDED = "appointment_ended"
    SOAP_NOTE_APPROVED = "soap_note_approved"
    FORM_DRAFT_GENERATED = "form_draft_generated"
    FORM_DRAFT_APPROVED = "form_draft_approved"
    FHIR_WRITE_SUCCESS = "fhir_write_success"
    FHIR_WRITE_FAILED = "fhir_write_failed"
    PHASE_ADVANCED = "phase_advanced"


class SSEEventType(str, Enum):
    TRANSCRIPT_CHUNK = "transcript_chunk"
    SOAP_UPDATE = "soap_update"
    BILLING_CODE_DETECTED = "billing_code_detected"
    LAB_REQ_QUEUED = "lab_requisition_queued"
    ERROR = "error"
    DONE = "done"