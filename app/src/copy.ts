// Plain-language labels and "why it matters" text for each rule code, written
// for an AP executive. Amounts come from the run; nothing here is invented.

import { VENDORS } from "./data/vendors";
import { money } from "./lib/engine";
import type { ExceptionCode, RunRecord } from "./types";

export const REASON_LABEL: Record<ExceptionCode, string> = {
  MISSING_FIELD: "Missing required fields",
  ARITHMETIC_MISMATCH: "Invoice totals don't add up",
  LOW_EXTRACTION_CONFIDENCE: "Uncertain read of key figures",
  HANDWRITTEN_DOCUMENT: "Handwritten invoice",
  SCANNED_DOCUMENT: "Scanned document",
  UNKNOWN_VENDOR: "Unknown vendor",
  VENDOR_BLOCKED: "Blocked vendor",
  VENDOR_NAME_VARIANT: "Vendor name variant",
  BANK_ACCOUNT_MISMATCH: "Bank account mismatch",
  MISSING_PO_REFERENCE: "No PO reference",
  PO_MATCH_UNCONFIRMED: "PO match unconfirmed",
  UNKNOWN_PO: "PO not recognised",
  PO_VENDOR_MISMATCH: "PO belongs to another vendor",
  EXPIRED_PO: "Expired PO",
  CLOSED_PO: "Closed PO",
  CURRENCY_MISMATCH: "Currency mismatch",
  PO_AMOUNT_EXCEEDED: "Invoice exceeds PO",
  CUMULATIVE_PO_EXCEEDED: "Cumulative billing exceeds PO",
  PENDING_PO_CONFLICT: "Competes with pending invoice on PO",
  QUANTITY_EXCEEDS_PO: "Quantity exceeds PO",
  PRICE_VARIANCE: "Unit price above PO",
  LINE_NOT_ON_PO: "Line not on PO",
  PARTIAL_BILLING: "Partial billing",
  WITHIN_TOLERANCE: "Variance within tolerance",
  DUPLICATE_INVOICE: "Duplicate invoice",
  POSSIBLE_DUPLICATE: "Possible duplicate",
  REPEAT_SUBMISSION: "Repeat upload",
  OVER_APPROVAL_LIMIT: "Above auto-approval limit",
};

// One plain-language line per rule, for summaries. Details live in Detailed view.
export const SHORT: Partial<Record<ExceptionCode, string>> = {
  BANK_ACCOUNT_MISMATCH: "The account on this invoice doesn't match the approved vendor record.",
  UNKNOWN_VENDOR: "This payee isn't in the approved vendor list.",
  DUPLICATE_INVOICE: "This invoice is already on file. Paying it would pay the same bill twice.",
  CUMULATIVE_PO_EXCEEDED: "Together with earlier invoices, this bills more than the PO allows.",
  PO_AMOUNT_EXCEEDED: "The invoice is above the PO value, beyond tolerance.",
  QUANTITY_EXCEEDS_PO: "More units are billed than were ordered.",
  PRICE_VARIANCE: "The unit price is higher than agreed on the PO.",
  PO_MATCH_UNCONFIRMED: "No PO is printed. A likely PO was suggested and needs confirming.",
  MISSING_PO_REFERENCE: "No PO is printed and none fits the invoice.",
  UNKNOWN_PO: "The PO number on the invoice doesn't exist.",
  ARITHMETIC_MISMATCH: "The numbers on the invoice don't add up.",
  MISSING_FIELD: "Required details are missing from the invoice.",
  HANDWRITTEN_DOCUMENT: "Handwritten invoice. A person confirms the figures before approval.",
  LOW_EXTRACTION_CONFIDENCE: "Some figures couldn't be read with certainty.",
  EXPIRED_PO: "The PO has expired and needs re-authorisation.",
  POSSIBLE_DUPLICATE: "Same vendor and amount as a recent invoice with a different number.",
  PENDING_PO_CONFLICT: "Another unapproved invoice is competing for the same PO.",
  OVER_APPROVAL_LIMIT: "Above the auto-approval limit, so a person signs off.",
  PO_VENDOR_MISMATCH: "The PO belongs to a different vendor.",
};

// The shortest correct instruction for what to do next.
export function nextStep(run: RunRecord, open: ExceptionCode[]): string {
  if (run.status === "approved") return "Eligible for the next payment run. Not yet paid.";
  if (run.status === "rejected") return "Nothing to do. No payable was created.";
  const v = VENDORS.find((x) => x.id === run.vendorId);
  const po = run.poMatch.po;
  switch (requiredAction(run, open)) {
    case "bank":
      return `Verify the bank change by calling ${v ? `${v.name} on ${v.phone}` : "the vendor"}, the contact already on file.`;
    case "onboard":
      return "Send the vendor to procurement for onboarding. It can't be approved until then.";
    case "fields":
      return "Check the highlighted figures against the original, then correct or confirm them.";
    case "po":
      return po ? `Confirm ${po.id} with ${po.approvedBy}, or assign the right PO.` : "Ask the requester which PO this invoice belongs to.";
    case "po_amount":
      return run.decision.nextAction.replace(/^\d\.\s*/, "").split(/ \d\. /)[0];
    case "dup":
      return "Ask the vendor whether this re-issues an invoice already on file.";
    case "waiting":
      return "Waiting for the vendor's reply.";
    default:
      return "Review the findings, then approve with a justification or reject.";
  }
}

// What the analyst has to DO next, derived from the open controls. The queue
// groups by this instead of by status.
export type ActionKey = "bank" | "onboard" | "fields" | "po" | "po_amount" | "dup" | "review" | "waiting";
export const ACTION_GROUPS: { key: ActionKey; label: string; hint: string }[] = [
  { key: "bank", label: "Verify payment details", hint: "Call the trusted contact on file before releasing" },
  { key: "onboard", label: "Vendor onboarding", hint: "Payee is not in the vendor master" },
  { key: "fields", label: "Confirm extracted data", hint: "Handwritten, uncertain or inconsistent figures" },
  { key: "po", label: "Confirm PO", hint: "No PO printed; a match is only suggested" },
  { key: "po_amount", label: "Resolve PO mismatch", hint: "Over PO value, quantity or price" },
  { key: "dup", label: "Check possible duplicate", hint: "Same vendor and amount as a recent invoice" },
  { key: "review", label: "Review and approve", hint: "Judgement call with justification" },
  { key: "waiting", label: "Waiting on vendor", hint: "Clarification requested" },
];

export function requiredAction(run: RunRecord, open: ExceptionCode[]): ActionKey {
  if (run.status === "awaiting_info") return "waiting";
  const any = (...c: ExceptionCode[]) => c.some((x) => open.includes(x));
  if (any("BANK_ACCOUNT_MISMATCH")) return "bank";
  if (any("UNKNOWN_VENDOR", "VENDOR_BLOCKED", "PO_VENDOR_MISMATCH")) return "onboard";
  if (any("ARITHMETIC_MISMATCH", "MISSING_FIELD", "HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE")) return "fields";
  if (any("PO_MATCH_UNCONFIRMED", "MISSING_PO_REFERENCE", "UNKNOWN_PO")) return "po";
  if (any("CUMULATIVE_PO_EXCEEDED", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "PRICE_VARIANCE", "PENDING_PO_CONFLICT", "EXPIRED_PO", "CLOSED_PO", "LINE_NOT_ON_PO", "CURRENCY_MISMATCH")) return "po_amount";
  if (any("POSSIBLE_DUPLICATE")) return "dup";
  return "review";
}

export function whyItMatters(code: ExceptionCode, run: RunRecord): string {
  const amt = money(run.invoice.total, run.invoice.currency);
  const b = run.poMatch.billing;
  switch (code) {
    case "BANK_ACCOUNT_MISMATCH":
      return `Payments sent to a fraudster's account are rarely recovered. The full ${amt} is at risk if the change is not genuine.`;
    case "UNKNOWN_VENDOR":
      return `No verified legal entity, tax ID or bank account exists for this payee. Paying ${amt} would bypass vendor due diligence.`;
    case "DUPLICATE_INVOICE":
      return `Processing it would create a second payable for the same bill: ${amt} paid twice.`;
    case "CUMULATIVE_PO_EXCEEDED":
      return b ? `Paying it would spend ${money(b.billedAfter - b.poTotal)} more than was authorised on the PO.` : "Spend would exceed what was authorised.";
    case "PO_AMOUNT_EXCEEDED":
      return b ? `${money(b.billedAfter - b.poTotal)} above the authorised PO value.` : "Spend would exceed what was authorised.";
    case "PENDING_PO_CONFLICT":
      return "Two unapproved invoices together exceed what the PO authorises; approving both would overspend.";
    case "QUANTITY_EXCEEDS_PO":
      return "Billing for more units than were ordered usually means over-delivery or a billing error.";
    case "ARITHMETIC_MISMATCH":
      return "If the numbers on the invoice don't reconcile, the amount due cannot be trusted, whatever the PO says.";
    case "PO_MATCH_UNCONFIRMED":
      return "Without a confirmed PO there is no proof this spend was authorised. The suggested match is a lead, not evidence.";
    case "HANDWRITTEN_DOCUMENT":
    case "LOW_EXTRACTION_CONFIDENCE":
      return "A single misread digit changes the amount paid. A person confirms the figures against the original.";
    case "MISSING_FIELD":
      return "Without these fields the invoice cannot be booked or checked for duplicates.";
    case "EXPIRED_PO":
      return "Spend against an expired PO is no longer authorised until the owner re-approves it.";
    case "POSSIBLE_DUPLICATE":
      return `Same vendor and amount as a recent invoice; could be a re-issue of a bill already on file (${amt}).`;
    case "PRICE_VARIANCE":
      return "The vendor is charging more per unit than agreed on the PO.";
    case "OVER_APPROVAL_LIMIT":
      return "Large invoices always get a second pair of eyes, by policy.";
    default:
      return "Requires a human decision before payment.";
  }
}
