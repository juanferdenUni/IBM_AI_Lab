// Spec: CONTRACTS.md §4 REST API Endpoints
function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;

  if (!configured) {
    if (typeof window !== "undefined") {
      return `${window.location.protocol}//${window.location.hostname}:8000`;
    }
    return "http://127.0.0.1:8000";
  }

  try {
    const url = new URL(configured);
    if (
      typeof window !== "undefined" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      window.location.hostname !== url.hostname
    ) {
      url.hostname = window.location.hostname;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return configured.replace(/\/$/, "");
  }
}

const BASE = resolveApiBase();
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem("supabase_token");
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
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
  getFormDraft: (patientId: string) => get<any>(`/api/patients/${patientId}/form-draft`),
  createAppointment: (patientId: string) =>
    post<any>(`/api/patients/${patientId}/appointments`, { scheduled_at: new Date().toISOString() }),
  generateContextBrief: (patientId: string, appointmentId: string) =>
    post<any>(`/api/patients/${patientId}/context-brief`, { appointment_id: appointmentId }),
  uploadAudio: async (patientId: string, appointmentId: string, blob: Blob): Promise<{ audio_file_path: string }> => {
    const form = new FormData();
    form.append("file", blob, "recording.webm");
    const token = localStorage.getItem("supabase_token");
    const res = await fetch(`${BASE}/api/patients/${patientId}/appointment/upload-audio?appointment_id=${appointmentId}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  startAppointmentScribe: (patientId: string, appointmentId: string, audioFilePath: string) =>
    post<any>(`/api/patients/${patientId}/appointment/start`, { appointment_id: appointmentId, audio_file_path: audioFilePath }),
  endAppointment: (patientId: string, appointmentId: string) =>
    post<any>(`/api/patients/${patientId}/appointment/end`, { appointment_id: appointmentId }),
  generateFormDraft: (patientId: string, appointmentId: string, soapNoteId: string) =>
    post<any>(`/api/patients/${patientId}/form-draft`, { appointment_id: appointmentId, soap_note_id: soapNoteId }),
  updateFormDraft: (formId: string, fields: Record<string, unknown>) =>
    patch<any>(`/api/form-drafts/${formId}`, { fields }),
  approveFormDraft: (formId: string) =>
    post<any>(`/api/form-drafts/${formId}/approve-and-sync`, {}),
};
