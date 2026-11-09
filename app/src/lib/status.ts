// Current-state summary of a case, derived from what is open and resolved NOW.
// The original rule outcome (run.decision, run.findings) is never rewritten;
// this layer only changes what we tell the reviewer. A resolved exception
// stays visible as "authorised" or "attested", never as "all checks passed".

import { REASON_LABEL, SHORT, nextStep } from "../copy.ts";
import type { AuditEvent, ExceptionCode, RunRecord } from "../types.ts";
import { bankCheck } from "./controls.ts";
import { PO_DISCREPANCY, auditActionId, openCodes } from "./review.ts";

export interface CaseSummary {
  tone: "ok" | "warn" | "hold" | "bad" | "wait";
  title: string;
  line: string;
  next: string;
  bankAttested?: { by: string; ref: string };
  poAuthorised?: { by: string; ref: string };
}

function lastEvent(run: RunRecord, id: string): AuditEvent | undefined {
  return [...run.audit].reverse().find((e) => auditActionId(e) === id);
}

export function caseSummary(run: RunRecord): CaseSummary {
  const open = openCodes(run);
  const resolved = new Set(run.resolvedCodes ?? []);
  const flagged = (c: ExceptionCode) => run.findings.some((f) => f.code === c && f.action !== "info");
  const bankEv = lastEvent(run, "verify_bank");
  const poEv = lastEvent(run, "resolve_po");
  const bankDone = flagged("BANK_ACCOUNT_MISMATCH") && resolved.has("BANK_ACCOUNT_MISMATCH") && !!bankEv;
  const poCodes = PO_DISCREPANCY.filter((c) => flagged(c));
  const poDone = poCodes.length > 0 && poCodes.every((c) => resolved.has(c)) && !!poEv;
  const bankAttested = bankDone ? { by: bankEv!.actor, ref: (bankEv!.reference ?? "not recorded").replace(/^Call-back ref /, "").replace(/ · reviewer-attested$/, "") } : undefined;
  const poAuthorised = poDone ? { by: poEv!.actor, ref: (poEv!.reference ?? "").replace(/^Authorised by /, "") } : undefined;
  const base = { bankAttested, poAuthorised };
  const next = nextStep(run, open);

  if (run.status === "rejected") return { ...base, tone: "bad", title: "Rejected", line: run.decision.headline.replace(/^Rejected:?\s*/, "") || "Rejected by a reviewer. No payable was created.", next };
  if (run.status === "approved") {
    const parts: string[] = [];
    if (poAuthorised) parts.push(`PO discrepancy authorised (${poAuthorised.ref}); the original discrepancy stays in the evidence and audit trail. PO record unchanged.`);
    if (bankAttested) parts.push("Bank change verified by reviewer attestation, not independently by the system.");
    const other = [...resolved].filter((c) => flagged(c) && !PO_DISCREPANCY.includes(c) && c !== "BANK_ACCOUNT_MISMATCH");
    if (other.length) parts.push(`Reviewer-resolved: ${other.map((c) => REASON_LABEL[c].toLowerCase()).join(", ")}.`);
    if (!parts.length) return { ...base, tone: "ok", title: "Approved: all checks passed", line: bankCheck(run) === "compared" ? "Totals reconcile, vendor and bank match records, PO within tolerance, no duplicate." : "Totals reconcile, vendor matches records, PO within tolerance, no duplicate. No bank details were printed, so payment would go to the account on file (not verified).", next };
    const title = poAuthorised ? "Approved with authorised PO exception" : bankAttested ? "Approved after bank verification" : "Approved after reviewer resolution";
    return { ...base, tone: "ok", title, line: parts.join(" "), next };
  }
  if (run.status === "awaiting_info") return { ...base, tone: "wait", title: "Awaiting vendor reply", line: `${open.length} item${open.length === 1 ? "" : "s"} still open.`, next };
  if (open.length === 0) {
    const what = bankDone ? "Verification recorded" : "Resolutions recorded";
    return { ...base, tone: "warn", title: `${what} — awaiting approval`, line: bankDone ? "The bank change was verified by the reviewer (attestation). All blocking items are now resolved; the original mismatch stays on record." : "All blocking items are resolved. A reviewer must approve.", next };
  }
  const n = open.length;
  const items = `${n} item${n === 1 ? "" : "s"} still open`;
  const reason = `${SHORT[open[0]] ?? REASON_LABEL[open[0]] + "."}${n > 1 ? ` ${n - 1} more to resolve.` : ""}`;
  if (bankDone) return { ...base, tone: run.status === "payment_hold" ? "hold" : "warn", title: `Bank verification recorded — ${items}`, line: open.map((c) => REASON_LABEL[c]).join(", ") + ".", next };
  if (run.status === "payment_hold") return { ...base, tone: "hold", title: run.decision.headline, line: reason, next };
  return { ...base, tone: "warn", title: n === 1 ? `Needs review: ${REASON_LABEL[open[0]].toLowerCase()}` : `Needs review: ${n} items to resolve`, line: reason, next };
}
