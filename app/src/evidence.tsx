// Evidence patterns: side-by-side comparisons that make a finding scannable in
// seconds. Each pattern reads only stored run data; nothing is inferred here.

import { VENDORS } from "./data/vendors";
import { expectedTotal, fmtPct, maskAccount, money } from "./lib/engine";
import type { RunRecord } from "./types";

const has = (run: RunRecord, code: string) => run.findings.some((f) => f.code === code);

function Mark({ ok, label }: { ok: boolean | null; label?: string }) {
  if (ok === null) return <span className="mk mk-na">—</span>;
  return (
    <span className={`mk ${ok ? "mk-ok" : "mk-bad"}`} aria-label={ok ? "matches" : "does not match"}>
      {ok ? "✓" : "✕"}
      {label && <em>{label}</em>}
    </span>
  );
}

// ---------- Vendor identity + bank account ----------
export function VendorBankEvidence({ run }: { run: RunRecord }) {
  const v = VENDORS.find((x) => x.id === run.vendorId);
  const bankBad = has(run, "BANK_ACCOUNT_MISMATCH");
  const bankResolved = (run.resolvedCodes ?? []).includes("BANK_ACCOUNT_MISMATCH");
  return (
    <div className={`ev ${!v || bankBad ? "ev-alert" : ""}`} id="ev-vendor">
      <div className="ev-head">
        <span className="ev-title">Vendor & bank account</span>
        {!v ? <span className="ev-flag ev-flag-hold">Not in vendor master</span> : bankBad ? <span className={`ev-flag ${bankResolved ? "ev-flag-ok" : "ev-flag-hold"}`}>{bankResolved ? "Change verified" : "Account mismatch"}</span> : <span className="ev-flag ev-flag-ok">Verified</span>}
      </div>
      <div className="cmp">
        <div className="cmp-row cmp-h">
          <span />
          <span>On invoice</span>
          <span>Approved record</span>
          <span />
        </div>
        <div className="cmp-row">
          <span className="cmp-k">Payee</span>
          <span>{run.invoice.vendor || "—"}</span>
          <span>{v ? v.name : <span className="muted">no match</span>}</span>
          <Mark ok={!!v} />
        </div>
        <div className={`cmp-row ${bankBad && !bankResolved ? "cmp-bad" : ""}`}>
          <span className="cmp-k">Remit-to account</span>
          <span className="num-l">{run.invoice.bankAccount ? maskAccount(run.invoice.bankAccount) : <span className="muted">not printed</span>}</span>
          <span className="num-l">{v ? `${maskAccount(v.bankAccount)} · ${v.bankName}` : "—"}</span>
          <Mark ok={!v ? null : !bankBad} />
        </div>
      </div>
      {v && bankBad && (
        <div className="ev-action">
          <strong>Security control:</strong> verify by calling {v.phone} (trusted contact on file). Never use a phone number or email from the invoice.
        </div>
      )}
      {!v && <div className="ev-action">Procurement must onboard and verify this payee (legal entity, tax ID, bank confirmation) before any approval.</div>}
    </div>
  );
}

// ---------- Invoice vs PO ----------
export function PoEvidence({ run }: { run: RunRecord }) {
  const { po, billing: b, method, lines } = run.poMatch;
  const c = run.invoice.currency;
  if (!po || !b) {
    return (
      <div className="ev ev-alert" id="ev-po">
        <div className="ev-head">
          <span className="ev-title">Purchase order</span>
          <span className="ev-flag ev-flag-warn">No PO matched</span>
        </div>
        <div className="small muted">{run.invoice.poReference ? `PO "${run.invoice.poReference}" is not in the PO table.` : "No PO number on the invoice and no open PO for this vendor fits the amount."}</div>
      </div>
    );
  }
  // PO utilisation, every segment computed from the stored ledger:
  //   billed before (confirmed: paid or approved) | this invoice within the PO | this invoice over the PO
  // Pending invoices (in review / on hold) are shown separately and never counted as spend.
  const variance = b.billedAfter - b.poTotal;
  const ceiling = b.poTotal * (1 + b.tolerancePct);
  const exceeds = b.billedAfter > ceiling + 0.005;
  const overPo = Math.max(0, b.billedAfter - Math.max(b.poTotal, b.previouslyBilled));
  const thisWithin = Math.max(0, b.thisInvoice - overPo);
  const flag = exceeds ? ["Exceeds PO + tolerance", "ev-flag-warn"] : variance > 0.005 ? ["Over PO, within tolerance", "ev-flag-ok"] : b.remainingAfter > 0.005 ? ["Within PO", "ev-flag-ok"] : ["Uses the full PO", "ev-flag-ok"];
  const scale = Math.max(ceiling, b.billedAfter + (b.pendingOnPo ?? 0)) * 1.04;
  const w = (n: number) => `${Math.max(0, (n / scale) * 100)}%`;
  const ledger = b.ledger ?? b.priorInvoices.map((n) => ({ invoiceNumber: n, issueDate: "—", total: NaN, status: "paid" as const, source: "erp" as const, confirmed: true }));
  const statusText = (s: string, src: string) => (s === "paid" ? "Paid (ERP record)" : s === "approved" ? "Approved, not yet paid" : src === "run" ? "Pending review / hold" : s);
  const qtyLines = (lines ?? []).filter((l) => l.poQty !== null);
  return (
    <div className={`ev ${exceeds ? "ev-alert" : ""}`} id="ev-po">
      <div className="ev-head">
        <span className="ev-title">
          PO utilisation · {po.id} {method === "inferred" && <span className="ev-flag ev-flag-warn">suggested match, unconfirmed</span>}
        </span>
        <span className={`ev-flag ${flag[1]}`}>{flag[0]}</span>
      </div>
      <div className="figs">
        <Fig k="Authorised PO value" v={money(b.poTotal, c)} />
        <Fig k="Billed before" v={money(b.previouslyBilled, c)} sub={b.priorInvoices.length ? `${b.priorInvoices.length} invoice${b.priorInvoices.length > 1 ? "s" : ""} · confirmed` : "none"} />
        <Fig k="This invoice" v={money(b.thisInvoice, c)} />
        <Fig k="Cumulative" v={money(b.billedAfter, c)} sub={fmtPct(b.poTotal ? b.billedAfter / b.poTotal - 1 : 0) + " vs PO"} tone={exceeds ? "bad" : undefined} />
        <Fig k={variance > 0.005 ? "Over the PO" : "Remaining"} v={money(Math.abs(b.remainingAfter), c)} tone={exceeds ? "bad" : undefined} />
        <Fig k="Tolerance" v={fmtPct(b.tolerancePct, false)} sub={`ceiling ${money(ceiling, c)}`} />
      </div>
      <div className="util-bar" role="img" aria-label={`Billed before ${money(b.previouslyBilled, c)}, this invoice ${money(b.thisInvoice, c)}, PO ${money(b.poTotal, c)}${overPo ? `, ${money(overPo, c)} over` : ""}`}>
        {b.previouslyBilled > 0 && (
          <span className="ub-prev" style={{ width: w(b.previouslyBilled) }} title={`Billed before ${money(b.previouslyBilled, c)}`}>
            {b.previouslyBilled / scale > 0.16 && <em>{money(b.previouslyBilled, c)}</em>}
          </span>
        )}
        {thisWithin > 0 && (
          <span className="ub-this" style={{ width: w(thisWithin) }} title={`This invoice within the PO ${money(thisWithin, c)}`}>
            {thisWithin / scale > 0.14 && <em>{money(thisWithin, c)}</em>}
          </span>
        )}
        {overPo > 0.005 && (
          <span className={exceeds ? "ub-over" : "ub-tol-over"} style={{ width: w(overPo) }} title={`Over the authorised PO ${money(overPo, c)}`}>
            {overPo / scale > 0.1 && <em>+{money(overPo, c)}</em>}
          </span>
        )}
        {b.pendingOnPo > 0 && <span className="ub-pend" style={{ width: w(b.pendingOnPo) }} title={`Pending, not committed ${money(b.pendingOnPo, c)}`} />}
        <span className="ub-tol" style={{ left: w(b.poTotal), width: w(ceiling - b.poTotal) }} title={`Tolerance up to ${money(ceiling, c)}`} />
        <span className="ub-po" style={{ left: w(b.poTotal) }}>
          <small>PO {money(b.poTotal, c)}</small>
        </span>
      </div>
      <div className="meter-legend">
        {b.previouslyBilled > 0 && (
          <span>
            <i className="sw ub-prev" /> billed before (confirmed)
          </span>
        )}
        <span>
          <i className="sw ub-this" /> this invoice
        </span>
        {overPo > 0.005 && (
          <span>
            <i className={`sw ${exceeds ? "ub-over" : "ub-tol-over"}`} /> over the authorised value
          </span>
        )}
        {b.pendingOnPo > 0 && (
          <span>
            <i className="sw ub-pend" /> pending, not counted ({b.pendingInvoices.join(", ")})
          </span>
        )}
        <span>
          <i className="sw ub-tol" /> tolerance band
        </span>
      </div>
      {qtyLines.length > 0 && qtyLines.some((l) => l.status !== "ok" || l.priorQty > 0) && (
        <table className="tbl tbl-sm" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Ordered</th>
              <th className="num">Billed before</th>
              <th className="num">This invoice</th>
              <th className="num">Total billed</th>
              <th className="num">Excess</th>
              <th className="num">PO / inv. price</th>
            </tr>
          </thead>
          <tbody>
            {qtyLines.map((l, i) => {
              const total = l.priorQty + l.invoiceQty;
              const excess = Math.max(0, total - (l.poQty ?? 0));
              return (
                <tr key={i} className={l.status !== "ok" ? "tr-bad" : ""}>
                  <td>{l.description}</td>
                  <td className="num">{l.poQty}</td>
                  <td className="num">{l.priorQty}</td>
                  <td className="num">{l.invoiceQty}</td>
                  <td className="num strong">{total}</td>
                  <td className={`num ${excess ? "t-bad strong" : "muted"}`}>{excess || "—"}</td>
                  <td className={`num ${l.status === "price_over" ? "t-bad" : ""}`}>
                    {l.poUnitPrice !== null ? money(l.poUnitPrice, c) : "—"} / {money(l.invoiceUnitPrice, c)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(ledger.length > 0 || b.previouslyBilled > 0) && (
        <details className="ledger">
          <summary>Invoices on this PO ({ledger.length + 1}) · each counted once; rejected duplicates excluded</summary>
          <table className="tbl tbl-sm">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">Counts as spend</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.invoiceNumber}>
                  <td className="mono">{l.invoiceNumber}</td>
                  <td className="tabnum">{l.issueDate}</td>
                  <td>{statusText(l.status, l.source)}</td>
                  <td className="num">{Number.isFinite(l.total) ? money(l.total, c) : "—"}</td>
                  <td className="num">{l.confirmed ? "Yes" : "No (pending)"}</td>
                </tr>
              ))}
              <tr className="ledger-cur">
                <td className="mono">{run.invoice.invoiceNumber ?? "this invoice"}</td>
                <td className="tabnum">{run.invoice.issueDate ?? "—"}</td>
                <td>This invoice</td>
                <td className="num">{money(b.thisInvoice, c)}</td>
                <td className="num">If approved</td>
              </tr>
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Fig({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: "bad" }) {
  return (
    <div className="fig">
      <div className="fig-k">{k}</div>
      <div className={`fig-v ${tone === "bad" ? "fig-bad" : ""}`}>{v}</div>
      {sub && <div className="fig-sub">{sub}</div>}
    </div>
  );
}

// ---------- Duplicate ----------
export function DuplicateEvidence({ run }: { run: RunRecord }) {
  const d = run.duplicateOf;
  if (!d) {
    if (!run.repeatSubmission) return null;
    return (
      <div className="ev">
        <div className="ev-head">
          <span className="ev-title">Repeat upload</span>
          <span className="ev-flag ev-flag-warn">Same file seen before</span>
        </div>
        <div className="small muted">This exact file was uploaded earlier. Recorded as an attempt; no new payable.</div>
      </div>
    );
  }
  const c = run.invoice.currency;
  const status = d.status === "paid" ? "Paid · payment record in ERP" : d.status === "approved" ? "Approved for payment · not yet paid" : "Under review";
  return (
    <div className="ev ev-alert" id="ev-dup">
      <div className="ev-head">
        <span className="ev-title">Duplicate of {d.invoiceNumber}</span>
        <span className="ev-flag ev-flag-bad">No second payable</span>
      </div>
      <div className="cmp">
        <div className="cmp-row cmp-h">
          <span />
          <span>This submission</span>
          <span>Original on file</span>
          <span />
        </div>
        <div className="cmp-row">
          <span className="cmp-k">Vendor</span>
          <span>{run.vendorMatched ?? run.invoice.vendor}</span>
          <span>{run.vendorMatched ?? run.invoice.vendor}</span>
          <Mark ok />
        </div>
        <div className="cmp-row">
          <span className="cmp-k">Invoice number</span>
          <span className="num-l">{run.invoice.invoiceNumber ?? "—"}</span>
          <span className="num-l">{d.invoiceNumber}</span>
          <Mark ok label={run.invoice.invoiceNumber !== d.invoiceNumber ? "normalised" : undefined} />
        </div>
        <div className="cmp-row">
          <span className="cmp-k">Amount</span>
          <span className="num-l">{money(run.invoice.total, c)}</span>
          <span className="num-l">{money(d.total, c)}</span>
          <Mark ok={Math.abs((run.invoice.total ?? 0) - d.total) < 0.01} />
        </div>
        <div className="cmp-row">
          <span className="cmp-k">Invoice date</span>
          <span className="num-l">{run.invoice.issueDate ?? "—"}</span>
          <span className="num-l">{d.issueDate}</span>
          <Mark ok={run.invoice.issueDate === d.issueDate} />
        </div>
      </div>
      <div className="ev-action">
        <strong>Original status:</strong> {status} · source {d.source === "erp" ? "ERP history (demo data)" : `earlier run ${d.runId}`}
        {run.repeatSubmission && !d && " · identical file"}
      </div>
    </div>
  );
}

// ---------- Arithmetic ----------
export function ArithmeticEvidence({ run }: { run: RunRecord }) {
  const inv = run.invoice;
  const c = inv.currency;
  const exp = expectedTotal(inv);
  const diff = exp !== null && inv.total !== null ? inv.total - exp : null;
  const bad = diff !== null && Math.abs(diff) > 1;
  const rows: [string, number | null, string?][] = [
    ["Subtotal", inv.subtotal],
    ["Tax", inv.tax],
    ...(inv.shipping ? ([["Freight / shipping", inv.shipping]] as [string, number][]) : []),
    ...(inv.otherCharges ? ([["Other charges", inv.otherCharges]] as [string, number][]) : []),
    ...(inv.discount ? ([["Discount", -inv.discount]] as [string, number][]) : []),
  ];
  return (
    <div className={`ev ${bad ? "ev-alert" : ""}`} id="ev-math">
      <div className="ev-head">
        <span className="ev-title">Invoice arithmetic</span>
        <span className={`ev-flag ${bad ? "ev-flag-warn" : "ev-flag-ok"}`}>{bad ? "Does not reconcile" : "Reconciles"}</span>
      </div>
      <div className="sum">
        {rows.map(([k, v]) => (
          <div key={k} className="sum-row">
            <span>{k}</span>
            <span className="tabnum">{money(v, c)}</span>
          </div>
        ))}
        <div className="sum-row sum-total">
          <span>Expected total</span>
          <span className="tabnum">{money(exp, c)}</span>
        </div>
        <div className={`sum-row ${bad ? "sum-bad" : ""}`}>
          <span>Total printed on invoice</span>
          <span className="tabnum">{money(inv.total, c)}</span>
        </div>
        {diff !== null && Math.abs(diff) >= 0.01 && (
          <div className={`sum-row ${bad ? "sum-bad" : ""}`}>
            <span>Difference</span>
            <span className="tabnum">
              {diff > 0 ? "+" : "−"}
              {money(Math.abs(diff), c)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Which patterns to show, most relevant first.
// Summary view shows the evidence behind every finding that is still relevant
// (most severe first); Detailed view shows all of it.
export function EvidenceStack({ run, relevantOnly }: { run: RunRecord; relevantOnly?: boolean }) {
  const blocks: { key: string; node: React.ReactNode; weight: number }[] = [];
  const open = (code: string) => run.findings.some((f) => f.code === code && f.action !== "info");
  if (run.duplicateOf || run.repeatSubmission) blocks.push({ key: "dup", node: <DuplicateEvidence run={run} />, weight: 4 });
  blocks.push({ key: "vendor", node: <VendorBankEvidence run={run} />, weight: open("BANK_ACCOUNT_MISMATCH") || open("UNKNOWN_VENDOR") ? 3 : 0 });
  blocks.push({ key: "po", node: <PoEvidence run={run} />, weight: ["CUMULATIVE_PO_EXCEEDED", "PO_AMOUNT_EXCEEDED", "PO_MATCH_UNCONFIRMED", "QUANTITY_EXCEEDS_PO", "PENDING_PO_CONFLICT", "PRICE_VARIANCE"].some(open) ? 2 : 1 });
  blocks.push({ key: "math", node: <ArithmeticEvidence run={run} />, weight: open("ARITHMETIC_MISMATCH") ? 2.5 : -1 });
  const sorted = blocks.filter((b) => b.weight >= 0).sort((a, b) => b.weight - a.weight);
  const relevant = sorted.filter((b) => b.weight >= 2);
  const shown = !relevantOnly ? sorted : relevant.length ? relevant : sorted.slice(0, 1);
  return (
    <div className="ev-stack">
      {shown.map((b) => (
        <div key={b.key}>{b.node}</div>
      ))}
    </div>
  );
}
