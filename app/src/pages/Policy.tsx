import { useEffect, useMemo, useState } from "react";
import { REASON_LABEL } from "../copy";
import { isOpen, resolutionLabel } from "../lib/engine";
import { evaluate } from "../lib/revalidate";
import { DEFAULT_RULES, loadRules, saveRules, type Rules } from "../lib/rules";
import { Shell } from "../Shell";
import type { ExceptionCode } from "../types";
import { StatusBadge, resolutionToStatus, useRuns, useToast } from "../ui";

type Field = { k: keyof Rules; name: string; desc: string; scale?: number; step?: number; unit: string };

const GROUPS: { title: string; sub: string; fields: Field[]; fixed?: string[] }[] = [
  {
    title: "Matching",
    sub: "How closely an invoice must match its purchase order.",
    fields: [
      { k: "amountTolerancePct", name: "PO amount tolerance", desc: "Cumulative billing may exceed the PO value by at most this much.", scale: 100, step: 0.5, unit: "%" },
      { k: "priceTolerancePct", name: "Unit price tolerance", desc: "Invoice unit price vs PO unit price.", scale: 100, step: 0.5, unit: "%" },
      { k: "quantityTolerance", name: "Quantity tolerance", desc: "Units billed beyond the PO quantity, across all invoices.", unit: "units" },
      { k: "arithmeticToleranceAbs", name: "Arithmetic rounding", desc: "Allowed rounding when totals are re-added. PO tolerance never excuses arithmetic.", step: 0.5, unit: "$" },
    ],
  },
  {
    title: "Fraud & security",
    sub: "Controls that stop payment. The fixed ones cannot be relaxed from the UI.",
    fields: [{ k: "duplicateWindowDays", name: "Possible-duplicate window", desc: "Same vendor and same amount within this window is flagged.", unit: "days" }],
    fixed: ["Bank account differs from vendor master → payment hold, needs recorded call-back verification", "Vendor not in vendor master → payment hold until onboarded", "Same vendor + same invoice number → rejected, no second payable"],
  },
  {
    title: "Human review",
    sub: "When a person must look, even if every check passes.",
    fields: [{ k: "autoApproveLimit", name: "Auto-approval limit", desc: "Invoices above this always get a reviewer.", step: 1000, unit: "$" }],
  },
];

const PRECEDENCE: { status: "rejected" | "payment_hold" | "needs_review" | "approved"; when: string; codes: ExceptionCode[] }[] = [
  { status: "rejected", when: "Confirmed duplicate or blocked vendor", codes: ["DUPLICATE_INVOICE", "VENDOR_BLOCKED"] },
  { status: "payment_hold", when: "Security or vendor-identity risk", codes: ["BANK_ACCOUNT_MISMATCH", "UNKNOWN_VENDOR", "PO_VENDOR_MISMATCH"] },
  { status: "needs_review", when: "Human judgement or correction needed", codes: ["ARITHMETIC_MISMATCH", "MISSING_FIELD", "PO_MATCH_UNCONFIRMED", "CUMULATIVE_PO_EXCEEDED", "PENDING_PO_CONFLICT", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "PRICE_VARIANCE", "LOW_EXTRACTION_CONFIDENCE", "HANDWRITTEN_DOCUMENT", "EXPIRED_PO", "POSSIBLE_DUPLICATE", "OVER_APPROVAL_LIMIT"] },
  { status: "approved", when: "Every mandatory check passes", codes: ["WITHIN_TOLERANCE", "PARTIAL_BILLING", "VENDOR_NAME_VARIANT", "SCANNED_DOCUMENT"] },
];

export default function Policy() {
  const { runs } = useRuns();
  const [rules, setRules] = useState<Rules>(() => loadRules());
  const [saved, setSaved] = useState<Rules>(() => loadRules());
  const [toast, notify] = useToast();
  useEffect(() => saveRules(saved), [saved]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);

  // Impact preview: re-run the deterministic checks on every stored invoice
  // with the run's own thresholds and with the draft thresholds, and compare.
  const impact = useMemo(() => {
    if (!dirty) return [];
    return runs
      .filter((r) => !r.repeatSubmission)
      .map((r) => {
        const base = { ...DEFAULT_RULES, ...(r.rules ?? {}) };
        const before = evaluate(r.invoice, base, r, runs).decision.resolution;
        const after = evaluate(r.invoice, rules, r, runs).decision.resolution;
        return { r, before, after };
      })
      .filter((x) => x.before !== x.after);
  }, [rules, runs, dirty]);

  const field = (f: Field) => (
    <label key={f.k} className="setting">
      <div>
        <div className="setting-name">{f.name}</div>
        <div className="setting-desc">
          {f.desc} <span className="muted">Default {Number(DEFAULT_RULES[f.k]) * (f.scale ?? 1)} {f.unit}.</span>
        </div>
      </div>
      <div className="setting-ctl">
        <input className="input input-num" type="number" step={f.step ?? 1} value={Number(rules[f.k]) * (f.scale ?? 1)} onChange={(e) => setRules({ ...rules, [f.k]: Number(e.target.value) / (f.scale ?? 1) })} />
        <span className="unit">{f.unit}</span>
      </div>
    </label>
  );

  return (
    <Shell page="policy" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <header className="page-head">
        <div>
          <div className="eyebrow">Policy rules</div>
          <h1 className="display-sm">The rules that govern automation</h1>
          <p className="muted">The AI reads and explains. These deterministic controls decide. Thresholds apply to new runs from this browser.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setRules(DEFAULT_RULES)}>
            Restore defaults
          </button>
          <button className="btn btn-primary" disabled={!dirty} onClick={() => (setSaved(rules), notify("Policy saved; applies to new runs"))}>
            Save policy
          </button>
        </div>
      </header>

      <div className="policy">
        <div className="surface">
          {GROUPS.map((g) => (
            <section key={g.title} className="pgroup">
              <h2>{g.title}</h2>
              <p className="muted small">{g.sub}</p>
              {g.fields.map(field)}
              {g.title === "Human review" && (
                <label className="setting">
                  <div>
                    <div className="setting-name">Always review handwritten invoices</div>
                    <div className="setting-desc">A single misread digit changes the amount paid. Default on.</div>
                  </div>
                  <div className="setting-ctl">
                    <input type="checkbox" className="switch" checked={rules.reviewHandwritten} onChange={(e) => setRules({ ...rules, reviewHandwritten: e.target.checked })} />
                  </div>
                </label>
              )}
              {g.fixed?.map((t) => (
                <div key={t} className="setting setting-fixed">
                  <div className="setting-name">{t}</div>
                  <span className="tag tag-ok">Always on</span>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="policy-side">
          <section className="surface pad">
            <h2>Impact preview</h2>
            {!dirty ? (
              <p className="muted small">Change a threshold to see which stored invoices would get a different decision. Computed by re-running the rules on {runs.filter((r) => !r.repeatSubmission).length} stored invoices.</p>
            ) : impact.length === 0 ? (
              <p className="small">No stored invoice would change decision. Security controls are unaffected by thresholds.</p>
            ) : (
              <ul className="impact">
                {impact.map(({ r, before, after }) => (
                  <li key={r.id}>
                    <span className="strong">{r.vendorMatched ?? r.invoice.vendor}</span> <span className="mono muted">{r.invoice.invoiceNumber}</span>
                    <div className="impact-row">
                      <StatusBadge status={resolutionToStatus(before)} /> → <StatusBadge status={resolutionToStatus(after)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {dirty && <p className="muted small">Preview only. Saved policy applies to new runs; existing decisions are not rewritten.</p>}
          </section>
          <section className="surface pad">
            <h2>Decision precedence</h2>
            <p className="muted small">Every finding is kept; the strictest one decides.</p>
            <ol className="prec">
              {PRECEDENCE.map((p) => (
                <li key={p.status}>
                  <StatusBadge status={p.status} />
                  <div>
                    <div className="strong">{p.when}</div>
                    <div className="muted small">{p.codes.map((c) => REASON_LABEL[c]).join(" · ")}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="muted small">
              Reviewer gates: bank holds need a recorded call-back; suggested POs need confirmation; handwritten figures need confirmation; invoices that don't reconcile can't be approved; unknown vendors can't be approved here. Labels: {resolutionLabel("AUTO_APPROVE")} means eligible for payment, not paid.
            </p>
          </section>
        </div>
      </div>
      {toast}
    </Shell>
  );
}
