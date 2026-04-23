import { useState, useEffect, useRef } from "react";
import { DEMO_MODE } from "./config";
import { api } from "./lib/api";
import {
  MOCK_PATIENT,
  MOCK_CONTEXT_ITEMS,
  MOCK_EMR_DOCS,
  MOCK_FORM_FIELDS,
  MOCK_SOAP_LINES,
} from "./mockData";
import type { BriefContent, SOAPContent, BillingCode, FormFieldValue } from "./types";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function briefToContextItems(brief: BriefContent) {
  const items: { label: string; value: string; status: string }[] = [];
  brief.chronic_conditions.forEach(c => items.push({ label: "Condition", value: c, status: "ok" }));
  brief.recent_labs.slice(0, 3).forEach(lab => {
    const status = lab.flag && lab.flag !== null ? "warn" : "ok";
    items.push({ label: lab.test, value: `${lab.value} — ${lab.date}`, status });
  });
  if (brief.active_medications.length > 0)
    items.push({ label: "Active Rx", value: brief.active_medications.join(", "), status: "ok" });
  brief.recent_correspondence.forEach(c =>
    items.push({ label: c.type, value: c.summary, status: "ok" })
  );
  brief.missing_data_flags.forEach(flag =>
    items.push({ label: "Missing", value: flag, status: "danger" })
  );
  return items;
}

function formDraftToFields(form_json: Record<string, FormFieldValue>) {
  return Object.entries(form_json).map(([key, field]) => ({
    id: key,
    label: key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    value: field.value === null || field.value === undefined ? "" : String(field.value),
    confidence: Math.round(field.confidence * 100),
  }));
}

const SOAP_COLORS = {
  S: { color: BLUE, bg: BLUE_LIGHT },
  O: { color: TEAL, bg: TEAL_LIGHT },
  A: { color: AMBER, bg: AMBER_LIGHT },
  P: { color: GREEN, bg: GREEN_LIGHT },
};

// ─── Shared Components ───────────────────────────────────────────────────────

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2);
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

function Badge({ children, color = TEAL, bg = TEAL_LIGHT }: { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <span style={{
      background: bg, color: color, fontSize: 11, fontWeight: 600,
      padding: "2px 8px", borderRadius: 20, letterSpacing: "0.03em",
      fontFamily: "'DM Sans', sans-serif",
    }}>{children}</span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 90 ? GREEN : value >= 75 ? AMBER : RED;
  void (value >= 90 ? GREEN_LIGHT : value >= 75 ? AMBER_LIGHT : RED_LIGHT);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: "#e5e7eb", borderRadius: 99 }}>
        <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 600, minWidth: 28, fontFamily: "'DM Mono', monospace" }}>{value}%</span>
    </div>
  );
}

function PhaseHeader({ phase, onNav }: { phase: string; onNav: (p: string) => void }) {
  const phases = [
    { key: "pre", label: "Pre-Appointment", sub: "Context Engine" },
    { key: "during", label: "During Appointment", sub: "Active Scribe" },
    { key: "post", label: "Post-Appointment", sub: "Form Originator" },
  ];
  return (
    <div style={{ display: "flex", borderBottom: `1.5px solid ${TEAL_DARK}`, background: TEAL_DARK, fontFamily: "'DM Sans', sans-serif" }}>
      {phases.map((p, i) => {
        const active = p.key === phase;
        return (
          <button key={p.key} onClick={() => onNav(p.key)} style={{
            flex: 1, padding: "14px 0 10px", border: "none", cursor: "pointer",
            background: active ? TEAL_MID : "transparent",
            borderRight: i < 2 ? `1px solid rgba(255,255,255,0.15)` : "none",
            transition: "background 0.2s",
          }}>
            <div style={{ fontSize: 11, color: active ? "#fff" : "rgba(255,255,255,0.5)", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>{p.label}</div>
            <div style={{ fontSize: 13, color: active ? "#fff" : "rgba(255,255,255,0.65)", marginTop: 2, fontWeight: 500 }}>{p.sub}</div>
          </button>
        );
      })}
    </div>
  );
}

function PatientBar({ patientDisplay }: { patientDisplay: typeof MOCK_PATIENT }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "12px 24px", background: "#fff",
      borderBottom: "0.5px solid #e5e7eb",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <Avatar name={patientDisplay.name} size={38} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: GRAY_DARK }}>{patientDisplay.name}</div>
        <div style={{ fontSize: 12, color: GRAY_MID }}>
          DOB: {new Date(patientDisplay.dob).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })} · MRN: {patientDisplay.mrn}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: TEAL }}>{patientDisplay.apptTime} — {patientDisplay.apptType}</div>
        <div style={{ fontSize: 12, color: GRAY_MID }}>{patientDisplay.physician} · Last visit: {patientDisplay.lastVisit}</div>
      </div>
    </div>
  );
}

// ─── PRE-APPOINTMENT ─────────────────────────────────────────────────────────

interface PreAppointmentProps {
  onNext: (briefId?: string) => void;
  patientId: string | null;
  appointmentId: string | null;
}

function PreAppointment({ onNext, patientId, appointmentId }: PreAppointmentProps) {
  const [loadStep, setLoadStep] = useState(0);
  const [started, setStarted] = useState(false);
  const [contextItems, setContextItems] = useState(MOCK_CONTEXT_ITEMS);
  const [briefId, setBriefId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!started) return;

    if (DEMO_MODE) {
      const steps = [500, 900, 1400, 1900, 2500, 3000];
      steps.forEach((delay, i) => {
        setTimeout(() => setLoadStep(i + 1), delay);
      });
      return;
    }

    // Real mode: call backend
    if (!patientId || !appointmentId) {
      setError("Missing patient or appointment ID");
      return;
    }
    setLoading(true);
    setError(null);
    api.generateContextBrief(patientId, appointmentId)
      .then(brief => {
        setBriefId(brief.id);
        setContextItems(briefToContextItems(brief.brief_json));
        setLoadStep(6);
      })
      .catch(err => {
        console.error("Context brief error:", err);
        setError("Failed to generate context brief — check backend");
        setLoadStep(6); // still allow proceeding with mock data
      })
      .finally(() => setLoading(false));
  }, [started, patientId, appointmentId]);

  const emrDocs = DEMO_MODE ? MOCK_EMR_DOCS : [
    { name: "FHIR Conditions", type: "FHIR", loaded: loadStep > 0 },
    { name: "Lab Observations", type: "Lab", loaded: loadStep > 0 },
    { name: "Active Medications", type: "Rx", loaded: loadStep > 0 },
    { name: "Recent Correspondence", type: "Fax", loaded: loadStep > 0 },
  ];

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Morning Dashboard */}
        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: TEAL, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🌅</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Morning Dashboard</span>
            {!DEMO_MODE && <Badge color="#fff" bg="rgba(255,255,255,0.2)">Live</Badge>}
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>AI Context Brief</div>

            {error && (
              <div style={{ padding: "8px 12px", background: RED_LIGHT, border: `1px solid ${RED}`, borderRadius: 6, fontSize: 12, color: RED, marginBottom: 10 }}>
                ⚠ {error}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {contextItems.map((item, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px",
                  background: item.status === "danger" ? RED_LIGHT : item.status === "warn" ? AMBER_LIGHT : GRAY_BG,
                  borderRadius: 6, fontSize: 12,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%", marginTop: 4, flexShrink: 0,
                    background: item.status === "danger" ? RED : item.status === "warn" ? AMBER : TEAL_MID,
                  }} />
                  <div>
                    <span style={{ fontWeight: 600, color: GRAY_DARK }}>{item.label}: </span>
                    <span style={{ color: GRAY_MID }}>{item.value}</span>
                  </div>
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

        {/* EMR Document Scan */}
        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: BLUE, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🔍</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>EMR Document Scan</span>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: GRAY_MID, marginBottom: 14 }}>
              {DEMO_MODE
                ? "Connecting to legacy EMR via SMART on FHIR API. Scanning incoming e-faxes, lab results, and historical records."
                : "Querying HAPI FHIR server for conditions, observations, medications, and correspondence."}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {emrDocs.map((doc, i) => {
                const loaded = DEMO_MODE ? (started && loadStep > i) : doc.loaded;
                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    background: loaded ? GREEN_LIGHT : GRAY_BG, borderRadius: 8,
                    transition: "background 0.4s",
                  }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      background: loaded ? GREEN : "#d1d5db",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, color: "#fff", flexShrink: 0, transition: "background 0.4s",
                    }}>
                      {loaded ? "✓" : "…"}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_DARK }}>{doc.name}</div>
                    </div>
                    <Badge color={loaded ? GREEN : GRAY_MID} bg={loaded ? GREEN_LIGHT : GRAY_BG}>
                      {loaded ? "Loaded" : "Pending"}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {loadStep >= 4 && (
              <div style={{
                padding: "10px 14px", background: GREEN_LIGHT, border: `1px solid #97C459`,
                borderRadius: 8, fontSize: 12, color: GREEN,
                animation: "fadeIn 0.4s ease",
              }}>
                ✅ <strong>{emrDocs.length} of {emrDocs.length} sources loaded.</strong> Context brief ready for review.
              </div>
            )}

            <div style={{ marginTop: 14, borderTop: "0.5px solid #e5e7eb", paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 6 }}>FHIR API Status</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["EMR Connected", "e-Fax Active", "Lab API Ready"].map((s, i) => (
                  <div key={i} style={{ fontSize: 11, padding: "3px 8px", background: started ? GREEN_LIGHT : GRAY_BG, color: started ? GREEN : GRAY_MID, borderRadius: 20, fontWeight: 600, transition: "all 0.5s" }}>
                    {s}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {loadStep >= 4 && (
        <div style={{ marginTop: 20, textAlign: "center" }}>
          <button onClick={() => onNext(briefId ?? undefined)} style={{
            padding: "12px 36px", background: TEAL, color: "#fff",
            border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14,
            cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
            boxShadow: `0 2px 12px ${TEAL}44`,
          }}>
            Patient arrived — Begin Appointment →
          </button>
        </div>
      )}

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

// ─── DURING APPOINTMENT ───────────────────────────────────────────────────────

interface DuringAppointmentProps {
  onNext: (soapNoteId?: string) => void;
  patientId: string | null;
  appointmentId: string | null;
}

function DuringAppointment({ onNext, patientId, appointmentId }: DuringAppointmentProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [soapStep, setSoapStep] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [realSoap, setRealSoap] = useState<SOAPContent | null>(null);
  const [realBillingCodes, setRealBillingCodes] = useState<BillingCode[]>([]);
  const [transcript, setTranscript] = useState("");
  const [soapNoteId, setSoapNoteId] = useState<string | null>(null);
  const [streamDone, setStreamDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => {
        setElapsed(e => e + 1);
        setPulse(p => !p);
      }, 1000);

      if (DEMO_MODE) {
        const steps = [1500, 3000, 5000, 7000];
        steps.forEach((d, i) => setTimeout(() => setSoapStep(i + 1), d));
      } else {
        // Real mode: connect to SSE stream
        if (!patientId) return;
        const es = api.streamAppointment(patientId);
        esRef.current = es;

        es.addEventListener("soap_update", (e: MessageEvent) => {
          const soap = JSON.parse(e.data) as SOAPContent;
          setRealSoap(soap);
          setSoapStep(s => Math.min(s + 1, 4));
        });

        es.addEventListener("transcript_chunk", (e: MessageEvent) => {
          const chunk = JSON.parse(e.data) as { text: string };
          setTranscript(t => t ? `${t} ${chunk.text}` : chunk.text);
        });

        es.addEventListener("billing_code_detected", (e: MessageEvent) => {
          const code = JSON.parse(e.data) as BillingCode;
          setRealBillingCodes(prev => [...prev, code]);
          setSoapStep(s => Math.min(s + 1, 4));
        });

        es.addEventListener("done", () => {
          es.close();
          setStreamDone(true);
          setSoapStep(4);
          clearInterval(timerRef.current!);
          if (patientId && appointmentId) {
            api.endAppointment(patientId, appointmentId)
              .then(note => setSoapNoteId(note.id))
              .catch(err => console.error("endAppointment error:", err));
          }
        });

        es.onerror = () => {
          console.warn("SSE stream error — no active transcription");
          es.close();
        };
      }
    } else {
      clearInterval(timerRef.current!);
      esRef.current?.close();
    }
    return () => {
      clearInterval(timerRef.current!);
      esRef.current?.close();
    };
  }, [recording, patientId, appointmentId]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const soapSections = realSoap
    ? [
        { label: "S" as const, text: realSoap.subjective },
        { label: "O" as const, text: realSoap.objective },
        { label: "A" as const, text: realSoap.assessment },
        { label: "P" as const, text: realSoap.plan },
      ].filter(s => s.text)
    : MOCK_SOAP_LINES.slice(0, soapStep).map(l => ({ label: l.label as "S" | "O" | "A" | "P", text: l.text }));

  const actionItems = DEMO_MODE
    ? [
        { label: "HbA1c Lab Req.", ready: soapStep >= 3 },
        { label: "CBC Lab Req.", ready: soapStep >= 4 },
        { label: "OHIP Billing — A879A", ready: soapStep >= 4 },
        { label: "ODSP Form Flag", ready: soapStep >= 2 },
      ]
    : realBillingCodes.map(c => ({ label: `${c.code} — ${c.description}`, ready: true }));

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 20 }}>

        {/* Live Scribe Interface */}
        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#1a1a2e", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🎙️</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Live Scribe Interface</span>
            {!DEMO_MODE && <Badge color="#fff" bg="rgba(255,255,255,0.2)">Live</Badge>}
          </div>
          <div style={{ padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative" }}>
              <div style={{
                width: 70, height: 70, borderRadius: "50%",
                background: recording ? (pulse ? "#fee2e2" : RED_LIGHT) : GRAY_BG,
                border: `2px solid ${recording ? RED : "#d1d5db"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 28, transition: "all 0.3s", cursor: "pointer",
              }} onClick={() => !streamDone && setRecording(r => !r)}>
                🎙️
              </div>
              {recording && (
                <div style={{
                  position: "absolute", bottom: -6, right: -6,
                  background: RED, color: "#fff", fontSize: 9, fontWeight: 800,
                  padding: "2px 5px", borderRadius: 4, letterSpacing: "0.1em",
                }}>REC</div>
              )}
            </div>

            <div style={{ fontSize: 13, color: recording ? RED : GRAY_MID, fontWeight: 600 }}>
              {streamDone ? "✓ Stream complete" : recording ? `Recording — ${fmt(elapsed)}` : "Tap to start recording"}
            </div>

            {!DEMO_MODE && transcript && (
              <div style={{ width: "100%", fontSize: 11, color: GRAY_MID, fontFamily: "'DM Mono', monospace", maxHeight: 80, overflow: "hidden", textOverflow: "ellipsis" }}>
                {transcript.slice(-300)}
              </div>
            )}

            <button onClick={() => !streamDone && setRecording(r => !r)} disabled={streamDone} style={{
              padding: "8px 24px", background: recording ? RED_LIGHT : TEAL,
              color: recording ? RED : "#fff", border: `1px solid ${recording ? RED : TEAL}`,
              borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: streamDone ? "default" : "pointer",
              fontFamily: "'DM Sans', sans-serif", opacity: streamDone ? 0.6 : 1,
            }}>
              {streamDone ? "✓ Done" : recording ? "⏹ Stop Scribe" : "▶ Start Scribe"}
            </button>

            <div style={{ width: "100%", borderTop: "0.5px solid #e5e7eb", paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: GRAY_MID, marginBottom: 8 }}>Action Items Queued</div>
              {actionItems.length === 0 && !DEMO_MODE && (
                <div style={{ fontSize: 12, color: GRAY_MID }}>Billing codes will appear here during transcription...</div>
              )}
              {actionItems.map((item, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 0",
                  fontSize: 12, color: item.ready ? GREEN : GRAY_MID,
                }}>
                  <span style={{ fontSize: 14 }}>{item.ready ? "✅" : "⏳"}</span>
                  {item.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* SOAP Draft */}
        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#1D2B3A", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>SOAP Draft</span>
            {soapStep > 0 && <Badge color="#fff" bg="rgba(255,255,255,0.15)">{DEMO_MODE ? "AI-generated · live" : "Granite · live"}</Badge>}
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {soapStep === 0 && (
              <div style={{ textAlign: "center", padding: "40px 20px", color: GRAY_MID, fontSize: 13 }}>
                Start recording to generate SOAP note in real-time...
              </div>
            )}
            {soapSections.map((line, i) => {
              const colors = SOAP_COLORS[line.label];
              return (
                <div key={i} style={{
                  display: "flex", gap: 10, padding: "10px 12px",
                  background: colors.bg, borderRadius: 8,
                  animation: "fadeIn 0.5s ease",
                }}>
                  <div style={{
                    fontWeight: 800, fontSize: 13, color: colors.color,
                    minWidth: 16, fontFamily: "'DM Mono', monospace",
                  }}>{line.label}:</div>
                  <div style={{ fontSize: 13, color: GRAY_DARK, lineHeight: 1.5 }}>{line.text}</div>
                </div>
              );
            })}

            {soapStep >= 4 && (
              <div style={{
                marginTop: 8, padding: "10px 14px",
                background: GREEN_LIGHT, borderRadius: 8, fontSize: 12, color: GREEN,
              }}>
                ✅ SOAP note complete. Ready for physician review and sync to EMR.
              </div>
            )}
          </div>
        </div>
      </div>

      {soapStep >= 4 && (
        <div style={{ marginTop: 20, textAlign: "center" }}>
          <button onClick={() => onNext(soapNoteId ?? undefined)} style={{
            padding: "12px 36px", background: TEAL, color: "#fff",
            border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14,
            cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
            boxShadow: `0 2px 12px ${TEAL}44`,
          }}>
            Appointment complete — Generate Forms →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── POST-APPOINTMENT ─────────────────────────────────────────────────────────

interface PostAppointmentProps {
  patientId: string | null;
  appointmentId: string | null;
  soapNoteId: string | null;
}

function PostAppointment({ patientId, appointmentId, soapNoteId }: PostAppointmentProps) {
  const [fields, setFields] = useState(MOCK_FORM_FIELDS.map(f => ({ ...f })));
  const [formDraftId, setFormDraftId] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genDone, setGenDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) {
      setGenerating(true);
      setTimeout(() => { setGenerating(false); setGenDone(true); }, 2000);
      return;
    }

    if (!patientId || !appointmentId || !soapNoteId) {
      // Fall back to mock if IDs missing
      setGenerating(true);
      setTimeout(() => { setGenerating(false); setGenDone(true); }, 2000);
      return;
    }

    setGenerating(true);
    setError(null);
    api.generateFormDraft(patientId, appointmentId, soapNoteId)
      .then(draft => {
        setFormDraftId(draft.id);
        setFields(formDraftToFields(draft.form_json));
        setGenDone(true);
      })
      .catch(err => {
        console.error("Form draft error:", err);
        setError("Could not generate form from backend — showing mock data");
        setFields(MOCK_FORM_FIELDS.map(f => ({ ...f })));
        setGenDone(true);
      })
      .finally(() => setGenerating(false));
  }, [patientId, appointmentId, soapNoteId]);

  const handleChange = (id: string, val: string) => {
    setFields(prev => prev.map(f => f.id === id ? { ...f, value: val } : f));

    if (!DEMO_MODE && formDraftId) {
      api.updateFormDraft(formDraftId, {
        [id]: { value: val, confidence: 1.0, source: "physician_edit" },
      }).catch(err => console.error("updateFormDraft error:", err));
    }
  };

  const handleApprove = async () => {
    if (!DEMO_MODE && formDraftId) {
      try {
        await api.approveFormDraft(formDraftId);
      } catch (err) {
        console.error("approveFormDraft error:", err);
      }
    }
    setApproved(true);
  };

  const autoFilled = fields.filter(f => f.confidence > 0).length;
  const avgConf = autoFilled > 0
    ? Math.round(fields.filter(f => f.confidence > 0).reduce((a, f) => a + f.confidence, 0) / autoFilled)
    : 0;

  return (
    <div style={{ padding: 24, fontFamily: "'DM Sans', sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 20 }}>

        {/* Form Panel */}
        <div style={{ background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#2D1B6B", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📄</span>
            <span style={{ fontWeight: 600, color: "#fff", fontSize: 14 }}>Disability Tax Credit Form (T2201)</span>
            {!DEMO_MODE && <Badge color="#fff" bg="rgba(255,255,255,0.2)">Live</Badge>}
          </div>
          <div style={{ padding: 16 }}>
            {error && (
              <div style={{ padding: "8px 12px", background: AMBER_LIGHT, border: `1px solid ${AMBER}`, borderRadius: 6, fontSize: 12, color: AMBER, marginBottom: 10 }}>
                ⚠ {error}
              </div>
            )}
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
                {fields.map((field) => (
                  <div key={field.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: GRAY_MID, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {field.label}
                      </label>
                      {field.confidence > 0 && <ConfidenceBar value={field.confidence} />}
                    </div>
                    <input
                      value={field.value}
                      onChange={e => handleChange(field.id, e.target.value)}
                      placeholder={field.confidence === 0 ? "⚠ Requires physician input" : ""}
                      style={{
                        width: "100%", padding: "7px 10px", fontSize: 13,
                        border: `0.5px solid ${field.confidence === 0 ? RED : field.confidence < 85 ? AMBER : "#e5e7eb"}`,
                        borderRadius: 6, background: field.confidence === 0 ? RED_LIGHT : "#fff",
                        color: GRAY_DARK, fontFamily: "'DM Sans', sans-serif",
                        outline: "none", boxSizing: "border-box",
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Review & Sign Panel */}
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
                  <div style={{ width: `${Math.round(autoFilled / fields.length * 100)}%`, height: "100%", background: TEAL, borderRadius: 99 }} />
                </div>
                <div style={{ fontSize: 12, color: TEAL, marginTop: 4, fontWeight: 600 }}>
                  {autoFilled} of {fields.length} sections auto-filled
                </div>
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
                  { label: "High confidence (≥90%)", count: fields.filter(f => f.confidence >= 90).length, color: GREEN, bg: GREEN_LIGHT },
                  { label: "Needs review (75–89%)", count: fields.filter(f => f.confidence >= 75 && f.confidence < 90).length, color: AMBER, bg: AMBER_LIGHT },
                  { label: "Physician required", count: fields.filter(f => f.confidence < 75).length, color: RED, bg: RED_LIGHT },
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
                <button onClick={handleApprove} disabled={!genDone} style={{
                  width: "100%", padding: "11px 0", background: genDone ? TEAL : "#d1d5db",
                  color: "#fff", border: "none", borderRadius: 8,
                  fontWeight: 700, fontSize: 13, cursor: genDone ? "pointer" : "not-allowed",
                  fontFamily: "'DM Sans', sans-serif",
                }}>
                  ✓ Approve & Sync to EMR
                </button>
              ) : (
                <div style={{
                  width: "100%", padding: "11px 0", background: GREEN_LIGHT,
                  border: `1px solid #97C459`, borderRadius: 8,
                  fontWeight: 700, fontSize: 13, color: GREEN,
                  textAlign: "center",
                }}>
                  ✅ Approved & Synced to EMR
                </div>
              )}
            </div>
          </div>

          {/* Source Summary */}
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
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────

export default function Curas() {
  const [phase, setPhase] = useState("pre");
  const [patientDisplay, setPatientDisplay] = useState(MOCK_PATIENT);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [appointmentId] = useState<string | null>(
    import.meta.env.VITE_APPOINTMENT_ID ?? null
  );
  const [soapNoteId, setSoapNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) return;
    api.getPatients()
      .then(patients => {
        if (patients.length === 0) return;
        const p = patients[0];
        setPatientId(p.id);
        setPatientDisplay({
          name: p.display_name,
          dob: p.date_of_birth,
          mrn: p.mrn,
          apptTime: "—",
          apptType: "—",
          physician: "—",
          lastVisit: "—",
        });
      })
      .catch(err => console.error("getPatients error:", err));
  }, []);

  const handlePreNext = (briefId?: string) => {
    void briefId; // available for future use (e.g. approveContextBrief)
    setPhase("during");
  };

  const handleDuringNext = (noteId?: string) => {
    if (noteId) setSoapNoteId(noteId);
    setPhase("post");
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F8F9FA", fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* App Header */}
      <div style={{
        background: TEAL_DARK, padding: "10px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "rgba(255,255,255,0.15)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18,
          }}>🏥</div>
          <div>
            <div style={{ fontWeight: 700, color: "#fff", fontSize: 15 }}>Curas AI</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>Autonomous Clinical Assistant</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {DEMO_MODE && (
            <span style={{ fontSize: 11, padding: "3px 10px", background: AMBER_LIGHT, color: AMBER, borderRadius: 20, fontWeight: 600 }}>
              DEMO MODE
            </span>
          )}
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
            {new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </div>
        </div>
      </div>

      {/* Phase Nav */}
      <PhaseHeader phase={phase} onNav={setPhase} />

      {/* Patient Bar */}
      <PatientBar patientDisplay={patientDisplay} />

      {/* Phase Content */}
      {phase === "pre" && (
        <PreAppointment
          onNext={handlePreNext}
          patientId={patientId}
          appointmentId={appointmentId}
        />
      )}
      {phase === "during" && (
        <DuringAppointment
          onNext={handleDuringNext}
          patientId={patientId}
          appointmentId={appointmentId}
        />
      )}
      {phase === "post" && (
        <PostAppointment
          patientId={patientId}
          appointmentId={appointmentId}
          soapNoteId={soapNoteId}
        />
      )}
    </div>
  );
}
