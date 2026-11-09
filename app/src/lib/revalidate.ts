// Reviewer corrections → full deterministic re-validation. Runs on the server
// so a correction can never skip a check: the corrected invoice goes through
// exactly the same validate / vendor / PO / duplicate / decide rules as a new
// upload, against the same reference data and the run's own policy snapshot.

import { PURCHASE_ORDERS } from "../data/purchaseOrders.ts";
import { ERP_LEDGER, VENDORS } from "../data/vendors.ts";
import type { AuditEvent, CaseStatus, Correction, ExceptionCode, FieldChange, Invoice, LineItem, RunRecord } from "../types.ts";
import { assignedPoFinding, buildLedger, checkDuplicates, checkVendor, decide, initialStatus, matchPurchaseOrder, money, templateExplanation, validateInvoice } from "./engine.ts";
import { justificationError } from "./review.ts";
import { DEFAULT_RULES, type Rules } from "./policy.ts";

// Fields a reviewer may correct. Vendor name and bank account are deliberately
// excluded: editing them would let a reviewer launder a fraud signal.
export const EDITABLE_TOP = ["invoiceNumber", "issueDate", "poReference", "subtotal", "tax", "shipping", "otherCharges", "discount", "total"] as const;
export const EDITABLE_LINE = ["quantity", "unitPrice", "total"] as const;
const NUMERIC = new Set(["subtotal", "tax", "shipping", "otherCharges", "discount", "total"]);

export interface CorrectionRequest {
  reviewer: string;
  reason: string;
  source: string; // where the corrected value comes from (page/line on the document, vendor email, PO)
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
export function evaluate(inv: Invoice, rules: Rules, run: Pick<RunRecord, "id" | "fileHash">, others: RunRecord[], now = Date.now(), opts: { assignedPo?: boolean; includeSameFile?: boolean } = {}) {
  const rest = others.filter((r) => r.id !== run.id);
  const ledger = buildLedger(ERP_LEDGER, rest);
  const prior = rest.filter((r) => opts.includeSameFile || r.fileHash !== run.fileHash).map((r) => ({ runId: r.id, fileHash: r.fileHash, createdAt: r.createdAt, status: r.status, invoiceNumber: r.invoice.invoiceNumber }));
  const findings = [...validateInvoice(inv, rules)];
  const v = checkVendor(inv, VENDORS);
  findings.push(...v.findings);
  const pm = matchPurchaseOrder(inv, v.vendor, PURCHASE_ORDERS, ledger, rules, new Date(now).toISOString().slice(0, 10));
  findings.push(...pm.findings);
  if (opts.assignedPo && pm.poMatch.po && pm.poMatch.method === "explicit" && !findings.some((f) => f.code === "PO_MATCH_UNCONFIRMED")) findings.push(assignedPoFinding(pm.poMatch.po));
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
  const rErr = justificationError(reason, "reason for the correction");
  if (rErr) return { ok: false, error: rErr };
  if ((req.source ?? "").trim().length < 5) return { ok: false, error: "Cite the source of the corrected value (where it appears on the document, or the vendor's written confirmation)." };
  if (!run.invoice.invoiceNumber && "invoiceNumber" in req.invoice && String(req.invoice.invoiceNumber ?? "").trim()) return { ok: false, error: "The invoice number is missing from the document. Request a revised invoice from the vendor instead of entering one manually." };
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
  // A PO the reviewer put on the invoice (different from what was extracted) stays unconfirmed.
  const poKey = (x: string | null | undefined) => (x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const assignedPo = changes.some((c) => c.field === "poReference") && poKey(next.poReference) !== "" && poKey(next.poReference) !== poKey((run.originalInvoice ?? before).poReference);
  const { findings, decision, v, pm, dup } = evaluate(next, { ...DEFAULT_RULES, ...(run.rules ?? {}) }, run, others, now, { assignedPo });

  // A clean result after a manual correction still needs an explicit approval.
  const status: CaseStatus = decision.resolution === "AUTO_APPROVE" ? "needs_review" : initialStatus(decision.resolution);
  // Data changed, so earlier PO / figure confirmations no longer hold. A
  // recorded bank verification is about the account, which cannot be edited.
  const keep: ExceptionCode[] = (run.resolvedCodes ?? []).filter((c) => c === "BANK_ACCOUNT_MISMATCH");

  const correction: Correction = { at: now, reviewer, reason: `${reason} (source: ${(req.source ?? "").trim()})`, changes, decisionBefore: run.decision.resolution, decisionAfter: decision.resolution };
  const event: AuditEvent = {
    at: now,
    actor: reviewer,
    kind: "reviewer",
    action: `Corrected ${changes.length} field${changes.length > 1 ? "s" : ""} and re-ran all checks: ${changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join("; ")}`,
    fromStatus: run.status,
    toStatus: status,
    note: `${reason} (source: ${(req.source ?? "").trim()})`,
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

// Stale-state guard for approval. Findings are computed when an invoice is
// processed; by the time a reviewer approves, other invoices may have used up
// the PO or the PO may have expired. Re-run the deterministic checks against
// the current ledger. If a blocking finding appears that the case did not have,
// add it (the original findings, decision and audit stay untouched) so it has
// to be resolved like any other. Competing PENDING invoices are deliberately
// ignored here: whichever is approved first is legitimate, and the later one is
// flagged when it is checked.
const STALE_CODES: ExceptionCode[] = ["CUMULATIVE_PO_EXCEEDED", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "EXPIRED_PO", "CLOSED_PO", "VENDOR_BLOCKED", "PO_VENDOR_MISMATCH"];

export function refreshStale(run: RunRecord, others: RunRecord[], now = Date.now()): RunRecord | null {
  const fresh = evaluate(run.invoice, { ...DEFAULT_RULES, ...(run.rules ?? {}) }, run, others, now);
  const known = new Set(run.findings.map((f) => f.code));
  const added = fresh.findings.filter((f) => f.action !== "info" && STALE_CODES.includes(f.code) && !known.has(f.code));
  if (!added.length) return null;
  const findings = [...run.findings, ...added];
  const resolved = new Set(run.resolvedCodes ?? []);
  const remaining = [...new Set(findings.filter((f) => f.action !== "info" && !resolved.has(f.code)).map((f) => f.code))];
  const event: AuditEvent = {
    at: now,
    actor: "System",
    kind: "system",
    action: `Checks re-run before approval: ${[...new Set(added.map((f) => f.code))].join(", ")} now applies (the PO position changed since this invoice was processed)`,
    fromStatus: run.status,
    toStatus: run.status,
    remaining,
  };
  return { ...run, findings, poMatch: fresh.pm.poMatch, audit: [...run.audit, event] };
}
