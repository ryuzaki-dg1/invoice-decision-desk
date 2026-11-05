// Core domain types for the invoice-to-decision pipeline.
// Shared by the browser (pipeline + UI) and the server (run store, review rules).

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export type DocumentType = "digital" | "scanned" | "handwritten";

export interface Invoice {
  vendor: string;
  invoiceNumber: string | null;
  poReference: string | null;
  issueDate: string | null; // ISO yyyy-mm-dd
  dueDate: string | null;
  paymentTerms: string | null;
  lineItems: LineItem[];
  subtotal: number | null;
  tax: number;
  shipping: number; // freight / delivery, as printed
  otherCharges: number; // any other explicit surcharge or fee
  discount: number; // positive number, subtracted
  total: number | null;
  currency: string;
  bankAccount: string | null; // remit-to account number as printed
  documentType: DocumentType;
  // Fields the model said it could not read with certainty. Self-reported by
  // the model, not a calibrated probability.
  lowConfidenceFields: string[];
}

export interface Vendor {
  id: string;
  name: string;
  aliases: string[];
  bankAccount: string; // account on file in the vendor master
  bankName: string;
  phone: string; // trusted contact on file, used for call-back verification
  status: "active" | "blocked";
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  vendor: string;
  issuedDate: string;
  expirationDate: string;
  lineItems: LineItem[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  currency: string;
  status: "open" | "closed" | "expired";
  approvedBy: string;
}

// An invoice already known to AP: seeded ERP history (with payment records)
// plus every run processed here that was not rejected.
export interface LedgerInvoice {
  vendorId: string | null;
  vendor: string;
  invoiceNumber: string;
  poId: string | null;
  total: number;
  issueDate: string;
  lineItems: LineItem[];
  status: "paid" | "approved" | "in_review";
  source: "erp" | "run";
  runId?: string;
}

// What the process should do when a check fails. The strictest action across
// all findings decides the outcome.
export type CheckAction = "reject" | "escalate" | "review" | "info";

export type ExceptionCode =
  | "MISSING_FIELD"
  | "ARITHMETIC_MISMATCH"
  | "LOW_EXTRACTION_CONFIDENCE"
  | "HANDWRITTEN_DOCUMENT"
  | "SCANNED_DOCUMENT"
  | "UNKNOWN_VENDOR"
  | "VENDOR_BLOCKED"
  | "VENDOR_NAME_VARIANT"
  | "BANK_ACCOUNT_MISMATCH"
  | "MISSING_PO_REFERENCE"
  | "PO_MATCH_UNCONFIRMED"
  | "UNKNOWN_PO"
  | "PO_VENDOR_MISMATCH"
  | "EXPIRED_PO"
  | "CLOSED_PO"
  | "CURRENCY_MISMATCH"
  | "PO_AMOUNT_EXCEEDED"
  | "CUMULATIVE_PO_EXCEEDED"
  | "PENDING_PO_CONFLICT"
  | "QUANTITY_EXCEEDS_PO"
  | "PRICE_VARIANCE"
  | "LINE_NOT_ON_PO"
  | "PARTIAL_BILLING"
  | "WITHIN_TOLERANCE"
  | "DUPLICATE_INVOICE"
  | "POSSIBLE_DUPLICATE"
  | "REPEAT_SUBMISSION"
  | "OVER_APPROVAL_LIMIT";

export interface Evidence {
  label: string;
  value: string;
  tone?: "bad" | "good" | "neutral";
}

export interface Finding {
  code: ExceptionCode;
  action: CheckAction;
  stage: StageId;
  title: string;
  detail: string;
  evidence?: Evidence[];
}

export type Resolution = "AUTO_APPROVE" | "FLAG_FOR_REVIEW" | "ESCALATE" | "REJECT";

export interface BillingSummary {
  poTotal: number;
  tolerancePct: number;
  previouslyBilled: number;
  thisInvoice: number;
  billedAfter: number;
  remainingAfter: number;
  priorInvoices: string[]; // confirmed: paid or approved
  pendingOnPo: number; // other invoices on this PO still in review / on hold
  pendingInvoices: string[];
}

export interface LineCheck {
  description: string;
  poDescription: string | null;
  poQty: number | null;
  priorQty: number;
  invoiceQty: number;
  poUnitPrice: number | null;
  invoiceUnitPrice: number;
  status: "ok" | "qty_over" | "price_over" | "not_on_po";
}

export interface PoMatch {
  po: PurchaseOrder | null;
  method: "explicit" | "inferred" | "none";
  inferenceNote?: string;
  billing?: BillingSummary;
  lines?: LineCheck[];
}

export interface Decision {
  resolution: Resolution;
  headline: string;
  decidingCodes: ExceptionCode[];
  nextAction: string;
}

export interface Explanation {
  summary: string;
  vendorEmail: string | null;
  generatedBy: "llm" | "template";
}

export type StageId = "ingest" | "extract" | "validate" | "vendor" | "po_match" | "duplicates" | "decide" | "explain";

// "blocked" = a business rule stopped the invoice (expected behaviour);
// "error" = the step itself failed to execute.
export type StageStatus = "pending" | "running" | "done" | "warn" | "blocked" | "error";

export interface StageState {
  id: StageId;
  status: StageStatus;
  summary?: string;
  lines: string[];
  startedAt?: number;
  endedAt?: number;
}

// Current workflow status of an invoice case (changes with reviewer actions).
export type CaseStatus = "approved" | "needs_review" | "payment_hold" | "awaiting_info" | "rejected";

export interface AuditEvent {
  at: number;
  actor: string; // "System" or the reviewer's name
  kind: "system" | "reviewer";
  action: string;
  fromStatus?: CaseStatus;
  toStatus: CaseStatus;
  note?: string;
}

export interface DuplicateRef {
  invoiceNumber: string;
  source: "erp" | "run";
  status: LedgerInvoice["status"];
  runId?: string;
  issueDate: string;
  total: number;
}

export interface RunRecord {
  id: string;
  createdAt: number;
  durationMs: number;
  fileName: string;
  fileHash: string;
  pageCount: number;
  extractionMethod: string;
  invoice: Invoice;
  vendorId: string | null;
  vendorMatched: string | null;
  poMatch: PoMatch;
  findings: Finding[];
  decision: Decision;
  explanation: Explanation;
  stages: StageState[];
  model: string;
  status: CaseStatus;
  // Controls a reviewer has explicitly resolved (e.g. bank change verified, PO confirmed).
  resolvedCodes: ExceptionCode[];
  hasPreview: boolean; // first page image stored on the server
  repeatSubmission: boolean;
  duplicateOf?: DuplicateRef;
  audit: AuditEvent[];
  // Policy thresholds in force when the run was processed; re-used when a
  // reviewer's corrections are re-validated.
  rules?: RulesSnapshot;
  // First model extraction, kept once a reviewer corrects any field.
  originalInvoice?: Invoice;
  corrections?: Correction[];
}

export interface RulesSnapshot {
  amountTolerancePct: number;
  priceTolerancePct: number;
  quantityTolerance: number;
  arithmeticToleranceAbs: number;
  duplicateWindowDays: number;
  autoApproveLimit: number;
  reviewHandwritten: boolean;
}

export interface FieldChange {
  field: string; // e.g. "total", "lineItems[0].unitPrice"
  from: string;
  to: string;
}

export interface Correction {
  at: number;
  reviewer: string;
  reason: string;
  changes: FieldChange[];
  decisionBefore: Resolution;
  decisionAfter: Resolution;
}
