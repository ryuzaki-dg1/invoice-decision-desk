// Reviewer corrections → full deterministic re-validation. Runs on the server
// so a correction can never skip a check: the corrected invoice goes through
// exactly the same validate / vendor / PO / duplicate / decide rules as a new
// upload, against the same reference data and the run's own policy snapshot.

import { PURCHASE_ORDERS } from "../data/purchaseOrders.ts";
import { ERP_LEDGER, VENDORS } from "../data/vendors.ts";
import type { AuditEvent, CaseStatus, Correction, ExceptionCode, FieldChange, Invoice, LineItem, RunRecord } from "../types.ts";
import { buildLedger, checkDuplicates, checkVendor, decide, initialStatus, matchPurchaseOrder, money, templateExplanation, validateInvoice } from "./engine.ts";
import { DEFAULT_RULES, type Rules } from "./policy.ts";

// Fields a reviewer may correct. Vendor name and bank account are deliberately
// excluded: editing them would let a reviewer launder a fraud signal.
export const EDITABLE_TOP = ["invoiceNumber", "issueDate", "poReference", "subtotal", "tax", "shipping", "otherCharges", "discount", "total"] as const;
export const EDITABLE_LINE = ["quantity", "unitPrice", "total"] as const;
const NUMERIC = new Set(["subtotal", "tax", "shipping", "otherCharges", "discount", "total"]);

export interface CorrectionRequest {
  reviewer: string;
  reason: string;
  invoice: Omit<Partial<Invoice>, "lineItems"> & { lineItems?: Partial<LineItem>[] };
}

const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? String(v) : String(v));

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// The deterministic part of the pipeline (everything after extraction), for
// one invoice against the other stored runs. Used for corrections and for
// previewing the impact of a policy change.
export function evaluate(inv: Invoice, rules: Rules, run: Pick<RunRecord, "id" | "fileHash">, others: RunRecord[], now = Date.now()) {
  const rest = others.filter((r) => r.id !== run.id);
  const ledger = buildLedger(ERP_LEDGER, rest);
  const prior = rest.filter((r) => r.fileHash !== run.fileHash).map((r) => ({ runId: r.id, fileHash: r.fileHash, createdAt: r.createdAt, status: r.status, invoiceNumber: r.invoice.invoiceNumber }));
  const findings = [...validateInvoice(inv, rules)];
  const v = checkVendor(inv, VENDORS);
  findings.push(...v.findings);
  const pm = matchPurchaseOrder(inv, v.vendor, PURCHASE_ORDERS, ledger, rules, new Date(now).toISOString().slice(0, 10));
  findings.push(...pm.findings);
  const dup = checkDuplicates(inv, v.vendor, ledger, rules, run.fileHash, prior);
  findings.push(...dup.findings);
  const { decision, extra } = decide(inv, findings, rules, v.vendor, dup.duplicateOf, pm.poMatch);
  findings.push(...extra);
  return { findings, decision, v, pm, dup };
}

export function applyCorrections(run: RunRecord, req: CorrectionRequest, others: RunRecord[], now = Date.now()): { ok: true; run: RunRecord; changes: FieldChange[] } | { ok: false; error: string } {
  const reviewer = (req.reviewer ?? "").trim();
  const reason = (req.reason ?? "").trim();
  if (!reviewer) return { ok: false, error: "Reviewer name is required." };
  if (reason.length < 5) return { ok: false, error: "Give a reason for the correction (recorded in the audit trail)." };
  if (run.status === "approved" || run.status === "rejected") return { ok: false, error: "Closed cases cannot be corrected." };

  const before = run.invoice;
  const next: Invoice = { ...before, lineItems: before.lineItems.map((l) => ({ ...l })) };
  const changes: FieldChange[] = [];

  for (const f of EDITABLE_TOP) {
    if (!(f in req.invoice)) continue;
    const raw = (req.invoice as Record<string, unknown>)[f];
    let val: string | number | null;
    if (NUMERIC.has(f)) {
      val = toNum(raw);
      if (val === null && f !== "subtotal" && f !== "total") val = 0;
      if (raw !== null && raw !== "" && val === null) return { ok: false, error: `${f} must be a number.` };
    } else {
      val = raw === null || raw === undefined || String(raw).trim() === "" ? null : String(raw).trim();
      if (f === "issueDate" && val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return { ok: false, error: "Invoice date must be yyyy-mm-dd." };
    }
    if (fmt(val) !== fmt((before as unknown as Record<string, unknown>)[f])) {
      changes.push({ field: f, from: fmt((before as unknown as Record<string, unknown>)[f]), to: fmt(val) });
      (next as unknown as Record<string, unknown>)[f] = val;
    }
  }
  (req.invoice.lineItems ?? []).forEach((li, i) => {
    if (!next.lineItems[i]) return;
    for (const f of EDITABLE_LINE) {
      if (!(f in li)) continue;
      const val = toNum(li[f]);
      if (val === null) continue;
      if (val !== next.lineItems[i][f]) {
        changes.push({ field: `lineItems[${i}].${f}`, from: fmt(next.lineItems[i][f]), to: fmt(val) });
        next.lineItems[i][f] = val;
      }
    }
  });
  if (!changes.length) return { ok: false, error: "No field values changed." };

  // A value a human typed is no longer "uncertain model read" — but the
  // document is still handwritten/scanned, so those policies still apply.
  const touched = new Set(changes.map((c) => c.field.split(/[.[]/)[0]));
  next.lowConfidenceFields = before.lowConfidenceFields.filter((f) => !touched.has(f.split(/[.[]/)[0]));

  // ---- Re-run every deterministic check ----
  const { findings, decision, v, pm, dup } = evaluate(next, { ...DEFAULT_RULES, ...(run.rules ?? {}) }, run, others, now);

  // A clean result after a manual correction still needs an explicit approval.
  const status: CaseStatus = decision.resolution === "AUTO_APPROVE" ? "needs_review" : initialStatus(decision.resolution);
  // Data changed, so earlier PO / figure confirmations no longer hold. A
  // recorded bank verification is about the account, which cannot be edited.
  const keep: ExceptionCode[] = (run.resolvedCodes ?? []).filter((c) => c === "BANK_ACCOUNT_MISMATCH");

  const correction: Correction = { at: now, reviewer, reason, changes, decisionBefore: run.decision.resolution, decisionAfter: decision.resolution };
  const event: AuditEvent = {
    at: now,
    actor: reviewer,
    kind: "reviewer",
    action: `Corrected ${changes.length} field${changes.length > 1 ? "s" : ""} and re-ran all checks: ${changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join("; ")}`,
    fromStatus: run.status,
    toStatus: status,
    note: reason,
    resolved: (run.findings.filter((f) => f.action !== "info").map((f) => f.code) as ExceptionCode[]).filter((c) => !findings.some((f) => f.code === c && f.action !== "info")),
    remaining: [...new Set(findings.filter((f) => f.action !== "info" && !keep.includes(f.code)).map((f) => f.code))],
  };
  const explanation = templateExplanation(next, pm.poMatch, findings, decision);
  explanation.summary = `Re-validated after reviewer correction. ${explanation.summary}`;

  return {
    ok: true,
    changes,
    run: {
      ...run,
      invoice: next,
      originalInvoice: run.originalInvoice ?? before,
      vendorId: v.vendor?.id ?? null,
      vendorMatched: v.vendor?.name ?? null,
      poMatch: pm.poMatch,
      findings,
      decision,
      explanation,
      status,
      resolvedCodes: keep,
      duplicateOf: dup.duplicateOf,
      corrections: [...(run.corrections ?? []), correction],
      audit: [...run.audit, event],
    },
  };
}

export function describeChange(c: FieldChange): string {
  const n = Number(c.to);
  return Number.isFinite(n) && c.to !== "—" && !/date|Number|Reference/i.test(c.field) ? `${c.field}: ${c.from} → ${money(n)}` : `${c.field}: ${c.from} → ${c.to}`;
}
