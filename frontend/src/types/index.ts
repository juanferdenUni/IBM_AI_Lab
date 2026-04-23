// Spec: CONTRACTS.md §3 Pydantic Models
// Mirror every model here as a TypeScript interface.
// Keep in sync with any contract changes — post in team channel first.

export type WorkflowState =
  | "pending"
  | "brief_ready"
  | "in_appointment"
  | "appointment_complete"
  | "form_ready"
  | "completed";

export type AppointmentPhase =
  | "pre_appointment"
  | "during_appointment"
  | "post_appointment"
  | "completed";

export type FormType = "T2201";

export interface Patient {
  id: string;
  fhir_id: string;
  mrn: string;
  display_name: string;
  date_of_birth: string;
  physician_id: string;
  workflow_state: WorkflowState;
  created_at: string;
  updated_at: string;
}

export interface LabResult {
  test: string;
  value: string;
  date: string;
  flag: "above_target" | "below_target" | "borderline" | null;
}

export interface Correspondence {
  type: string;
  date: string;
  summary: string;
}

export interface BriefContent {
  chronic_conditions: string[];
  recent_labs: LabResult[];
  active_medications: string[];
  recent_correspondence: Correspondence[];
  missing_data_flags: string[];
}

export interface ContextBrief {
  id: string;
  appointment_id: string;
  patient_id: string;
  brief_json: BriefContent;
  fhir_resources_snapshot: Record<string, unknown> | null;
  version: number;
  superseded_by: string | null;
  approved: boolean;
  approved_at: string | null;
  created_by: string;
  created_at: string;
}

export interface SOAPContent {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface BillingCode {
  code: string;
  description: string;
  confidence: number;
}

export interface SOAPNote {
  id: string;
  appointment_id: string;
  patient_id: string;
  transcript_text: string;
  soap_json: SOAPContent;
  billing_codes: BillingCode[];
  approved: boolean;
  approved_at: string | null;
  version: number;
  superseded_by: string | null;
  created_by: string;
  created_at: string;
}

export interface FormFieldValue {
  value: string | boolean | null;
  confidence: number;
  source: string;
}

export interface FormDraft {
  id: string;
  appointment_id: string;
  patient_id: string;
  soap_note_id: string;
  form_type: FormType;
  form_json: Record<string, FormFieldValue>;
  approved: boolean;
  approved_at: string | null;
  fhir_composition_id: string | null;
  fhir_doc_ref_id: string | null;
  version: number;
  superseded_by: string | null;
  created_by: string;
  created_at: string;
}
