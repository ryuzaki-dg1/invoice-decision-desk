import { useMemo, useState } from "react";
import { ACTION_GROUPS, REASON_LABEL, requiredAction } from "./copy";
import { isOpen, money } from "./lib/engine";
import { openCodes } from "./lib/review";
import type { CaseStatus, RunRecord } from "./types";
import { Empty, Icon, SEVERITY, SkeletonRows, StatusBadge, fmtDate, primaryReason, timeAgo, topFinding } from "./ui";

export const go = (id: string, from?: string) => {
  window.location.href = `/invoice/${id}${from ? `?from=${from}` : ""}`;
};

// Transparent priority: severity first, then money at stake, then time waiting.
export function prioritise(runs: RunRecord[]): (RunRecord & { why: string; action: string })[] {
  return runs
    .filter((r) => isOpen(r.status))
    .map((r) => {
      const f = topFinding(r);
      const sev = SEVERITY[f?.action ?? "info"];
      const action = ACTION_GROUPS.find((g) => g.key === requiredAction(r, openCodes(r)))!.label;
      return { ...r, action, why: `${sev.label} severity · ${money(r.invoice.total, r.invoice.currency)} at stake · waiting ${timeAgo(r.createdAt)}`, _rank: sev.rank };
    })
    .sort((a, b) => b._rank - a._rank || (b.invoice.total ?? 0) - (a.invoice.total ?? 0) || a.createdAt - b.createdAt);
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
    <div>
      <div className="toolbar">
        <label className="search">
          {Icon.search}
          <input className="input" placeholder="Search vendor, invoice, PO" aria-label="Search invoices" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={filter === k ? "on" : ""} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        {limit && shown.length > limit && (
          <a className="small" href="/history" style={{ marginLeft: "auto" }}>
            All {shown.length} invoices →
          </a>
        )}
      </div>
      {!loaded ? (
        <SkeletonRows />
      ) : list.length === 0 ? (
        <Empty title={runs.length ? "No invoices match" : "No invoices processed yet"}>{runs.length ? "Try a different search or filter." : <a href="/process">Process your first invoice →</a>}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dense dense-click">
            <thead>
              <tr>
                <th>Processed</th>
                <th>Vendor</th>
                <th>Invoice</th>
                <th className="num">Amount</th>
                <th>PO</th>
                <th>Status</th>
                <th>Reason</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => go(r.id, from)} onKeyDown={(e) => e.key === "Enter" && go(r.id, from)}>
                  <td className="muted tabnum">{fmtDate(r.createdAt)}</td>
                  <td className="strong">{r.vendorMatched ?? r.invoice.vendor}</td>
                  <td className="mono">
                    {r.invoice.invoiceNumber ?? "—"}
                    {r.repeatSubmission && <span className="sub">repeat</span>}
                  </td>
                  <td className="num strong">{money(r.invoice.total, r.invoice.currency)}</td>
                  <td className="mono">
                    {r.poMatch.po?.id ?? "—"}
                    {r.poMatch.method === "inferred" && <span className="sub">suggested</span>}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="muted">{primaryReason(r, (f) => REASON_LABEL[f.code])}</td>
                  <td className="num muted">{(r.durationMs / 1000).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
