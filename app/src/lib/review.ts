// Reviewer actions on an invoice case. The same rules run in the browser (to
// show what's allowed) and on the server (to enforce it), so a client cannot
// approve past an unresolved financial control.
//
// Controls that need a specific resolution before approval:
//   BANK_ACCOUNT_MISMATCH  → "Record independent bank verification"
//   PO_MATCH_UNCONFIRMED   → "Confirm suggested PO"
//   UNKNOWN_VENDOR / VENDOR_BLOCKED / PO_VENDOR_MISMATCH / DUPLICATE_INVOICE
//                          → cannot be resolved here (vendor master / reject)
// Every other review-level finding is resolved by a reviewer approving with a
// written justification.

import type { AuditEvent, CaseStatus, ExceptionCode, RunRecord } from "../types.ts";

export type ReviewActionId = "verify_bank" | "confirm_po" | "approve" | "request_info" | "keep_on_hold" | "reject";

export interface ReviewRequest {
  action: ReviewActionId;
  reviewer: string;
  justification: string;
  verificationConfirmed?: boolean;
}

export interface ActionOption {
  id: ReviewActionId;
  label: string;
  allowed: boolean;
  blockedReason?: string;
  needsVerification?: boolean;
  tone: "primary" | "neutral" | "danger";
}

const UNRESOLVABLE: ExceptionCode[] = ["UNKNOWN_VENDOR", "VENDOR_BLOCKED", "PO_VENDOR_MISMATCH", "DUPLICATE_INVOICE"];

export function openCodes(run: RunRecord): ExceptionCode[] {
  const resolved = new Set(run.resolvedCodes ?? []);
  return run.findings.filter((f) => f.action !== "info" && !resolved.has(f.code)).map((f) => f.code);
}

export function availableActions(run: RunRecord): ActionOption[] {
  if (run.status === "approved" || run.status === "rejected") return [];
  const open = openCodes(run);
  const has = (c: ExceptionCode) => open.includes(c);
  const hardBlock = open.find((c) => UNRESOLVABLE.includes(c));
  const out: ActionOption[] = [];

  if (has("BANK_ACCOUNT_MISMATCH")) {
    out.push({ id: "verify_bank", label: "Record independent bank verification", allowed: true, needsVerification: true, tone: "primary" });
  }
  if (has("PO_MATCH_UNCONFIRMED")) {
    out.push({ id: "confirm_po", label: `Confirm suggested PO ${run.poMatch.po?.id ?? ""}`.trim(), allowed: true, tone: "primary" });
  }

  let approveBlock: string | undefined;
  if (hardBlock === "UNKNOWN_VENDOR") approveBlock = "Vendor is not in the vendor master. Procurement must onboard it before any approval.";
  else if (hardBlock) approveBlock = "An unresolvable control is open (vendor or duplicate).";
  else if (has("BANK_ACCOUNT_MISMATCH")) approveBlock = "Record independent bank verification first.";
  else if (has("PO_MATCH_UNCONFIRMED")) approveBlock = "Confirm the suggested PO first.";
  out.push({ id: "approve", label: open.length ? "Approve (issues resolved)" : "Approve", allowed: !approveBlock, blockedReason: approveBlock, tone: "primary" });

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
  verify_bank: "Recorded independent bank verification",
  confirm_po: "Confirmed suggested PO",
  approve: "Approved after review",
  request_info: "Requested clarification from vendor",
  keep_on_hold: "Kept on hold",
  reject: "Rejected submission",
};

// Status once a control is resolved: holds clear to review, review clears to
// approved only through an explicit approve.
function statusAfterResolve(run: RunRecord, resolved: ExceptionCode[]): CaseStatus {
  const remaining = run.findings.filter((f) => f.action !== "info" && !resolved.includes(f.code));
  if (remaining.some((f) => f.action === "reject")) return "rejected";
  if (remaining.some((f) => f.action === "escalate")) return "payment_hold";
  return "needs_review";
}

export function applyReviewAction(run: RunRecord, req: ReviewRequest, now = Date.now()): { ok: true; run: RunRecord } | { ok: false; error: string } {
  const reviewer = (req.reviewer ?? "").trim();
  const justification = (req.justification ?? "").trim();
  if (!reviewer) return { ok: false, error: "Reviewer name is required." };
  if (justification.length < 5) return { ok: false, error: "A justification is required for the audit trail." };
  const option = availableActions(run).find((o) => o.id === req.action);
  if (!option) return { ok: false, error: `"${req.action}" is not available for a case in status ${run.status}.` };
  if (!option.allowed) return { ok: false, error: option.blockedReason ?? "Action not allowed." };
  if (option.needsVerification && !req.verificationConfirmed) {
    return { ok: false, error: "Confirm that the bank change was independently verified with a trusted vendor contact." };
  }

  let resolved = [...(run.resolvedCodes ?? [])];
  let to: CaseStatus;
  switch (req.action) {
    case "verify_bank":
      resolved = [...resolved, "BANK_ACCOUNT_MISMATCH"];
      to = statusAfterResolve(run, resolved);
      break;
    case "confirm_po":
      resolved = [...resolved, "PO_MATCH_UNCONFIRMED"];
      to = statusAfterResolve(run, resolved);
      break;
    case "approve":
      resolved = [...new Set([...resolved, ...openCodes(run)])];
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
  const event: AuditEvent = { at: now, actor: reviewer, kind: "reviewer", action: ACTION_TEXT[req.action], fromStatus: run.status, toStatus: to, note: justification };
  return { ok: true, run: { ...run, status: to, resolvedCodes: resolved, audit: [...run.audit, event] } };
}
