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

// Add endpoint wrappers per CONTRACTS.md §4
export const api = {
  get,
  post,
  patch,
  getPatients: () => get<any>(`/api/patients`),
  getPatient: (patientId: string) => get<any>(`/api/patients/${patientId}`),
  generateContextBrief: (patientId: string, appointmentId: string) =>
    post<any>(`/api/patients/${patientId}/context-brief`, { appointment_id: appointmentId }),
  endAppointment: (patientId: string, appointmentId: string) =>
    post<any>(`/api/patients/${patientId}/appointment/end`, { appointment_id: appointmentId }),
  generateFormDraft: (patientId: string, appointmentId: string, soapNoteId: string) =>
    post<any>(`/api/patients/${patientId}/form-draft`, { appointment_id: appointmentId, soap_note_id: soapNoteId }),
  updateFormDraft: (formId: string, fields: Record<string, unknown>) =>
    patch<any>(`/api/form-drafts/${formId}`, { fields }),
  approveFormDraft: (formId: string) =>
    post<any>(`/api/form-drafts/${formId}/approve-and-sync`, {}),
};
