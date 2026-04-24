// Spec: CONTRACTS.md §4 REST API Endpoints
import type {
  Patient,
  ContextBrief,
  SOAPNote,
  FormDraft,
  FormFieldValue,
} from "../types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patch<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  // §4.2 Patients
  getPatients: (): Promise<Patient[]> =>
    get("/api/patients"),

  // §4.3 Context Engine
  generateContextBrief: (patientId: string, appointmentId: string): Promise<ContextBrief> =>
    post(`/api/patients/${patientId}/context-brief`, { appointment_id: appointmentId }),

  getContextBrief: (patientId: string): Promise<ContextBrief> =>
    get(`/api/patients/${patientId}/context-brief`),

  approveContextBrief: (briefId: string): Promise<{ id: string; approved: boolean; approved_at: string }> =>
    post(`/api/context-briefs/${briefId}/approve`, {}),

  // §4.4 Active Scribe
  startAppointment: (patientId: string, appointmentId: string, audioFilePath: string): Promise<{ appointment_id: string; stream_url: string; status: string }> =>
    post(`/api/patients/${patientId}/appointment/start`, { appointment_id: appointmentId, audio_file_path: audioFilePath }),

  endAppointment: (patientId: string, appointmentId: string): Promise<SOAPNote> =>
    post(`/api/patients/${patientId}/appointment/end`, { appointment_id: appointmentId }),

  getSOAPNote: (patientId: string): Promise<SOAPNote> =>
    get(`/api/patients/${patientId}/soap-note`),

  approveSOAPNote: (noteId: string): Promise<{ id: string; approved: boolean; approved_at: string }> =>
    post(`/api/soap-notes/${noteId}/approve`, {}),

  // §4.5 Form Originator
  generateFormDraft: (patientId: string, appointmentId: string, soapNoteId: string): Promise<FormDraft> =>
    post(`/api/patients/${patientId}/form-draft`, { appointment_id: appointmentId, soap_note_id: soapNoteId }),

  getFormDraft: (patientId: string): Promise<FormDraft> =>
    get(`/api/patients/${patientId}/form-draft`),

  updateFormDraft: (draftId: string, fields: Record<string, FormFieldValue>): Promise<FormDraft> =>
    patch(`/api/form-drafts/${draftId}`, { fields }),

  approveFormDraft: (draftId: string): Promise<{ id: string; approved: boolean; approved_at: string; fhir_composition_id: string; fhir_doc_ref_id: string; patient_workflow_state: string }> =>
    post(`/api/form-drafts/${draftId}/approve-and-sync`, {}),

  // §4.4 SSE stream — token passed as query param (EventSource can't set headers)
  streamAppointment: (patientId: string, appointmentId: string, token?: string): EventSource => {
    const params = new URLSearchParams({ appointment_id: appointmentId });
    if (token) params.set("token", token);
    const url = `${BASE}/api/patients/${patientId}/appointment/stream?${params.toString()}`;
    return new EventSource(url);
  },
};
