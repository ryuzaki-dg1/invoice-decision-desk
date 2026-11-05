// Decision-first building blocks shared by the Process page and the invoice
// detail screen: timeline, decision header, control checks, evidence,
// findings, extracted data, vendor communication, audit trail, review panel.

import { useState, type ReactNode } from "react";
import { REASON_LABEL, whyItMatters } from "./copy";
import { expectedTotal, maskAccount, money, statusLabel } from "./lib/engine";
import { STAGES } from "./lib/pipeline";
import { availableActions, openCodes, type ActionOption } from "./lib/review";
import { submitReview } from "./lib/runsApi";
import type { CaseStatus, Decision, Explanation, Finding, Invoice, PoMatch, RunRecord, StageId, StageState, Vendor } from "./types";
import { SEVERITY, Severity, StatusBadge, fmtDate, useReviewer } from "./ui";
import { VENDORS } from "./data/vendors";

// ---------------- Timeline ----------------

const TL_ICON: Record<StageState["status"], string> = { pending: "", running: "", done: "✓", warn: "!", blocked: "■", error: "✕" };
const TL_TAG: Partial<Record<StageState["status"], [string, string]>> = {
  warn: ["Needs review", "tl-tag-warn"],
  blocked: ["Rule triggered", "tl-tag-blocked"],
  error: ["System error", "tl-tag-error"],
};

export function Timeline({ stages, live }: { stages: StageState[]; live?: boolean }) {
  const byId = new Map(stages.map((s) => [s.id, s]));
  return (
    <ol className="timeline">
      {STAGES.map((def, i) => {
        const s = byId.get(def.id) ?? { id: def.id, status: "pending" as const, lines: [] };
        const ms = s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null;
        const tag = TL_TAG[s.status];
        return (
          <li key={def.id} className={`tl tl-${s.status}`}>
            <span className="tl-dot">{s.status === "running" ? <span className="spinner" /> : TL_ICON[s.status] || i + 1}</span>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-label">{def.label}</span>
                {tag && <span className={`tl-tag ${tag[1]}`}>{tag[0]}</span>}
                <span className="tl-time">{s.status === "running" && live ? "running…" : ms !== null ? (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`) : ""}</span>
              </div>
              <div className="tl-sum">{s.summary ?? def.what}</div>
              {s.lines.length > 0 && (
                <details className="tl-details">
                  <summary>Details</summary>
                  <ul>
                    {s.lines.map((l, j) => (
                      <li key={j}>{l}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------- Decision header ----------------

export function decidedBy(run: Pick<RunRecord, "audit">): string {
  const last = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  return last ? `${last.actor} (reviewer) · ${fmtDate(last.at)}` : "Rules engine (automated)";
}

export function DecisionHeader({
  status,
  invoice,
  decision,
  findings,
  vendorName,
  meta,
  run,
}: {
  status: CaseStatus;
  invoice: Invoice;
  decision: Decision;
  findings: Finding[];
  vendorName: string | null;
  meta?: ReactNode;
  run?: RunRecord;
}) {
  const lastReview = run ? [...run.audit].reverse().find((e) => e.kind === "reviewer") : undefined;
  // Once a reviewer has closed the case, lead with their decision, not the original exception.
  if (lastReview && (status === "approved" || status === "rejected")) {
    return (
      <div className={`dhead dhead-${status}`}>
        <div className="row-between">
          <StatusBadge status={status} large />
          {meta && <div className="small muted">{meta}</div>}
        </div>
        <div className="dhead-inv">
          {invoice.invoiceNumber ?? "No invoice #"} — {vendorName ?? invoice.vendor} <span className="dhead-amt muted">· {money(invoice.total, invoice.currency)}</span>
        </div>
        <div className="dhead-reason">
          {lastReview.action} by {lastReview.actor}: “{lastReview.note}”
        </div>
        <div className="next">
          <span className="next-icon">→</span>
          <div>
            <div className="next-label">Original automated decision</div>
            {decision.headline}. {status === "approved" ? "Now eligible for the payment run; not yet paid." : "Closed; no payable created."}
          </div>
        </div>
      </div>
    );
  }
  const primary = findings.find((f) => decision.decidingCodes.includes(f.code));
  const why = primary && run ? whyItMatters(primary.code, run) : null;
  return (
    <div className={`dhead dhead-${status}`}>
      <div className="row-between">
        <StatusBadge status={status} large />
        {meta && <div className="small muted">{meta}</div>}
      </div>
      <div className="dhead-inv">
        {invoice.invoiceNumber ?? "No invoice #"} — {vendorName ?? invoice.vendor} <span className="dhead-amt muted">· {money(invoice.total, invoice.currency)}</span>
      </div>
      <div className="dhead-reason">{status === "approved" && !primary ? decision.headline : primary ? primary.detail : decision.headline}</div>
      {status !== "approved" && primary && (
        <div className="wwn">
          <div>
            <div className="wwn-k">What happened</div>
            {primary.title}
            {decision.decidingCodes.length > 1 && <span className="muted"> (+{decision.decidingCodes.length - 1} more)</span>}
          </div>
          <div>
            <div className="wwn-k">Why it matters</div>
            {why ?? "Requires a human decision before payment."}
          </div>
          <div>
            <div className="wwn-k">What needs to happen</div>
            {decision.nextAction}
          </div>
        </div>
      )}
      {(status === "approved" || !primary) && (
        <div className="next">
          <span className="next-icon">→</span>
          <div>
            <div className="next-label">Next action</div>
            {decision.nextAction}
          </div>
        </div>
      )}
    </div>
  );
}

// Compact pass/fail strip of the five control areas.
const CONTROL_AREAS: { stage: StageId; label: string }[] = [
  { stage: "validate", label: "Document & totals" },
  { stage: "vendor", label: "Vendor & bank" },
  { stage: "po_match", label: "PO match" },
  { stage: "duplicates", label: "Duplicates" },
];

export function ControlStrip({ findings, resolved = [] }: { findings: Finding[]; resolved?: string[] }) {
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {CONTROL_AREAS.map((a) => {
        const fs = findings.filter((f) => f.stage === a.stage && f.action !== "info");
        const open = fs.filter((f) => !resolved.includes(f.code));
        const worst = open.reduce((m, f) => Math.max(m, SEVERITY[f.action].rank), 0);
        const cls = open.length === 0 ? "st-approved" : worst >= 3 ? "st-rejected" : worst === 2 ? "st-payment_hold" : "st-needs_review";
        const text = open.length === 0 ? (fs.length ? "resolved" : "passed") : REASON_LABEL[open[0].code].toLowerCase();
        return (
          <span key={a.stage} className={`badge ${cls}`} title={open.map((f) => f.title).join("; ")}>
            <i aria-hidden /> {a.label}: {text}
          </span>
        );
      })}
    </div>
  );
}

// ---------------- Findings ----------------

export function FindingsList({ findings, run, resolved = [] }: { findings: Finding[]; run?: RunRecord; resolved?: string[] }) {
  const sorted = [...findings].sort((a, b) => SEVERITY[b.action].rank - SEVERITY[a.action].rank);
  const blocking = sorted.filter((f) => f.action !== "info");
  const info = sorted.filter((f) => f.action === "info");
  const one = (f: Finding, i: number) => (
    <div key={i} className={`finding finding-${f.action}`}>
      <div className="finding-top">
        <Severity action={f.action} />
        <span className="finding-title">{f.title}</span>
        {resolved.includes(f.code) && <span className="badge st-approved">resolved</span>}
        <span className="finding-code">{f.code}</span>
      </div>
      <div className="finding-detail">{f.detail}</div>
      {run && f.action !== "info" && (
        <div className="finding-detail" style={{ marginTop: 6 }}>
          <strong>Why it matters:</strong> {whyItMatters(f.code, run)}
        </div>
      )}
      {f.evidence && f.evidence.length > 0 && (
        <div className="evidence">
          {f.evidence.map((e, j) => (
            <FragmentRow key={j} k={e.label} v={e.value} tone={e.tone} />
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div>
      {blocking.length === 0 && <div className="muted">No exceptions. Every mandatory check passed.</div>}
      {blocking.length > 0 && <div className="findings">{blocking.map(one)}</div>}
      {info.length > 0 && (
        <div className="fgroup">
          <div className="label" style={{ marginTop: blocking.length ? 18 : 10 }}>
            Recorded, not blocking ({info.length})
          </div>
          <div className="findings">{info.map(one)}</div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <>
      <span className="ev-k">{k}</span>
      <span className={`ev-v ${tone === "bad" ? "ev-bad" : tone === "good" ? "ev-good" : ""}`}>{v}</span>
    </>
  );
}

// ---------------- Evidence comparisons ----------------

export function PoComparison({ poMatch, currency }: { poMatch: PoMatch; currency: string }) {
  const b = poMatch.billing;
  const po = poMatch.po;
  if (!po || !b) return <div className="muted">No purchase order matched, so there is nothing to compare against.</div>;
  const variance = b.billedAfter - b.poTotal;
  const variancePct = b.poTotal ? variance / b.poTotal : 0;
  const ceiling = b.poTotal * (1 + b.tolerancePct);
  const exceeds = b.billedAfter > ceiling + 0.005;
  const overPo = variance > 0.005;
  const scale = Math.max(ceiling, b.billedAfter) * 1.02;
  const w = (n: number) => `${Math.max(0, (n / scale) * 100)}%`;
  const status = exceeds ? ["Exceeds tolerance", "st-needs_review"] : overPo ? ["Within tolerance", "st-approved"] : b.remainingAfter > 0.005 ? ["Within PO", "st-approved"] : ["Matches PO", "st-approved"];
  return (
    <div className="poc">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div>
          <span className="cell-strong">{po.id}</span>{" "}
          {poMatch.method === "inferred" ? <span className="badge st-needs_review">suggested, needs confirmation</span> : <span className="muted small">referenced on invoice</span>}
        </div>
        <span className={`badge ${status[1]}`}>
          <i aria-hidden /> {status[0]}
        </span>
      </div>
      <div className="poc-grid">
        <Stat k="PO value" v={money(b.poTotal, currency)} />
        <Stat k={b.previouslyBilled > 0 ? "Cumulative billed" : "This invoice"} v={money(b.billedAfter, currency)} />
        <Stat k="Variance" v={`${variance >= 0 ? "+" : "−"}${money(Math.abs(variance), currency)} (${variancePct >= 0 ? "+" : ""}${(variancePct * 100).toFixed(2)}%)`} tone={exceeds ? "bad" : undefined} />
        <Stat k="Allowed tolerance" v={`${(b.tolerancePct * 100).toFixed(2)}%`} />
      </div>
      <div className="poc-track" role="img" aria-label={`Previously billed ${money(b.previouslyBilled, currency)}, this invoice ${money(b.thisInvoice, currency)}, PO ${money(b.poTotal, currency)}`}>
        {b.previouslyBilled > 0 && <div className="poc-prev" style={{ width: w(b.previouslyBilled) }} title={`Previously billed ${money(b.previouslyBilled, currency)}`} />}
        <div className={`poc-this ${exceeds ? "poc-over" : ""}`} style={{ width: w(b.thisInvoice), borderRadius: b.previouslyBilled > 0 ? "0 5px 5px 0" : 5 }} title={`This invoice ${money(b.thisInvoice, currency)}`} />
        <div className="poc-tol" style={{ left: w(b.poTotal), width: w(ceiling - b.poTotal) }} title="Tolerance band" />
        <div className="poc-mark" style={{ left: w(b.poTotal) }} title={`PO value ${money(b.poTotal, currency)}`} />
      </div>
      <div className="poc-foot">
        {b.previouslyBilled > 0 && (
          <span>
            <i className="sw" style={{ background: "#9fb2e8" }} />
            Previously billed {money(b.previouslyBilled, currency)} ({b.priorInvoices.join(", ")})
          </span>
        )}
        <span>
          <i className="sw" style={{ background: exceeds ? "var(--bad)" : "var(--accent)" }} />
          This invoice {money(b.thisInvoice, currency)}
        </span>
        <span>
          <i className="sw" style={{ background: "var(--ink)", width: 2 }} /> PO value
        </span>
        <span className="muted">{b.remainingAfter >= 0 ? `${money(b.remainingAfter, currency)} remaining on PO` : `${money(-b.remainingAfter, currency)} over PO`}</span>
      </div>
      {poMatch.lines && poMatch.lines.length > 0 && (
        <table className="mini-table" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Ordered</th>
              <th className="num">Prev. billed</th>
              <th className="num">This invoice</th>
              <th className="num">PO price</th>
              <th className="num">Invoice price</th>
            </tr>
          </thead>
          <tbody>
            {poMatch.lines.map((l, i) => (
              <tr key={i} className={l.status !== "ok" ? "bad" : ""}>
                <td>{l.description}</td>
                <td className="num">{l.poQty ?? "—"}</td>
                <td className="num">{l.priorQty}</td>
                <td className="num">{l.invoiceQty}</td>
                <td className="num">{l.poUnitPrice !== null ? money(l.poUnitPrice, currency) : "—"}</td>
                <td className="num">{money(l.invoiceUnitPrice, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "bad" }) {
  return (
    <div>
      <div className="poc-k">{k}</div>
      <div className="poc-v" style={tone === "bad" ? { color: "var(--bad-ink)" } : undefined}>
        {v}
      </div>
    </div>
  );
}

export function VendorEvidence({ run }: { run: Pick<RunRecord, "invoice" | "vendorId" | "findings"> }) {
  const v: Vendor | undefined = VENDORS.find((x) => x.id === run.vendorId);
  const bankBad = run.findings.some((f) => f.code === "BANK_ACCOUNT_MISMATCH");
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th />
          <th>On invoice</th>
          <th>Vendor master</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr className={!v ? "bad" : ""}>
          <td className="muted">Vendor</td>
          <td>{run.invoice.vendor || "—"}</td>
          <td>{v ? `${v.name} (${v.id})` : "No match"}</td>
          <td>{v ? "✓" : "✕"}</td>
        </tr>
        <tr className={bankBad ? "bad" : ""}>
          <td className="muted">Remit-to account</td>
          <td>{run.invoice.bankAccount ? maskAccount(run.invoice.bankAccount) : "not printed"}</td>
          <td>{v ? `${maskAccount(v.bankAccount)} · ${v.bankName}` : "—"}</td>
          <td>{!v ? "—" : bankBad ? "✕" : "✓"}</td>
        </tr>
        {v && (
          <tr>
            <td className="muted">Trusted contact</td>
            <td className="muted">use only the number on file →</td>
            <td>{v.phone}</td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function DuplicateEvidence({ run }: { run: RunRecord }) {
  if (!run.duplicateOf && !run.repeatSubmission) return <div className="muted">No earlier invoice with this vendor and number. Not a repeat upload.</div>;
  const d = run.duplicateOf;
  return (
    <div className="evidence" style={{ marginTop: 0 }}>
      {d && (
        <>
          <FragmentRow k="Original invoice" v={`${d.invoiceNumber} · ${money(d.total, run.invoice.currency)} · ${d.issueDate}`} />
          <FragmentRow k="Original status" v={d.status === "paid" ? "Paid (payment record in ERP)" : d.status === "approved" ? "Approved for payment, not yet paid" : "Under review"} />
          <FragmentRow k="Source" v={d.source === "erp" ? "ERP history (demo data)" : `Earlier run ${d.runId}`} />
          <FragmentRow k="This submission" v={`${run.invoice.invoiceNumber ?? "—"} · ${money(run.invoice.total, run.invoice.currency)}`} tone="bad" />
        </>
      )}
      {run.repeatSubmission && <FragmentRow k="Repeat upload" v="Recorded as an attempt; no new payable created" />}
    </div>
  );
}

// ---------------- Extracted data ----------------

export function ExtractedData({ invoice, extractionMethod }: { invoice: Invoice; extractionMethod?: string }) {
  const low = new Set(invoice.lowConfidenceFields.map((f) => f.split(/[.[]/)[0]));
  const c = invoice.currency;
  const F = ({ k, label, value, missing }: { k: string; label: string; value: string; missing?: boolean }) => (
    <div className={`field ${low.has(k) ? "field-low" : ""} ${missing ? "field-missing" : ""}`} title={low.has(k) ? "Model flagged this field as uncertain" : undefined}>
      <div className="field-k">
        {label}
        {low.has(k) && " · uncertain"}
      </div>
      <div className="field-v">{value}</div>
    </div>
  );
  const exp = expectedTotal(invoice);
  const diff = exp !== null && invoice.total !== null ? invoice.total - exp : null;
  return (
    <div>
      {extractionMethod && (
        <div className="small muted" style={{ marginBottom: 10 }}>
          Read by: {extractionMethod} · document {invoice.documentType}
        </div>
      )}
      <div className="fields">
        <F k="vendor" label="Vendor" value={invoice.vendor || "missing"} missing={!invoice.vendor} />
        <F k="invoiceNumber" label="Invoice number" value={invoice.invoiceNumber ?? "missing"} missing={!invoice.invoiceNumber} />
        <F k="poReference" label="PO reference" value={invoice.poReference ?? "not printed"} />
        <F k="issueDate" label="Invoice date" value={invoice.issueDate ?? "missing"} missing={!invoice.issueDate} />
        <F k="dueDate" label="Due date" value={invoice.dueDate ?? "—"} />
        <F k="bankAccount" label="Remit-to account" value={invoice.bankAccount ? maskAccount(invoice.bankAccount) : "not printed"} />
      </div>
      <table className="mini-table" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((li, i) => (
            <tr key={i} className={Math.abs(li.quantity * li.unitPrice - li.total) > 1 ? "bad" : ""}>
              <td>{li.description}</td>
              <td className="num">{li.quantity}</td>
              <td className="num">{money(li.unitPrice, c)}</td>
              <td className="num">{money(li.total, c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        <span className="muted">Subtotal</span>
        <span>{money(invoice.subtotal, c)}</span>
        <span className="muted">Tax</span>
        <span>{money(invoice.tax, c)}</span>
        {invoice.shipping !== 0 && (
          <>
            <span className="muted">Freight / shipping</span>
            <span>{money(invoice.shipping, c)}</span>
          </>
        )}
        {invoice.otherCharges !== 0 && (
          <>
            <span className="muted">Other charges</span>
            <span>{money(invoice.otherCharges, c)}</span>
          </>
        )}
        {invoice.discount !== 0 && (
          <>
            <span className="muted">Discount</span>
            <span>−{money(invoice.discount, c)}</span>
          </>
        )}
        <span className="muted">Expected total</span>
        <span>{money(exp, c)}</span>
        <span className="t-strong">Invoice total</span>
        <span className="t-strong" style={diff !== null && Math.abs(diff) > 1 ? { color: "var(--bad-ink)" } : undefined}>
          {money(invoice.total, c)}
        </span>
      </div>
    </div>
  );
}

// ---------------- Vendor communication ----------------

export function VendorComms({ explanation, streaming, status }: { explanation?: Explanation; streaming?: string; status: CaseStatus }) {
  const [copied, setCopied] = useState(false);
  if (!explanation) return streaming ? <pre className="stream">{streaming}<span className="caret">▋</span></pre> : <div className="muted">Generating…</div>;
  return (
    <div>
      <div className="label">Summary for AP {explanation.generatedBy === "template" && "· template (AI service unavailable)"}</div>
      <p className="summary">{explanation.summary}</p>
      <div className="row-between" style={{ marginTop: 18, marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>
          Draft email to vendor · not sent automatically
        </div>
        {explanation.vendorEmail && (
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(explanation.vendorEmail!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy email"}
          </button>
        )}
      </div>
      {explanation.vendorEmail ? (
        <pre className="email">{explanation.vendorEmail}</pre>
      ) : (
        <div className="muted small">
          {status === "payment_hold"
            ? "No email drafted on purpose: for a payment hold, verification happens through trusted contacts on file, and an email could alert a fraudster."
            : "No vendor email needed for this outcome."}
        </div>
      )}
    </div>
  );
}

// ---------------- Audit ----------------

export function AuditTrail({ run }: { run: RunRecord }) {
  return (
    <ul className="audit">
      <li>
        <span className="audit-dot" />
        <div>
          <div className="cell-strong">Uploaded {run.fileName}</div>
          <div className="small muted">
            {fmtDate(run.createdAt)} · {run.pageCount} page(s) · {run.extractionMethod} · {run.model} · processed in {(run.durationMs / 1000).toFixed(1)} s
          </div>
        </div>
      </li>
      {run.audit.map((e, i) => (
        <li key={i} className={e.kind === "reviewer" ? "audit-reviewer" : ""}>
          <span className="audit-dot" />
          <div>
            <div className="cell-strong">{e.action}</div>
            <div className="small muted">
              {e.actor} · {fmtDate(e.at)} · {e.fromStatus ? `${statusLabel(e.fromStatus)} → ` : ""}
              {statusLabel(e.toStatus)}
            </div>
            {e.note && <div className="audit-note">"{e.note}"</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------- Review panel ----------------

export function ReviewPanel({ run, onUpdated, onError }: { run: RunRecord; onUpdated: (r: RunRecord) => void; onError: (m: string) => void }) {
  const [reviewer, setReviewer] = useReviewer();
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const options = availableActions(run);
  if (!options.length) {
    return (
      <div className="review">
        <div className="cell-strong">Case closed: {statusLabel(run.status)}</div>
        <div className="small muted">No further reviewer action is possible. See the audit trail for who decided and why.</div>
      </div>
    );
  }
  const needsVerify = options.some((o) => o.needsVerification && o.allowed);
  const vendor = VENDORS.find((v) => v.id === run.vendorId);
  const act = async (o: ActionOption) => {
    setBusy(o.id);
    try {
      const updated = await submitReview(run.id, { action: o.id, reviewer, justification: note, verificationConfirmed: verified });
      setNote("");
      setVerified(false);
      onUpdated(updated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const open = openCodes(run);
  return (
    <div className="review">
      <div className="row-between">
        <div className="cell-strong">Resolve this exception</div>
        <span className="small muted">{open.length} open control{open.length === 1 ? "" : "s"}</span>
      </div>
      <div className="review-grid">
        <label>
          <div className="label">Reviewer (demo identity)</div>
          <input className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" />
        </label>
        <label>
          <div className="label">Justification (recorded in the audit trail)</div>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called vendor on number on file; controller confirmed" />
        </label>
      </div>
      {needsVerify && (
        <label className="check">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          <span>
            I independently verified the bank change with a trusted contact already on file{vendor ? ` (${vendor.name}, ${vendor.phone})` : ""}, not using contact details from this invoice or email.
          </span>
        </label>
      )}
      <div className="actions">
        {options.map((o) => (
          <button
            key={o.id}
            className={`btn ${o.tone === "primary" ? "btn-primary" : o.tone === "danger" ? "btn-danger" : ""}`}
            disabled={!o.allowed || !!busy || !reviewer.trim() || note.trim().length < 5 || (o.needsVerification && !verified)}
            title={o.blockedReason}
            onClick={() => act(o)}
          >
            {busy === o.id ? "Saving…" : o.label}
          </button>
        ))}
      </div>
      {options.filter((o) => !o.allowed && o.blockedReason).map((o) => (
        <div key={o.id} className="blocked-note">
          {o.label} unavailable: {o.blockedReason}
        </div>
      ))}
      {(!reviewer.trim() || note.trim().length < 5) && <div className="blocked-note">Enter your name and a justification to enable actions.</div>}
    </div>
  );
}

// ---------------- Tabs ----------------

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? "tab-on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
