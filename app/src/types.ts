// Core domain types for the invoice-to-decision pipeline.
// Shared by the browser (pipeline + UI) and the server (run store).

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
  shipping: number;
  total: number | null;
  currency: string;
  bankAccount: string | null; // remit-to account number as printed
  documentType: DocumentType;
  // Fields the model could not read with confidence (smudged, ambiguous digits).
  lowConfidenceFields: string[];
}

export interface Vendor {
  id: string;
  name: string;
  aliases: string[];
  bankAccount: string; // account on file in the vendor master
  bankName: string;
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

// An invoice already known to the AP ledger: seeded history (previously paid)
// plus every run processed by this system that was not rejected.
export interface LedgerInvoice {
  vendorId: string | null;
  vendor: string;
  invoiceNumber: string;
  poId: string | null;
  total: number;
  issueDate: string;
  lineItems: LineItem[];
  status: "paid" | "approved" | "pending_review";
  source: "erp" | "run";
  runId?: string;
}

// What the process should do when a check fails. The strictest action across
// all findings decides the outcome.
export type CheckAction = "reject" | "escalate" | "review" | "info";

export type ExceptionCode =
  | "MISSING_FIELD"
  | "ARITHMETIC_MISMATCH"
  | "LOW_CONFIDENCE_READ"
  | "HANDWRITTEN_DOCUMENT"
  | "VENDOR_NOT_IN_MASTER"
  | "VENDOR_BLOCKED"
  | "VENDOR_NAME_VARIANT"
  | "BANK_DETAILS_CHANGED"
  | "MISSING_PO_REFERENCE"
  | "PO_INFERRED"
  | "UNKNOWN_PO"
  | "PO_VENDOR_MISMATCH"
  | "EXPIRED_PO"
  | "CLOSED_PO"
  | "CURRENCY_MISMATCH"
  | "AMOUNT_OVER_PO"
  | "CUMULATIVE_OVERBILLING"
  | "QUANTITY_OVER_PO"
  | "PRICE_VARIANCE"
  | "LINE_NOT_ON_PO"
  | "PARTIAL_BILLING"
  | "WITHIN_TOLERANCE"
  | "DUPLICATE_INVOICE"
  | "POSSIBLE_DUPLICATE"
  | "OVER_APPROVAL_LIMIT";

export interface Finding {
  code: ExceptionCode;
  action: CheckAction;
  stage: StageId;
  title: string;
  detail: string;
}

export type Resolution = "AUTO_APPROVE" | "FLAG_FOR_REVIEW" | "ESCALATE" | "REJECT";

export interface BillingSummary {
  poTotal: number;
  previouslyBilled: number;
  thisInvoice: number;
  billedAfter: number;
  remainingAfter: number;
  priorInvoices: string[];
}

export interface PoMatch {
  po: PurchaseOrder | null;
  method: "explicit" | "inferred" | "none";
  inferenceNote?: string;
  billing?: BillingSummary;
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

export type StageId =
  | "ingest"
  | "extract"
  | "validate"
  | "vendor"
  | "po_match"
  | "duplicates"
  | "decide"
  | "explain";

export type StageStatus = "pending" | "running" | "done" | "warn" | "fail" | "skipped";

export interface StageState {
  id: StageId;
  status: StageStatus;
  summary?: string;
  lines: string[];
  startedAt?: number;
  endedAt?: number;
}

export type ReviewStatus = "auto_approved" | "pending" | "approved" | "rejected";

export interface RunRecord {
  id: string;
  createdAt: number;
  durationMs: number;
  fileName: string;
  pageCount: number;
  invoice: Invoice;
  vendorId: string | null;
  vendorMatched: string | null;
  poMatch: PoMatch;
  findings: Finding[];
  decision: Decision;
  explanation: Explanation;
  stages: StageState[];
  model: string;
  reviewStatus: ReviewStatus;
  reviewNote?: string;
  reviewedAt?: number;
}
