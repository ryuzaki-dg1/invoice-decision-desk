// Reviewer actions on an invoice case. The same rules run in the browser (to
// show what's allowed) and on the server (to enforce it), so a client cannot
// approve past an unresolved financial control.
//
// Every blocking finding needs its OWN explicit resolution before Approve
// unlocks. Resolving one finding never approves an invoice that still has
// another open finding; the status is recomputed from what remains.
//
//   BANK_ACCOUNT_MISMATCH              → verify_bank (recorded call-back)
//   PO_MATCH_UNCONFIRMED               → confirm_po
//   HANDWRITTEN / LOW_EXTRACTION       → confirm_fields
//   PO value / qty / price / expiry…   → resolve_po (authorised amendment, with reference)
//   ARITHMETIC / MISSING_FIELD /
//   MISSING_PO_REFERENCE / UNKNOWN_PO  → correct the fields (server re-runs every rule)
//   POSSIBLE_DUPLICATE / OVER_LIMIT    → approve with justification (judgement calls)
//   UNKNOWN_VENDOR / VENDOR_BLOCKED /
//   PO_VENDOR_MISMATCH / DUPLICATE     → cannot be resolved here

import type { AuditEvent, CaseStatus, ExceptionCode, RunRecord } from "../types.ts";

export type ReviewActionId = "verify_bank" | "confirm_po" | "confirm_fields" | "resolve_po" | "approve" | "request_info" | "keep_on_hold" | "reject";

export interface ReviewRequest {
  action: ReviewActionId;
  reviewer: string;
  justification: string;
  verificationConfirmed?: boolean; // verify_bank: reviewer's explicit manual attestation
  verificationReference?: string; // verify_bank: call reference (who was spoken to, when, ticket no.)
  authorizedBy?: string; // resolve_po: PO owner / budget holder who authorised
  reference?: string; // resolve_po: amendment or approval reference
}

export interface ActionOption {
  id: ReviewActionId;
  label: string;
  allowed: boolean;
  blockedReason?: string;
  needsVerification?: boolean;
  needsAuthorization?: boolean;
  resolves?: ExceptionCode[];
  tone: "primary" | "neutral" | "danger";
}

export const UNRESOLVABLE: ExceptionCode[] = ["UNKNOWN_VENDOR", "VENDOR_BLOCKED", "PO_VENDOR_MISMATCH", "DUPLICATE_INVOICE"];
export const PO_DISCREPANCY: ExceptionCode[] = ["CUMULATIVE_PO_EXCEEDED", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "PRICE_VARIANCE", "PENDING_PO_CONFLICT", "EXPIRED_PO", "CLOSED_PO", "LINE_NOT_ON_PO", "CURRENCY_MISMATCH"];
export const NEEDS_CORRECTION: ExceptionCode[] = ["ARITHMETIC_MISMATCH", "MISSING_FIELD", "MISSING_PO_REFERENCE", "UNKNOWN_PO"];
const FIELD_CONFIRM: ExceptionCode[] = ["HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE"];
// Judgement calls a reviewer may accept with a written justification.
const APPROVE_RESOLVES: ExceptionCode[] = ["POSSIBLE_DUPLICATE", "OVER_APPROVAL_LIMIT"];

const GENERIC = /^(ok(ay)?|fine|looks? (fine|good|ok|legit)|seems? (fine|legit|ok|good)|approved?|done|checked|verified|confirmed|n\/?a|none|test|asdf+|yes|lgtm|all good|good)\W*$/i;

// A justification has to say something: at least 15 characters, 3 words, and
// not a stock phrase. Shared by review actions and field corrections; enforced
// on the server too.
export function justificationError(text: string, what = "justification"): string | null {
  const t = (text ?? "").trim();
  if (t.length < 15 || t.split(/\s+/).length < 3 || GENERIC.test(t)) return `Give a specific ${what} (at least 15 characters, saying what was checked and with whom or against what).`;
  return null;
}

// Events written before actionId existed are recognised by their stored text.
export function auditActionId(e: AuditEvent): string | undefined {
  if (e.kind !== "reviewer") return undefined;
  if (e.actionId) return e.actionId;
  if (/^Verified payment details/.test(e.action)) return "verify_bank";
  if (/^Resolved PO discrepancy/.test(e.action)) return "resolve_po";
  return undefined;
}

export function openCodes(run: RunRecord): ExceptionCode[] {
  const resolved = new Set(run.resolvedCodes ?? []);
  return [...new Set(run.findings.filter((f) => f.action !== "info" && !resolved.has(f.code)).map((f) => f.code))];
}

export function availableActions(run: RunRecord): ActionOption[] {
  if (run.status === "approved" || run.status === "rejected") return [];
  const open = openCodes(run);
  const has = (...c: ExceptionCode[]) => c.some((x) => open.includes(x));
  const hardBlock = open.find((c) => UNRESOLVABLE.includes(c));
  const out: ActionOption[] = [];

  if (has("BANK_ACCOUNT_MISMATCH")) out.push({ id: "verify_bank", label: "Verify payment details", allowed: true, needsVerification: true, resolves: ["BANK_ACCOUNT_MISMATCH"], tone: "primary" });
  if (has(...FIELD_CONFIRM)) out.push({ id: "confirm_fields", label: "Confirm extracted information", allowed: true, resolves: open.filter((c) => FIELD_CONFIRM.includes(c)), tone: "primary" });
  if (has("PO_MATCH_UNCONFIRMED")) out.push({ id: "confirm_po", label: `Confirm suggested PO ${run.poMatch.po?.id ?? ""}`.trim(), allowed: true, resolves: ["PO_MATCH_UNCONFIRMED"], tone: "primary" });
  if (has(...PO_DISCREPANCY)) {
    out.push({ id: "resolve_po", label: "Resolve PO discrepancy", allowed: true, needsAuthorization: true, resolves: open.filter((c) => PO_DISCREPANCY.includes(c)), tone: "primary" });
  }

  // Approve only when nothing material is open.
  const blocking = open.filter((c) => !APPROVE_RESOLVES.includes(c));
  let approveBlock: string | undefined;
  if (hardBlock === "UNKNOWN_VENDOR") approveBlock = "Vendor isn't in the vendor master. Procurement must onboard and verify it first.";
  else if (hardBlock) approveBlock = "An unresolvable control is open (vendor or duplicate).";
  else if (blocking.length) {
    const names: Partial<Record<ExceptionCode, string>> = { BANK_ACCOUNT_MISMATCH: "verify payment details", PO_MATCH_UNCONFIRMED: "confirm the PO", HANDWRITTEN_DOCUMENT: "confirm the extracted information", LOW_EXTRACTION_CONFIDENCE: "confirm the extracted information" };
    const steps = [...new Set(blocking.map((c) => names[c] ?? (PO_DISCREPANCY.includes(c) ? "resolve the PO discrepancy" : NEEDS_CORRECTION.includes(c) ? "correct the extracted fields" : c)))];
    approveBlock = `Still open: ${steps.join(", ")}.`;
  }
  out.push({ id: "approve", label: "Approve for payment run", allowed: !approveBlock, blockedReason: approveBlock, resolves: open.filter((c) => APPROVE_RESOLVES.includes(c)), tone: "primary" });

  out.push({
    id: "request_info",
    label: hardBlock === "UNKNOWN_VENDOR" ? "Request vendor onboarding" : "Request clarification",
    allowed: run.status !== "awaiting_info",
    blockedReason: run.status === "awaiting_info" ? "Already waiting on the vendor." : undefined,
    tone: "neutral",
  });
  if (run.status === "payment_hold") out.push({ id: "keep_on_hold", label: "Keep on hold", allowed: true, tone: "neutral" });
  out.push({ id: "reject", label: "Reject submission", allowed: true, tone: "danger" });
  return out;
}

const ACTION_TEXT: Record<ReviewActionId, string> = {
  verify_bank: "Reviewer attested bank details verified by call-back (not independently verified by the system)",
  confirm_po: "Confirmed suggested PO",
  confirm_fields: "Confirmed extracted information against the original document",
  resolve_po: "Resolved PO discrepancy with authorisation",
  approve: "Approved for payment run",
  request_info: "Requested information",
  keep_on_hold: "Kept on hold",
  reject: "Rejected submission",
};

// Recompute status from the findings that remain after a resolution: holds
// clear to review, review clears to approved only through an explicit approve.
export function statusFromOpen(run: RunRecord, resolved: ExceptionCode[]): CaseStatus {
  const remaining = run.findings.filter((f) => f.action !== "info" && !resolved.includes(f.code));
  if (remaining.some((f) => f.action === "reject")) return "rejected";
  if (remaining.some((f) => f.action === "escalate")) return "payment_hold";
  return "needs_review";
}

export function applyReviewAction(run: RunRecord, req: ReviewRequest, now = Date.now()): { ok: true; run: RunRecord } | { ok: false; error: string } {
  const reviewer = (req.reviewer ?? "").trim();
  const justification = (req.justification ?? "").trim();
  if (!reviewer) return { ok: false, error: "Reviewer name is required." };
  const jErr = justificationError(justification);
  if (jErr) return { ok: false, error: jErr };
  const option = availableActions(run).find((o) => o.id === req.action);
  if (!option) return { ok: false, error: `"${req.action}" is not available for a case that is ${run.status.replace("_", " ")}.` };
  if (!option.allowed) return { ok: false, error: option.blockedReason ?? "Action not allowed." };
  if (option.needsVerification && !req.verificationConfirmed) return { ok: false, error: "Tick the attestation: you personally verified the bank change with the trusted contact on file." };
  if (option.needsVerification && (req.verificationReference ?? "").trim().length < 3) return { ok: false, error: "Enter a verification reference (who you spoke to, date/time or ticket number)." };
  if (option.needsAuthorization && (!req.authorizedBy?.trim() || !req.reference?.trim())) return { ok: false, error: "Record who authorised the PO change and the amendment or approval reference." };

  const before = openCodes(run);
  let resolved = [...(run.resolvedCodes ?? [])];
  let to: CaseStatus;
  switch (req.action) {
    case "verify_bank":
    case "confirm_po":
    case "confirm_fields":
    case "resolve_po":
      resolved = [...new Set([...resolved, ...(option.resolves ?? [])])];
      to = statusFromOpen(run, resolved);
      break;
    case "approve":
      resolved = [...new Set([...resolved, ...(option.resolves ?? [])])];
      to = "approved";
      break;
    case "request_info":
      to = "awaiting_info";
      break;
    case "keep_on_hold":
      to = "payment_hold";
      break;
    case "reject":
      to = "rejected";
      break;
  }
  const remaining = run.findings.filter((f) => f.action !== "info" && !resolved.includes(f.code)).map((f) => f.code);
  const event: AuditEvent = {
    at: now,
    actor: reviewer,
    kind: "reviewer",
    action: ACTION_TEXT[req.action],
    fromStatus: run.status,
    toStatus: to,
    note: justification,
    resolved: before.filter((c) => resolved.includes(c)),
    remaining: to === "approved" || to === "rejected" ? [] : [...new Set(remaining)],
    reference: req.action === "resolve_po" ? `Authorised by ${req.authorizedBy!.trim()} · ref ${req.reference!.trim()}` : req.action === "verify_bank" ? `Call-back ref ${req.verificationReference!.trim()} · reviewer-attested` : undefined,
    actionId: req.action,
    attested: req.action === "verify_bank" ? true : undefined,
  };
  return { ok: true, run: { ...run, status: to, resolvedCodes: resolved, audit: [...run.audit, event] } };
}
