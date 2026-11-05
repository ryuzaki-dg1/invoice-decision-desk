import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Lock, RotateCcw, Save } from "lucide-react";
import { REASON_LABEL } from "../copy";
import { openCases } from "../lib/analytics";
import { evaluate } from "../lib/revalidate";
import { DEFAULT_RULES, loadRules, saveRules, type Rules } from "../lib/rules";
import { Shell } from "../Shell";
import type { ExceptionCode } from "../types";
import { StatusBadge, resolutionToStatus, useRuns, useToast } from "../ui";

type NumField = { k: keyof Rules; name: string; desc: string; scale?: number; step?: number; unit: string; fmt: (v: number) => string };
const pct = (v: number) => `${(v * 100).toFixed(2).replace(/\.00$/, "")}%`;
const usd = (v: number) => `$${v.toLocaleString("en-US")}`;

const MATCHING: NumField[] = [
  { k: "amountTolerancePct", name: "PO amount tolerance", desc: "How far cumulative billing may exceed the PO value.", scale: 100, step: 0.5, unit: "%", fmt: pct },
  { k: "priceTolerancePct", name: "Unit price tolerance", desc: "How far the invoice unit price may exceed the PO price.", scale: 100, step: 0.5, unit: "%", fmt: pct },
  { k: "quantityTolerance", name: "Quantity tolerance", desc: "Extra units allowed beyond the PO quantity, across all invoices.", unit: "units", fmt: (v) => `${v} units` },
  { k: "arithmeticToleranceAbs", name: "Arithmetic rounding", desc: "Rounding allowed when the invoice totals are re-added.", step: 0.5, unit: "$", fmt: (v) => `$${v.toFixed(2)}` },
];
const RISK: NumField[] = [{ k: "duplicateWindowDays", name: "Duplicate detection window", desc: "Same vendor and same amount within this window is flagged.", unit: "days", fmt: (v) => `${v} days` }];
const REVIEW: NumField[] = [{ k: "autoApproveLimit", name: "Auto-approval threshold", desc: "Invoices above this amount always get a reviewer.", step: 1000, unit: "$", fmt: usd }];

const PRECEDENCE: { status: "rejected" | "payment_hold" | "needs_review" | "approved"; when: string; codes: ExceptionCode[] }[] = [
  { status: "rejected", when: "Confirmed duplicate or blocked vendor", codes: ["DUPLICATE_INVOICE", "VENDOR_BLOCKED"] },
  { status: "payment_hold", when: "Security or vendor-identity risk", codes: ["BANK_ACCOUNT_MISMATCH", "UNKNOWN_VENDOR", "PO_VENDOR_MISMATCH"] },
  { status: "needs_review", when: "Needs judgement or correction", codes: ["ARITHMETIC_MISMATCH", "MISSING_FIELD", "PO_MATCH_UNCONFIRMED", "CUMULATIVE_PO_EXCEEDED", "PENDING_PO_CONFLICT", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "PRICE_VARIANCE", "LOW_EXTRACTION_CONFIDENCE", "HANDWRITTEN_DOCUMENT", "EXPIRED_PO", "POSSIBLE_DUPLICATE", "OVER_APPROVAL_LIMIT"] },
  { status: "approved", when: "Every mandatory check passes", codes: ["WITHIN_TOLERANCE", "PARTIAL_BILLING", "VENDOR_NAME_VARIANT", "SCANNED_DOCUMENT"] },
];

export default function Policy() {
  const { runs } = useRuns();
  const [saved, setSaved] = useState<Rules>(() => loadRules());
  const [rules, setRules] = useState<Rules>(saved);
  const [toast, notify] = useToast();
  useEffect(() => saveRules(saved), [saved]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);

  // Impact preview: re-run the deterministic checks on stored invoices with
  // each run's own thresholds vs the draft, and list decisions that change.
  const impact = useMemo(() => {
    if (!dirty) return [];
    return runs
      .filter((r) => !r.repeatSubmission)
      .map((r) => ({ r, before: evaluate(r.invoice, { ...DEFAULT_RULES, ...(r.rules ?? {}) }, r, runs).decision.resolution, after: evaluate(r.invoice, rules, r, runs).decision.resolution }))
      .filter((x) => x.before !== x.after);
  }, [rules, runs, dirty]);

  const num = (f: NumField) => {
    const changed = rules[f.k] !== saved[f.k];
    return (
      <div key={f.k} className="set">
        <div className="set-text">
          <div className="set-name">
            {f.name} {changed && <span className="pill pill-warn">Unsaved</span>}
          </div>
          <div className="set-desc">{f.desc}</div>
        </div>
        <div className="set-ctl">
          <input
            className="input input-num"
            type="number"
            aria-label={f.name}
            step={f.step ?? 1}
            value={Number(rules[f.k]) * (f.scale ?? 1)}
            onChange={(e) => setRules({ ...rules, [f.k]: Number(e.target.value) / (f.scale ?? 1) })}
          />
          <span className="unit">{f.unit}</span>
        </div>
        <div className="set-cur">
          Default {f.fmt(Number(DEFAULT_RULES[f.k]))}
        </div>
      </div>
    );
  };
  const locked = (name: string, desc: string) => (
    <div className="set">
      <div className="set-text">
        <div className="set-name">{name}</div>
        <div className="set-desc">{desc}</div>
      </div>
      <div className="set-ctl">
        <span className="toggle on locked" aria-label={`${name}: always on`}>
          <span />
        </span>
      </div>
      <div className="set-cur">
        <Lock size={12} /> Always on
      </div>
    </div>
  );

  return (
    <Shell page="policy" openCount={openCases(runs).length}>
      <header className="page-head">
        <div>
          <h1 className="h1">Policy rules</h1>
          <p className="sub">The deterministic controls that decide every invoice. The AI reads and explains; these rules decide.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setRules(DEFAULT_RULES)} disabled={JSON.stringify(rules) === JSON.stringify(DEFAULT_RULES)}>
            <RotateCcw size={15} /> Reset to defaults
          </button>
          <button className="btn btn-primary" disabled={!dirty} onClick={() => (setSaved(rules), notify("Policy saved · applies to new invoices"))}>
            <Save size={15} /> Save changes
          </button>
        </div>
      </header>

      <div className="policy">
        <div className="card">
          <section className="pgroup">
            <h2 className="h2">Matching rules</h2>
            <p className="muted small">How closely an invoice must match its purchase order.</p>
            {MATCHING.map(num)}
          </section>
          <section className="pgroup">
            <h2 className="h2">Risk & security</h2>
            <p className="muted small">Controls that stop payment. Security controls can't be switched off.</p>
            {RISK.map(num)}
            {locked("Bank account verification", "A remit-to account that differs from the vendor record puts the invoice on payment hold until a call-back is recorded.")}
            {locked("Unknown vendor control", "Payees not in the vendor master are held until procurement onboards them.")}
          </section>
          <section className="pgroup">
            <h2 className="h2">Human review</h2>
            <p className="muted small">When a person must look, even if every check passes.</p>
            {REVIEW.map(num)}
            <div className="set">
              <div className="set-text">
                <div className="set-name">
                  Handwritten document review {rules.reviewHandwritten !== saved.reviewHandwritten && <span className="pill pill-warn">Unsaved</span>}
                </div>
                <div className="set-desc">Always send handwritten invoices to a reviewer. A single misread digit changes the amount paid.</div>
              </div>
              <div className="set-ctl">
                <button className={`toggle ${rules.reviewHandwritten ? "on" : ""}`} role="switch" aria-checked={rules.reviewHandwritten} aria-label="Handwritten document review" onClick={() => setRules({ ...rules, reviewHandwritten: !rules.reviewHandwritten })}>
                  <span />
                </button>
              </div>
              <div className="set-cur">{rules.reviewHandwritten ? "On" : "Off"} · default on</div>
            </div>
          </section>
        </div>

        <aside className="policy-side">
          <section className="card pad">
            <h2 className="h3">Impact preview</h2>
            {!dirty ? (
              <p className="muted small">Change a setting to see which of the {runs.filter((r) => !r.repeatSubmission).length} stored invoices would get a different decision. Computed by re-running the rules.</p>
            ) : impact.length === 0 ? (
              <p className="small">No stored invoice would change decision. Security controls aren't affected by thresholds.</p>
            ) : (
              <ul className="impact">
                {impact.map(({ r, before, after }) => (
                  <li key={r.id}>
                    <div className="strong">{r.vendorMatched ?? r.invoice.vendor}</div>
                    <div className="impact-row">
                      <StatusBadge status={resolutionToStatus(before)} /> → <StatusBadge status={resolutionToStatus(after)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {dirty && <p className="muted small">Saved changes apply to new invoices; existing decisions are not rewritten.</p>}
          </section>
          <details className="card pad prec-box">
            <summary>
              <h2 className="h3">Decision precedence</h2>
              <ChevronDown size={16} />
            </summary>
            <p className="muted small">All findings are kept; the strictest one decides.</p>
            <ol className="prec">
              {PRECEDENCE.map((p) => (
                <li key={p.status}>
                  <StatusBadge status={p.status} />
                  <div>
                    <div className="strong small">{p.when}</div>
                    <div className="muted small">{p.codes.map((c) => REASON_LABEL[c]).join(" · ")}</div>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        </aside>
      </div>
      {toast}
    </Shell>
  );
}
