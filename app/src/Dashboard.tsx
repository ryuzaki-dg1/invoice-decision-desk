import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { DecisionBadge, ExplanationPanel, FindingsList, InvoiceView, RESOLUTION_META, StageList, reviewLabel } from "./components";
import { money, resolutionLabel } from "./lib/engine";
import { fetchRuns, resetRuns, reviewRun } from "./lib/runsApi";
import { Shell } from "./Shell";
import type { Resolution, RunRecord } from "./types";

type Filter = "all" | "action" | "approved" | "stopped";
const ORDER: Resolution[] = ["AUTO_APPROVE", "FLAG_FOR_REVIEW", "ESCALATE", "REJECT"];

export default function Dashboard() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("run"));

  const reload = () =>
    fetchRuns()
      .then(setRuns)
      .finally(() => setLoaded(true));
  useEffect(() => {
    reload();
  }, []);

  const pending = runs.filter((r) => r.reviewStatus === "pending");
  const stats = useMemo(() => {
    const total = runs.length;
    const auto = runs.filter((r) => r.decision.resolution === "AUTO_APPROVE").length;
    const value = runs.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
    const stopped = runs.filter((r) => r.decision.resolution === "REJECT" || r.decision.resolution === "ESCALATE");
    const stoppedValue = stopped.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
    const avgMs = total ? runs.reduce((s, r) => s + r.durationMs, 0) / total : 0;
    const mix = ORDER.map((res) => ({ res, n: runs.filter((r) => r.decision.resolution === res).length }));
    const reasons = new Map<string, number>();
    for (const r of runs) for (const f of r.findings) if (f.action !== "info") reasons.set(f.title, (reasons.get(f.title) ?? 0) + 1);
    const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { total, auto, value, stoppedValue, stoppedCount: stopped.length, avgMs, mix, topReasons };
  }, [runs]);

  const visible = runs.filter((r) => {
    if (filter === "action") return r.reviewStatus === "pending";
    if (filter === "approved") return r.reviewStatus === "auto_approved" || r.reviewStatus === "approved";
    if (filter === "stopped") return r.decision.resolution === "REJECT" || r.decision.resolution === "ESCALATE" || r.reviewStatus === "rejected";
    return true;
  });
  const selected = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <Shell active="dashboard" pending={pending.length}>
      <div className="dash">
        <div className="tiles">
          <Tile label="Invoices processed" value={String(stats.total)} sub={`${money(stats.value)} total value`} />
          <Tile label="Auto-approved" value={stats.total ? `${Math.round((stats.auto / stats.total) * 100)}%` : "—"} sub={`${stats.auto} of ${stats.total} with no human touch`} />
          <Tile label="Awaiting a reviewer" value={String(pending.length)} sub={pending.length ? `${money(pending.reduce((s, r) => s + (r.invoice.total ?? 0), 0))} on hold for review` : "queue is clear"} />
          <Tile label="Stopped before payment" value={money(stats.stoppedValue)} sub={`${stats.stoppedCount} duplicate / fraud / unknown-vendor cases`} />
          <Tile label="Avg time per invoice" value={stats.total ? `${(stats.avgMs / 1000).toFixed(1)} s` : "—"} sub="upload to decision" />
        </div>

        <div className="dash-charts">
          <section className="card">
            <h2>Decision mix</h2>
            {stats.total ? (
              <>
                <div className="mix" role="img" aria-label={stats.mix.map((m) => `${resolutionLabel(m.res)} ${m.n}`).join(", ")}>
                  {stats.mix
                    .filter((m) => m.n > 0)
                    .map((m) => (
                      <div key={m.res} className="mix-seg" style={{ flexGrow: m.n, background: RESOLUTION_META[m.res].color }} title={`${resolutionLabel(m.res)}: ${m.n} (${Math.round((m.n / stats.total) * 100)}%)`} />
                    ))}
                </div>
                <div className="mix-legend">
                  {stats.mix.map((m) => (
                    <button key={m.res} className="mix-item" onClick={() => setFilter(m.res === "AUTO_APPROVE" ? "approved" : m.res === "FLAG_FOR_REVIEW" ? "action" : "stopped")}>
                      <span className="sw" style={{ background: RESOLUTION_META[m.res].color }} />
                      <span aria-hidden>{RESOLUTION_META[m.res].icon}</span> {resolutionLabel(m.res)} <strong>{m.n}</strong>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="muted">No runs yet.</div>
            )}
          </section>
          <section className="card">
            <h2>Top reasons invoices were stopped</h2>
            {stats.topReasons.length ? (
              <div className="reasons">
                {stats.topReasons.map(([title, n]) => (
                  <div key={title} className="reason" title={`${title}: ${n}`}>
                    <span className="reason-label">{title}</span>
                    <span className="reason-bar">
                      <span style={{ width: `${(n / stats.topReasons[0][1]) * 100}%` }} />
                    </span>
                    <span className="reason-n">{n}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">Nothing stopped yet.</div>
            )}
          </section>
        </div>

        <section className="card">
          <div className="row-between">
            <div className="filters">
              {(
                [
                  ["all", `All (${runs.length})`],
                  ["action", `Needs action (${pending.length})`],
                  ["approved", "Approved"],
                  ["stopped", "Rejected / on hold"],
                ] as [Filter, string][]
              ).map(([k, l]) => (
                <button key={k} className={`filter ${filter === k ? "filter-on" : ""}`} onClick={() => setFilter(k)}>
                  {l}
                </button>
              ))}
            </div>
            <button
              className="btn-ghost"
              onClick={async () => {
                if (confirm("Clear all run history? (Seeded ERP history stays.)")) {
                  await resetRuns();
                  setSelectedId(null);
                  reload();
                }
              }}
            >
              Reset demo data
            </button>
          </div>
          <table className="runs">
            <thead>
              <tr>
                <th>When</th>
                <th>Vendor</th>
                <th>Invoice</th>
                <th className="num">Amount</th>
                <th>PO</th>
                <th>Decision</th>
                <th>Main reason</th>
                <th>Status</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const main = r.findings.find((f) => r.decision.decidingCodes.includes(f.code));
                return (
                  <tr key={r.id} className={selectedId === r.id ? "row-on" : ""} onClick={() => setSelectedId(r.id)}>
                    <td className="muted">{new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{r.vendorMatched ?? r.invoice.vendor}</td>
                    <td className="mono">{r.invoice.invoiceNumber ?? "—"}</td>
                    <td className="num">{money(r.invoice.total, r.invoice.currency)}</td>
                    <td className="mono">
                      {r.poMatch.po?.id ?? "—"}
                      {r.poMatch.method === "inferred" && <span className="muted"> (inferred)</span>}
                    </td>
                    <td>
                      <DecisionBadge resolution={r.decision.resolution} />
                    </td>
                    <td className="reason-cell">{main?.title ?? "All checks passed"}</td>
                    <td>
                      <span className={`status status-${r.reviewStatus}`}>{reviewLabel(r.reviewStatus)}</span>
                    </td>
                    <td className="num muted">{(r.durationMs / 1000).toFixed(1)} s</td>
                  </tr>
                );
              })}
              {loaded && visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted empty">
                    No runs here yet. <a href="/">Process an invoice →</a>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {selected && <RunDrawer run={selected} onClose={() => setSelectedId(null)} onUpdated={(u) => setRuns((prev) => prev.map((r) => (r.id === u.id ? u : r)))} />}
    </Shell>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

function RunDrawer({ run, onClose, onUpdated }: { run: RunRecord; onClose: () => void; onUpdated: (r: RunRecord) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (status: "approved" | "rejected") => {
    setBusy(true);
    try {
      onUpdated(await reviewRun(run.id, status, note));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <div>
            <div className="drawer-title">
              {run.vendorMatched ?? run.invoice.vendor} · {run.invoice.invoiceNumber ?? "no invoice #"}
            </div>
            <div className="muted">
              {run.fileName} · {new Date(run.createdAt).toLocaleString()} · {run.model}
            </div>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="drawer-decision">
          <DecisionBadge resolution={run.decision.resolution} large />
          <div>
            <div className="decision-headline">{run.decision.headline}</div>
            <div className="muted">Next: {run.decision.nextAction}</div>
          </div>
        </div>

        {run.reviewStatus === "pending" ? (
          <div className="review-box">
            <div className="label">Reviewer decision</div>
            <textarea placeholder="Note for the audit trail (e.g. confirmed PO with requester)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            <div className="row-gap">
              <button className="btn-approve" disabled={busy} onClick={() => act("approved")}>
                Approve for payment
              </button>
              <button className="btn-reject" disabled={busy} onClick={() => act("rejected")}>
                Reject
              </button>
            </div>
          </div>
        ) : (
          <div className="review-box">
            <span className={`status status-${run.reviewStatus}`}>{reviewLabel(run.reviewStatus)}</span>
            {run.reviewedAt && <span className="muted"> · {new Date(run.reviewedAt).toLocaleString()}</span>}
            {run.reviewNote && <div className="note">"{run.reviewNote}"</div>}
          </div>
        )}

        <h3>Findings</h3>
        <FindingsList findings={run.findings} />
        <h3>Explanation</h3>
        <ExplanationPanel explanation={run.explanation} />
        <h3>Extracted data</h3>
        <InvoiceView invoice={run.invoice} poMatch={run.poMatch} />
        <h3>Run trail</h3>
        <StageList stages={run.stages} />
      </aside>
    </div>
  );
}
