import { useMemo } from "react";
import { REASON_LABEL } from "../copy";
import { isOpen, money } from "../lib/engine";
import { PageHead, Shell } from "../Shell";
import { AttentionTable, RunsTable, attentionOrder } from "../tables";
import type { CaseStatus, ExceptionCode } from "../types";
import { Icon, STATUS_COLOR, useRuns } from "../ui";

const MIX: { key: CaseStatus; label: string; icon: string }[] = [
  { key: "approved", label: "Approved", icon: "✓" },
  { key: "needs_review", label: "Needs review", icon: "!" },
  { key: "payment_hold", label: "Payment hold", icon: "■" },
  { key: "rejected", label: "Rejected", icon: "✕" },
];

export default function Overview() {
  const { runs, loaded } = useRuns();
  const open = attentionOrder(runs);

  const m = useMemo(() => {
    const total = runs.length;
    const repeats = runs.filter((r) => r.repeatSubmission).length;
    const eligible = runs.filter((r) => !r.repeatSubmission);
    const stp = eligible.filter((r) => r.decision.resolution === "AUTO_APPROVE").length;
    const openRuns = runs.filter((r) => isOpen(r.status));
    const openValue = openRuns.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
    const avgMs = total ? runs.reduce((s, r) => s + r.durationMs, 0) / total : 0;
    const bucket = (s: CaseStatus): CaseStatus => (s === "awaiting_info" ? "needs_review" : s);
    const mix = MIX.map((x) => ({ ...x, n: runs.filter((r) => bucket(r.status) === x.key).length }));
    const reasons = new Map<ExceptionCode, number>();
    for (const r of runs) for (const f of new Set(r.findings.filter((x) => x.action !== "info").map((x) => x.code))) reasons.set(f, (reasons.get(f) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { total, repeats, eligible: eligible.length, stp, openCount: openRuns.length, openValue, avgMs, mix, top };
  }, [runs]);

  return (
    <Shell page="overview" openCount={m.openCount}>
      <PageHead
        title="Accounts Payable Overview"
        sub="Know what's cleared, what's blocked, and what needs your attention."
        action={
          <a className="btn btn-primary btn-lg" href="/process">
            Process new invoice {Icon.arrow}
          </a>
        }
      />

      <div className="kpis">
        <Kpi label="Invoices processed" value={String(m.total)} sub={m.repeats ? `incl. ${m.repeats} repeat submission${m.repeats > 1 ? "s" : ""}` : "unique submissions"} />
        <Kpi label="Straight-through rate" value={m.eligible ? `${Math.round((m.stp / m.eligible) * 100)}%` : "—"} sub={`${m.stp} of ${m.eligible} approved with no human touch`} />
        <Kpi label="Awaiting review" value={String(m.openCount)} sub="needs review, on hold or awaiting vendor" />
        <Kpi label="Value requiring intervention" value={money(m.openValue)} sub="unresolved invoices only" />
        <Kpi label="Avg. processing time" value={m.total ? `${(m.avgMs / 1000).toFixed(1)} s` : "—"} sub="upload to decision" />
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Needs your attention</div>
            <div className="card-sub">Unresolved exceptions, most severe and oldest first</div>
          </div>
          <a className="btn btn-sm" href="/queue">
            Open review queue
          </a>
        </div>
        <AttentionTable runs={open.slice(0, 6)} loaded={loaded} from="overview" />
      </section>

      <div className="two-col">
        <section className="card card-pad">
          <div className="card-title">Decision breakdown</div>
          <div className="card-sub" style={{ marginBottom: 14 }}>
            Current status of every processed invoice
          </div>
          {m.total ? (
            <>
              <div className="mix" role="img" aria-label={m.mix.map((x) => `${x.label} ${x.n}`).join(", ")}>
                {m.mix
                  .filter((x) => x.n)
                  .map((x) => (
                    <div key={x.key} className="mix-seg" style={{ flexGrow: x.n, background: STATUS_COLOR[x.key] }} title={`${x.label}: ${x.n} (${Math.round((x.n / m.total) * 100)}%)`} />
                  ))}
              </div>
              <div className="mix-legend">
                {m.mix.map((x) => (
                  <div key={x.key} className="mix-item">
                    <span className="mix-sw" style={{ background: STATUS_COLOR[x.key] }} />
                    <span aria-hidden className="muted">
                      {x.icon}
                    </span>
                    {x.label}
                    <span className="mix-count">{x.n}</span>
                    <span className="mix-pct">{Math.round((x.n / m.total) * 100)}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="muted">No invoices processed yet.</div>
          )}
        </section>
        <section className="card card-pad">
          <div className="card-title">Top exception reasons</div>
          <div className="card-sub" style={{ marginBottom: 14 }}>
            Invoices affected by each rule (blocking findings only)
          </div>
          {m.top.length ? (
            <div className="bars">
              {m.top.map(([code, n]) => (
                <div key={code} className="bar-row" title={`${REASON_LABEL[code]}: ${n}`}>
                  <span className="bar-label">{REASON_LABEL[code]}</span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${(n / m.top[0][1]) * 100}%`, display: "block" }} />
                  </span>
                  <span className="bar-n">{n}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">No exceptions recorded yet.</div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <div className="card-title">Recent invoice activity</div>
        </div>
        <RunsTable runs={runs} loaded={loaded} from="overview" limit={8} />
      </section>
    </Shell>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}
