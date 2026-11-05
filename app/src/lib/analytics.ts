// One analytics layer for every screen, so Overview, Queue and History can't
// disagree.
//
//  - Attempt: one execution of the pipeline (every upload, including repeats).
//  - Invoice case: one invoice identity. Identity = matched vendor + normalised
//    invoice number when both are known (reliable); otherwise the file hash;
//    otherwise the attempt itself (never merged on guesswork, e.g. amount).
//  - The case's PRIMARY attempt is the first one that wasn't itself rejected as
//    a repeat of an earlier attempt; later attempts are kept and shown as
//    history, never deleted.

import type { CaseStatus, ExceptionCode, RunRecord } from "../types.ts";
import { isOpen, normalizeInvoiceNumber } from "./engine.ts";

export interface InvoiceCase {
  key: string;
  identity: "vendor+number" | "file" | "attempt";
  primary: RunRecord;
  attempts: RunRecord[]; // oldest first
  latest: RunRecord;
  status: CaseStatus;
}

export function caseKey(r: RunRecord): { key: string; identity: InvoiceCase["identity"] } {
  const n = normalizeInvoiceNumber(r.invoice.invoiceNumber);
  if (r.vendorId && n) return { key: `${r.vendorId}|${n}`, identity: "vendor+number" };
  if (r.fileHash) return { key: `file|${r.fileHash}`, identity: "file" };
  return { key: `run|${r.id}`, identity: "attempt" };
}

export function buildCases(runs: RunRecord[]): InvoiceCase[] {
  const groups = new Map<string, { identity: InvoiceCase["identity"]; runs: RunRecord[] }>();
  for (const r of [...runs].sort((a, b) => a.createdAt - b.createdAt)) {
    const { key, identity } = caseKey(r);
    const g = groups.get(key) ?? { identity, runs: [] };
    g.runs.push(r);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const primary = g.runs.find((r) => !r.repeatSubmission) ?? g.runs[0];
      return { key, identity: g.identity, primary, attempts: g.runs, latest: g.runs[g.runs.length - 1], status: primary.status };
    })
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

// Upload → initial automated decision (excludes the explanation step and any
// time waiting for a human).
export function timeToDecision(r: RunRecord): number {
  const decide = r.stages.find((s) => s.id === "decide");
  return decide?.endedAt ? Math.max(0, decide.endedAt - r.createdAt) : r.durationMs;
}

const isDuplicateCase = (c: InvoiceCase) => c.primary.findings.some((f) => f.code === "DUPLICATE_INVOICE");

export interface Metrics {
  attempts: number;
  cases: number;
  repeatAttempts: number;
  eligible: number; // unique cases with an initial decision, excluding duplicates of invoices already on file
  autoApproved: number; // eligible cases approved by rules with no human touch
  stpRate: number | null;
  awaiting: number; // unique cases still open (review, hold, awaiting vendor)
  holds: number;
  valueRequiringIntervention: number;
  avgDecisionMs: number | null;
  byStatus: Record<"approved" | "needs_review" | "payment_hold" | "rejected", number>;
  topExceptions: [ExceptionCode, number][];
}

export function computeMetrics(runs: RunRecord[]): Metrics {
  const cases = buildCases(runs);
  const eligible = cases.filter((c) => !isDuplicateCase(c));
  const auto = eligible.filter((c) => c.primary.decision.resolution === "AUTO_APPROVE" && !c.primary.audit.some((e) => e.kind === "reviewer"));
  const open = cases.filter((c) => isOpen(c.status));
  const byStatus = { approved: 0, needs_review: 0, payment_hold: 0, rejected: 0 };
  for (const c of cases) byStatus[c.status === "awaiting_info" ? "needs_review" : c.status]++;
  const reasons = new Map<ExceptionCode, number>();
  for (const c of cases) for (const code of new Set(c.primary.findings.filter((f) => f.action !== "info").map((f) => f.code))) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  return {
    attempts: runs.length,
    cases: cases.length,
    repeatAttempts: runs.length - cases.length,
    eligible: eligible.length,
    autoApproved: auto.length,
    stpRate: eligible.length ? auto.length / eligible.length : null,
    awaiting: open.length,
    holds: open.filter((c) => c.status === "payment_hold").length,
    valueRequiringIntervention: open.reduce((s, c) => s + (c.primary.invoice.total ?? 0), 0),
    avgDecisionMs: runs.length ? runs.reduce((s, r) => s + timeToDecision(r), 0) / runs.length : null,
    byStatus,
    topExceptions: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}

// Open cases (primary attempts only), for the queue and the attention list.
export function openCases(runs: RunRecord[]): RunRecord[] {
  return buildCases(runs)
    .filter((c) => isOpen(c.status))
    .map((c) => c.primary);
}
