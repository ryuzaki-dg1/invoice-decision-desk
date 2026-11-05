// Plain-language labels and "why it matters" text for each rule code, written
// for an AP executive. Amounts come from the run; nothing here is invented.

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
