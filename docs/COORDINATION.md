# Team Coordination

**Team:** Warriors — IBM SkillsBuild AI Experiential Learning Lab  
**Scope:** Weeks 6–8 execution plan, ownership, handoffs, and done criteria.  
**Last updated:** 2026-04-19

Reference documents:
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system design and data flow
- [`docs/CONTRACTS.md`](CONTRACTS.md) — API contracts, Pydantic models, DDL, SSE schemas

---

## Table of Contents

1. [Team & Ownership Matrix](#1-team--ownership-matrix)
2. [Handoff Points](#2-handoff-points)
3. [File Contracts by Owner](#3-file-contracts-by-owner)
4. [Git Workflow](#4-git-workflow)

---

## 1. Team & Ownership Matrix

| Person | Feature area | Files owned | Explicitly NOT responsible for |
|---|---|---|---|
| **Hitaishi + Ajitha** | Frontend — all UI for all three phases, unified review dashboard, Supabase JS client, Vercel deploy | All files under `frontend/` | Any file under `backend/`, `orchestrate/`, or `scripts/` |
| **Juan** | Pre-Appointment (Context Engine, FHIR queries, Granite summarization, `context_briefs` persistence) + IBM Orchestrate workflow owner | `backend/api/context_briefs.py`, `backend/api/orchestrate.py`, `backend/services/context_engine.py`, `backend/services/fhir_client.py` (primary), `backend/data/fhir_fallback/*.json`, `orchestrate/workflows/*`, `scripts/seed_fhir.py` | Whisper, SSE streaming, T2201 mapping, shared Pydantic models, DB migrations, auth middleware |
| **Sunny** | During-Appointment (Whisper integration, SSE streaming, SOAP generation via Granite, `soap_notes` persistence) + **shared LLM wrapper + audit service + health endpoint** | `backend/api/appointments.py`, `backend/services/scribe.py`, `backend/services/soap_generator.py`, `backend/services/llm.py` (primary), `backend/services/audit.py`, `backend/api/health.py`, `backend/data/demo_audio.mp3` | FHIR reads/writes, T2201 mapping, Orchestrate config, shared Pydantic models, DB migrations, auth middleware |
| **Anahat** | Post-Appointment (Form Originator, T2201 mapping, confidence scoring, FHIR write-back) + **core shared backend infrastructure** | `backend/main.py`, `backend/config.py`, `backend/models/*.py`, `backend/middleware/auth.py`, `backend/middleware/orchestrate_auth.py`, `backend/services/supabase_client.py`, `backend/api/form_drafts.py`, `backend/api/patients.py`, `backend/api/audit.py`, `backend/schemas/t2201.json`, all Supabase migration files, Render deployment config | Frontend, Orchestrate workflow YAML, Whisper, SSE streaming, `llm.py`, `audit.py`, `health.py`, `seed_fhir.py` |

### Shared files — primary owner named

| File | Primary owner | Who else may touch it | Rule |
|---|---|---|---|
| `backend/services/fhir_client.py` | Juan | Anahat (EMR write-back in `form_drafts.py` calls it) | Juan owns the interface and all read methods. Anahat adds `write_composition` and `write_document_reference` without changing existing method signatures. |
| `backend/services/llm.py` | Sunny | Juan (context engine calls it), Anahat (form originator calls it) | Sunny owns the file. Juan and Anahat call `generate()` — they do not modify `llm.py`. If a change is needed, raise it in the channel so Sunny can make it. |
| `backend/api/patients.py` | Anahat | Nobody else modifies it | Anahat provides `GET /api/patients`, `GET /api/patients/{id}`, and `PATCH /api/patients/{id}/workflow-state`. Other routers read patients via Supabase directly or call these endpoints. |
| `docs/CONTRACTS.md` | Shared | Anyone | Changes require a message in the team channel before the PR. No silent contract changes. |

---

## 2. Handoff Points

Each row is a concrete, verifiable handoff. The receiver should not need to ask clarifying questions.

| From | To | What is handed off | Verification |
|---|---|---|---|
| **Anahat** | Juan + Sunny | `backend/models/*.py` committed to `main`. All models importable. | `from backend.models.soap_note import SOAPNote` raises no error. |
| **Anahat** | Juan + Sunny | All six Supabase tables exist with correct schema. | `SELECT * FROM context_briefs LIMIT 1` runs without error in Supabase SQL editor. |
| **Anahat** | Juan + Sunny | `backend/services/supabase_client.py` returns a working `AsyncClient`. | `get_client()` called in a test script returns a client that can execute `SELECT 1`. |
| **Sunny** | Juan + Anahat | `backend/services/llm.py` `generate()` callable with real Granite response. | `generate("hello")` returns a non-empty string from watsonx. |
| **Sunny** | Everyone | `GET /health` live on Render. | `curl https://<render-url>/health` returns `{"status": "ok"}`. |
| **Juan** | Anahat | `fhir_client.py` `write_composition` and `write_document_reference` interface agreed. | Interface matches `CONTRACTS.md §6` signatures exactly before Anahat implements the callers. |
| **Juan** | Sunny | `GET /api/patients/{id}/context-brief` returns an approved `ContextBrief`. | Sunny's scribe endpoint reads the brief to seed SOAP context; `approved=true` is the gate. |
| **Juan** | Frontend | `GET /api/patients/{id}/context-brief` returns JSON matching `ContextBrief` type. | Frontend replaces mock with real call; TypeScript type check passes. |
| **Sunny** | Anahat | `GET /api/patients/{id}/soap-note` returns an approved `SOAPNote`. | Anahat's Form Originator fetches `soap_note_id` from this endpoint. `approved=true` is the gate. |
| **Sunny** | Frontend | SSE stream at `GET /api/patients/{id}/appointment/stream` emits all event types from `CONTRACTS.md §5`. | Frontend `useSSEStream` hook receives `transcript_chunk` and `soap_update` events without errors. |
| **Anahat** | Frontend | `GET /api/patients/{id}/form-draft` returns JSON matching `FormDraft` type. | Frontend renders T2201 form with confidence badges; TypeScript type check passes. |
| **Everyone** | Frontend | FastAPI `/docs` OpenAPI spec matches `CONTRACTS.md §4`. | Frontend engineer runs `GET /docs` and confirms all endpoints and response shapes are present. |
| **Juan** | Everyone | `POST /api/orchestrate/advance-phase` correctly advances all four phases. | Demo flow runs start-to-finish triggered through Orchestrate, not direct API calls. |

---

## 3. File Contracts by Owner

A file listed here is owned by exactly one person. "May touch" means they can open a PR modifying that file, but must get the primary owner's review approval.

### Anahat

| File | Spec in CONTRACTS.md | Notes |
|---|---|---|
| `backend/main.py` | §6 `main.py` | Copy the router-mount structure verbatim from the spec; do not add extra logic here |
| `backend/config.py` | §6 `config.py` | All env vars are listed; add no new vars without updating §7 |
| `backend/models/enums.py` | §3.1 Enums | All five enum classes defined there |
| `backend/models/patient.py` | §3.2 Patient | `PatientCreate`, `PatientUpdate`, `Patient` |
| `backend/models/appointment.py` | §3.3 Appointment | `AppointmentCreate`, `Appointment` |
| `backend/models/context_brief.py` | §3.4 Context Brief | `LabResult`, `Correspondence`, `BriefContent`, `ContextBriefCreate`, `ContextBrief` |
| `backend/models/soap_note.py` | §3.5 SOAP Note | `SOAPContent`, `BillingCode`, `SOAPNoteCreate`, `SOAPNoteUpdate`, `SOAPNote` |
| `backend/models/form_draft.py` | §3.6 Form Draft | `FormFieldValue`, `FormDraftCreate`, `FormDraftUpdate`, `FormDraft` |
| `backend/models/audit_log.py` | §3.7 Audit Log | `AuditLogEntry` |
| `backend/models/orchestrate.py` | §3.8 Orchestrate | `PhaseAdvanceRequest` (with validator), `PhaseAdvanceResponse` |
| `backend/services/supabase_client.py` | §6 `supabase_client.py` | Singleton pattern; use `AsyncClient` |
| `backend/middleware/auth.py` | §6 `auth.py` | Implements `auth_dependency`; respects `AUTH_ENABLED` flag |
| `backend/middleware/orchestrate_auth.py` | §6 `orchestrate_auth.py` | Implements `orchestrate_auth_dependency`; validates `X-Orchestrate-Secret` |
| `backend/api/patients.py` | §4.2 Patients | Three endpoints: `GET /patients`, `GET /patients/{id}`, `PATCH /patients/{id}/workflow-state` |
| `backend/api/form_drafts.py` | §4.5 Form Originator | Four endpoints: POST generate, GET latest, PATCH fields, POST approve-and-sync |
| `backend/api/audit.py` | §4.7 Audit Log | One endpoint: `GET /audit-log` |
| `backend/schemas/t2201.json` | §6 `t2201.json` | 14 fields specified; do not add fields not in the spec |
| `supabase/migrations/001_initial.sql` | §2 Database Schema (DDL) | Copy the full DDL block verbatim; run in Supabase SQL editor to verify |
| `backend/requirements.txt` | — | Pin all versions; include: fastapi, uvicorn, pydantic, pydantic-settings, supabase, httpx, faster-whisper, python-jose, python-multipart |
| `render.yaml` | — | Start command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`; Python 3.11 |

### Juan

| File | Spec in CONTRACTS.md | Notes |
|---|---|---|
| `backend/api/context_briefs.py` | §4.3 Context Engine | Four endpoints: POST generate, GET latest, GET history, POST approve |
| `backend/api/orchestrate.py` | §4.6 Orchestrate Integration | One endpoint: `POST /orchestrate/advance-phase`; uses `orchestrate_auth_dependency` |
| `backend/services/context_engine.py` | §6 `context_engine.py` | `generate_brief(patient_id, appointment_id)` — FHIR queries + Granite call |
| `backend/services/fhir_client.py` | §6 `fhir_client.py` | Juan writes all 6 read methods + `FHIRError`; Anahat adds `write_composition` and `write_document_reference` in a separate PR without touching existing signatures |
| `backend/data/fhir_fallback/*.json` | §6 `fhir_fallback/*.json` | 5 files; each is a real FHIR Bundle JSON copied from actual HAPI responses after seed |
| `orchestrate/workflows/main_workflow.yaml` | §6 `main_workflow.yaml` | State machine table and HITL gates are fully specified; implement in Orchestrate UI |
| `orchestrate/README.md` | — | How to import the workflow YAML into Orchestrate and set the webhook URL |
| `scripts/seed_fhir.py` | §6 `seed_fhir.py` | All seed values hardcoded in the spec; writes IDs to `backend/data/fhir_seed_ids.json` |

### Sunny

| File | Spec in CONTRACTS.md | Notes |
|---|---|---|
| `backend/api/appointments.py` | §4.4 Active Scribe | Six endpoints: POST start, GET stream (SSE), POST end, GET soap-note, PATCH soap-note, POST approve |
| `backend/services/scribe.py` | §6 `whisper_runner.py` | File is named `scribe.py` in the repo; function is `transcribe_chunks()` |
| `backend/services/soap_generator.py` | §6 `soap_generator.py` | `update_soap()` + `SOAPUpdateResult` + `SOAP_SYSTEM_PROMPT` constant |
| `backend/services/llm.py` | §6 `llm.py` | `generate()` + `LLMError`; stub first (returns hardcoded string), real watsonx call in week 7 |
| `backend/services/audit.py` | §6 `audit.py` | `log_action()` — swallows its own exceptions; never raises |
| `backend/api/health.py` | §4.8 Health | One endpoint: `GET /health`; no auth, no DB |
| `backend/data/demo_audio.mp3` | — | ~7-min pre-recorded doctor-patient roleplay; committed to repo; tested on Render before demo |

### Hitaishi + Ajitha

| File | Spec in CONTRACTS.md | Notes |
|---|---|---|
| `frontend/src/types/index.ts` | §3 Pydantic Models | TypeScript interface for every model; keep in sync with any contract changes |
| `frontend/src/lib/api.ts` | §4 REST API Endpoints | Typed fetch wrapper per endpoint; return mocked data until backend is live |
| `frontend/src/lib/supabase.ts` | §7 frontend env vars | `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)` singleton |
| `frontend/src/components/Scribe/useSSEStream.ts` | §5 SSE Event Schemas | Hook subscribes to `/appointment/stream?token=<jwt>`; handles all 6 event types |
| `frontend/.env.example` | §7 Environment Variables | Must contain exactly `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL` |
| All other `frontend/` files | §4 endpoint shapes + §3 model shapes | No other files are specified centrally; frontend team has full autonomy |

---

## 4. Git Workflow

### Branch naming

```
feature/<owner>-<short-description>
```

Examples:

| Branch | Owner |
|---|---|
| `feature/anahat-pydantic-models` | Anahat |
| `feature/anahat-supabase-migration` | Anahat |
| `feature/juan-context-engine` | Juan |
| `feature/juan-orchestrate-workflow` | Juan |
| `feature/sunny-whisper-scribe` | Sunny |
| `feature/sunny-sse-stream` | Sunny |
| `feature/frontend-scaffolding` | Hitaishi + Ajitha |
| `feature/frontend-real-endpoints` | Hitaishi + Ajitha |

### Rules

| Rule | Detail |
|---|---|
| No direct push to `main` | All changes via PR |
| Frontend and backend PRs are independent | No need to coordinate frontend and backend PRs; they don't share files |
| Contract changes need team notification | Any change to `docs/CONTRACTS.md` must be posted in the team channel before merging |

### Merge strategy

Squash-merge all PRs into `main` so `git log` on `main` is readable.

