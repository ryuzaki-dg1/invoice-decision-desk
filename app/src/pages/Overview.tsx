import { useMemo } from "react";
import { REASON_LABEL } from "../copy";
import { isOpen, money, resolutionLabel } from "../lib/engine";
import { Shell } from "../Shell";
import { RunsTable, go, prioritise } from "../tables";
import type { CaseStatus, ExceptionCode } from "../types";
import { Icon, STATUS_COLOR, SkeletonRows, useRuns } from "../ui";

const MIX: { key: CaseStatus; label: string; icon: string }[] = [
  { key: "approved", label: "Approved", icon: "✓" },
  { key: "needs_review", label: "Needs review", icon: "!" },
  { key: "payment_hold", label: "Payment hold", icon: "■" },
  { key: "rejected", label: "Rejected", icon: "✕" },
];

export default function Overview() {
  const { runs, loaded } = useRuns();
  const queue = prioritise(runs);

  const m = useMemo(() => {
    const total = runs.length;
    const repeats = runs.filter((r) => r.repeatSubmission).length;
    const eligible = runs.filter((r) => !r.repeatSubmission);
    const stp = eligible.filter((r) => r.decision.resolution === "AUTO_APPROVE").length;
    const openRuns = runs.filter((r) => isOpen(r.status));
    const openValue = openRuns.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
    const holds = runs.filter((r) => r.status === "payment_hold").length;
    const avgMs = total ? runs.reduce((s, r) => s + r.durationMs, 0) / total : 0;
    const bucket = (s: CaseStatus): CaseStatus => (s === "awaiting_info" ? "needs_review" : s);
    const mix = MIX.map((x) => ({ ...x, n: runs.filter((r) => bucket(r.status) === x.key).length }));
    const reasons = new Map<ExceptionCode, number>();
    for (const r of runs) for (const c of new Set(r.findings.filter((x) => x.action !== "info").map((x) => x.code))) reasons.set(c, (reasons.get(c) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { total, repeats, eligible: eligible.length, stp, openCount: openRuns.length, openValue, holds, avgMs, mix, top };
  }, [runs]);

  const today = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const headline = !loaded ? "Loading…" : m.openCount === 0 ? "Nothing needs your attention" : `${m.openCount} invoice${m.openCount > 1 ? "s" : ""} need${m.openCount > 1 ? "" : "s"} your attention`;

  return (
    <Shell page="overview" openCount={m.openCount}>
      <header className="hero">
        <div>
          <div className="eyebrow">{today} · Accounts payable</div>
          <h1 className="display">{headline}</h1>
          <p className="hero-sub">
            {m.openCount ? (
              <>
                <strong>{money(m.openValue)}</strong> is waiting on a decision{m.holds ? `, including ${m.holds} payment hold${m.holds > 1 ? "s" : ""}` : ""}. Everything else is cleared or closed.
              </>
            ) : (
              "Every processed invoice is approved or closed."
            )}
          </p>
        </div>
        <a className="btn btn-primary btn-lg" href="/process">
          Process invoice {Icon.arrow}
        </a>
      </header>

      <div className="stats">
        <Stat k="Processed" v={String(m.total)} s={m.repeats ? `${m.repeats} repeat submission${m.repeats > 1 ? "s" : ""}` : "unique submissions"} />
        <Stat k="Straight-through" v={m.eligible ? `${Math.round((m.stp / m.eligible) * 100)}%` : "—"} s={`${m.stp} of ${m.eligible} with no human touch`} />
        <Stat k="Awaiting review" v={String(m.openCount)} s="review, hold or awaiting vendor" />
        <Stat k="Requiring intervention" v={money(m.openValue)} s="unresolved invoices only" />
        <Stat k="Avg. time to decision" v={m.total ? `${(m.avgMs / 1000).toFixed(1)} s` : "—"} s="upload to decision" />
      </div>

      <section className="surface">
        <div className="surface-head">
          <div>
            <h2>Priority queue</h2>
            <p className="muted small">Ordered by severity, then amount at stake, then time waiting.</p>
          </div>
          <a className="btn btn-sm" href="/queue">
            Open review workspace
          </a>
        </div>
        {!loaded ? (
          <SkeletonRows />
        ) : queue.length === 0 ? (
          <div className="empty">
            <div className="empty-title">Queue is clear</div>
            <a href="/process">Process an invoice →</a>
          </div>
        ) : (
          <ol className="pq">
            {queue.slice(0, 6).map((r, i) => {
              const f = r.findings.find((x) => x.action !== "info" && !(r.resolvedCodes ?? []).includes(x.code));
              return (
                <li key={r.id} className={`pq-row pq-${r.status}`} tabIndex={0} onClick={() => go(r.id, "overview")} onKeyDown={(e) => e.key === "Enter" && go(r.id, "overview")}>
                  <span className="pq-rank">{i + 1}</span>
                  <div className="pq-main">
                    <div className="pq-top">
                      <span className="pq-vendor">{r.vendorMatched ?? r.invoice.vendor}</span>
                      <span className="mono muted">{r.invoice.invoiceNumber ?? "no invoice no."}</span>
                      {i === 0 && <span className="tag tag-hold">Highest priority</span>}
                    </div>
                    <div className="pq-reason">{f ? REASON_LABEL[f.code] : resolutionLabel(r.decision.resolution)} — <span className="muted">{r.action}</span></div>
                    <div className="pq-why">{r.why}</div>
                  </div>
                  <div className="pq-amt">{money(r.invoice.total, r.invoice.currency)}</div>
                  <span className="pq-go">Open {Icon.arrow}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="split-2">
        <section className="surface">
          <div className="surface-head">
            <h2>Decisions</h2>
            <span className="muted small">current status of {m.total} invoice{m.total === 1 ? "" : "s"}</span>
          </div>
          {m.total ? (
            <div className="pad">
              <div className="mix" role="img" aria-label={m.mix.map((x) => `${x.label} ${x.n}`).join(", ")}>
                {m.mix
                  .filter((x) => x.n)
                  .map((x) => (
                    <span key={x.key} style={{ flexGrow: x.n, background: STATUS_COLOR[x.key] }} title={`${x.label}: ${x.n} (${Math.round((x.n / m.total) * 100)}%)`} />
                  ))}
              </div>
              <div className="mix-legend">
                {m.mix.map((x) => (
                  <div key={x.key}>
                    <i style={{ background: STATUS_COLOR[x.key] }} />
                    <span className="muted" aria-hidden>
                      {x.icon}
                    </span>
                    {x.label}
                    <b>{x.n}</b>
                    <span className="muted tabnum">{Math.round((x.n / m.total) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="pad muted small">No invoices yet.</div>
          )}
        </section>
        <section className="surface">
          <div className="surface-head">
            <h2>Most frequent exceptions</h2>
            <span className="muted small">invoices affected</span>
          </div>
          <div className="pad bars">
            {m.top.length ? (
              m.top.map(([code, n]) => (
                <div key={code} className="bar" title={`${REASON_LABEL[code]}: ${n}`}>
                  <span>{REASON_LABEL[code]}</span>
                  <span className="bar-track">
                    <span style={{ width: `${(n / m.top[0][1]) * 100}%` }} />
                  </span>
                  <b>{n}</b>
                </div>
              ))
            ) : (
              <span className="muted small">None recorded.</span>
            )}
          </div>
        </section>
      </div>

      <section className="surface">
        <div className="surface-head">
          <h2>Recent activity</h2>
        </div>
        <RunsTable runs={runs} loaded={loaded} from="overview" limit={8} />
      </section>
    </Shell>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
      <div className="stat-s">{s}</div>
    </div>
  );
}
