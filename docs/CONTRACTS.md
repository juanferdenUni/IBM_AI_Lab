# API & Data Contracts

**Team:** Warriors — IBM SkillsBuild AI Experiential Learning Lab  
**Purpose:** Canonical interface specification. Every engineer codes against this document. When this document and the code disagree, fix the code.  
**Last updated:** 2026-04-19

---

## Table of Contents

1. [Conventions](#1-conventions)
2. [Database Schema (DDL)](#2-database-schema-ddl)
3. [Pydantic Models](#3-pydantic-models)
4. [REST API Endpoints](#4-rest-api-endpoints)
5. [SSE Event Schemas](#5-sse-event-schemas)
6. [Shared Services & Module Specs](#6-shared-services)
7. [Environment Variables](#7-environment-variables)
8. [Orchestrate ↔ Backend Contract](#8-orchestrate--backend-contract)
9. [Repo Structure](#9-repo-structure)

---

## 1. Conventions

### IDs
All IDs are UUID v4. Python type: `uuid.UUID`. Postgres type: `uuid`. JSON wire format: lowercase hyphenated string — `"3fa85f64-5717-4562-b3fc-2c963f66afa6"`.

### Timestamps
ISO 8601 UTC with millisecond precision: `"2026-04-19T14:32:00.000Z"`. Python: `datetime` with `timezone.utc`. Pydantic serialises via `model_config = {"json_encoders": {datetime: lambda v: v.isoformat()}}`.

### Error shape
All errors use FastAPI's default structure. Do not wrap or alter it.

```json
{"detail": "Human-readable description of the error"}
```

Validation errors (422) use FastAPI's standard `detail` array.

### Auth headers

| Route group | Header | Value |
|---|---|---|
| All `/api/*` user-facing routes | `Authorization` | `Bearer <supabase_jwt>` |
| All `/api/orchestrate/*` routes | `X-Orchestrate-Secret` | Value of `ORCHESTRATE_SHARED_SECRET` env var |

When `AUTH_ENABLED=false`, the JWT middleware is skipped and a stub user is injected:

```json
{"id": "00000000-0000-0000-0000-000000000000", "email": "demo@warriors.dev"}
```

The SSE endpoint cannot set custom headers from the browser `EventSource` API. Pass the JWT as a query parameter: `?token=<jwt>`.

### Pagination
No pagination in MVP. List endpoints return full arrays. The audit log endpoint accepts `?limit=N` (default 100).

### CORS
Backend allows `FRONTEND_URL` as a CORS origin for all `/api/*` routes. `/health` has no CORS restriction.

### Base path
All application routes: `/api/*`. Keep-alive route: `/health` (no prefix).

---

## 2. Database Schema (DDL)

Run these statements in order as a single Supabase migration. The `auth.users` table is managed by Supabase Auth and is referenced but not created here.

```sql
-- ─────────────────────────────────────────────────────────────────
-- Prerequisites
-- ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────

CREATE TYPE workflow_state AS ENUM (
    'pending',
    'brief_ready',
    'in_appointment',
    'appointment_complete',
    'form_ready',
    'completed'
);

CREATE TYPE appointment_phase AS ENUM (
    'pre_appointment',
    'during_appointment',
    'post_appointment',
    'completed'
);

CREATE TYPE form_type AS ENUM (
    'T2201'
);

CREATE TYPE audit_action AS ENUM (
    'context_brief_generated',
    'context_brief_approved',
    'appointment_started',
    'appointment_ended',
    'soap_note_approved',
    'form_draft_generated',
    'form_draft_approved',
    'fhir_write_success',
    'fhir_write_failed',
    'phase_advanced'
);

-- ─────────────────────────────────────────────────────────────────
-- Shared trigger: auto-update updated_at
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- PATIENTS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE patients (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    fhir_id         TEXT            NOT NULL UNIQUE,
    mrn             TEXT            NOT NULL UNIQUE,
    display_name    TEXT            NOT NULL,
    date_of_birth   DATE            NOT NULL,
    physician_id    UUID            NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    workflow_state  workflow_state  NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_patients_physician_id ON patients(physician_id);
CREATE INDEX idx_patients_workflow_state ON patients(workflow_state);

CREATE TRIGGER patients_set_updated_at
    BEFORE UPDATE ON patients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- APPOINTMENTS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE appointments (
    id                      UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id              UUID                NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    physician_id            UUID                NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    scheduled_at            TIMESTAMPTZ         NOT NULL,
    phase                   appointment_phase   NOT NULL DEFAULT 'pre_appointment',
    orchestrate_instance_id TEXT,
    audio_file_path         TEXT,
    created_at              TIMESTAMPTZ         NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ         NOT NULL DEFAULT now()
);

CREATE INDEX idx_appointments_patient_id    ON appointments(patient_id);
CREATE INDEX idx_appointments_physician_id  ON appointments(physician_id);
CREATE INDEX idx_appointments_scheduled_at  ON appointments(scheduled_at);

CREATE TRIGGER appointments_set_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- CONTEXT BRIEFS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE context_briefs (
    id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id          UUID        NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    patient_id              UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    brief_json              JSONB       NOT NULL,
    fhir_resources_snapshot JSONB,
    version                 INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
    superseded_by           UUID        REFERENCES context_briefs(id) ON DELETE SET NULL,
    approved                BOOLEAN     NOT NULL DEFAULT FALSE,
    approved_at             TIMESTAMPTZ,
    created_by              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT context_briefs_approved_at_consistency
        CHECK (approved = FALSE OR approved_at IS NOT NULL)
);

CREATE INDEX idx_context_briefs_appointment_id ON context_briefs(appointment_id);
CREATE INDEX idx_context_briefs_patient_id     ON context_briefs(patient_id);

-- Fast lookup for "current version" — the one with no successor
CREATE UNIQUE INDEX idx_context_briefs_current
    ON context_briefs(appointment_id)
    WHERE superseded_by IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- SOAP NOTES
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE soap_notes (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id  UUID        NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    patient_id      UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    transcript_text TEXT        NOT NULL,
    soap_json       JSONB       NOT NULL,
    billing_codes   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    approved        BOOLEAN     NOT NULL DEFAULT FALSE,
    approved_at     TIMESTAMPTZ,
    version         INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
    superseded_by   UUID        REFERENCES soap_notes(id) ON DELETE SET NULL,
    created_by      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT soap_notes_approved_at_consistency
        CHECK (approved = FALSE OR approved_at IS NOT NULL)
);

CREATE INDEX idx_soap_notes_appointment_id ON soap_notes(appointment_id);
CREATE INDEX idx_soap_notes_patient_id     ON soap_notes(patient_id);

CREATE UNIQUE INDEX idx_soap_notes_current
    ON soap_notes(appointment_id)
    WHERE superseded_by IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- FORM DRAFTS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE form_drafts (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id      UUID        NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    patient_id          UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    soap_note_id        UUID        NOT NULL REFERENCES soap_notes(id) ON DELETE RESTRICT,
    form_type           form_type   NOT NULL DEFAULT 'T2201',
    form_json           JSONB       NOT NULL,
    approved            BOOLEAN     NOT NULL DEFAULT FALSE,
    approved_at         TIMESTAMPTZ,
    fhir_composition_id TEXT,
    fhir_doc_ref_id     TEXT,
    version             INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
    superseded_by       UUID        REFERENCES form_drafts(id) ON DELETE SET NULL,
    created_by          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT form_drafts_approved_at_consistency
        CHECK (approved = FALSE OR approved_at IS NOT NULL),
    CONSTRAINT form_drafts_fhir_ids_on_approval
        CHECK (approved = FALSE OR (fhir_composition_id IS NOT NULL AND fhir_doc_ref_id IS NOT NULL))
);

CREATE INDEX idx_form_drafts_appointment_id ON form_drafts(appointment_id);
CREATE INDEX idx_form_drafts_patient_id     ON form_drafts(patient_id);
CREATE INDEX idx_form_drafts_soap_note_id   ON form_drafts(soap_note_id);

CREATE UNIQUE INDEX idx_form_drafts_current
    ON form_drafts(appointment_id)
    WHERE superseded_by IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- AUDIT LOG  (append-only — no UPDATE or DELETE permitted)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    event           audit_action    NOT NULL,
    actor_id        UUID            NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    resource_type   TEXT            NOT NULL
                        CHECK (resource_type IN ('context_brief','soap_note','form_draft','appointment','patient')),
    resource_id     UUID            NOT NULL,
    appointment_id  UUID            REFERENCES appointments(id) ON DELETE SET NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_appointment_id ON audit_log(appointment_id);
CREATE INDEX idx_audit_log_actor_id       ON audit_log(actor_id);
CREATE INDEX idx_audit_log_resource_id    ON audit_log(resource_id);
CREATE INDEX idx_audit_log_created_at     ON audit_log(created_at DESC);

-- Enforce immutability at the database level
CREATE OR REPLACE FUNCTION audit_log_deny_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log rows are immutable — no UPDATE or DELETE allowed';
END;
$$;

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();

CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();
```

### Versioning policy

When a physician regenerates a brief, SOAP note, or form draft:

1. Backend inserts a new row with `version = (SELECT MAX(version) FROM <table> WHERE appointment_id = $1) + 1`.
2. Backend sets `superseded_by = <new_row_id>` on the previous current row.
3. Queries for the current version use `WHERE superseded_by IS NULL`, which is covered by the partial unique index.
4. Approving a version does not prevent regeneration. Regenerating after approval creates version N+1 with `approved = FALSE` and requires re-approval.

---

## 3. Pydantic Models

All models live in `backend/models/`. Pydantic v2 is required.

### 3.1 Enums

**`WorkflowState`** — stored on `patients.workflow_state`

| Value | Meaning |
|---|---|
| `pending` | Patient loaded; no brief generated yet |
| `brief_ready` | Context brief generated and available for review |
| `in_appointment` | Whisper transcription in progress |
| `appointment_complete` | SOAP note finalized; awaiting physician approval |
| `form_ready` | T2201 draft generated; awaiting physician approval |
| `completed` | Form approved and written to FHIR |

**`AppointmentPhase`** — stored on `appointments.phase`

| Value | Meaning |
|---|---|
| `pre_appointment` | Brief generation phase |
| `during_appointment` | Transcription + SOAP drafting phase |
| `post_appointment` | Form generation phase |
| `completed` | FHIR write-back done |

**`FormType`** — stored on `form_drafts.form_type`

| Value | Meaning |
|---|---|
| `T2201` | CRA Disability Tax Credit Certificate |

**`AuditAction`** — stored on `audit_log.event`

| Value | Triggered when |
|---|---|
| `context_brief_generated` | Granite returns a brief and it is persisted |
| `context_brief_approved` | Physician clicks Approve on context brief |
| `appointment_started` | Whisper background task begins |
| `appointment_ended` | Transcription complete; SOAP persisted |
| `soap_note_approved` | Physician approves SOAP note |
| `form_draft_generated` | Granite returns T2201 mapping and it is persisted |
| `form_draft_approved` | Physician approves form |
| `fhir_write_success` | Both FHIR resources created successfully |
| `fhir_write_failed` | FHIR POST returned non-2xx |
| `phase_advanced` | Orchestrate triggers a phase transition |

**`SSEEventType`** — emitted on the `/appointment/stream` endpoint

| Value | Emitted when |
|---|---|
| `transcript_chunk` | Whisper completes one audio segment |
| `soap_update` | Granite returns an updated SOAP note |
| `billing_code_detected` | Granite identifies an OHIP billing code |
| `lab_requisition_queued` | Granite detects a lab order in the Plan section |
| `error` | Whisper or Granite fails mid-stream |
| `done` | Audio file fully processed; stream closing |

```python
# backend/models/enums.py
from enum import Enum

class WorkflowState(str, Enum):
    PENDING              = "pending"
    BRIEF_READY          = "brief_ready"
    IN_APPOINTMENT       = "in_appointment"
    APPOINTMENT_COMPLETE = "appointment_complete"
    FORM_READY           = "form_ready"
    COMPLETED            = "completed"

class AppointmentPhase(str, Enum):
    PRE_APPOINTMENT    = "pre_appointment"
    DURING_APPOINTMENT = "during_appointment"
    POST_APPOINTMENT   = "post_appointment"
    COMPLETED          = "completed"

class FormType(str, Enum):
    T2201 = "T2201"

class AuditAction(str, Enum):
    CONTEXT_BRIEF_GENERATED  = "context_brief_generated"
    CONTEXT_BRIEF_APPROVED   = "context_brief_approved"
    APPOINTMENT_STARTED      = "appointment_started"
    APPOINTMENT_ENDED        = "appointment_ended"
    SOAP_NOTE_APPROVED       = "soap_note_approved"
    FORM_DRAFT_GENERATED     = "form_draft_generated"
    FORM_DRAFT_APPROVED      = "form_draft_approved"
    FHIR_WRITE_SUCCESS       = "fhir_write_success"
    FHIR_WRITE_FAILED        = "fhir_write_failed"
    PHASE_ADVANCED           = "phase_advanced"

class SSEEventType(str, Enum):
    TRANSCRIPT_CHUNK      = "transcript_chunk"
    SOAP_UPDATE           = "soap_update"
    BILLING_CODE_DETECTED = "billing_code_detected"
    LAB_REQ_QUEUED        = "lab_requisition_queued"
    ERROR                 = "error"
    DONE                  = "done"
```

---

### 3.2 Patient

**`PatientCreate` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `fhir_id` | `str` | yes | FHIR `Patient.id` on the HAPI server |
| `mrn` | `str` | yes | Medical record number; used as FHIR identifier |
| `display_name` | `str` | yes | Short display name shown in the UI, e.g. `"Sarah M."` |
| `date_of_birth` | `date` | yes | ISO date `YYYY-MM-DD`; used for age calculation and T2201 |
| `physician_id` | `UUID` | yes | FK to `auth.users.id` of the treating physician |

**`PatientUpdate` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `display_name` | `str \| None` | no | Overwrite display name |
| `workflow_state` | `WorkflowState \| None` | no | Advance or correct workflow state |

**`Patient` response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `fhir_id` | `str` | FHIR Patient ID |
| `mrn` | `str` | Medical record number |
| `display_name` | `str` | UI label |
| `date_of_birth` | `date` | ISO date |
| `physician_id` | `UUID` | Treating physician |
| `workflow_state` | `WorkflowState` | Current phase in the workflow |
| `created_at` | `datetime` | UTC |
| `updated_at` | `datetime` | UTC; updated on every state change |

```python
# backend/models/patient.py
from uuid import UUID
from datetime import date, datetime
from pydantic import BaseModel
from .enums import WorkflowState

class PatientCreate(BaseModel):
    fhir_id:       str
    mrn:           str
    display_name:  str
    date_of_birth: date
    physician_id:  UUID

class PatientUpdate(BaseModel):
    display_name:   str | None = None
    workflow_state: WorkflowState | None = None

class Patient(BaseModel):
    id:             UUID
    fhir_id:        str
    mrn:            str
    display_name:   str
    date_of_birth:  date
    physician_id:   UUID
    workflow_state: WorkflowState
    created_at:     datetime
    updated_at:     datetime

    model_config = {"from_attributes": True}
```

---

### 3.3 Appointment

**`AppointmentCreate` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `patient_id` | `UUID` | yes | FK to `patients.id` |
| `physician_id` | `UUID` | yes | FK to `auth.users.id` |
| `scheduled_at` | `datetime` | yes | UTC datetime of the appointment slot |
| `audio_file_path` | `str \| None` | no | Server-local path to the pre-recorded audio file; set when known |

**`Appointment` response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `patient_id` | `UUID` | FK |
| `physician_id` | `UUID` | FK |
| `scheduled_at` | `datetime` | UTC |
| `phase` | `AppointmentPhase` | Current phase |
| `orchestrate_instance_id` | `str \| None` | Orchestrate workflow instance tracking ID |
| `audio_file_path` | `str \| None` | Set before `during_appointment` starts |
| `created_at` | `datetime` | UTC |
| `updated_at` | `datetime` | UTC |

```python
# backend/models/appointment.py
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel
from .enums import AppointmentPhase

class AppointmentCreate(BaseModel):
    patient_id:      UUID
    physician_id:    UUID
    scheduled_at:    datetime
    audio_file_path: str | None = None

class Appointment(BaseModel):
    id:                       UUID
    patient_id:               UUID
    physician_id:             UUID
    scheduled_at:             datetime
    phase:                    AppointmentPhase
    orchestrate_instance_id:  str | None
    audio_file_path:          str | None
    created_at:               datetime
    updated_at:               datetime

    model_config = {"from_attributes": True}
```

---

### 3.4 Context Brief

**`BriefContent` fields** (the shape of `context_briefs.brief_json`):

| Field | Type | Description |
|---|---|---|
| `chronic_conditions` | `list[str]` | Free-text condition strings with ICD code and onset year |
| `recent_labs` | `list[LabResult]` | Most recent lab results; up to 10 |
| `active_medications` | `list[str]` | Active medication strings from FHIR MedicationRequest |
| `recent_correspondence` | `list[Correspondence]` | Faxes and referral letters; up to 5 |
| `missing_data_flags` | `list[str]` | Explicit descriptions of absent expected data |

**`LabResult` fields:**

| Field | Type | Description |
|---|---|---|
| `test` | `str` | Lab test name, e.g. `"HbA1c"` |
| `value` | `str` | Result with units, e.g. `"8.2%"` |
| `date` | `str` | ISO date of the result |
| `flag` | `str \| None` | One of `"above_target"`, `"below_target"`, `"borderline"`, or `None` |

**`ContextBrief` response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `appointment_id` | `UUID` | FK |
| `patient_id` | `UUID` | FK |
| `brief_json` | `BriefContent` | Structured brief from Granite |
| `fhir_resources_snapshot` | `dict \| None` | Raw FHIR bundle used to generate the brief |
| `version` | `int` | Starts at 1; increments on regeneration |
| `superseded_by` | `UUID \| None` | Points to the newer version; `null` = this is current |
| `approved` | `bool` | `true` after physician clicks Approve |
| `approved_at` | `datetime \| None` | UTC timestamp of approval |
| `created_by` | `UUID` | Physician user ID |
| `created_at` | `datetime` | UTC |

```python
# backend/models/context_brief.py
from uuid import UUID
from datetime import datetime
from typing import Any
from pydantic import BaseModel

class LabResult(BaseModel):
    test:  str
    value: str
    date:  str
    flag:  str | None = None

class Correspondence(BaseModel):
    type:    str
    date:    str
    summary: str

class BriefContent(BaseModel):
    chronic_conditions:    list[str]
    recent_labs:           list[LabResult]
    active_medications:    list[str]
    recent_correspondence: list[Correspondence]
    missing_data_flags:    list[str]

class ContextBriefCreate(BaseModel):
    appointment_id: UUID
    patient_id:     UUID

class ContextBrief(BaseModel):
    id:                      UUID
    appointment_id:          UUID
    patient_id:              UUID
    brief_json:              BriefContent
    fhir_resources_snapshot: dict[str, Any] | None
    version:                 int
    superseded_by:           UUID | None
    approved:                bool
    approved_at:             datetime | None
    created_by:              UUID
    created_at:              datetime

    model_config = {"from_attributes": True}
```

---

### 3.5 SOAP Note

**`SOAPContent` fields:**

| Field | Type | Description |
|---|---|---|
| `subjective` | `str` | Patient-reported symptoms and history |
| `objective` | `str` | Clinician observations and vitals |
| `assessment` | `str` | Diagnosis and clinical impression |
| `plan` | `str` | Treatment plan, referrals, follow-up |

**`BillingCode` fields:**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `code` | `str` | | OHIP billing code, e.g. `"A001"` |
| `description` | `str` | | Human-readable description |
| `confidence` | `float` | `0.0 ≤ x ≤ 1.0` | Granite confidence for this extraction |

**`SOAPNoteUpdate` fields** (all optional; only supplied fields are overwritten):

| Field | Type | Description |
|---|---|---|
| `subjective` | `str \| None` | Replace subjective section |
| `objective` | `str \| None` | Replace objective section |
| `assessment` | `str \| None` | Replace assessment section |
| `plan` | `str \| None` | Replace plan section |
| `billing_codes` | `list[BillingCode] \| None` | Replace entire billing code list |

```python
# backend/models/soap_note.py
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field

class SOAPContent(BaseModel):
    subjective: str
    objective:  str
    assessment: str
    plan:       str

class BillingCode(BaseModel):
    code:        str
    description: str
    confidence:  float = Field(ge=0.0, le=1.0)

class SOAPNoteCreate(BaseModel):
    appointment_id:  UUID
    patient_id:      UUID
    transcript_text: str
    soap_json:       SOAPContent
    billing_codes:   list[BillingCode] = []

class SOAPNoteUpdate(BaseModel):
    subjective:    str | None = None
    objective:     str | None = None
    assessment:    str | None = None
    plan:          str | None = None
    billing_codes: list[BillingCode] | None = None

class SOAPNote(BaseModel):
    id:              UUID
    appointment_id:  UUID
    patient_id:      UUID
    transcript_text: str
    soap_json:       SOAPContent
    billing_codes:   list[BillingCode]
    approved:        bool
    approved_at:     datetime | None
    version:         int
    superseded_by:   UUID | None
    created_by:      UUID
    created_at:      datetime

    model_config = {"from_attributes": True}
```

---

### 3.6 Form Draft

**`FormFieldValue` fields:**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `value` | `str \| bool \| None` | | Field value; `null` means Granite could not populate it |
| `confidence` | `float` | `0.0 ≤ x ≤ 1.0` | Granite confidence; `0.0` = not populated; `1.0` = physician-confirmed |
| `source` | `str` | | Citation, e.g. `"FHIR Condition active list"` or `"physician_edit"` |

**`FormDraftUpdate` fields:**

| Field | Type | Description |
|---|---|---|
| `fields` | `dict[str, FormFieldValue]` | Keys are T2201 field names to overwrite; only supplied keys are updated |

**`FormDraft` response fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `appointment_id` | `UUID` | FK |
| `patient_id` | `UUID` | FK |
| `soap_note_id` | `UUID` | The approved SOAP note used as input |
| `form_type` | `FormType` | Always `"T2201"` in MVP |
| `form_json` | `dict[str, FormFieldValue]` | All T2201 fields keyed by field name |
| `approved` | `bool` | `true` after physician approves |
| `approved_at` | `datetime \| None` | UTC |
| `fhir_composition_id` | `str \| None` | Set after successful FHIR write |
| `fhir_doc_ref_id` | `str \| None` | Set after successful FHIR write |
| `version` | `int` | Starts at 1 |
| `superseded_by` | `UUID \| None` | `null` = current |
| `created_by` | `UUID` | Physician user ID |
| `created_at` | `datetime` | UTC |

```python
# backend/models/form_draft.py
from uuid import UUID
from datetime import datetime
from typing import Any
from pydantic import BaseModel, Field
from .enums import FormType

class FormFieldValue(BaseModel):
    value:      str | bool | None
    confidence: float = Field(ge=0.0, le=1.0)
    source:     str

class FormDraftCreate(BaseModel):
    appointment_id: UUID
    patient_id:     UUID
    soap_note_id:   UUID
    form_type:      FormType = FormType.T2201

class FormDraftUpdate(BaseModel):
    fields: dict[str, FormFieldValue]

class FormDraft(BaseModel):
    id:                  UUID
    appointment_id:      UUID
    patient_id:          UUID
    soap_note_id:        UUID
    form_type:           FormType
    form_json:           dict[str, FormFieldValue]
    approved:            bool
    approved_at:         datetime | None
    fhir_composition_id: str | None
    fhir_doc_ref_id:     str | None
    version:             int
    superseded_by:       UUID | None
    created_by:          UUID
    created_at:          datetime

    model_config = {"from_attributes": True}
```

---

### 3.7 Audit Log Entry

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `event` | `AuditAction` | What happened |
| `actor_id` | `UUID` | User who triggered the event |
| `resource_type` | `str` | One of: `context_brief`, `soap_note`, `form_draft`, `appointment`, `patient` |
| `resource_id` | `UUID` | ID of the affected resource |
| `appointment_id` | `UUID \| None` | Associated appointment; `null` for patient-level events |
| `metadata` | `dict \| None` | Arbitrary context: latencies, FHIR response codes, diffs |
| `created_at` | `datetime` | UTC; immutable |

```python
# backend/models/audit_log.py
from uuid import UUID
from datetime import datetime
from typing import Any
from pydantic import BaseModel
from .enums import AuditAction

class AuditLogEntry(BaseModel):
    id:             UUID
    event:          AuditAction
    actor_id:       UUID
    resource_type:  str
    resource_id:    UUID
    appointment_id: UUID | None
    metadata:       dict[str, Any] | None
    created_at:     datetime

    model_config = {"from_attributes": True}
```

---

### 3.8 Orchestrate Phase Advance

```python
# backend/models/orchestrate.py
from uuid import UUID
from pydantic import BaseModel, model_validator
from .enums import AppointmentPhase

class PhaseAdvanceRequest(BaseModel):
    patient_id:      UUID
    appointment_id:  UUID
    target_phase:    AppointmentPhase
    triggered_by:    str        # "physician" | "orchestrate" | "system"
    audio_file_path: str | None = None

    @model_validator(mode="after")
    def audio_required_for_during(self) -> "PhaseAdvanceRequest":
        if self.target_phase == AppointmentPhase.DURING_APPOINTMENT and not self.audio_file_path:
            raise ValueError("audio_file_path is required when target_phase is during_appointment")
        return self

class PhaseAdvanceResponse(BaseModel):
    appointment_id:  UUID
    previous_phase:  AppointmentPhase
    current_phase:   AppointmentPhase
    next_action_url: str    # relative URL the frontend should poll or subscribe to
```

---

## 4. REST API Endpoints

**Base URL:** `https://<render-url>` in production, `http://localhost:8000` locally.  
All routes prefixed `/api` unless noted.

---

### 4.1 Auth / Users

#### `GET /api/me`

Returns the currently authenticated physician derived from the JWT.

**Auth:** Bearer JWT  
**Request body:** none

**Response 200:**
```json
{
  "id": "a1b2c3d4-0001-0001-0001-000000000001",
  "email": "sarah.smith@clinic.ca",
  "created_at": "2026-01-10T08:00:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token missing, expired, or invalid |

---

### 4.2 Patients

#### `GET /api/patients`

Returns all patients assigned to the authenticated physician, ordered by `workflow_state`, then `display_name`. In the demo, always one patient.

**Auth:** Bearer JWT  
**Query params:** none

**Response 200:**
```json
[
  {
    "id": "b2c3d4e5-0002-0002-0002-000000000002",
    "fhir_id": "hapi-patient-7a3f9c",
    "mrn": "WARRIOR-001",
    "display_name": "Sarah M.",
    "date_of_birth": "1978-07-22",
    "physician_id": "a1b2c3d4-0001-0001-0001-000000000001",
    "workflow_state": "pending",
    "created_at": "2026-04-19T08:00:00.000Z",
    "updated_at": "2026-04-19T08:00:00.000Z"
  }
]
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |

---

#### `GET /api/patients/{id}`

Returns a single patient. Returns `404` if the patient belongs to a different physician.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Response 200:**
```json
{
  "id": "b2c3d4e5-0002-0002-0002-000000000002",
  "fhir_id": "hapi-patient-7a3f9c",
  "mrn": "WARRIOR-001",
  "display_name": "Sarah M.",
  "date_of_birth": "1978-07-22",
  "physician_id": "a1b2c3d4-0001-0001-0001-000000000001",
  "workflow_state": "brief_ready",
  "created_at": "2026-04-19T08:00:00.000Z",
  "updated_at": "2026-04-19T09:15:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | Patient not found or belongs to another physician |

---

#### `PATCH /api/patients/{id}/workflow-state`

Updates the patient's `workflow_state`. Called by the frontend after Orchestrate confirms a transition.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Request body:**
```json
{
  "workflow_state": "brief_ready"
}
```

**Response 200:**
```json
{
  "id": "b2c3d4e5-0002-0002-0002-000000000002",
  "workflow_state": "brief_ready",
  "updated_at": "2026-04-19T09:15:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `400` | `workflow_state` value not in enum |
| `401` | Token invalid |
| `404` | Patient not found |

---

### 4.3 Context Engine (Pre-Appointment)

#### `POST /api/patients/{id}/context-brief`

Generates a new context brief. Queries HAPI FHIR (or fallback), calls Granite, persists to Supabase. If a brief already exists for the appointment, supersedes it (version + 1). Returns the new brief synchronously.

**Auth:** Bearer JWT or `X-Orchestrate-Secret`  
**Path params:** `id` — patient UUID

**Request body:**
```json
{
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003"
}
```

**Response 201:**
```json
{
  "id": "d4e5f6a7-0004-0004-0004-000000000004",
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "patient_id": "b2c3d4e5-0002-0002-0002-000000000002",
  "brief_json": {
    "chronic_conditions": [
      "Type 2 Diabetes (E11.9) — dx 2019",
      "Hypertension (I10) — dx 2021"
    ],
    "recent_labs": [
      {"test": "HbA1c",  "value": "8.2%",      "date": "2026-03-15", "flag": "above_target"},
      {"test": "eGFR",   "value": "61 mL/min",  "date": "2026-03-15", "flag": "borderline"},
      {"test": "BP",     "value": "138/88 mmHg","date": "2026-03-15", "flag": null}
    ],
    "active_medications": [
      "Metformin 1000mg BID",
      "Ramipril 5mg OD"
    ],
    "recent_correspondence": [
      {
        "type": "Cardiology referral response",
        "date": "2026-04-01",
        "summary": "Echo normal, no intervention needed"
      }
    ],
    "missing_data_flags": [
      "No recent lipid panel found (last result >12 months old)",
      "ODSP application status not reflected in EMR"
    ]
  },
  "fhir_resources_snapshot": null,
  "version": 1,
  "superseded_by": null,
  "approved": false,
  "approved_at": null,
  "created_by": "a1b2c3d4-0001-0001-0001-000000000001",
  "created_at": "2026-04-19T09:15:30.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Auth missing |
| `404` | Patient not found |
| `502` | FHIR query failed and `USE_FHIR_FALLBACK=false` |
| `503` | Granite call returned non-2xx |

---

#### `GET /api/patients/{id}/context-brief`

Returns the current (non-superseded) context brief for the patient's active appointment.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Response 200:** Full `ContextBrief` object (same shape as the `POST` response above)

**Response 404:**
```json
{"detail": "No context brief found for patient b2c3d4e5-0002-0002-0002-000000000002"}
```

---

#### `GET /api/patients/{id}/context-brief/history`

Returns all versions of the context brief for the patient's active appointment, ordered by `version` descending.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Response 200:**
```json
[
  {
    "id": "d4e5f6a7-0004-0004-0004-000000000004",
    "version": 2,
    "superseded_by": null,
    "approved": false,
    "approved_at": null,
    "created_at": "2026-04-19T09:30:00.000Z"
  },
  {
    "id": "d4e5f6a7-0004-0004-0004-000000000099",
    "version": 1,
    "superseded_by": "d4e5f6a7-0004-0004-0004-000000000004",
    "approved": false,
    "approved_at": null,
    "created_at": "2026-04-19T09:15:30.000Z"
  }
]
```

Each object in the array is a full `ContextBrief`.

---

#### `POST /api/context-briefs/{id}/approve`

Marks a context brief as physician-approved. Enables `during_appointment` phase transition.

**Auth:** Bearer JWT  
**Path params:** `id` — context brief UUID  
**Request body:** `{}`

**Response 200:**
```json
{
  "id": "d4e5f6a7-0004-0004-0004-000000000004",
  "approved": true,
  "approved_at": "2026-04-19T09:20:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | Brief not found |
| `409` | Brief already approved |

---

### 4.4 Active Scribe (During Appointment)

#### `POST /api/patients/{id}/appointment/start`

Initialises a transcription session. Validates the audio file is accessible on the server, stores `audio_file_path` on the appointment record, spawns the Whisper background task.

**Auth:** Bearer JWT or `X-Orchestrate-Secret`  
**Path params:** `id` — patient UUID

**Request body:**
```json
{
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "audio_file_path": "/app/audio/sarah_m_20260419.mp3"
}
```

**Response 200:**
```json
{
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "stream_url": "/api/patients/b2c3d4e5-0002-0002-0002-000000000002/appointment/stream",
  "status": "transcription_started"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `400` | `audio_file_path` does not exist on the server filesystem |
| `401` | Auth missing |
| `404` | Patient or appointment not found |
| `409` | Transcription already in progress for this appointment |

---

#### `GET /api/patients/{id}/appointment/stream`

SSE endpoint. Client opens a persistent connection; server pushes events for the lifetime of the transcription. See §5 for the complete event schema.

**Auth:** JWT passed as query parameter `?token=<jwt>` (browser `EventSource` cannot set headers)  
**Path params:** `id` — patient UUID  
**Response content-type:** `text/event-stream`

Server sends `: ping` comment lines every 15 seconds to prevent proxy timeouts.

**Connection lifecycle:**
1. Client connects → server confirms transcription is active and begins streaming.
2. `transcript_chunk` events emitted as Whisper completes each segment.
3. `soap_update` events emitted after every 5 `transcript_chunk` events.
4. `billing_code_detected` and `lab_requisition_queued` emitted as detected.
5. `done` emitted when audio file is fully processed → server closes connection.

**Wire format example:**
```
event: transcript_chunk
data: {"chunk_index": 0, "text": "Good morning Sarah, how have you been feeling?", "start_ms": 0, "end_ms": 4200, "is_final": false}

event: soap_update
data: {"subjective": "Patient greeted by physician.", "objective": "", "assessment": "", "plan": ""}

event: done
data: {"total_chunks": 14, "duration_seconds": 412, "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003"}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token missing, invalid, or expired |
| `404` | No active transcription for this patient |

---

#### `POST /api/patients/{id}/appointment/end`

Finalises the SOAP note after the SSE stream emits `done`. Persists the full transcript and final SOAP JSON to `soap_notes`. Returns the persisted record.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Request body:**
```json
{
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003"
}
```

**Response 201:**
```json
{
  "id": "e5f6a7b8-0005-0005-0005-000000000005",
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "patient_id": "b2c3d4e5-0002-0002-0002-000000000002",
  "transcript_text": "Doctor: Good morning Sarah, how have you been feeling?\nPatient: Not great. I've been really thirsty and using the bathroom constantly for the past two weeks...",
  "soap_json": {
    "subjective": "Patient reports polyuria and polydipsia for 2 weeks. Increased fatigue. No chest pain or shortness of breath.",
    "objective": "BP 138/88 mmHg, HR 78 bpm, weight 82 kg. Patient alert, no acute distress.",
    "assessment": "Uncontrolled Type 2 Diabetes (E11.9). Hypertension (I10) — currently stable.",
    "plan": "1. Increase Metformin to 2000 mg/day. 2. Repeat HbA1c in 3 months. 3. Referral to registered dietician. 4. Continue Ramipril 5 mg OD. 5. Patient counselled on hydration and diet."
  },
  "billing_codes": [
    {"code": "A001", "description": "General assessment — GP/FP", "confidence": 0.92}
  ],
  "approved": false,
  "approved_at": null,
  "version": 1,
  "superseded_by": null,
  "created_by": "a1b2c3d4-0001-0001-0001-000000000001",
  "created_at": "2026-04-19T10:45:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | Patient or active appointment not found |
| `409` | SOAP note already finalised for this appointment |

---

#### `GET /api/patients/{id}/soap-note`

Returns the current (non-superseded) SOAP note for the patient's active appointment.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Response 200:** Full `SOAPNote` object (same shape as the `appointment/end` response above)

**Response 404:**
```json
{"detail": "No SOAP note found for patient b2c3d4e5-0002-0002-0002-000000000002"}
```

---

#### `PATCH /api/soap-notes/{id}`

Partial in-place edit of a SOAP note draft. Only supplied fields are overwritten. Does not create a new version — inline edits modify the current draft. Approved notes are immutable; call `appointment/start` again to regenerate.

**Auth:** Bearer JWT  
**Path params:** `id` — soap note UUID

**Request body:**
```json
{
  "plan": "1. Increase Metformin to 2000 mg/day. 2. Repeat HbA1c in 3 months. 3. Urgent referral to nephrologist given borderline eGFR. 4. Continue Ramipril 5 mg OD."
}
```

**Response 200:**
```json
{
  "id": "e5f6a7b8-0005-0005-0005-000000000005",
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "patient_id": "b2c3d4e5-0002-0002-0002-000000000002",
  "transcript_text": "Doctor: Good morning Sarah...",
  "soap_json": {
    "subjective": "Patient reports polyuria and polydipsia for 2 weeks. Increased fatigue. No chest pain or shortness of breath.",
    "objective": "BP 138/88 mmHg, HR 78 bpm, weight 82 kg. Patient alert, no acute distress.",
    "assessment": "Uncontrolled Type 2 Diabetes (E11.9). Hypertension (I10) — currently stable.",
    "plan": "1. Increase Metformin to 2000 mg/day. 2. Repeat HbA1c in 3 months. 3. Urgent referral to nephrologist given borderline eGFR. 4. Continue Ramipril 5 mg OD."
  },
  "billing_codes": [
    {"code": "A001", "description": "General assessment — GP/FP", "confidence": 0.92}
  ],
  "approved": false,
  "approved_at": null,
  "version": 1,
  "superseded_by": null,
  "created_by": "a1b2c3d4-0001-0001-0001-000000000001",
  "created_at": "2026-04-19T10:45:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | SOAP note not found |
| `409` | Note is already approved; create a new version via `appointment/start` |

---

#### `POST /api/soap-notes/{id}/approve`

Marks the SOAP note as physician-approved. After approval no further edits are accepted. Orchestrate is notified so the workflow can advance to `post_appointment`.

**Auth:** Bearer JWT  
**Path params:** `id` — soap note UUID  
**Request body:** `{}`

**Response 200:**
```json
{
  "id": "e5f6a7b8-0005-0005-0005-000000000005",
  "approved": true,
  "approved_at": "2026-04-19T10:50:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | SOAP note not found |
| `409` | Already approved |

---

### 4.5 Form Originator (Post-Appointment)

#### `POST /api/patients/{id}/form-draft`

Generates a T2201 draft from the approved SOAP note plus full FHIR history. Calls Granite with the T2201 JSON schema. Persists and returns the draft synchronously. Called by Orchestrate.

**Auth:** Bearer JWT or `X-Orchestrate-Secret`  
**Path params:** `id` — patient UUID

**Request body:**
```json
{
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "soap_note_id":   "e5f6a7b8-0005-0005-0005-000000000005"
}
```

**Response 201:**
```json
{
  "id": "f6a7b8c9-0006-0006-0006-000000000006",
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
  "patient_id": "b2c3d4e5-0002-0002-0002-000000000002",
  "soap_note_id": "e5f6a7b8-0005-0005-0005-000000000005",
  "form_type": "T2201",
  "form_json": {
    "patient_last_name": {
      "value": "M.",
      "confidence": 0.99,
      "source": "FHIR Patient.name"
    },
    "patient_first_name": {
      "value": "Sarah",
      "confidence": 0.99,
      "source": "FHIR Patient.name"
    },
    "date_of_birth": {
      "value": "1978-07-22",
      "confidence": 1.0,
      "source": "FHIR Patient.birthDate"
    },
    "sin": {
      "value": null,
      "confidence": 0.0,
      "source": "not available in clinical records"
    },
    "diagnosis_code": {
      "value": "E11.9",
      "confidence": 0.97,
      "source": "FHIR Condition active list"
    },
    "marked_restriction_walking": {
      "value": true,
      "confidence": 0.62,
      "source": "SOAP Plan — patient reports difficulty with prolonged standing"
    },
    "certifying_practitioner_cpso": {
      "value": null,
      "confidence": 0.0,
      "source": "not in FHIR — physician must enter manually"
    }
  },
  "approved": false,
  "approved_at": null,
  "fhir_composition_id": null,
  "fhir_doc_ref_id": null,
  "version": 1,
  "superseded_by": null,
  "created_by": "a1b2c3d4-0001-0001-0001-000000000001",
  "created_at": "2026-04-19T10:52:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Auth missing |
| `404` | SOAP note not found |
| `409` | SOAP note is not approved |
| `502` | FHIR query failed |
| `503` | Granite call failed |

---

#### `GET /api/patients/{id}/form-draft`

Returns the current (non-superseded) form draft for the patient's active appointment.

**Auth:** Bearer JWT  
**Path params:** `id` — patient UUID

**Response 200:** Full `FormDraft` object (same shape as the `POST` response above)

**Response 404:**
```json
{"detail": "No form draft found for patient b2c3d4e5-0002-0002-0002-000000000002"}
```

---

#### `PATCH /api/form-drafts/{id}`

Updates specific T2201 fields. Physician-supplied values get `confidence: 1.0` and `source: "physician_edit"` by convention; the client should set these explicitly in the request. Only keys present in `fields` are overwritten; all other fields are untouched.

**Auth:** Bearer JWT  
**Path params:** `id` — form draft UUID

**Request body:**
```json
{
  "fields": {
    "sin": {
      "value": "123-456-789",
      "confidence": 1.0,
      "source": "physician_edit"
    },
    "certifying_practitioner_cpso": {
      "value": "12345",
      "confidence": 1.0,
      "source": "physician_edit"
    }
  }
}
```

**Response 200:** Full updated `FormDraft` object, with the edited fields reflected:
```json
{
  "id": "f6a7b8c9-0006-0006-0006-000000000006",
  "form_json": {
    "patient_last_name": {"value": "M.", "confidence": 0.99, "source": "FHIR Patient.name"},
    "sin": {"value": "123-456-789", "confidence": 1.0, "source": "physician_edit"},
    "certifying_practitioner_cpso": {"value": "12345", "confidence": 1.0, "source": "physician_edit"}
  },
  "approved": false,
  "version": 1,
  "created_at": "2026-04-19T10:52:00.000Z"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | Draft not found |
| `409` | Draft already approved; create a new version via `POST /api/patients/{id}/form-draft` |

---

#### `POST /api/form-drafts/{id}/approve-and-sync`

Approves the form draft and immediately writes FHIR resources. On success, sets `approved=true`, `fhir_composition_id`, and `fhir_doc_ref_id`, advances patient `workflow_state` to `completed`, and writes an `audit_log` entry. Operation is atomic: if the FHIR write fails, the record remains unapproved and the endpoint returns `502` — safe to retry.

**Auth:** Bearer JWT  
**Path params:** `id` — form draft UUID  
**Request body:** `{}`

**Response 200:**
```json
{
  "id": "f6a7b8c9-0006-0006-0006-000000000006",
  "approved": true,
  "approved_at": "2026-04-19T11:05:00.000Z",
  "fhir_composition_id": "hapi-composition-abc123",
  "fhir_doc_ref_id": "hapi-docref-def456",
  "patient_workflow_state": "completed"
}
```

**Errors:**

| Status | Condition |
|---|---|
| `401` | Token invalid |
| `404` | Draft not found |
| `409` | Already approved |
| `502` | FHIR POST returned non-2xx; draft remains unapproved |

---

### 4.6 Orchestrate Integration

#### `POST /api/orchestrate/advance-phase`

Called exclusively by IBM Orchestrate. Validates the shared secret, enforces guard conditions, invokes the backend module for the target phase, and returns the result. All three phase actions (brief generation, scribe start, form generation) are driven through this single endpoint.

**Auth:** `X-Orchestrate-Secret: <ORCHESTRATE_SHARED_SECRET>` — no Bearer JWT

**Request body:**
```json
{
  "patient_id":      "b2c3d4e5-0002-0002-0002-000000000002",
  "appointment_id":  "c3d4e5f6-0003-0003-0003-000000000003",
  "target_phase":    "during_appointment",
  "triggered_by":    "physician",
  "audio_file_path": "/app/audio/sarah_m_20260419.mp3"
}
```

**Response 200:**
```json
{
  "appointment_id":  "c3d4e5f6-0003-0003-0003-000000000003",
  "previous_phase":  "pre_appointment",
  "current_phase":   "during_appointment",
  "next_action_url": "/api/patients/b2c3d4e5-0002-0002-0002-000000000002/appointment/stream"
}
```

**Guard failure 409:**
```json
{
  "detail": "Cannot advance to during_appointment: no approved context_brief for appointment c3d4e5f6-0003-0003-0003-000000000003"
}
```

**Guard conditions by target phase:**

| Target phase | Guard | Failure message |
|---|---|---|
| `during_appointment` | `context_briefs` row exists and `approved=true` for this appointment | `"no approved context_brief for appointment {id}"` |
| `post_appointment` | `soap_notes` row exists and `approved=true` for this appointment | `"no approved soap_note for appointment {id}"` |
| `completed` | `form_drafts` row exists for this appointment | `"no form_draft for appointment {id}"` |

**Errors:**

| Status | Condition |
|---|---|
| `401` | `X-Orchestrate-Secret` missing or incorrect |
| `400` | `target_phase` is not a valid `AppointmentPhase` value |
| `400` | `audio_file_path` missing when `target_phase == "during_appointment"` |
| `409` | Guard condition failed |
| `5xx` | Backend action failed (Granite/FHIR unreachable); Orchestrate should retry |

---

### 4.7 Audit Log

#### `GET /api/audit-log`

Read-only view of audit log entries for a given patient. For debugging and review.

**Auth:** Bearer JWT  
**Query params:**

| Param | Type | Required | Default |
|---|---|---|---|
| `patient_id` | UUID | yes | — |
| `limit` | int | no | `100` |

**Request:**
```
GET /api/audit-log?patient_id=b2c3d4e5-0002-0002-0002-000000000002&limit=5
```

**Response 200:**
```json
[
  {
    "id": "a7b8c9d0-0007-0007-0007-000000000007",
    "event": "context_brief_generated",
    "actor_id": "a1b2c3d4-0001-0001-0001-000000000001",
    "resource_type": "context_brief",
    "resource_id": "d4e5f6a7-0004-0004-0004-000000000004",
    "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003",
    "metadata": {
      "granite_latency_ms": 1823,
      "fhir_resources_fetched": 5,
      "fhir_source": "live"
    },
    "created_at": "2026-04-19T09:15:30.000Z"
  }
]
```

**Errors:**

| Status | Condition |
|---|---|
| `400` | `patient_id` missing or not a valid UUID |
| `401` | Token invalid |

---

### 4.8 Health

#### `GET /health`

No auth. No DB or FHIR calls. Returns immediately. Used by cron-job.org keep-alive.

**Response 200:**
```json
{
  "status": "ok",
  "timestamp": "2026-04-19T14:00:00.000Z"
}
```

---

## 5. SSE Event Schemas

The SSE stream at `GET /api/patients/{id}/appointment/stream` uses the standard SSE wire format. Each event is two lines followed by a blank line:

```
event: <event_type>
data: <json_string>

```

The Python `StreamingResponse` generator yields `f"event: {type}\ndata: {json}\n\n"` strings. Comment-only keepalive lines are `": ping\n\n"`.

---

### `transcript_chunk`

Emitted for every Whisper output segment, in order.

| Field | Type | Description |
|---|---|---|
| `chunk_index` | `int` | 0-based index; monotonically increasing |
| `text` | `str` | Transcribed text for this segment |
| `start_ms` | `int` | Segment start time in milliseconds from audio start |
| `end_ms` | `int` | Segment end time in milliseconds from audio start |
| `is_final` | `bool` | `true` only on the last chunk of the audio file |

```json
{
  "chunk_index": 3,
  "text": "Patient reports increased thirst and frequent urination over the past two weeks.",
  "start_ms": 90000,
  "end_ms": 117500,
  "is_final": false
}
```

---

### `soap_update`

Emitted after every 5 `transcript_chunk` events and once more immediately before `done`. Contains the **complete current SOAP object** — the frontend replaces its entire SOAP state with each emission, not a partial patch.

| Field | Type | Description |
|---|---|---|
| `subjective` | `str` | Full subjective section as of this update |
| `objective` | `str` | Full objective section |
| `assessment` | `str` | Full assessment section |
| `plan` | `str` | Full plan section |

```json
{
  "subjective": "Patient reports polyuria and polydipsia for 2 weeks. Increased fatigue. Denies chest pain.",
  "objective": "BP 138/88 mmHg, HR 78 bpm, weight 82 kg.",
  "assessment": "Uncontrolled Type 2 Diabetes (E11.9). Hypertension stable.",
  "plan": "1. Increase Metformin. 2. Repeat HbA1c in 3 months."
}
```

---

### `billing_code_detected`

Emitted zero or more times as Granite identifies OHIP billing codes. Frontend appends to the billing code sidebar list; does not replace.

| Field | Type | Description |
|---|---|---|
| `code` | `str` | OHIP billing code, e.g. `"A001"` |
| `description` | `str` | Human-readable label for the code |

```json
{
  "code": "A001",
  "description": "General assessment — GP/FP"
}
```

---

### `lab_requisition_queued`

Emitted when Granite detects a lab order in the Plan section. Display-only in MVP.

| Field | Type | Description |
|---|---|---|
| `test_name` | `str` | Name of the lab test, e.g. `"HbA1c"` |
| `urgency` | `str` | One of: `"routine"`, `"urgent"`, `"stat"` |

```json
{
  "test_name": "HbA1c",
  "urgency": "routine"
}
```

---

### `error`

Emitted if Whisper or Granite fails mid-stream. Frontend displays the message and stops waiting for `done`.

| Field | Type | Description |
|---|---|---|
| `message` | `str` | Human-readable error description |

```json
{
  "message": "Whisper transcription failed on chunk 7: model process exited unexpectedly"
}
```

---

### `done`

Emitted once as the final event. No further events follow. Frontend may now call `POST /api/patients/{id}/appointment/end`.

| Field | Type | Description |
|---|---|---|
| `total_chunks` | `int` | Number of `transcript_chunk` events emitted |
| `duration_seconds` | `float` | Total audio duration in seconds |
| `appointment_id` | `str` | UUID of the appointment, for client-side correlation |

```json
{
  "total_chunks": 14,
  "duration_seconds": 412.3,
  "appointment_id": "c3d4e5f6-0003-0003-0003-000000000003"
}
```

---

## 6. Shared Services

All services live in `backend/services/`. Route handlers import from here; they do not instantiate clients or call external APIs directly.

---

### `backend/services/llm.py`

Wraps the watsonx Granite API. All LLM calls in the application go through this module.

**SDK:** `ibm-watsonx-ai` — add to `requirements.txt`.  
**Docs:** https://ibm.github.io/watsonx-ai-python-sdk/fm_model_inference.html

```bash
pip install ibm-watsonx-ai
```

| Function | Signature | Returns | Description |
|---|---|---|---|
| `generate` | `(prompt, system, response_model, max_tokens)` | `T \| str` | Calls Granite; parses into `response_model` if provided, otherwise returns raw string |

```python
# backend/services/llm.py
import re
import json
from typing import TypeVar, Type
from pydantic import BaseModel
from ibm_watsonx_ai import APIClient, Credentials
from ibm_watsonx_ai.foundation_models import ModelInference
from ibm_watsonx_ai.metanames import GenTextParamsMetaNames as GenParams
from backend.config import settings

T = TypeVar("T", bound=BaseModel)

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

# Module-level singleton — instantiated once on first call
_model: ModelInference | None = None

async def generate(
    prompt:         str,
    system:         str = "",
    response_model: Type[T] | None = None,
    max_tokens:     int = 1024,
) -> T | str:
    global _model
    if _model is None:
        _model = _get_model()

    # If a structured response is expected, append JSON instructions to system prompt
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
        response = _model.chat(messages=messages)
    except Exception as e:
        raise LLMError(f"watsonx call failed: {e}") from e

    # Extract text from response
    # response shape: {"choices": [{"message": {"content": "<text>"}}]}
    raw: str = response["choices"][0]["message"]["content"].strip()

    if response_model is None:
        return raw

    # Strip markdown code fences if Granite wrapped the JSON anyway
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()

    try:
        return response_model.model_validate_json(clean)
    except Exception as e:
        raise LLMError(f"Failed to parse Granite response into {response_model.__name__}: {e}\nRaw: {raw}") from e


class LLMError(Exception):
    """Raised on non-2xx watsonx response or unparseable JSON output."""
    ...
```

**Stub for week 6 (commit this first so teammates can import):**

```python
# Temporary stub — replace with real implementation above in week 7
async def generate(prompt, system="", response_model=None, max_tokens=1024):
    if response_model is not None:
        return response_model.model_validate({})   # empty but valid model
    return "stub response"

class LLMError(Exception):
    ...
```

---

### `backend/services/fhir_client.py`

Wraps HAPI FHIR HTTP calls. Routes to local JSON fallback when `USE_FHIR_FALLBACK=true`.

| Function | Signature | Returns | Description |
|---|---|---|---|
| `get_patient` | `(mrn: str)` | `dict` | FHIR `Patient` resource by MRN identifier |
| `get_observations` | `(fhir_patient_id: str, count: int = 10)` | `dict` | `Observation` bundle, sorted by date desc |
| `get_conditions` | `(fhir_patient_id: str)` | `dict` | Active `Condition` bundle |
| `get_medications` | `(fhir_patient_id: str)` | `dict` | Active `MedicationRequest` bundle |
| `get_communications` | `(fhir_patient_id: str, count: int = 5)` | `dict` | Recent `Communication` bundle |
| `get_document_references` | `(fhir_patient_id: str)` | `dict` | All `DocumentReference` resources |
| `write_composition` | `(data: dict)` | `dict` | POST `Composition`; no-op in fallback mode |
| `write_document_reference` | `(data: dict)` | `dict` | POST `DocumentReference`; no-op in fallback mode |

```python
# backend/services/fhir_client.py
from typing import Any

async def get_patient(mrn: str) -> dict[str, Any]:
    """Fetch FHIR Patient by MRN. Falls back to local JSON if USE_FHIR_FALLBACK=true."""
    ...

async def get_observations(fhir_patient_id: str, count: int = 10) -> dict[str, Any]:
    """Fetch most recent Observations sorted by date desc."""
    ...

async def get_conditions(fhir_patient_id: str) -> dict[str, Any]:
    """Fetch active Conditions."""
    ...

async def get_medications(fhir_patient_id: str) -> dict[str, Any]:
    """Fetch active MedicationRequests."""
    ...

async def get_communications(fhir_patient_id: str, count: int = 5) -> dict[str, Any]:
    """Fetch most recent Communications sorted by sent date desc."""
    ...

async def get_document_references(fhir_patient_id: str) -> dict[str, Any]:
    """Fetch all DocumentReference resources for the patient."""
    ...

async def write_composition(data: dict[str, Any]) -> dict[str, Any]:
    """
    POST a FHIR Composition. Returns the created resource with server-assigned id.
    When USE_FHIR_FALLBACK=true: logs a warning, returns {"id": "fallback-mock-id", "resourceType": "Composition"}.
    """
    ...

async def write_document_reference(data: dict[str, Any]) -> dict[str, Any]:
    """
    POST a FHIR DocumentReference. Returns the created resource.
    When USE_FHIR_FALLBACK=true: same no-op behaviour as write_composition.
    """
    ...

class FHIRError(Exception):
    """FHIR server returned non-2xx or response was unparseable."""
    ...
```

---

### `backend/services/audit.py`

Appends rows to `audit_log`. Errors are caught and logged; they never propagate to callers so a logging failure never interrupts a clinical action.

```python
# backend/services/audit.py
from uuid import UUID
from typing import Any
from models.enums import AuditAction

async def log_action(
    actor_id:       UUID,
    action:         AuditAction,
    resource_type:  str,
    resource_id:    UUID,
    appointment_id: UUID | None = None,
    metadata:       dict[str, Any] | None = None,
) -> None:
    """
    INSERT one row into audit_log. Non-blocking — exceptions are swallowed
    after logging to stderr so callers are never blocked by audit failures.
    """
    ...
```

---

### `backend/services/supabase_client.py`

Provides an initialised `AsyncClient` singleton. All database access uses this client.

```python
# backend/services/supabase_client.py
from supabase import AsyncClient

async def get_client() -> AsyncClient:
    """
    Returns the initialised Supabase AsyncClient singleton.
    Initialises on first call using SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
    Thread-safe for asyncio; not safe across processes.
    """
    ...
```

---

### `backend/services/whisper_runner.py`

Wraps `faster-whisper` for async chunk-by-chunk transcription. Runs the synchronous `faster-whisper` calls in a thread-pool executor to avoid blocking the event loop.

```python
# backend/services/whisper_runner.py
from collections.abc import AsyncGenerator

async def transcribe_chunks(
    audio_path:      str,
    chunk_seconds:   int = 30,
    overlap_seconds: int = 5,
) -> AsyncGenerator[dict[str, object], None]:
    """
    Load audio file at audio_path, transcribe using faster-whisper.
    Yields dicts: {chunk_index: int, text: str, start_ms: int, end_ms: int, is_final: bool}.
    is_final=True on the last segment of the file.
    Uses WHISPER_MODEL_SIZE from settings.
    Raises WhisperError if the model fails to load or a segment fails.
    """
    ...

class WhisperError(Exception):
    """faster-whisper model load failure or segment transcription failure."""
    ...
```

---

### `backend/config.py`

Reads all environment variables using `pydantic-settings`. One `Settings` instance is created at import time and imported everywhere as `from backend.config import settings`.

```python
# backend/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # Supabase
    supabase_url:               str
    supabase_anon_key:          str
    supabase_service_role_key:  str

    # IBM Granite / watsonx
    watsonx_api_key:    str
    watsonx_project_id: str
    watsonx_url:        str
    granite_model_id:   str = "ibm/granite-3-8b-instruct"

    # FHIR
    fhir_base_url:       str  = "https://hapi.fhir.org/baseR4"
    use_fhir_fallback:   bool = False

    # Whisper
    whisper_model_size: str = "base.en"

    # Orchestrate
    orchestrate_shared_secret: str

    # Feature flags
    auth_enabled:          bool  = True
    confidence_threshold:  float = 0.75

    # Deployment
    backend_url:  str = ""
    frontend_url: str = ""

    # Logging
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

settings = Settings()
```

---

### `backend/main.py`

FastAPI application entry point. Registers middleware, mounts all routers, configures CORS.

```python
# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .middleware.auth import auth_dependency
from .api import patients, context_briefs, appointments, soap_notes, form_drafts, orchestrate, audit, health

app = FastAPI(title="Warriors AI Copilot API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers — all user-facing routes under /api
app.include_router(patients.router,       prefix="/api")
app.include_router(context_briefs.router, prefix="/api")
app.include_router(appointments.router,   prefix="/api")
app.include_router(soap_notes.router,     prefix="/api")
app.include_router(form_drafts.router,    prefix="/api")
app.include_router(orchestrate.router,    prefix="/api")
app.include_router(audit.router,          prefix="/api")

# Health has no /api prefix
app.include_router(health.router)
```

All routers define their own path prefixes (e.g. `router = APIRouter()`). The `/api` prefix is applied at mount time above so route definitions inside each router file are relative (e.g. `/patients`, not `/api/patients`).

---

### `backend/middleware/auth.py`

FastAPI dependency injected into every user-facing route. Validates the Supabase JWT. Returns the decoded user dict. When `AUTH_ENABLED=false`, skips validation and returns the stub user.

```python
# backend/middleware/auth.py
from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .config import settings

security = HTTPBearer(auto_error=False)

async def auth_dependency(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    """
    Returns decoded user dict: {"id": "<uuid>", "email": "<str>"}.
    If AUTH_ENABLED=false, returns stub user without touching the token.
    If AUTH_ENABLED=true and token is missing or invalid, raises HTTP 401.
    Validates JWT signature against Supabase JWKS endpoint using supabase-py or PyJWT.
    """
    if not settings.auth_enabled:
        return {"id": "00000000-0000-0000-0000-000000000000", "email": "demo@warriors.dev"}
    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    ...  # validate JWT, return user dict
```

Usage in a route:

```python
from backend.middleware.auth import auth_dependency

@router.get("/patients")
async def list_patients(user: dict = Depends(auth_dependency)):
    ...
```

---

### `backend/middleware/orchestrate_auth.py`

FastAPI dependency injected into `/api/orchestrate/*` routes only. Validates the `X-Orchestrate-Secret` header. Never used alongside `auth_dependency` — they are mutually exclusive by route.

```python
# backend/middleware/orchestrate_auth.py
from fastapi import Request, HTTPException, Header
from .config import settings

async def orchestrate_auth_dependency(
    x_orchestrate_secret: str | None = Header(default=None),
) -> None:
    """
    Raises HTTP 401 if X-Orchestrate-Secret header is missing or does not match
    ORCHESTRATE_SHARED_SECRET from settings. Returns None on success.
    """
    if x_orchestrate_secret != settings.orchestrate_shared_secret:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Orchestrate-Secret")
```

Usage in `backend/api/orchestrate.py`:

```python
from backend.middleware.orchestrate_auth import orchestrate_auth_dependency

@router.post("/orchestrate/advance-phase", dependencies=[Depends(orchestrate_auth_dependency)])
async def advance_phase(body: PhaseAdvanceRequest):
    ...
```

---

### `backend/services/context_engine.py`

Owned by Juan. Assembles FHIR data into a Granite prompt and returns a structured `BriefContent`.

| Function | Signature | Returns | Description |
|---|---|---|---|
| `generate_brief` | `(patient_id: UUID, appointment_id: UUID) -> BriefContent` | `BriefContent` | Queries FHIR, builds prompt, calls `generate()`, returns parsed brief |

```python
# backend/services/context_engine.py
from uuid import UUID
from backend.models.context_brief import BriefContent
from backend.services import fhir_client, llm

async def generate_brief(patient_id: UUID, appointment_id: UUID) -> BriefContent:
    """
    1. Look up patient MRN from Supabase patients table.
    2. Call fhir_client.get_patient(mrn), get_conditions(fhir_id),
       get_observations(fhir_id), get_medications(fhir_id), get_communications(fhir_id)
       concurrently via asyncio.gather().
    3. Assemble raw FHIR JSON into a system + user prompt.
       System prompt instructs Granite to return BriefContent JSON schema.
    4. Call llm.generate(prompt, system=SYSTEM_PROMPT, response_model=BriefContent).
    5. Return the parsed BriefContent.
    Raises FHIRError if FHIR calls fail.
    Raises LLMError if Granite call fails or JSON parse fails.
    """
    ...
```

System prompt template (embed in the function or a constant at module level):

```python
BRIEF_SYSTEM_PROMPT = """
You are a clinical documentation assistant. Given raw FHIR resources for a patient,
produce a structured context brief for the attending physician.
Return a JSON object matching this schema exactly:
{
  "chronic_conditions": ["string"],
  "recent_labs": [{"test": "string", "value": "string", "date": "YYYY-MM-DD", "flag": "above_target|below_target|borderline|null"}],
  "active_medications": ["string"],
  "recent_correspondence": [{"type": "string", "date": "YYYY-MM-DD", "summary": "string"}],
  "missing_data_flags": ["string"]
}
Do not invent data not present in the FHIR resources. If a field has no data, return an empty array.
"""
```

---

### `backend/services/soap_generator.py`

Owned by Sunny. Called every 5 transcript chunks during the scribe phase. Maintains and returns the full SOAP note.

| Function | Signature | Returns | Description |
|---|---|---|---|
| `update_soap` | `(current_soap, new_segment, full_transcript)` | `tuple[SOAPContent, list[BillingCode]]` | Sends current SOAP + new transcript to Granite; returns updated SOAP and any new billing codes |

```python
# backend/services/soap_generator.py
from backend.models.soap_note import SOAPContent, BillingCode
from backend.services import llm

class SOAPUpdateResult(BaseModel):
    soap: SOAPContent
    billing_codes: list[BillingCode]

async def update_soap(
    current_soap:    SOAPContent,
    new_segment:     str,
    full_transcript: str,
) -> tuple[SOAPContent, list[BillingCode]]:
    """
    Calls llm.generate() with the current SOAP state and the new transcript segment.
    Granite is instructed to return a JSON object matching SOAPUpdateResult.
    Returns (updated SOAPContent, list of new BillingCode detections).
    Does NOT accumulate billing codes — caller is responsible for deduplication.
    Raises LLMError on failure; caller should emit SSE error event and continue.
    """
    result = await llm.generate(
        prompt=f"Current SOAP:\n{current_soap.model_dump_json()}\n\nNew transcript segment:\n{new_segment}",
        system=SOAP_SYSTEM_PROMPT,
        response_model=SOAPUpdateResult,
    )
    return result.soap, result.billing_codes
```

System prompt constant (embed at module level):

```python
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
```

---

### `scripts/seed_fhir.py`

Owned by Juan. Run once before the demo. Creates the fictional patient Sarah M. on the HAPI FHIR public server and writes the resulting resource IDs to `backend/data/fhir_seed_ids.json`.

```
Behaviour:
- Checks for existing Patient with identifier system="MRN", value="WARRIOR-001".
- If found, skips creation and reads existing IDs.
- If not found, creates all resources via FHIR REST API (POST).
- Creates in order: Patient → Condition (x2) → Observation (x4) → MedicationRequest (x2) → Communication (x1).
- Each resource references the Patient by the FHIR Patient ID returned from the Patient POST.
- Writes final IDs to backend/data/fhir_seed_ids.json:
  {
    "patient_id": "<fhir-id>",
    "condition_ids": ["<id1>", "<id2>"],
    "observation_ids": ["<id1>", "<id2>", "<id3>", "<id4>"],
    "medication_request_ids": ["<id1>", "<id2>"],
    "communication_id": "<id>"
  }
- Uses httpx (sync) — no FastAPI or Supabase dependency.
- Reads FHIR_BASE_URL from environment (defaults to https://hapi.fhir.org/baseR4).
```

Seed data values (hardcoded in the script):

| Resource | Value |
|---|---|
| Patient name | Sarah M., DOB 1978-07-22, MRN WARRIOR-001 |
| Condition 1 | Type 2 Diabetes, ICD E11.9, onset 2019-01-01, clinical-status active |
| Condition 2 | Hypertension, ICD I10, onset 2021-06-01, clinical-status active |
| Observation 1 | HbA1c, 8.2%, date 2026-03-15 |
| Observation 2 | eGFR, 61 mL/min, date 2026-03-15 |
| Observation 3 | BP, 138/88 mmHg, date 2026-03-15 |
| Observation 4 | Lipid panel, total cholesterol 5.8 mmol/L, date 2024-11-01 (intentionally old — triggers missing-data flag) |
| MedicationRequest 1 | Metformin 1000mg BID, status active |
| MedicationRequest 2 | Ramipril 5mg OD, status active |
| Communication | Cardiology referral response, sent 2026-04-01, body "Echo normal, no intervention needed" |

---

### `orchestrate/workflows/main_workflow.yaml`

Owned by Juan. Defines the IBM Orchestrate workflow that drives phase transitions. The workflow calls `POST /api/orchestrate/advance-phase` at each transition with the appropriate `target_phase`.

**State machine:**

| Current state | Trigger | Guard checked by FastAPI | Next state | Orchestrate calls |
|---|---|---|---|---|
| (start) | Patient clicked in dashboard | — | `pre_appointment` | `POST /api/orchestrate/advance-phase` `{target_phase: "pre_appointment"}` |
| `pre_appointment` | Physician clicks "Start Appointment" | Approved context brief exists | `during_appointment` | `POST /api/orchestrate/advance-phase` `{target_phase: "during_appointment", audio_file_path: "..."}` |
| `during_appointment` | Physician clicks "End Appointment" + approves SOAP | Approved SOAP note exists | `post_appointment` | `POST /api/orchestrate/advance-phase` `{target_phase: "post_appointment"}` |
| `post_appointment` | Physician clicks "Approve" on form | Form draft exists | `completed` | `POST /api/orchestrate/advance-phase` `{target_phase: "completed"}` |

**HITL gates** (configured in Orchestrate, not FastAPI):
- `pre_appointment`: Orchestrate waits for physician to click "Start Appointment" before advancing.
- `during_appointment`: Orchestrate waits for physician to click "End Appointment" before advancing.
- `post_appointment`: Orchestrate waits for physician to click "Approve" on the form before advancing.

Orchestrate receives the physician action signal via `POST /workflow/advance` called from the frontend. The frontend URL for this call is the Orchestrate API endpoint — not the FastAPI backend.

---

### `backend/data/fhir_fallback/*.json`

Owned by Juan. Five static JSON files that mirror the HAPI FHIR seed data. Used when `USE_FHIR_FALLBACK=true`. Each file is the exact JSON response that the corresponding FHIR read method would return from the live server.

| File | FHIR equivalent |
|---|---|
| `patient_WARRIOR-001.json` | Response from `GET /Patient?identifier=WARRIOR-001` |
| `conditions_WARRIOR-001.json` | Response from `GET /Condition?patient={fhir_id}&clinical-status=active` |
| `observations_WARRIOR-001.json` | Response from `GET /Observation?patient={fhir_id}&_sort=-date&_count=10` |
| `medications_WARRIOR-001.json` | Response from `GET /MedicationRequest?patient={fhir_id}&status=active` |
| `communications_WARRIOR-001.json` | Response from `GET /Communication?recipient={fhir_id}&_sort=-sent&_count=5` |

Each file must be a valid FHIR Bundle JSON with a `resourceType: "Bundle"` wrapper and an `entry` array. Run `scripts/seed_fhir.py` first, then copy the actual FHIR API responses into these files so they match exactly.

---

### `backend/schemas/t2201.json`

Owned by Anahat. The CRA T2201 Disability Tax Credit Certificate field schema. Passed to Granite as part of the Form Originator prompt. Each key is a form field name; the value describes the field so Granite knows what to populate.

Minimum required fields for the MVP demo:

```json
{
  "patient_last_name":              {"type": "string",  "description": "Patient's last name"},
  "patient_first_name":             {"type": "string",  "description": "Patient's first name"},
  "date_of_birth":                  {"type": "string",  "description": "Patient's date of birth, format YYYY-MM-DD"},
  "sin":                            {"type": "string",  "description": "Patient's Social Insurance Number — not in clinical records, physician must enter"},
  "address":                        {"type": "string",  "description": "Patient's home address"},
  "diagnosis_code":                 {"type": "string",  "description": "Primary ICD-10 diagnosis code for the claimed disability"},
  "diagnosis_description":          {"type": "string",  "description": "Plain-language description of the primary diagnosis"},
  "marked_restriction_walking":     {"type": "boolean", "description": "True if patient has a marked restriction in walking"},
  "marked_restriction_mental":      {"type": "boolean", "description": "True if patient has a marked restriction in mental functions"},
  "life_sustaining_therapy":        {"type": "boolean", "description": "True if patient requires life-sustaining therapy"},
  "duration_years":                 {"type": "integer", "description": "Number of years the impairment has lasted or is expected to last"},
  "certifying_practitioner_name":   {"type": "string",  "description": "Full name of the certifying physician"},
  "certifying_practitioner_cpso":   {"type": "string",  "description": "CPSO registration number of the certifying physician — not in FHIR, physician must enter"},
  "certification_date":             {"type": "string",  "description": "Date the form is being certified, format YYYY-MM-DD"}
}
```

---

## 7. Environment Variables

### `backend/.env.example`

```bash
# ── Supabase ──────────────────────────────────────────────────────────────────
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# ── IBM Granite / watsonx ─────────────────────────────────────────────────────
WATSONX_API_KEY=your-watsonx-api-key
WATSONX_PROJECT_ID=your-watsonx-project-id
WATSONX_URL=https://us-south.ml.cloud.ibm.com
GRANITE_MODEL_ID=ibm/granite-3-8b-instruct

# ── HAPI FHIR ─────────────────────────────────────────────────────────────────
FHIR_BASE_URL=https://hapi.fhir.org/baseR4
# Set to true to bypass live FHIR calls and read from backend/data/fhir_fallback/
# Writes become no-ops when true.
USE_FHIR_FALLBACK=false

# ── Whisper ───────────────────────────────────────────────────────────────────
# Options (accuracy vs speed on CPU): tiny.en | base.en | small.en | medium.en
WHISPER_MODEL_SIZE=base.en

# ── IBM Orchestrate ───────────────────────────────────────────────────────────
# Value must match the secret configured in the Orchestrate webhook definition.
ORCHESTRATE_SHARED_SECRET=replace-before-demo

# ── Feature Flags ─────────────────────────────────────────────────────────────
# false = bypass Supabase JWT verification; stub user injected for demo mode
AUTH_ENABLED=true
# T2201 form fields below this threshold are flagged for physician review
CONFIDENCE_THRESHOLD=0.75

# ── Deployment ────────────────────────────────────────────────────────────────
BACKEND_URL=https://warriors-backend.onrender.com
FRONTEND_URL=https://warriors-frontend.vercel.app

# ── Logging ───────────────────────────────────────────────────────────────────
# DEBUG | INFO | WARNING | ERROR
LOG_LEVEL=INFO
```

### `frontend/.env.example`

```bash
# All frontend env vars must be prefixed VITE_ to be included in the browser bundle.
# For Vercel deployments set these in: Project Settings → Environment Variables.

VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key

# Points to local FastAPI in dev; Render URL in production
VITE_API_BASE_URL=http://localhost:8000
```

---

## 8. Orchestrate ↔ Backend Contract

### Authentication

Every Orchestrate → FastAPI request must include:

```
X-Orchestrate-Secret: <value of ORCHESTRATE_SHARED_SECRET>
```

`backend/middleware/orchestrate_auth.py` validates this header on all `/api/orchestrate/*` routes before the route handler runs. A missing or incorrect value returns `401` immediately. JWT middleware is not applied to these routes.

### Single entry point

All phase transitions use one endpoint:

```
POST /api/orchestrate/advance-phase
```

Orchestrate does not call `/api/patients/…/context-brief` or similar routes directly. The `advance-phase` endpoint dispatches internally to the correct module based on `target_phase`.

### Request/response shapes

**Request** (defined in `PhaseAdvanceRequest`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `patient_id` | UUID | yes | |
| `appointment_id` | UUID | yes | |
| `target_phase` | `AppointmentPhase` | yes | The phase to transition *to* |
| `triggered_by` | `str` | yes | `"physician"` \| `"orchestrate"` \| `"system"` |
| `audio_file_path` | `str \| None` | conditional | Required when `target_phase == "during_appointment"` |

**Response** (defined in `PhaseAdvanceResponse`):

| Field | Type | Description |
|---|---|---|
| `appointment_id` | UUID | Echo of the request |
| `previous_phase` | `AppointmentPhase` | Phase before transition |
| `current_phase` | `AppointmentPhase` | Phase after transition |
| `next_action_url` | `str` | Relative URL for the frontend to subscribe to or poll |

### Completion signalling

The MVP uses a **synchronous response model**:

- `pre_appointment` → FastAPI generates the context brief inline and returns `200` only after the brief is persisted. Orchestrate treats `200` as "brief ready".
- `during_appointment` → FastAPI starts the Whisper background task and returns `200` immediately. Orchestrate does **not** wait for transcription to finish. The physician drives the transition to `post_appointment` by approving the SOAP note via the frontend.
- `post_appointment` → FastAPI generates the T2201 draft inline and returns `200` after it is persisted.
- `completed` → FastAPI writes FHIR resources inline and returns `200` after both FHIR resources are created.

There are no async callbacks from FastAPI to Orchestrate. Orchestrate learns the outcome from the HTTP response status code.

### Decision point locations

| Decision point | Evaluated in | Implementation detail |
|---|---|---|
| **Data completeness** — is the patient's FHIR record sufficient to generate a brief? | FastAPI (`context_engine.py`) | A brief is always generated regardless of completeness. Gaps are surfaced as `missing_data_flags` in `brief_json`. Orchestrate does not gate on data completeness; the physician decides whether to proceed. |
| **Intent routing** — which phase runs next? | Orchestrate | The Orchestrate state machine determines valid transitions and when to trigger them. FastAPI enforces guard conditions (see §4.6) but does not decide *which* phase to target. |
| **Confidence threshold** — are T2201 fields above 0.75? | FastAPI (`form_originator.py`) | Applied field-by-field during generation. Fields below `CONFIDENCE_THRESHOLD` are flagged in `form_json`. Orchestrate has no visibility into individual field confidence. The HITL gate at the approval step requires physician sign-off regardless of confidence scores. |

---

## 9. Repo Structure

```
IBM_AI_Lab/
│
├── README.md
│
├── docs/
│   ├── ARCHITECTURE.md           # System design, diagrams, data flow per phase
│   └── CONTRACTS.md              # This file
│
├── frontend/                     # React 18 + Vite SPA — deployed to Vercel
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard/
│   │   │   │   ├── PatientList.tsx
│   │   │   │   └── PatientCard.tsx
│   │   │   ├── ContextBrief/
│   │   │   │   ├── BriefView.tsx
│   │   │   │   └── MissingDataFlag.tsx
│   │   │   ├── Scribe/
│   │   │   │   ├── TranscriptPanel.tsx
│   │   │   │   ├── SOAPEditor.tsx
│   │   │   │   ├── BillingCodeSidebar.tsx
│   │   │   │   └── useSSEStream.ts
│   │   │   └── FormOriginator/
│   │   │       ├── T2201Form.tsx
│   │   │       ├── FieldRow.tsx
│   │   │       └── ConfidenceBadge.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   └── App.tsx
│   │   ├── lib/
│   │   │   ├── api.ts             # Typed fetch wrappers for every endpoint in §4
│   │   │   └── supabase.ts        # Supabase JS client singleton
│   │   ├── types/
│   │   │   └── index.ts           # TypeScript mirrors of every Pydantic model in §3
│   │   └── main.tsx
│   ├── .env.example
│   ├── vite.config.ts
│   └── package.json
│
├── backend/                      # FastAPI — deployed to Render
│   ├── main.py                   # App init, middleware registration, router mounts
│   ├── config.py                 # pydantic-settings Settings class; reads .env
│   ├── routers/
│   │   ├── patients.py           # GET /api/patients, GET /api/patients/{id}, PATCH workflow-state
│   │   ├── context_brief.py      # POST/GET /api/patients/{id}/context-brief, POST approve
│   │   ├── scribe.py             # POST start, GET stream (SSE), POST end
│   │   ├── soap_notes.py         # GET /api/patients/{id}/soap-note, PATCH, POST approve
│   │   ├── form_drafts.py        # POST/GET /api/patients/{id}/form-draft, PATCH, POST approve-and-sync
│   │   ├── orchestrate.py        # POST /api/orchestrate/advance-phase
│   │   ├── audit.py              # GET /api/audit-log
│   │   └── health.py             # GET /health
│   ├── models/
│   │   ├── enums.py              # WorkflowState, AppointmentPhase, FormType, AuditAction, SSEEventType
│   │   ├── patient.py
│   │   ├── appointment.py
│   │   ├── context_brief.py
│   │   ├── soap_note.py
│   │   ├── form_draft.py
│   │   ├── audit_log.py
│   │   └── orchestrate.py        # PhaseAdvanceRequest, PhaseAdvanceResponse
│   ├── services/
│   │   ├── llm.py                # generate() — Granite/watsonx wrapper
│   │   ├── fhir_client.py        # All FHIR reads and writes; fallback routing
│   │   ├── whisper_runner.py     # transcribe_chunks() — faster-whisper async wrapper
│   │   ├── audit.py              # log_action() helper
│   │   └── supabase_client.py    # get_client() singleton
│   ├── middleware/
│   │   ├── auth.py               # JWT verification; bypassed when AUTH_ENABLED=false
│   │   └── orchestrate_auth.py   # X-Orchestrate-Secret validation
│   ├── schemas/
│   │   └── t2201.json            # T2201 form field schema — input to Granite for form generation
│   ├── data/
│   │   ├── fhir_fallback/
│   │   │   ├── patient_WARRIOR-001.json
│   │   │   ├── conditions_WARRIOR-001.json
│   │   │   ├── observations_WARRIOR-001.json
│   │   │   ├── medications_WARRIOR-001.json
│   │   │   └── communications_WARRIOR-001.json
│   │   └── fhir_seed_ids.json    # FHIR server IDs written by seed_fhir.py
│   ├── .env.example
│   └── requirements.txt
│
├── orchestrate/
│   ├── workflow.yaml             # IBM Orchestrate phase state machine definition
│   └── README.md                 # How to import and configure in Orchestrate UI
│
└── scripts/
    ├── seed_fhir.py              # Idempotent FHIR seed for patient WARRIOR-001
    └── check_health.py           # Smoke test: hits /health and GET /api/patients
```

### Team ownership

| Path | Owner |
|---|---|
| `frontend/` | Hitaishi + Ajitha |
| `backend/routers/context_brief.py`, `backend/services/fhir_client.py` | Juan |
| `backend/routers/scribe.py`, `backend/services/whisper_runner.py` | Sunny |
| `backend/routers/form_drafts.py`, `backend/schemas/t2201.json`, `backend/services/llm.py` | Anahat |
| `backend/main.py`, `backend/models/`, `backend/middleware/`, `backend/services/supabase_client.py`, `backend/services/audit.py`, `backend/routers/health.py`, `backend/routers/audit.py` | Anahat (shared infra) |
| `orchestrate/` | Juan (lead) + team |
| `scripts/` | Shared |
| `docs/` | Shared |
