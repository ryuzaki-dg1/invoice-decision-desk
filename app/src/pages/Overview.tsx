import { useMemo } from "react";
import { ArrowRight, CircleCheckBig, FileText, Inbox, Plus, Wallet, Zap } from "lucide-react";
import { REASON_LABEL } from "../copy";
import { isOpen, money, statusLabel } from "../lib/engine";
import { Shell } from "../Shell";
import { AttentionRow, go, prioritise } from "../tables";
import type { CaseStatus, ExceptionCode } from "../types";
import { Empty, STATUS_COLOR, SkeletonRows, StatusBadge, fmtSecs, timeAgo, useRuns } from "../ui";

const DIST: { key: CaseStatus; label: string }[] = [
  { key: "approved", label: "Approved" },
  { key: "needs_review", label: "Needs review" },
  { key: "payment_hold", label: "Payment hold" },
  { key: "rejected", label: "Rejected" },
];

function greeting(): string {
  const h = new Date().getHours(); // browser local time
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function Overview() {
  const { runs, loaded } = useRuns();
  const queue = prioritise(runs);

  const m = useMemo(() => {
    const total = runs.length;
    const eligible = runs.filter((r) => !r.repeatSubmission);
    const stp = eligible.filter((r) => r.decision.resolution === "AUTO_APPROVE").length;
    const open = runs.filter((r) => isOpen(r.status));
    const openValue = open.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
    const avgMs = total ? runs.reduce((s, r) => s + r.durationMs, 0) / total : 0;
    const bucket = (s: CaseStatus): CaseStatus => (s === "awaiting_info" ? "needs_review" : s);
    const dist = DIST.map((d) => ({ ...d, n: runs.filter((r) => bucket(r.status) === d.key).length }));
    const reasons = new Map<ExceptionCode, number>();
    for (const r of runs) for (const c of new Set(r.findings.filter((x) => x.action !== "info").map((x) => x.code))) reasons.set(c, (reasons.get(c) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    return { total, repeats: total - eligible.length, eligible: eligible.length, stp, open: open.length, holds: open.filter((r) => r.status === "payment_hold").length, openValue, avgMs, dist, top };
  }, [runs]);

  return (
    <Shell page="overview" openCount={m.open}>
      <header className="page-head">
        <div>
          <h1 className="h1">{greeting()}, AP team</h1>
          <p className="sub">Here's what needs your attention today.</p>
        </div>
        <a className="btn btn-primary btn-lg" href="/process">
          <Plus size={18} /> Process invoice
        </a>
      </header>

      <div className="kpis">
        <Kpi icon={<FileText size={18} />} tone="indigo" label="Invoices processed" value={String(m.total)} sub={m.repeats ? `incl. ${m.repeats} repeat submission${m.repeats > 1 ? "s" : ""}` : "unique submissions"} />
        <Kpi icon={<Zap size={18} />} tone="teal" label="Straight-through processing" value={m.eligible ? `${Math.round((m.stp / m.eligible) * 100)}%` : "—"} sub={`${m.stp} of ${m.eligible} approved with no human touch`} />
        <Kpi icon={<Inbox size={18} />} tone="amber" label="Awaiting action" value={String(m.open)} sub={m.holds ? `${m.holds} on payment hold` : "in the review queue"} />
        <Kpi icon={<Wallet size={18} />} tone="orange" label="Value requiring intervention" value={money(m.openValue)} sub="unresolved invoices only" />
      </div>

      <div className="home">
        <div className="home-left">
        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="h2">Needs your attention</h2>
              <p className="muted small">Most severe first, then largest amount, then longest waiting.</p>
            </div>
            {queue.length > 0 && (
              <a className="btn btn-sm" href="/queue">
                Open review queue <ArrowRight size={14} />
              </a>
            )}
          </div>
          {!loaded ? (
            <SkeletonRows />
          ) : queue.length === 0 ? (
            <Empty icon={<CircleCheckBig size={22} />} title="You're all caught up">
              Nothing is waiting on a decision. <a href="/process">Process an invoice</a>
            </Empty>
          ) : (
            <div className="arows">
              {queue.slice(0, 6).map((r) => (
                <AttentionRow key={r.id} r={r} onOpen={() => (window.location.href = `/queue?run=${r.id}`)} />
              ))}
            </div>
          )}
        </section>
        <RecentActivity runs={runs} loaded={loaded} />
        </div>

        <section className="card health">
          <div className="card-head">
            <h2 className="h2">Processing health</h2>
          </div>
          <div className="health-body">
            <div className="health-top">
              <div>
                <div className="big">{m.eligible ? `${Math.round((m.stp / m.eligible) * 100)}%` : "—"}</div>
                <div className="muted small">automation rate</div>
              </div>
              <div>
                <div className="big big-2">{m.total ? fmtSecs(m.avgMs) : "—"}</div>
                <div className="muted small">avg. time to decision</div>
              </div>
            </div>
            <h3 className="h3">Decisions</h3>
            {m.total ? (
              <div className="dist">
                {m.dist.map((d) => (
                  <div key={d.key} className="dist-row" title={`${d.label}: ${d.n}`}>
                    <span className="dist-l">{d.label}</span>
                    <span className="dist-track">
                      <span style={{ width: `${(d.n / m.total) * 100}%`, background: STATUS_COLOR[d.key] }} />
                    </span>
                    <span className="dist-n">{d.n}</span>
                    <span className="dist-p">{Math.round((d.n / m.total) * 100)}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No invoices yet.</p>
            )}
            <h3 className="h3">Most common exceptions</h3>
            {m.top.length ? (
              <ol className="topex">
                {m.top.map(([c, n]) => (
                  <li key={c}>
                    <span>{REASON_LABEL[c]}</span>
                    <b>{n}</b>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">None recorded.</p>
            )}
          </div>
        </section>
      </div>
    </Shell>
  );
}

function RecentActivity({ runs, loaded }: { runs: ReturnType<typeof useRuns>["runs"]; loaded: boolean }) {
  return (
      <section className="card">
        <div className="card-head">
          <h2 className="h2">Recent activity</h2>
          <a className="small" href="/history">
            View history
          </a>
        </div>
        {!loaded ? (
          <SkeletonRows n={3} />
        ) : runs.length === 0 ? (
          <Empty title="No activity yet" />
        ) : (
          <ul className="feed">
            {runs.slice(0, 6).map((r) => (
              <li key={r.id} tabIndex={0} onClick={() => go(r.id, "overview")} onKeyDown={(e) => e.key === "Enter" && go(r.id, "overview")}>
                <span className="feed-dot" style={{ background: STATUS_COLOR[r.status] }} />
                <span className="feed-text">
                  <b>{r.vendorMatched ?? r.invoice.vendor}</b> <span className="mono muted">{r.invoice.invoiceNumber}</span> · {statusLabel(r.status).toLowerCase()}
                  {r.audit.some((e) => e.kind === "reviewer") ? ` by ${[...r.audit].reverse().find((e) => e.kind === "reviewer")!.actor}` : " by rules"}
                </span>
                <span className="feed-amt">{money(r.invoice.total, r.invoice.currency)}</span>
                <StatusBadge status={r.status} />
                <span className="feed-time">{timeAgo(r.audit.at(-1)?.at ?? r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
  );
}

function Kpi({ icon, tone, label, value, sub }: { icon: React.ReactNode; tone: string; label: string; value: string; sub: string }) {
  return (
    <div className="kpi">
      <span className={`kpi-icon kpi-${tone}`}>{icon}</span>
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-sub">{sub}</div>
      </div>
    </div>
  );
}
