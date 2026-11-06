// Derives the reviewer-facing control checklist, invoice-check and
// payment-readiness indicators purely from a run's findings and resolution
// state. Nothing here is stored or editable: resolve a finding (review.ts) or
// correct the fields (revalidate.ts) and these recompute.

import type { ExceptionCode, RunRecord } from "../types.ts";
import { NEEDS_CORRECTION, PO_DISCREPANCY, type ReviewActionId } from "./review.ts";

export type ControlStatus = "passed" | "unresolved" | "resolved" | "na";
export type ControlAction = ReviewActionId | "correct";

export interface ControlItem {
  key: "document" | "vendor" | "payment" | "po" | "duplicate" | "limit";
  label: string;
  status: ControlStatus;
  open: ExceptionCode[];
  resolvedBy?: string; // reviewer + action that resolved it
  action?: { id: ControlAction; label: string };
  evidenceId: string; // DOM id of the supporting evidence block
}

const GROUPS: { key: ControlItem["key"]; label: string; codes: ExceptionCode[]; evidenceId: string; pass: string }[] = [
  { key: "document", label: "Document read & arithmetic", codes: ["MISSING_FIELD", "ARITHMETIC_MISMATCH", "HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE"], evidenceId: "ev-math", pass: "All required fields present; totals reconcile." },
  { key: "vendor", label: "Vendor identity", codes: ["UNKNOWN_VENDOR", "VENDOR_BLOCKED", "PO_VENDOR_MISMATCH"], evidenceId: "ev-vendor", pass: "Payee matches the approved vendor master." },
  { key: "payment", label: "Payment details", codes: ["BANK_ACCOUNT_MISMATCH"], evidenceId: "ev-vendor", pass: "Remit-to account matches the account on file (or none printed)." },
  { key: "po", label: "Purchase order", codes: ["PO_MATCH_UNCONFIRMED", "MISSING_PO_REFERENCE", "UNKNOWN_PO", ...PO_DISCREPANCY], evidenceId: "ev-po", pass: "Within PO value, quantities and prices (cumulative)." },
  { key: "duplicate", label: "Duplicate check", codes: ["DUPLICATE_INVOICE", "POSSIBLE_DUPLICATE"], evidenceId: "ev-dup", pass: "Not a repeat of an invoice already on file." },
  { key: "limit", label: "Approval limit", codes: ["OVER_APPROVAL_LIMIT"], evidenceId: "ev-math", pass: "Within the auto-approval limit." },
];

export const PASS_TEXT: Record<ControlItem["key"], string> = Object.fromEntries(GROUPS.map((g) => [g.key, g.pass])) as Record<ControlItem["key"], string>;

function actionFor(key: ControlItem["key"], open: ExceptionCode[]): ControlItem["action"] {
  const has = (...c: ExceptionCode[]) => c.some((x) => open.includes(x));
  switch (key) {
    case "document":
      return has(...NEEDS_CORRECTION) ? { id: "correct", label: "Correct extracted fields" } : { id: "confirm_fields", label: "Confirm extracted information" };
    case "vendor":
      return { id: "request_info", label: "Request vendor onboarding" };
    case "payment":
      return { id: "verify_bank", label: "Verify payment details" };
    case "po":
      if (has("PO_MATCH_UNCONFIRMED")) return { id: "confirm_po", label: "Confirm suggested PO" };
      if (has("MISSING_PO_REFERENCE", "UNKNOWN_PO")) return { id: "correct", label: "Assign the PO" };
      return { id: "resolve_po", label: "Resolve PO discrepancy" };
    case "duplicate":
      return has("POSSIBLE_DUPLICATE") ? { id: "approve", label: "Accept at approval with justification" } : undefined;
    case "limit":
      return { id: "approve", label: "Second approver signs off" };
  }
}

export function deriveControls(run: RunRecord): ControlItem[] {
  const resolved = new Set(run.resolvedCodes ?? []);
  const blocking = run.findings.filter((f) => f.action !== "info");
  const items: ControlItem[] = [];
  for (const g of GROUPS) {
    const mine = [...new Set(blocking.filter((f) => g.codes.includes(f.code)).map((f) => f.code))];
    if (g.key === "limit" && !mine.length) continue; // only shown when it applies
    const open = mine.filter((c) => !resolved.has(c));
    let status: ControlStatus = !mine.length ? "passed" : open.length ? "unresolved" : "resolved";
    if (g.key === "po" && !run.poMatch.po && !mine.length) status = "na";
    const ev = status === "resolved" ? [...run.audit].reverse().find((e) => e.kind === "reviewer" && e.resolved?.some((c) => mine.includes(c))) : undefined;
    items.push({
      key: g.key,
      label: g.label,
      status,
      open,
      resolvedBy: ev ? `${ev.action} · ${ev.actor}` : status === "resolved" ? "Resolved by reviewer" : undefined,
      action: status === "unresolved" && !(g.key === "duplicate" && open.includes("DUPLICATE_INVOICE")) ? actionFor(g.key, open) : undefined,
      evidenceId: g.evidenceId,
    });
  }
  return items;
}

// Is the INVOICE itself in order (document, arithmetic, PO, duplicates)?
export function invoiceChecks(run: RunRecord): "Passed" | "Exceptions found" | "Incomplete" {
  const c = deriveControls(run);
  const doc = c.find((x) => x.key === "document");
  if (doc?.status === "unresolved") return "Incomplete";
  if (c.some((x) => (x.key === "po" || x.key === "duplicate") && x.status === "unresolved")) return "Exceptions found";
  if (run.findings.some((f) => f.code === "DUPLICATE_INVOICE")) return "Exceptions found";
  return "Passed";
}

// Is it SAFE TO PAY? A valid invoice can still be unsafe (e.g. changed bank).
// "Ready" means approved for the payment run; nothing here sends payments.
export function paymentReadiness(run: RunRecord): { label: "Ready" | "Awaiting verification" | "Awaiting approval" | "Blocked" | "Closed"; detail: string } {
  if (run.status === "rejected") return { label: "Closed", detail: "No payable created" };
  if (run.status === "approved") return { label: "Ready", detail: "Approved for the payment run · not yet paid" };
  const c = deriveControls(run);
  const unresolved = c.filter((x) => x.status === "unresolved");
  if (c.find((x) => x.key === "vendor")?.status === "unresolved") return { label: "Blocked", detail: "Vendor not onboarded" };
  if (unresolved.length === 1 && unresolved[0].key === "payment") return { label: "Awaiting verification", detail: "Bank change needs a call-back" };
  if (unresolved.length) return { label: "Blocked", detail: `${unresolved.length} unresolved control${unresolved.length > 1 ? "s" : ""}` };
  return { label: "Awaiting approval", detail: "All controls satisfied · approval is an explicit step" };
}

// How an individual processing attempt relates to its invoice case.
export function attemptKind(run: RunRecord): "duplicate_of_paid" | "duplicate_submission" | "original" {
  if (!run.duplicateOf) return "original";
  return run.duplicateOf.source === "erp" ? "duplicate_of_paid" : "duplicate_submission";
}
