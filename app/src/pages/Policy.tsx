import { useEffect, useState } from "react";
import { REASON_LABEL } from "../copy";
import { isOpen } from "../lib/engine";
import { DEFAULT_RULES, loadRules, saveRules, type Rules } from "../lib/rules";
import { PageHead, Shell } from "../Shell";
import type { ExceptionCode } from "../types";
import { StatusBadge, useRuns, useToast } from "../ui";

const FIELDS: { k: keyof Rules; name: string; desc: string; scale?: number; step?: number }[] = [
  { k: "amountTolerancePct", name: "PO amount tolerance (%)", desc: "Cumulative billing may exceed the PO value by at most this much.", scale: 100, step: 0.5 },
  { k: "priceTolerancePct", name: "Unit price tolerance (%)", desc: "Invoice unit price vs PO unit price.", scale: 100, step: 0.5 },
  { k: "quantityTolerance", name: "Quantity tolerance (units)", desc: "Units billed beyond the PO quantity, across all invoices." },
  { k: "arithmeticToleranceAbs", name: "Arithmetic rounding ($)", desc: "Allowed rounding when totals are re-added. PO tolerance never applies here.", step: 0.5 },
  { k: "duplicateWindowDays", name: "Possible-duplicate window (days)", desc: "Same vendor and same amount within this window is flagged for review." },
  { k: "autoApproveLimit", name: "Auto-approval limit ($)", desc: "Invoices above this always get a human review.", step: 1000 },
];

const PRECEDENCE: { status: "rejected" | "payment_hold" | "needs_review" | "approved"; when: string; codes: ExceptionCode[] }[] = [
  { status: "rejected", when: "Confirmed duplicate or blocked vendor", codes: ["DUPLICATE_INVOICE", "VENDOR_BLOCKED"] },
  { status: "payment_hold", when: "Security or vendor-identity risk", codes: ["BANK_ACCOUNT_MISMATCH", "UNKNOWN_VENDOR", "PO_VENDOR_MISMATCH"] },
  {
    status: "needs_review",
    when: "Needs human judgement or clarification",
    codes: ["ARITHMETIC_MISMATCH", "MISSING_FIELD", "PO_MATCH_UNCONFIRMED", "CUMULATIVE_PO_EXCEEDED", "PO_AMOUNT_EXCEEDED", "QUANTITY_EXCEEDS_PO", "PRICE_VARIANCE", "LOW_EXTRACTION_CONFIDENCE", "HANDWRITTEN_DOCUMENT", "EXPIRED_PO", "POSSIBLE_DUPLICATE", "OVER_APPROVAL_LIMIT"],
  },
  { status: "approved", when: "Every mandatory check passes (informational findings are recorded)", codes: ["WITHIN_TOLERANCE", "PARTIAL_BILLING", "VENDOR_NAME_VARIANT", "SCANNED_DOCUMENT"] },
];

export default function Policy() {
  const { runs } = useRuns();
  const [rules, setRules] = useState<Rules>(() => loadRules());
  const [toast, notify] = useToast();
  useEffect(() => saveRules(rules), [rules]);
  return (
    <Shell page="policy" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <PageHead
        title="Policy rules"
        sub="Deterministic controls. The AI reads and explains; these rules decide."
        action={
          <button
            className="btn"
            onClick={() => {
              setRules(DEFAULT_RULES);
              notify("Defaults restored");
            }}
          >
            Restore defaults
          </button>
        }
      />
      <div className="policy">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Thresholds</div>
              <div className="card-sub">Apply to new runs started from this browser. Saved automatically.</div>
            </div>
          </div>
          <div style={{ padding: "4px 24px 12px" }}>
            {FIELDS.map((f) => (
              <label key={f.k} className="rule">
                <div>
                  <div className="rule-name">{f.name}</div>
                  <div className="rule-desc">{f.desc}</div>
                </div>
                <input className="input" type="number" step={f.step ?? 1} value={Number(rules[f.k]) * (f.scale ?? 1)} onChange={(e) => setRules({ ...rules, [f.k]: Number(e.target.value) / (f.scale ?? 1) })} />
              </label>
            ))}
            <label className="rule">
              <div>
                <div className="rule-name">Always review handwritten invoices</div>
                <div className="rule-desc">A single misread digit changes the amount paid.</div>
              </div>
              <input type="checkbox" checked={rules.reviewHandwritten} onChange={(e) => setRules({ ...rules, reviewHandwritten: e.target.checked })} style={{ justifySelf: "end", width: 18, height: 18 }} />
            </label>
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Decision precedence</div>
              <div className="card-sub">All findings are kept; the strictest one decides.</div>
            </div>
          </div>
          <div className="card-pad prec">
            {PRECEDENCE.map((p) => (
              <div key={p.status} className="prec-row">
                <div>
                  <StatusBadge status={p.status} />
                </div>
                <div>
                  <div className="cell-strong">{p.when}</div>
                  <div className="small muted">{p.codes.map((c) => REASON_LABEL[c]).join(" · ")}</div>
                </div>
              </div>
            ))}
            <div className="small muted" style={{ marginTop: 8 }}>
              Reviewer controls: a bank-account hold needs recorded independent verification; a suggested PO needs explicit confirmation; an unknown vendor cannot be approved until it is onboarded; rejected and approved cases are final.
            </div>
          </div>
        </section>
      </div>
      {toast}
    </Shell>
  );
}
