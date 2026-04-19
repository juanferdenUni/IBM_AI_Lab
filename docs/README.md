# Ontario Family Physician AI Copilot

**Team:** Warriors — IBM SkillsBuild AI Experiential Learning Lab  
**Hackathon:** 10-week healthcare AI track

An agentic AI copilot for Ontario family physicians that automates administrative documentation across the full appointment lifecycle — from pre-visit patient briefing to post-visit form completion.

---

## The Problem

Dr. Sarah Smith is a family physician in Mississauga. She sees patients for 10 hours a day and then spends 9+ more hours on paperwork — summarizing patient history before visits, transcribing notes after them, and filling out multi-page government forms like the T2201 Disability Tax Credit Certificate. None of that time is billable under OHIP.

Existing tools (EMR dictation, first-gen AI scribes) automate individual tasks but leave the physician responsible for stitching everything together. This product handles the orchestration.

---

## What It Does

Three AI-powered phases, one unified dashboard:

**1. Pre-Appointment Context Engine**  
Queries the patient's FHIR records (labs, conditions, medications, correspondence) and produces a structured clinical brief before the patient walks in. Missing data is flagged explicitly.

**2. Active Reasoning Scribe**  
Transcribes a pre-recorded appointment audio file via Whisper, streaming the transcript live to the dashboard. In parallel, IBM Granite drafts and updates a SOAP note (Subjective / Objective / Assessment / Plan) and extracts OHIP billing codes in real time.

**3. Autonomous Form Originator**  
After the appointment, maps the approved SOAP note and full patient history to the T2201 form fields. Each field gets a confidence score — low-confidence fields are highlighted for physician review.

Sarah reviews, edits, and approves all three outputs before anything is written back to the EMR.

---

## Tech Stack

| Layer | Technology |
|---|---|
| LLM | IBM Granite 3.x via watsonx |
| Backend | Python 3.11 + FastAPI |
| Database | Supabase (Postgres + Auth) |
| Frontend | React 18 + Vite |
| Frontend hosting | Vercel |
| Speech-to-Text | faster-whisper (local) |
| Mock EMR | HAPI FHIR public server (R4) |
| Orchestration | IBM Orchestrate |
| Backend hosting | Render free tier |

---

## Local Development

### Prerequisites

- Python 3.11+
- Node.js 20+
- A Supabase project (free tier is fine)
- IBM watsonx API key and project ID

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in credentials
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local    # set VITE_API_BASE_URL=http://localhost:8000
npm run dev                   # runs on :5173
```

### Seed FHIR data (one-time)

```bash
cd scripts
python seed_fhir.py
```

This creates the fictional patient Sarah M. (MRN `WARRIOR-001`) on the HAPI FHIR public server. The script is idempotent — safe to re-run.

### Demo mode (no auth, no live FHIR)

```bash
# backend/.env
AUTH_ENABLED=false
USE_FHIR_FALLBACK=true
```

`AUTH_ENABLED=false` bypasses Supabase JWT verification.  
`USE_FHIR_FALLBACK=true` reads from `backend/data/fhir_fallback/` instead of the live HAPI server.

---

## Repo Structure

```
IBM_AI_Lab/
├── frontend/        # React + Vite SPA → deployed to Vercel
├── backend/         # FastAPI app → deployed to Render
├── orchestrate/     # IBM Orchestrate workflow definition
├── scripts/         # FHIR seed + smoke tests
└── docs/
    ├── ARCHITECTURE.md   # System design, diagrams, data flows, DB schema
    └── CONTRACTS.md      # API endpoints, Pydantic models, DDL, SSE schemas
```

---

## Team

| Name | Role |
|---|---|
| Hitaishi | Frontend |
| Ajitha | Frontend |
| Juan | Pre-Appointment (Context Engine) + IBM Orchestrate |
| Sunny | During Appointment (Scribe, Whisper, SSE) |
| Anahat | Post-Appointment (Form Originator) + shared backend infra |

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the system works: three-phase agent design, end-to-end workflow, Mermaid diagrams, HAPI FHIR integration, IBM Orchestrate role, security posture, deployment details.
- **[docs/CONTRACTS.md](docs/CONTRACTS.md)** — what to code against: every REST endpoint with request/response examples, Pydantic models, Postgres DDL, SSE event schemas, shared service signatures, environment variables.

---

## Out of Scope

This is a 10-week hackathon MVP. The following are explicitly not built:

- Live microphone streaming (pre-recorded audio only)
- Real EMR integration (OSCAR, TELUS PS Suite)
- PHIPA compliance
- Multi-physician or concurrent sessions
- Real patient data (all data is fictional)
