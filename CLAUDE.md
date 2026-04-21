# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

Ontario Family Physician AI Copilot — a three-phase agentic assistant for family physicians built for the IBM SkillsBuild AI Experiential Learning Lab (10-week hackathon). It automates pre-appointment briefing, live transcription + SOAP note generation, and post-appointment form filling (T2201 Disability Tax Credit Certificate).

**Authoritative docs:**
- `docs/ARCHITECTURE.md` — end-to-end workflow, data flows, DB schema, FHIR integration, Orchestrate role
- `docs/CONTRACTS.md` — every REST endpoint with request/response examples, Pydantic models, Postgres DDL, SSE event schemas, shared service signatures

---

## Development Commands

### Backend (FastAPI)
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in credentials
uvicorn main:app --reload --port 8000
```

OpenAPI docs available at `http://localhost:8000/docs` once running.

### Frontend (React + Vite)
```bash
cd frontend
npm install
cp .env.example .env.local    # set VITE_API_BASE_URL=http://localhost:8000
npm run dev      # :5173
npm run build    # tsc -b && vite build
npm run lint     # eslint
```

### Seed FHIR data (one-time, idempotent)
```bash
cd scripts
python seed_fhir.py
```

Creates fictional patient Sarah M. (MRN `WARRIOR-001`) on the HAPI FHIR public server and writes seeded IDs to `backend/data/fhir_seed_ids.json`.

### Demo mode (bypass auth + FHIR)
```bash
# backend/.env
AUTH_ENABLED=false
USE_FHIR_FALLBACK=true
```

`USE_FHIR_FALLBACK=true` reads from `backend/data/fhir_fallback/*.json` instead of the live HAPI server. FHIR writes become no-ops (logged only).

---

## Architecture

### Three-Phase Agent Pipeline

| Phase | Trigger (Orchestrate → FastAPI) | Key services |
|---|---|---|
| Pre-Appointment | `POST /context/brief` | `context_engine.py` → FHIR reads → Granite → `context_briefs` table |
| During-Appointment | `POST /scribe/start` | `scribe.py` (faster-whisper) → SSE stream + `soap_generator.py` → Granite → `soap_notes` table |
| Post-Appointment | `POST /forms/t2201` | FHIR re-query + approved SOAP → Granite → `form_drafts` table → FHIR write-back on approval |

**IBM Orchestrate** owns only the phase state machine (`pre → during → post → completed`) and HITL gates. All reasoning, FHIR interaction, and data transformation live in FastAPI. The frontend advances phases via `POST /workflow/advance` → Orchestrate → FastAPI webhook; it never calls FastAPI directly for phase transitions.

### Request Transport
- **REST** for all request/response interactions
- **SSE** (not WebSocket) for the scribe stream at `GET /api/patients/{id}/appointment/stream`. Six event types: `transcript_chunk`, `soap_update`, `billing_code_suggestion`, `stream_complete`, `error`, `heartbeat`.

### Key Backend Services

| File | Purpose |
|---|---|
| `backend/services/llm.py` | **Shared** Granite wrapper — `generate()` + `LLMError`. Only Sunny modifies this file; others call `generate()`. |
| `backend/services/fhir_client.py` | FHIR reads (Juan owns) + `write_composition`/`write_document_reference` (Anahat adds). Never change existing method signatures. |
| `backend/services/audit.py` | `log_action()` — swallows its own exceptions; never raises. Called from all phases. |
| `backend/services/context_engine.py` | Parallel FHIR queries (conditions, observations, medications, communications) → Granite summarization |
| `backend/services/scribe.py` | `transcribe_chunks()` via faster-whisper in 30s chunks with 5s overlap |
| `backend/services/soap_generator.py` | `update_soap()` every 5 transcript chunks; returns `{subjective, objective, assessment, plan}` + billing codes |

### Database (Supabase Postgres)

Six tables, all UUIDs, all append-only versioned:
`patients`, `appointments`, `context_briefs`, `soap_notes`, `form_drafts`, `audit_log`

**Versioning pattern:** New rows get `version = current_max + 1`; previous row gets `superseded_by = new_id`. Always fetch `WHERE superseded_by IS NULL` for current version.

**T2201 confidence threshold:** Fields with `confidence < 0.75` (configurable via `CONFIDENCE_THRESHOLD` env var) are flagged for physician review. Fields at `confidence = 0.0` are always blank — never pre-filled.

### Ownership

| Person | Area | Key files |
|---|---|---|
| Anahat | Core infra + Post-Appointment | `main.py`, `config.py`, `models/*.py`, `middleware/`, `supabase_client.py`, `api/form_drafts.py`, `api/patients.py`, `supabase/migrations/` |
| Juan | Pre-Appointment + Orchestrate | `api/context_briefs.py`, `api/orchestrate.py`, `services/context_engine.py`, `services/fhir_client.py` (reads), `orchestrate/workflows/`, `scripts/seed_fhir.py` |
| Sunny | During-Appointment | `api/appointments.py`, `services/scribe.py`, `services/soap_generator.py`, `services/llm.py`, `services/audit.py`, `api/health.py` |
| Hitaishi + Ajitha | All frontend | Everything under `frontend/` |

---

## Sunny's Implementation Plan

Build in this order. Each step unblocks the next, and steps 1–3 unblock teammates.

### Step 1 — `backend/services/llm.py` (stub first, real second)

**Why first:** Juan and Anahat both import `generate()`. Nothing else can be tested until this exists.

Commit the stub immediately on its own branch (`feature/sunny-llm-stub`):
```python
async def generate(prompt, system="", response_model=None, max_tokens=1024):
    if response_model is not None:
        return response_model.model_validate({})
    return "stub response"

class LLMError(Exception): ...
```

Then replace with the real watsonx implementation (full spec in `docs/CONTRACTS.md §6 llm.py`):
- SDK: `ibm-watsonx-ai` (add to `requirements.txt`)
- Singleton `ModelInference` instantiated on first call, stored in module-level `_model`
- If `response_model` is passed: appends JSON schema instructions to system prompt, strips markdown fences from response, validates with `response_model.model_validate_json()`
- Raises `LLMError` on non-2xx or unparseable response

### Step 2 — `backend/api/health.py`

One endpoint, no dependencies, no auth, no DB. Gets the Render keep-alive working and unblocks the team's smoke test:
```python
GET /health → {"status": "ok"}
```

### Step 3 — `backend/services/audit.py`

Single async function `log_action(actor_id, action, resource_type, resource_id, appointment_id, metadata)`. INSERTs into `audit_log` via Supabase client. **Must swallow all exceptions** — wrap the entire body in `try/except Exception` and log to stderr. Never raises. Full signature in `docs/CONTRACTS.md §6 audit.py`.

> Depends on: Anahat's `supabase_client.py` and `models/enums.py` being merged first.

### Step 4 — `backend/services/soap_generator.py`

- `SOAP_SYSTEM_PROMPT` constant (full text in `docs/CONTRACTS.md §6 soap_generator.py`)
- `SOAPUpdateResult(BaseModel)` with fields `soap: SOAPContent` and `billing_codes: list[BillingCode]`
- `update_soap(current_soap, new_segment, full_transcript) → tuple[SOAPContent, list[BillingCode]]`
  - Calls `llm.generate(..., response_model=SOAPUpdateResult)`
  - Does NOT deduplicate billing codes — caller handles that
  - Raises `LLMError` on failure (caller emits SSE error event and continues)

### Step 5 — `backend/services/scribe.py` (whisper_runner)

- `transcribe_chunks(audio_path, chunk_seconds=30, overlap_seconds=5) → AsyncGenerator`
- Yields: `{chunk_index: int, text: str, start_ms: int, end_ms: int, is_final: bool}`
- Run faster-whisper synchronous calls in `asyncio.get_event_loop().run_in_executor()` to avoid blocking the event loop
- `is_final=True` on last segment
- Raises `WhisperError` on model load or segment failure

> `WHISPER_MODEL_SIZE` comes from `settings.whisper_model_size` (default `"base.en"`).

### Step 6 — `backend/api/appointments.py`

Six endpoints (all under `/api/patients/{id}/...`), spec in `docs/CONTRACTS.md §4.4`:

| Endpoint | Notes |
|---|---|
| `POST /appointment/start` | Validates audio file exists, stores path on appointment, spawns Whisper background task |
| `GET /appointment/stream` | SSE — JWT via `?token=` query param; sends `: ping` every 15s; emits `transcript_chunk`, `soap_update`, `billing_code_detected`, `lab_requisition_queued`, `done` |
| `POST /appointment/end` | Finalises and persists SOAP note to `soap_notes` table; returns full `SOAPNote` |
| `GET /soap-note` | Returns current (`superseded_by IS NULL`) SOAP note for patient's active appointment |
| `PATCH /soap-notes/{id}` | Inline partial edit; 409 if already approved |
| `POST /soap-notes/{id}/approve` | Sets `approved=true`; notifies Orchestrate to advance phase |

SSE stream drives a background task that:
1. Iterates `transcribe_chunks()` → emits `transcript_chunk` events
2. Every 5 chunks calls `update_soap()` → emits `soap_update` event
3. On `is_final=True` → emits `done` event

---

## Git Workflow

- Branch naming: `feature/<owner>-<short-description>` (e.g., `feature/sunny-sse-stream`)
- No direct push to `main` — all changes via PR
- Squash-merge all PRs into `main`
- Any change to `docs/CONTRACTS.md` requires team notification before merging
