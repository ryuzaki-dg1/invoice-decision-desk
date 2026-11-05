import { useMemo, useState } from "react";
import { ArrowRight, FileText, Search } from "lucide-react";
import { ACTION_GROUPS, REASON_LABEL, SHORT, requiredAction } from "./copy";
import { isOpen, money } from "./lib/engine";
import { openCodes } from "./lib/review";
import type { CaseStatus, CheckAction, RunRecord } from "./types";
import { Empty, SEVERITY, SeverityDot, SkeletonRows, StatusBadge, fmtDate, fmtSecs, timeAgo, topFinding } from "./ui";

export const go = (id: string, from?: string) => {
  window.location.href = `/invoice/${id}${from ? `?from=${from}` : ""}`;
};

export type QueueItem = RunRecord & { why: string; actionKey: string; actionLabel: string; sev: CheckAction; reason: string };

// Transparent priority: severity first, then money at stake, then time waiting.
export function prioritise(runs: RunRecord[]): QueueItem[] {
  return runs
    .filter((r) => isOpen(r.status))
    .map((r) => {
      const f = topFinding(r);
      const sev = f?.action ?? "review";
      const key = requiredAction(r, openCodes(r));
      return {
        ...r,
        sev,
        actionKey: key,
        actionLabel: ACTION_GROUPS.find((g) => g.key === key)!.label,
        reason: f ? REASON_LABEL[f.code] : "Review",
        why: `${SEVERITY[sev].label} severity · ${money(r.invoice.total, r.invoice.currency)} at stake · ${timeAgo(r.createdAt)}`,
      };
    })
    .sort((a, b) => SEVERITY[b.sev].rank - SEVERITY[a.sev].rank || (b.invoice.total ?? 0) - (a.invoice.total ?? 0) || a.createdAt - b.createdAt);
}

export function AttentionRow({ r, onOpen, selected, compact }: { r: QueueItem; onOpen: () => void; selected?: boolean; compact?: boolean }) {
  const f = topFinding(r);
  return (
    <div className={`arow ${selected ? "on" : ""} ${compact ? "arow-compact" : ""}`} role="button" tabIndex={0} aria-current={selected || undefined} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
      <SeverityDot action={r.sev} />
      <div className="arow-main">
        <div className="arow-top">
          <span className="arow-vendor">{r.vendorMatched ?? r.invoice.vendor}</span>
          {!compact && <span className="arow-inv">{r.invoice.invoiceNumber ?? "—"}</span>}
        </div>
        <div className="arow-reason">
          {compact ? (
            <>
              <span className="arow-inv">{r.invoice.invoiceNumber ?? "—"}</span> · {r.actionLabel}
            </>
          ) : (
            (f && SHORT[f.code]) ?? r.reason
          )}
        </div>
      </div>
      <div className="arow-amt">{money(r.invoice.total, r.invoice.currency)}</div>
      {!compact && (
        <span className="btn btn-sm arow-btn">
          Review <ArrowRight size={14} />
        </span>
      )}
    </div>
  );
}

type Filter = "all" | CaseStatus;

export function RunsTable({ runs, loaded, from, limit }: { runs: RunRecord[]; loaded: boolean; from: string; limit?: number }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const count = (s: Filter) => (s === "all" ? runs.length : runs.filter((r) => r.status === s || (s === "needs_review" && r.status === "awaiting_info")).length);
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
          <Search size={16} aria-hidden />
          <input className="input" placeholder="Search vendor, invoice or PO" aria-label="Search invoices" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="chips" role="group" aria-label="Filter by decision">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l} <span>{count(k)}</span>
            </button>
          ))}
        </div>
      </div>
      {!loaded ? (
        <SkeletonRows />
      ) : list.length === 0 ? (
        <Empty icon={<FileText size={22} />} title={runs.length ? "No invoices match" : "No invoices yet"}>
          {runs.length ? "Try another search or filter." : <a href="/process">Process your first invoice</a>}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="tbl tbl-click">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Invoice</th>
                <th className="num">Amount</th>
                <th>Date</th>
                <th>Decision</th>
                <th className="num">Processing</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => go(r.id, from)} onKeyDown={(e) => e.key === "Enter" && go(r.id, from)}>
                  <td className="strong">
                    {r.vendorMatched ?? r.invoice.vendor}
                    {r.repeatSubmission && <span className="sub">Repeat submission</span>}
                  </td>
                  <td className="mono">{r.invoice.invoiceNumber ?? "—"}</td>
                  <td className="num strong">{money(r.invoice.total, r.invoice.currency)}</td>
                  <td className="muted tabnum">{fmtDate(r.createdAt)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="num muted">{fmtSecs(r.durationMs)}</td>
                  <td className="num">
                    <span className="view-link">
                      View <ArrowRight size={14} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {limit && shown.length > limit && (
            <a className="table-more" href="/history">
              View all {shown.length} invoices <ArrowRight size={14} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
