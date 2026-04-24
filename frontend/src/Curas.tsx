import { useState, useEffect, useRef, type ReactNode } from "react";
import { DEMO_MODE } from "./config";
import { api } from "./lib/api";

const TEAL = "#0F6E56";
const TEAL_LIGHT = "#E1F5EE";
const TEAL_MID = "#1D9E75";
const TEAL_DARK = "#085041";
const BLUE = "#185FA5";
const BLUE_LIGHT = "#E6F1FB";
const AMBER = "#BA7517";
const AMBER_LIGHT = "#FAEEDA";
const GREEN = "#3B6D11";
const GREEN_LIGHT = "#EAF3DE";
const RED_LIGHT = "#FCEBEB";
const RED = "#A32D2D";
const GRAY_BG = "#F1EFE8";
const GRAY_DARK = "#444441";
const GRAY_MID = "#888780";

const PHYSICIAN_NAME = "Dr. Sarah Mitchell";

// ─── Types (mirrors backend CONTRACTS.md §3.2) ────────────────────────────────

interface Patient {
  id: string;
  fhir_id: string;
  mrn: string;
  display_name: string;
  date_of_birth: string;
  physician_id: string;
  workflow_state: string;
  created_at: string;
  updated_at: string;
  // UI-only display fields
  apptTime?: string;
  apptType?: string;
  lastVisit?: string;
}

interface ContextItem {
  label: string;
  value: string;
  status: string;
}

interface EmrDoc {
  name: string;
}

interface SoapLine {
  label: string;
  color: string;
  bg: string;
  text: string;
}

interface FormField {
  id: string;
  label: string;
  value: string;
  confidence: number;
}

// ─── Demo Data (used only when DEMO_MODE=true) ────────────────────────────────

const DEMO_PATIENTS: Patient[] = [
  {
    id: "demo-1",
    fhir_id: "hapi-patient-demo-1",
    mrn: "WARRIOR-001",
    display_name: "Sarah M.",
    date_of_birth: "1978-07-22",
    physician_id: "demo-physician",
    workflow_state: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    apptTime: "9:00 AM",
    apptType: "Follow-up — Type 2 Diabetes",
    lastVisit: "Oct 12, 2024",
  },
  {
    id: "demo-2",
    fhir_id: "hapi-patient-demo-2",
    mrn: "DEMO-002",
    display_name: "James O.",
    date_of_birth: "1958-07-22",
    physician_id: "demo-physician",
    workflow_state: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    apptTime: "10:30 AM",
    apptType: "Annual Physical",
    lastVisit: "Jan 8, 2025",
  },
  {
    id: "demo-3",
    fhir_id: "hapi-patient-demo-3",
    mrn: "DEMO-003",
    display_name: "Linda T.",
    date_of_birth: "1983-11-05",
    physician_id: "demo-physician",
    workflow_state: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    apptTime: "11:45 AM",
    apptType: "Hypertension Check",
    lastVisit: "Feb 20, 2025",
  },
];

const DEMO_CONTEXT_ITEMS: ContextItem[] = [
  { label: "Last HbA1c",  value: "7.2% — Jan 2025",                  status: "ok"     },
  { label: "Pending",     value: "ODSP form renewal",                 status: "warn"   },
  { label: "Recent fax",  value: "Cardiology consult results",        status: "ok"     },
  { label: "Missing",     value: "Updated medication list",           status: "danger" },
  { label: "Active Rx",   value: "Metformin 1000mg, Lisinopril 10mg", status: "ok"     },
  { label: "Allergies",   value: "Penicillin (severe)",               status: "danger" },
];

const DEMO_EMR_DOCS: EmrDoc[] = [
  { name: "Lab Results — Jan 2025" },
  { name: "Cardiology Consult Fax" },
  { name: "Prescription History"   },
  { name: "ODSP Renewal Form"      },
];

const DEMO_SOAP_LINES: SoapLine[] = [
  { label: "S", color: BLUE,  bg: BLUE_LIGHT,  text: "Patient reports fatigue, increased thirst over past 3 weeks. Denies chest pain. Concerned about ODSP renewal." },
  { label: "O", color: TEAL,  bg: TEAL_LIGHT,  text: "BP 128/82, HR 74 bpm, Temp 36.8°C. Weight 83kg (stable). HbA1c Jan 2025: 7.2%. Cardiology fax reviewed — no acute findings." },
  { label: "A", color: AMBER, bg: AMBER_LIGHT, text: "T2DM, stable but symptomatic fatigue. Rule out anemia. ODSP renewal required. Cardiology follow-up noted." },
  { label: "P", color: GREEN, bg: GREEN_LIGHT, text: "Req. HbA1c, CBC. Refer back to cardiology if symptoms worsen. Complete ODSP form. RTC 3 months." },
];

const DEMO_FORM_FIELDS: FormField[] = [
  { id: "f1",  label: "Patient Full Name",        value: "Sarah M.",                                            confidence: 99 },
  { id: "f2",  label: "Date of Birth",            value: "July 22, 1978",                                       confidence: 99 },
  { id: "f3",  label: "MRN",                      value: "WARRIOR-001",                                         confidence: 99 },
  { id: "f4",  label: "Primary Diagnosis",        value: "Type 2 Diabetes Mellitus (E11.9)",                    confidence: 97 },
  { id: "f5",  label: "Treating Physician",       value: PHYSICIAN_NAME,                                        confidence: 99 },
  { id: "f6",  label: "Functional Limitations",   value: "Moderate fatigue limiting sustained activity > 2hrs", confidence: 84 },
  { id: "f7",  label: "Duration of Condition",    value: "Diagnosed 2019 (approx. 7 years)",                    confidence: 91 },
  { id: "f8",  label: "Current Medications",      value: "Metformin 1000mg BID, Ramipril 5mg OD",               confidence: 96 },
  { id: "f9",  label: "Last Specialist Visit",    value: "Cardiology — April 2026",                             confidence: 88 },
  { id: "f10", label: "Prognosis / Permanence",   value: "Chronic, ongoing — not expected to resolve",          confidence: 78 },
  { id: "f11", label: "Physician Signature Date", value: "",                                                     confidence: 0  },
  { id: "f12", label: "Additional Notes",         value: "Patient requires follow-up HbA1c in 3 months",        confidence: 82 },
];

// ─── Shared Components ────────────────────────────────────────────────────────

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.split(" ").map((w: string) => w[0]).join("").slice(0, 2);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: TEAL_LIGHT, color: TEAL_DARK,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 600, fontSize: size * 0.35, flexShrink: 0,
      fontFamily: "'DM Sans', sans-serif",
    }}>{initials}</div>
  );
}

function Badge({ children, color = TEAL, bg = TEAL_LIGHT }: { children: ReactNode; color?: string; bg?: string }) {
  return (
    <span style={{
      background: bg, color, fontSize: 11, fontWeight: 600,
      padding: "2px 8px", borderRadius: 20, letterSpacing: "0.03em",
      fontFamily: "'DM Sans', sans-serif",
    }}>{children}</span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 90 ? GREEN : value >= 75 ? AMBER : RED;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: "#e5e7eb", borderRadius: 99 }}>
        <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 600, minWidth: 28, fontFamily: "'DM Mono', monospace" }}>{value}%</span>
    </div>
  );
}

function AppHeader({ patient, onBackToList }: { patient: Patient | null; onBackToList: (() => void) | null }) {
  return (
    <>
      <div style={{
        background: TEAL_DARK, padding: "10px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700, color: "#fff", fontSize: 15 }}>Curas AI</div>
          {DEMO_MODE && (
            <span style={{ fontSize: 11, padding: "2px 8px", background: AMBER_LIGHT, color: AMBER, borderRadius: 20, fontWeight: 600 }}>DEMO</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
          {new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </div>
      </div>
      {patient && (
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "12px 24px", background: "#fff",
          borderBottom: "0.5px solid #e5e7eb",
          fontFamily: "'DM Sans', sans-serif",
        }}>
          {onBackToList && (
            <button onClick={onBackToList} style={{
              background: "none", border: "none", color: TEAL, cursor: "pointer",
              fontSize: 13, fontWeight: 600, padding: 0, marginRight: 4,
              fontFamily: "'DM Sans', sans-serif",
            }}>← Patient List</button>
          )}
          <Avatar name={patient.display_name} size={38} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: GRAY_DARK }}>{patient.display_name}</div>
            <div style={{ fontSize: 12, color: GRAY_MID }}>
              DOB: {new Date(patient.date_of_birth).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })} · MRN: {patient.mrn}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEAL }}>
              {patient.apptTime ? `${patient.apptTime} — ` : ""}{patient.apptType ?? "Appointment"}
            </div>
            <div style={{ fontSize: 12, color: GRAY_MID }}>
              {PHYSICIAN_NAME}{patient.lastVisit ? ` · Last visit: ${patient.lastVisit}` : ""}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PhaseHeader({ phase }: { phase: string }) {
  const phases = [
    { key: "pre",    label: "Pre-Appointment",    sub: "Context Engine"  },
    { key: "during", label: "During Appointment", sub: "Active Scribe"   },
    { key: "post",   label: "Post-Appointment",   sub: "Form Originator" },
  ];
  const order = ["pre", "during", "post"];
  const currentIdx = order.indexOf(phase);
  return (
    <div style={{ display: "flex", borderBottom: `1.5px solid ${TEAL_DARK}`, background: TEAL_DARK, fontFamily: "'DM Sans', sans-serif" }}>
      {phases.map((p, i) => {
        const active = p.key === phase;
        const done = i < currentIdx;
        return (
          <div key={p.key} style={{
            flex: 1, padding: "14px 0 10px", textAlign: "center",
            background: active ? TEAL_MID : done ? "rgba(255,255,255,0.08)" : "transparent",
            borderRight: i < 2 ? `1px solid rgba(255,255,255,0.15)` : "none",
          }}>
            <div style={{ fontSize: 11, color: active ? "#fff" : done ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.4)", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {done ? "✓ " : ""}{p.label}
            </div>
            <div style={{ fontSize: 13, color: active ? "#fff" : "rgba(255,255,255,0.5)", marginTop: 2, fontWeight: 500 }}>{p.sub}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 1. PATIENT LIST ──────────────────────────────────────────────────────────

function PatientList({ onSelect }: { onSelect: (p: Patient) => void }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) {
      setPatients(DEMO_PATIENTS);
      setLoading(false);
      return;
    }
    api.getPatients()
      .then(data => { setPatients(data); setLoading(false); })
      .catch(err => {
        console.error("Failed to fetch patients:", err);
        setError("Could not load patients. Check backend connection.");
        setLoading(false);
      });
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 700, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: GRAY_DARK }}>Today's Appointments</div>
        <div style={{ fontSize: 13, color: GRAY_MID, marginTop: 4 }}>
          {new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · {PHYSICIAN_NAME}
        </div>
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: GRAY_MID, fontSize: 13 }}>Loading patients...</div>}

      {error && (
        <div style={{ padding: "10px 14px", background: RED_LIGHT, border: `1px solid ${RED}`, borderRadius: 8, fontSize: 13, color: RED, marginBottom: 16 }}>⚠ {error}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {patients.map((p) => (
          <div key={p.id} style={{
            background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12,
            padding: "16px 20px", display: "flex", alignItems: "center", gap: 16,
            cursor: "pointer", transition: "box-shadow 0.2s",
          }}
            onClick={() => onSelect(p)}
            onMouseEnter={e => (e.currentTarget.style.boxShadow = `0 2px 12px rgba(15,110,86,0.12)`)}
            onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}
          >
            <Avatar name={p.display_name} size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: GRAY_DARK }}>{p.display_name}</div>
              <div style={{ fontSize: 12, color: GRAY_MID, marginTop: 2 }}>
                DOB: {new Date(p.date_of_birth).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })} · MRN: {p.mrn}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: TEAL }}>{p.apptTime ?? "—"}</div>
              <div style={{ fontSize: 12, color: GRAY_MID, marginTop: 2 }}>{p.apptType ?? p.workflow_state}</div>
            </div>
            <div style={{ padding: "6px 14px", background: TEAL, color: "#fff", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
              Start →
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 2. PRE-APPOINTMENT ───────────────────────────────────────────────────────

function PreAppointment({ patient, appointmentId, onNext }: {
  patient: Patient;
  appointmentId: string | null;
  onNext: (briefId?: string) => void;
}) {
  const [loadStep, setLoadStep] = useState(0);
  const [started, setStarted] = useState(false);
  const [contextItems, setContextItems] = useState<ContextItem[]>(DEMO_CONTEXT_ITEMS);
  const [briefId, setBriefId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!started) return;
    if (DEMO_MODE) {
      [500, 900, 1400, 1900].forEach((delay, i) => setTimeout(() => setLoadStep(i + 1), delay));
      return;
    }
    if (!appointmentId) { setError("Missing appointment ID"); return; }
    setLoading(true);
    api.generateContextBrief(patient.id, appointmentId)
      .then(brief => {
        setBriefId(brief.id);
        const items: ContextItem[] = [];
        brief.brief_json.chronic_conditions.forEach((c: string) =>
          items.push({ label: "Condition", value: c, status: "ok" }));
        brief.brief_json.recent_labs.slice(0, 3).forEach((lab: any) =>
          items.push({ label: lab.test, value: `${lab.value} — ${lab.date}`, status: lab.flag ? "warn" : "ok" }));
        if (brief.brief_json.active_medications.length > 0)
          items.push({ label: "Active Rx", value: brief.brief_json.active_medications.join(", "), status: "ok" });
        brief.brief_json.missing_data_flags.forEach((flag: string) =>
          items.push({ label: "Missing", value: flag, status: "danger" }));
        setContextItems(items);
        setLoadStep(4);
      })
      .catch(err => { console.error(err); setError("Failed to generate context brief — showing demo data"); setLoadStep(4); })
      .finally(() => setLoading(false));
  }, [started, patient.id, appointmentId]);

  const emrDocs = DEMO_MODE ? DEMO_EMR_DOCS : [
    { name: "FHIR Conditions" }, { name: "Lab Observations" },
    { name: "Active Medications" }, { name: "Recent Correspondence" },
  ];

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: TEAL, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🌅</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Morning Dashboard</span>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: TEAL_LIGHT, borderRadius: 8, marginBottom: 16 }}>
              <Avatar name={patient.display_name} size={30} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: TEAL_DARK }}>{patient.display_name}</div>
                <div style={{ fontSize: 11, color: TEAL }}>{patient.apptTime ? `Appt ${patient.apptTime} · ` : ""}{patient.apptType ?? "Appointment"}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>AI Context Brief</div>
            {error && <div style={{ padding: "8px 12px", background: AMBER_LIGHT, border: `1px solid ${AMBER}`, borderRadius: 6, fontSize: 12, color: AMBER, marginBottom: 10 }}>⚠ {error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {contextItems.map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px", background: item.status === "danger" ? RED_LIGHT : item.status === "warn" ? AMBER_LIGHT : GRAY_BG, borderRadius: 6, fontSize: 12 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", marginTop: 4, flexShrink: 0, background: item.status === "danger" ? RED : item.status === "warn" ? AMBER : TEAL_MID }} />
                  <div><span style={{ fontWeight: 600, color: GRAY_DARK }}>{item.label}: </span><span style={{ color: GRAY_MID }}>{item.value}</span></div>
                </div>
              ))}
            </div>
            <button onClick={() => setStarted(true)} disabled={started || loading} style={{
              width: "100%", padding: "10px 0", background: started ? GRAY_MID : TEAL, color: "#fff",
              border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13,
              cursor: started ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              fontFamily: "'DM Sans', sans-serif", opacity: loading ? 0.8 : 1,
            }}>
              {loading ? "⏳ Querying FHIR + Granite..." : started ? "✓ Context Scan Complete" : "▶ Start AI Context Scan"}
            </button>
          </div>
        </div>

        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: BLUE, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🔍</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>EMR Document Scan</span>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: GRAY_MID, marginBottom: 14 }}>
              {DEMO_MODE ? "Connecting to legacy EMR via SMART on FHIR API. Scanning incoming e-faxes, lab results, and historical records." : "Querying HAPI FHIR server for conditions, observations, medications, and correspondence."}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {emrDocs.map((doc, i) => {
                const loaded = started && loadStep > i;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: loaded ? GREEN_LIGHT : GRAY_BG, borderRadius: 8, transition: "background 0.4s" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", background: loaded ? GREEN : "#d1d5db", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", flexShrink: 0, transition: "background 0.4s" }}>
                      {loaded ? "✓" : "…"}
                    </div>
                    <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: GRAY_DARK }}>{doc.name}</div>
                    <Badge color={loaded ? GREEN : GRAY_MID} bg={loaded ? GREEN_LIGHT : GRAY_BG}>{loaded ? "Loaded" : "Pending"}</Badge>
                  </div>
                );
              })}
            </div>
            {loadStep >= 4 && (
              <div style={{ padding: "10px 14px", background: GREEN_LIGHT, border: `1px solid #97C459`, borderRadius: 8, fontSize: 12, color: GREEN, animation: "fadeIn 0.4s ease" }}>
                ✅ <strong>{emrDocs.length} of {emrDocs.length} sources loaded.</strong> Context brief ready for review.
              </div>
            )}
            <div style={{ marginTop: 14, borderTop: "0.5px solid #e5e7eb", paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 6 }}>FHIR API Status</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["EMR Connected", "e-Fax Active", "Lab API Ready"].map((s, i) => (
                  <div key={i} style={{ fontSize: 11, padding: "3px 8px", background: started ? GREEN_LIGHT : GRAY_BG, color: started ? GREEN : GRAY_MID, borderRadius: 20, fontWeight: 600, transition: "all 0.5s" }}>{s}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {loadStep >= 4 && (
        <div style={{ marginTop: 20, textAlign: "center" }}>
          {/* FIX: Button says "Start Appointment →" per CONTRACTS.md */}
          <button onClick={() => onNext(briefId ?? undefined)} style={{ padding: "12px 36px", background: TEAL, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", boxShadow: `0 2px 12px ${TEAL}44` }}>
            Start Appointment →
          </button>
        </div>
      )}
      <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }`}</style>
    </div>
  );
}

// ─── 3. DURING APPOINTMENT ────────────────────────────────────────────────────

function DuringAppointment({ patient, appointmentId, onNext }: {
  patient: Patient;
  appointmentId: string | null;
  onNext: (soapNoteId?: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [soapStep, setSoapStep] = useState(0);
  const [pulse, setPulse] = useState(false);
  // FIX: SOAP lines are editable state, not read-only
  const [soapLines, setSoapLines] = useState<SoapLine[]>(DEMO_SOAP_LINES.map(l => ({ ...l })));
  const [soapNoteId, setSoapNoteId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => { setElapsed(e => e + 1); setPulse(p => !p); }, 1000);
      if (DEMO_MODE) {
        [1500, 3000, 5000, 7000].forEach((d, i) => setTimeout(() => setSoapStep(i + 1), d));
      } else {
        if (!patient.id) return;
        const token = localStorage.getItem("supabase_token") ?? "";
        const es = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/api/patients/${patient.id}/appointment/stream?token=${token}`);
        esRef.current = es;
        es.addEventListener("soap_update", (e: MessageEvent) => {
          const soap = JSON.parse(e.data);
          setSoapLines([
            { label: "S", color: BLUE,  bg: BLUE_LIGHT,  text: soap.subjective },
            { label: "O", color: TEAL,  bg: TEAL_LIGHT,  text: soap.objective  },
            { label: "A", color: AMBER, bg: AMBER_LIGHT, text: soap.assessment },
            { label: "P", color: GREEN, bg: GREEN_LIGHT, text: soap.plan       },
          ]);
          setSoapStep(s => Math.min(s + 1, 4));
        });
        es.addEventListener("done", () => {
          es.close(); setSoapStep(4);
          if (timerRef.current) clearInterval(timerRef.current);
          if (patient.id && appointmentId)
            api.endAppointment(patient.id, appointmentId).then(note => setSoapNoteId(note.id)).catch(console.error);
        });
        es.onerror = () => { console.warn("SSE error"); es.close(); };
      }
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      esRef.current?.close();
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); esRef.current?.close(); };
  }, [recording, patient.id, appointmentId]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // FIX: SOAP is editable
  const handleSoapEdit = (i: number, val: string) =>
    setSoapLines(prev => prev.map((l, idx) => idx === i ? { ...l, text: val } : l));

  const actionItems = [
    { label: "HbA1c Lab Req.",       ready: soapStep >= 3 },
    { label: "CBC Lab Req.",         ready: soapStep >= 4 },
    { label: "OHIP Billing — A879A", ready: soapStep >= 4 },
    { label: "ODSP Form Flag",       ready: soapStep >= 2 },
  ];

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 20 }}>

        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#1a1a2e", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🎙️</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Live Scribe Interface</span>
            {!DEMO_MODE && <Badge color="#fff" bg="rgba(255,255,255,0.2)">Live</Badge>}
          </div>
          <div style={{ padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative" }}>
              <div style={{ width: 70, height: 70, borderRadius: "50%", background: recording ? (pulse ? "#fee2e2" : RED_LIGHT) : GRAY_BG, border: `2px solid ${recording ? RED : "#d1d5db"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, transition: "all 0.3s", cursor: "pointer" }} onClick={() => setRecording(r => !r)}>🎙️</div>
              {recording && <div style={{ position: "absolute", bottom: -6, right: -6, background: RED, color: "#fff", fontSize: 9, fontWeight: 800, padding: "2px 5px", borderRadius: 4, letterSpacing: "0.1em" }}>REC</div>}
            </div>
            <div style={{ fontSize: 13, color: recording ? RED : GRAY_MID, fontWeight: 600 }}>
              {recording ? `Recording — ${fmt(elapsed)}` : "Tap to start recording"}
            </div>
            <button onClick={() => setRecording(r => !r)} style={{ padding: "8px 24px", background: recording ? RED_LIGHT : TEAL, color: recording ? RED : "#fff", border: `1px solid ${recording ? RED : TEAL}`, borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
              {recording ? "⏹ Stop Scribe" : "▶ Start Scribe"}
            </button>
            <div style={{ width: "100%", borderTop: "0.5px solid #e5e7eb", paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 8 }}>Action Items Queued</div>
              {actionItems.map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12, color: item.ready ? GREEN : GRAY_MID }}>
                  <span style={{ fontSize: 14 }}>{item.ready ? "✅" : "⏳"}</span>{item.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#1D2B3A", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>SOAP Draft</span>
            {soapStep > 0 && <Badge color="#fff" bg="rgba(255,255,255,0.15)">{DEMO_MODE ? "AI-generated · editable" : "Granite · editable"}</Badge>}
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {soapStep === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px", color: GRAY_MID, fontSize: 13 }}>Start recording to generate SOAP note in real-time...</div>
            ) : (
              soapLines.slice(0, soapStep).map((line, i) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "10px 12px", background: line.bg, borderRadius: 8, animation: "fadeIn 0.5s ease" }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: line.color, minWidth: 16, fontFamily: "'DM Mono', monospace", paddingTop: 2 }}>{line.label}:</div>
                  {/* FIX: editable textarea, not read-only div */}
                  <textarea
                    value={line.text}
                    onChange={e => handleSoapEdit(i, e.target.value)}
                    rows={3}
                    style={{ flex: 1, fontSize: 13, color: GRAY_DARK, lineHeight: 1.5, background: "transparent", border: `1px solid ${line.color}33`, borderRadius: 6, padding: "4px 8px", resize: "vertical", fontFamily: "'DM Sans', sans-serif", outline: "none" }}
                  />
                </div>
              ))
            )}
            {soapStep >= 4 && (
              <div style={{ marginTop: 8, padding: "10px 14px", background: GREEN_LIGHT, borderRadius: 8, fontSize: 12, color: GREEN }}>
                ✅ SOAP note complete. Review and edit above, then end the appointment.
              </div>
            )}
          </div>
        </div>
      </div>

      {soapStep >= 4 && (
        <div style={{ marginTop: 20, textAlign: "center" }}>
          {/* FIX: Button says "End Appointment →" per CONTRACTS.md */}
          <button onClick={() => onNext(soapNoteId ?? undefined)} style={{ padding: "12px 36px", background: TEAL, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", boxShadow: `0 2px 12px ${TEAL}44` }}>
            End Appointment →
          </button>
        </div>
      )}
      <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }`}</style>
    </div>
  );
}

// ─── 4. POST-APPOINTMENT ──────────────────────────────────────────────────────

function PostAppointment({ patient, appointmentId, soapNoteId, onDone }: {
  patient: Patient;
  appointmentId: string | null;
  soapNoteId: string | null;
  onDone: () => void;
}) {
  const [fields, setFields] = useState<FormField[]>(DEMO_FORM_FIELDS.map(f => ({ ...f })));
  const [formDraftId, setFormDraftId] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [generating, setGenerating] = useState(true);
  const [genDone, setGenDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE || !patient.id || !appointmentId || !soapNoteId) {
      setTimeout(() => { setGenerating(false); setGenDone(true); }, 2000);
      return;
    }
    setGenerating(true);
    api.generateFormDraft(patient.id, appointmentId, soapNoteId)
      .then(draft => {
        setFormDraftId(draft.id);
        const converted: FormField[] = Object.entries(draft.form_json).map(([key, field]: [string, any]) => ({
          id: key,
          label: key.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
          value: field.value === null || field.value === undefined ? "" : String(field.value),
          confidence: Math.round(field.confidence * 100),
        }));
        setFields(converted);
        setGenDone(true);
      })
      .catch(err => { console.error(err); setError("Could not generate form — showing demo data"); setGenDone(true); })
      .finally(() => setGenerating(false));
  }, [patient.id, appointmentId, soapNoteId]);

  const autoFilled = fields.filter(f => f.confidence > 0).length;
  const avgConf = autoFilled > 0 ? Math.round(fields.filter(f => f.confidence > 0).reduce((a, f) => a + f.confidence, 0) / autoFilled) : 0;

  const handleChange = (id: string, val: string) => {
    setFields(prev => prev.map(f => f.id === id ? { ...f, value: val } : f));
    if (!DEMO_MODE && formDraftId)
      api.updateFormDraft(formDraftId, { [id]: { value: val, confidence: 1.0, source: "physician_edit" } }).catch(console.error);
  };

  const handleApprove = async () => {
    if (!DEMO_MODE && formDraftId) {
      try { await api.approveFormDraft(formDraftId); } catch (err) { console.error(err); }
    }
    setApproved(true);
    setTimeout(() => onDone(), 1200);
  };

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 20 }}>

        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#2D1B6B", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📄</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Disability Tax Credit Form (T2201)</span>
            {!DEMO_MODE && <Badge color="#fff" bg="rgba(255,255,255,0.2)">Live</Badge>}
          </div>
          <div style={{ padding: 16 }}>
            {error && <div style={{ padding: "8px 12px", background: AMBER_LIGHT, border: `1px solid ${AMBER}`, borderRadius: 6, fontSize: 12, color: AMBER, marginBottom: 10 }}>⚠ {error}</div>}
            {generating && (
              <div style={{ textAlign: "center", padding: "24px 0", color: GRAY_MID, fontSize: 13 }}>
                <div style={{ marginBottom: 8 }}>🤖 {DEMO_MODE ? "Mapping clinical notes to form fields..." : "Calling Granite to populate T2201..."}</div>
                <div style={{ height: 4, background: GRAY_BG, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: TEAL, borderRadius: 99, animation: "loadBar 2s ease forwards" }} />
                </div>
              </div>
            )}
            {genDone && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {fields.map(field => (
                  <div key={field.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: GRAY_MID, textTransform: "uppercase", letterSpacing: "0.05em" }}>{field.label}</label>
                      {field.confidence > 0 && <ConfidenceBar value={field.confidence} />}
                    </div>
                    <input value={field.value} onChange={e => handleChange(field.id, e.target.value)} placeholder={field.confidence === 0 ? "⚠ Requires physician input" : ""} style={{ width: "100%", padding: "7px 10px", fontSize: 13, border: `0.5px solid ${field.confidence === 0 ? RED : field.confidence < 85 ? AMBER : "#e5e7eb"}`, borderRadius: 6, background: field.confidence === 0 ? RED_LIGHT : "#fff", color: GRAY_DARK, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ background: "#6B3A2D", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>🔎</span>
              <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Review & Sign</span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: GRAY_MID, marginBottom: 4 }}>Auto-fill Coverage</div>
                <div style={{ height: 10, background: GRAY_BG, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${fields.length > 0 ? Math.round(autoFilled / fields.length * 100) : 0}%`, height: "100%", background: TEAL, borderRadius: 99 }} />
                </div>
                <div style={{ fontSize: 12, color: TEAL, marginTop: 4, fontWeight: 600 }}>{autoFilled} of {fields.length} sections auto-filled</div>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1, background: GREEN_LIGHT, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: GREEN, fontWeight: 600 }}>Avg. Confidence</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: GREEN }}>{genDone ? avgConf : "—"}%</div>
                </div>
                <div style={{ flex: 1, background: RED_LIGHT, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                  <div style={{ fontSize: 11, color: RED, fontWeight: 600 }}>Needs Review</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: RED }}>
                    {genDone ? fields.filter(f => f.confidence < 85 && f.confidence > 0).length + fields.filter(f => f.confidence === 0).length : "—"}
                  </div>
                </div>
              </div>
              <div style={{ borderTop: "0.5px solid #e5e7eb", paddingTop: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 8 }}>Field Status</div>
                {[
                  { label: "High confidence (≥90%)", count: fields.filter(f => f.confidence >= 90).length, color: GREEN },
                  { label: "Needs review (75–89%)",  count: fields.filter(f => f.confidence >= 75 && f.confidence < 90).length, color: AMBER },
                  { label: "Physician required",     count: fields.filter(f => f.confidence < 75).length, color: RED },
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: GRAY_DARK }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.color }} />
                      {item.label}
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: item.color }}>{item.count}</span>
                  </div>
                ))}
              </div>
              {!approved ? (
                <button onClick={handleApprove} disabled={!genDone} style={{ width: "100%", padding: "11px 0", background: genDone ? TEAL : "#d1d5db", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: genDone ? "pointer" : "not-allowed", fontFamily: "'DM Sans', sans-serif" }}>
                  ✓ Approve & Sync to EMR
                </button>
              ) : (
                <div style={{ width: "100%", padding: "11px 0", background: GREEN_LIGHT, border: `1px solid #97C459`, borderRadius: 8, fontWeight: 700, fontSize: 13, color: GREEN, textAlign: "center" }}>
                  ✅ Approved & Synced to EMR
                </div>
              )}
            </div>
          </div>
          <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 8 }}>Data Sources Used</div>
            {(DEMO_MODE
              ? ["SOAP Note (Active Scribe)", "Lab Results — Jan 2025", "Prescription History", "Cardiology Consult Fax"]
              : ["SOAP Note (Granite Scribe)", "FHIR Conditions", "FHIR Observations", "FHIR Medications", "FHIR Correspondence"]
            ).map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", fontSize: 12, color: GRAY_DARK }}>
                <span style={{ color: TEAL, fontSize: 14 }}>✓</span> {s}
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes loadBar { from { width: 0%; } to { width: 100%; } }
        @keyframes fadeIn  { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
        @media (max-width: 768px) { .grid-2col { grid-template-columns: 1fr !important; } }
      `}</style>
    </div>
  );
}

// ─── 5. COMPLETION SCREEN ─────────────────────────────────────────────────────

// FIX: Completion screen exists — "All done for Sarah M."
function CompletionScreen({ patient, onBackToList }: { patient: Patient; onBackToList: () => void }) {
  return (
    <div style={{ padding: 60, textAlign: "center", fontFamily: "'DM Sans', sans-serif", maxWidth: 600, margin: "0 auto" }}>
      <div style={{ fontSize: 56, marginBottom: 20 }}>✅</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: GRAY_DARK, marginBottom: 8 }}>
        All done for {patient.display_name}.
      </div>
      <div style={{ fontSize: 14, color: GRAY_MID, marginBottom: 32 }}>
        SOAP note approved · T2201 synced to EMR · Audit trail recorded
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 40 }}>
        {["SOAP Note Saved", "Form Synced", "Billing Queued", "Audit Logged"].map((s, i) => (
          <div key={i} style={{ padding: "8px 16px", background: GREEN_LIGHT, color: GREEN, borderRadius: 20, fontSize: 13, fontWeight: 600 }}>✓ {s}</div>
        ))}
      </div>
      <button onClick={onBackToList} style={{ padding: "13px 36px", background: TEAL, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", boxShadow: `0 2px 12px ${TEAL}44` }}>
        ← Back to Patient List
      </button>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────

export default function Curas() {
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [phase, setPhase] = useState("list");
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [soapNoteId, setSoapNoteId] = useState<string | null>(null);

  const handleSelectPatient = (p: Patient) => {
    setSelectedPatient(p);
    setPhase("pre");
    setAppointmentId(import.meta.env.VITE_APPOINTMENT_ID ?? null);
  };

  const handleBackToList = () => {
    setSelectedPatient(null);
    setPhase("list");
    setAppointmentId(null);
    setSoapNoteId(null);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F8F9FA", fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      <AppHeader
        patient={phase !== "list" ? selectedPatient : null}
        onBackToList={phase !== "list" && phase !== "done" ? handleBackToList : null}
      />

      {phase !== "list" && phase !== "done" && <PhaseHeader phase={phase} />}

      {phase === "list" && <PatientList onSelect={handleSelectPatient} />}
      {phase === "pre" && selectedPatient && (
        <PreAppointment patient={selectedPatient} appointmentId={appointmentId} onNext={(briefId) => { void briefId; setPhase("during"); }} />
      )}
      {phase === "during" && selectedPatient && (
        <DuringAppointment patient={selectedPatient} appointmentId={appointmentId} onNext={(noteId) => { if (noteId) setSoapNoteId(noteId); setPhase("post"); }} />
      )}
      {phase === "post" && selectedPatient && (
        <PostAppointment patient={selectedPatient} appointmentId={appointmentId} soapNoteId={soapNoteId} onDone={() => setPhase("done")} />
      )}
      {phase === "done" && selectedPatient && (
        <CompletionScreen patient={selectedPatient} onBackToList={handleBackToList} />
      )}
    </div>
  );
}
