import { useMemo, useState } from "react";
import { REASON_LABEL } from "./copy";
import { isOpen, money } from "./lib/engine";
import type { CaseStatus, RunRecord } from "./types";
import { Empty, Icon, SEVERITY, Severity, SkeletonRows, StatusBadge, fmtDate, primaryReason, timeAgo, topFinding } from "./ui";

const go = (id: string, from?: string) => {
  window.location.href = `/invoice/${id}${from ? `?from=${from}` : ""}`;
};

// Open exceptions, most severe first, then oldest first.
export function attentionOrder(runs: RunRecord[]): RunRecord[] {
  return runs
    .filter((r) => isOpen(r.status))
    .sort((a, b) => {
      const sa = SEVERITY[topFinding(a)?.action ?? "info"].rank;
      const sb = SEVERITY[topFinding(b)?.action ?? "info"].rank;
      return sb - sa || a.createdAt - b.createdAt;
    });
}

export function AttentionTable({ runs, loaded, from, showAge = true }: { runs: RunRecord[]; loaded: boolean; from: string; showAge?: boolean }) {
  if (!loaded) return <SkeletonRows />;
  if (!runs.length)
    return (
      <Empty title="Nothing needs your attention">
        Every processed invoice is either approved or closed. <a href="/process">Process an invoice →</a>
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table className="table table-click">
        <thead>
          <tr>
            <th>Invoice</th>
            <th className="num">Amount</th>
            <th>Exception</th>
            <th>Severity</th>
            <th>Recommended action</th>
            <th>Status</th>
            {showAge && <th>Waiting</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const f = topFinding(r);
            return (
              <tr key={r.id} onClick={() => go(r.id, from)}>
                <td>
                  <div className="cell-strong">{r.vendorMatched ?? r.invoice.vendor}</div>
                  <div className="cell-sub mono">{r.invoice.invoiceNumber ?? "no invoice #"}</div>
                </td>
                <td className="num cell-strong">{money(r.invoice.total, r.invoice.currency)}</td>
                <td>{f ? REASON_LABEL[f.code] : "—"}</td>
                <td>{f ? <Severity action={f.action} /> : "—"}</td>
                <td style={{ maxWidth: 340 }} className="small">
                  {r.decision.nextAction}
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                {showAge && <td className="muted tabnum">{timeAgo(r.createdAt)}</td>}
                <td>
                  <button className="btn btn-sm" onClick={(e) => (e.stopPropagation(), go(r.id, from))}>
                    Review
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Filter = "all" | CaseStatus;

export function RunsTable({ runs, loaded, from, limit }: { runs: RunRecord[]; loaded: boolean; from: string; limit?: number }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return runs
      .filter((r) => filter === "all" || r.status === filter || (filter === "needs_review" && r.status === "awaiting_info"))
      .filter((r) => !needle || [r.vendorMatched, r.invoice.vendor, r.invoice.invoiceNumber, r.poMatch.po?.id, r.fileName].some((s) => s?.toLowerCase().includes(needle)));
  }, [runs, q, filter]);
  const list = limit ? shown.slice(0, limit) : shown;
  const FILTERS: [Filter, string][] = [
    ["all", "All"],
    ["approved", "Approved"],
    ["needs_review", "Needs review"],
    ["payment_hold", "Payment hold"],
    ["rejected", "Rejected"],
  ];
  return (
    <>
      <div className="toolbar">
        <label className="search">
          {Icon.search}
          <input className="input" placeholder="Search vendor, invoice, PO…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={filter === k ? "seg-on" : ""} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        {limit && shown.length > limit && (
          <a className="small" href="/history" style={{ marginLeft: "auto" }}>
            View all {shown.length} →
          </a>
        )}
      </div>
      {!loaded ? (
        <SkeletonRows />
      ) : list.length === 0 ? (
        <Empty title={runs.length ? "No invoices match" : "No invoices processed yet"}>{runs.length ? "Try a different search or filter." : <a href="/process">Process your first invoice →</a>}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Processed</th>
                <th>Vendor</th>
                <th>Invoice</th>
                <th className="num">Amount</th>
                <th>PO</th>
                <th>Decision</th>
                <th>Primary reason</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                return (
                  <tr key={r.id} onClick={() => go(r.id, from)}>
                    <td className="muted tabnum">{fmtDate(r.createdAt)}</td>
                    <td className="cell-strong">{r.vendorMatched ?? r.invoice.vendor}</td>
                    <td className="mono">
                      {r.invoice.invoiceNumber ?? "—"}
                      {r.repeatSubmission && <div className="cell-sub">repeat submission</div>}
                    </td>
                    <td className="num">{money(r.invoice.total, r.invoice.currency)}</td>
                    <td className="mono">
                      {r.poMatch.po?.id ?? "—"}
                      {r.poMatch.method === "inferred" && <div className="cell-sub">suggested</div>}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="small">{primaryReason(r, (f) => REASON_LABEL[f.code])}</td>
                    <td className="num muted">{(r.durationMs / 1000).toFixed(1)} s</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
