// Static mock data used when VITE_DEMO_MODE=true.
// All API shapes should mirror CONTRACTS.md so swapping to real data is a no-op.

export const MOCK_PATIENT = {
  name: "Sarah Mitchell",
  dob: "1971-03-14",
  mrn: "2847-391-204",
  apptTime: "9:00 AM",
  apptType: "Follow-up — Type 2 Diabetes",
  physician: "Dr. Patel",
  lastVisit: "Oct 12, 2024",
};

export const MOCK_CONTEXT_ITEMS = [
  { label: "Last HbA1c", value: "7.2% — Jan 2025", status: "ok" },
  { label: "Pending", value: "ODSP form renewal", status: "warn" },
  { label: "Recent fax", value: "Cardiology consult results", status: "ok" },
  { label: "Missing", value: "Updated medication list", status: "danger" },
  { label: "Active Rx", value: "Metformin 1000mg, Lisinopril 10mg", status: "ok" },
  { label: "Allergies", value: "Penicillin (severe)", status: "danger" },
];

export const MOCK_EMR_DOCS = [
  { name: "Lab Results — Jan 2025", type: "Lab", loaded: true },
  { name: "Cardiology Consult Fax", type: "Fax", loaded: true },
  { name: "Prescription History", type: "Rx", loaded: true },
  { name: "ODSP Renewal Form", type: "Form", loaded: false },
];

export const MOCK_FORM_FIELDS = [
  { id: "f1", label: "Patient Full Name", value: "Sarah Mitchell", confidence: 99 },
  { id: "f2", label: "Date of Birth", value: "March 14, 1971", confidence: 99 },
  { id: "f3", label: "OHIP Number", value: "2847-391-204", confidence: 99 },
  { id: "f4", label: "Primary Diagnosis", value: "Type 2 Diabetes Mellitus (E11.9)", confidence: 97 },
  { id: "f5", label: "Treating Physician", value: "Dr. A. Patel, MD", confidence: 99 },
  { id: "f6", label: "Functional Limitations", value: "Moderate fatigue limiting sustained activity > 2hrs", confidence: 84 },
  { id: "f7", label: "Duration of Condition", value: "Diagnosed 2018 (approx. 7 years)", confidence: 91 },
  { id: "f8", label: "Current Medications", value: "Metformin 1000mg BID, Lisinopril 10mg OD", confidence: 96 },
  { id: "f9", label: "Last Specialist Visit", value: "Cardiology — October 2024", confidence: 88 },
  { id: "f10", label: "Prognosis / Permanence", value: "Chronic, ongoing — not expected to resolve", confidence: 78 },
  { id: "f11", label: "Physician Signature Date", value: "", confidence: 0 },
  { id: "f12", label: "Additional Notes", value: "Patient requires follow-up HbA1c in 3 months", confidence: 82 },
];

export const MOCK_SOAP_LINES = [
  { label: "S", text: "Patient reports fatigue, increased thirst over past 3 weeks. Denies chest pain. Concerned about ODSP renewal." },
  { label: "O", text: "BP 128/82, HR 74 bpm, Temp 36.8°C. Weight 83kg (stable). HbA1c Jan 2025: 7.2%. Cardiology fax reviewed — no acute findings." },
  { label: "A", text: "T2DM, stable but symptomatic fatigue. Rule out anemia. ODSP renewal required. Cardiology follow-up noted." },
  { label: "P", text: "Req. HbA1c, CBC. Refer back to cardiology if symptoms worsen. Complete ODSP form. RTC 3 months." },
];
