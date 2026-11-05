// Shared UI pieces for the live run view and the dashboard.

import { useState } from "react";
import { money, resolutionLabel } from "./lib/engine";
import { STAGES } from "./lib/pipeline";
import type { CheckAction, Decision, Explanation, Finding, Invoice, PoMatch, Resolution, ReviewStatus, StageState } from "./types";

export const RESOLUTION_META: Record<Resolution, { color: string; icon: string; ink: string }> = {
  AUTO_APPROVE: { color: "#0ca30c", icon: "✓", ink: "#ffffff" },
  FLAG_FOR_REVIEW: { color: "#fab219", icon: "!", ink: "#0b0b0b" },
  ESCALATE: { color: "#ec835a", icon: "⏸", ink: "#ffffff" },
  REJECT: { color: "#d03b3b", icon: "✕", ink: "#ffffff" },
};

export function DecisionBadge({ resolution, large }: { resolution: Resolution; large?: boolean }) {
  const m = RESOLUTION_META[resolution];
  return (
    <span className={`badge ${large ? "badge-lg" : ""}`} style={{ background: m.color, color: m.ink }}>
      <span aria-hidden>{m.icon}</span> {resolutionLabel(resolution)}
    </span>
  );
}

export function reviewLabel(s: ReviewStatus): string {
  return { auto_approved: "Auto-approved", pending: "Awaiting reviewer", approved: "Approved by reviewer", rejected: "Rejected" }[s];
}

const ACTION_META: Record<CheckAction, { label: string; cls: string; icon: string }> = {
  reject: { label: "Reject", cls: "f-reject", icon: "✕" },
  escalate: { label: "Hold", cls: "f-escalate", icon: "⏸" },
  review: { label: "Review", cls: "f-review", icon: "!" },
  info: { label: "Info", cls: "f-info", icon: "i" },
};

const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

export function FindingsList({ findings }: { findings: Finding[] }) {
  const order: CheckAction[] = ["reject", "escalate", "review", "info"];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  if (!sorted.length) return <div className="muted">No findings. Every check passed.</div>;
  return (
    <div className="findings">
      {sorted.map((f, i) => {
        const m = ACTION_META[f.action];
        return (
          <div key={i} className={`finding ${m.cls}`}>
            <div className="finding-head">
              <span className="finding-tag">
                <span aria-hidden>{m.icon}</span> {m.label}
              </span>
              <span className="finding-title">{f.title}</span>
              <span className="finding-stage">{STAGE_LABEL[f.stage]} · {f.code}</span>
            </div>
            <div className="finding-detail">{f.detail}</div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_ICON: Record<StageState["status"], string> = {
  pending: "",
  running: "",
  done: "✓",
  warn: "!",
  fail: "✕",
  skipped: "–",
};

export function StageList({ stages, live }: { stages: StageState[]; live?: boolean }) {
  const byId = new Map(stages.map((s) => [s.id, s]));
  return (
    <ol className="stages">
      {STAGES.map((def, i) => {
        const s = byId.get(def.id) ?? { id: def.id, status: "pending" as const, lines: [] };
        const ms = s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null;
        return (
          <li key={def.id} className={`stage stage-${s.status}`}>
            <div className="stage-rail">
              <span className="stage-dot">{s.status === "running" ? <span className="spinner" /> : STATUS_ICON[s.status] || i + 1}</span>
            </div>
            <div className="stage-body">
              <div className="stage-head">
                <span className="stage-label">{def.label}</span>
                {ms !== null && <span className="stage-time">{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}</span>}
                {s.status === "running" && live && <span className="stage-time">running…</span>}
              </div>
              <div className="stage-what">{s.summary ?? def.what}</div>
              {s.lines.length > 0 && (
                <ul className="stage-lines">
                  {s.lines.map((l, j) => (
                    <li key={j}>{l}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function DecisionPanel({ decision, findings }: { decision: Decision; findings: Finding[] }) {
  return (
    <div className="decision" style={{ borderTopColor: RESOLUTION_META[decision.resolution].color }}>
      <div className="decision-top">
        <DecisionBadge resolution={decision.resolution} large />
        <div className="decision-headline">{decision.headline}</div>
      </div>
      <div className="decision-next">
        <div className="label">Next action</div>
        <div>{decision.nextAction}</div>
      </div>
      <div className="label">Findings ({findings.length})</div>
      <FindingsList findings={findings} />
    </div>
  );
}

export function ExplanationPanel({ explanation, streaming }: { explanation?: Explanation; streaming?: string }) {
  const [copied, setCopied] = useState(false);
  if (!explanation && !streaming) return null;
  if (!explanation) return <pre className="stream">{streaming}<span className="caret">▋</span></pre>;
  return (
    <div className="explain">
      <div className="label">Summary for the AP team {explanation.generatedBy === "template" && <span className="muted">(template)</span>}</div>
      <p className="summary">{explanation.summary}</p>
      {explanation.vendorEmail && (
        <>
          <div className="label row-between">
            <span>Draft email to vendor · not sent, needs a human</span>
            <button
              className="btn-ghost"
              onClick={() => {
                navigator.clipboard.writeText(explanation.vendorEmail!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="email">{explanation.vendorEmail}</pre>
        </>
      )}
    </div>
  );
}

export function InvoiceView({ invoice, poMatch }: { invoice: Invoice; poMatch?: PoMatch }) {
  const low = new Set(invoice.lowConfidenceFields.map((f) => f.split(/[.[]/)[0]));
  const F = ({ k, label, value }: { k: string; label: string; value: string }) => (
    <div className={`kv ${low.has(k) ? "kv-low" : ""}`} title={low.has(k) ? "Read with low confidence" : undefined}>
      <div className="kv-k">{label}{low.has(k) && " ⚠"}</div>
      <div className="kv-v">{value}</div>
    </div>
  );
  const po = poMatch?.po;
  return (
    <div>
      <div className="kv-grid">
        <F k="vendor" label="Vendor" value={invoice.vendor || "—"} />
        <F k="invoiceNumber" label="Invoice #" value={invoice.invoiceNumber ?? "missing"} />
        <F k="poReference" label="PO on invoice" value={invoice.poReference ?? "none"} />
        <F k="issueDate" label="Date" value={invoice.issueDate ?? "missing"} />
        <F k="dueDate" label="Due" value={invoice.dueDate ?? "—"} />
        <F k="bankAccount" label="Remit-to account" value={invoice.bankAccount ? `…${invoice.bankAccount.replace(/\D/g, "").slice(-4)}` : "not printed"} />
        <F k="subtotal" label="Subtotal" value={money(invoice.subtotal, invoice.currency)} />
        <F k="tax" label="Tax" value={money(invoice.tax, invoice.currency)} />
        <F k="total" label="Total" value={money(invoice.total, invoice.currency)} />
      </div>
      <table className="lines">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((li, i) => (
            <tr key={i}>
              <td>{li.description}</td>
              <td className="num">{li.quantity}</td>
              <td className="num">{money(li.unitPrice, invoice.currency)}</td>
              <td className="num">{money(li.total, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {po && poMatch?.billing && <BillingBar poId={po.id} method={poMatch.method} billing={poMatch.billing} currency={po.currency} />}
    </div>
  );
}

function BillingBar({ poId, method, billing, currency }: { poId: string; method: PoMatch["method"]; billing: NonNullable<PoMatch["billing"]>; currency: string }) {
  const scale = Math.max(billing.poTotal, billing.billedAfter);
  const w = (n: number) => `${Math.max(0, (n / scale) * 100)}%`;
  const over = billing.billedAfter > billing.poTotal + 0.005;
  return (
    <div className="billing">
      <div className="label">
        {poId} {method === "inferred" ? "(inferred)" : ""} · PO value {money(billing.poTotal, currency)}
      </div>
      <div className="billing-track" role="img" aria-label={`Previously billed ${money(billing.previouslyBilled, currency)}, this invoice ${money(billing.thisInvoice, currency)}, PO ${money(billing.poTotal, currency)}`}>
        {billing.previouslyBilled > 0 && <div className="seg seg-prev" style={{ width: w(billing.previouslyBilled) }} title={`Previously billed ${money(billing.previouslyBilled, currency)}`} />}
        <div className={`seg ${over ? "seg-over" : "seg-this"}`} style={{ width: w(billing.thisInvoice) }} title={`This invoice ${money(billing.thisInvoice, currency)}`} />
        <div className="po-limit" style={{ left: w(billing.poTotal) }} />
      </div>
      <div className="billing-legend">
        {billing.previouslyBilled > 0 && (
          <span>
            <i className="sw seg-prev" /> Previously billed {money(billing.previouslyBilled, currency)} ({billing.priorInvoices.join(", ")})
          </span>
        )}
        <span>
          <i className={`sw ${over ? "seg-over" : "seg-this"}`} /> This invoice {money(billing.thisInvoice, currency)}
        </span>
        <span>
          {over ? `Over PO by ${money(billing.billedAfter - billing.poTotal, currency)}` : `${money(Math.max(0, billing.remainingAfter), currency)} left on PO`}
        </span>
      </div>
    </div>
  );
}
