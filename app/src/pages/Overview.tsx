import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, CircleCheckBig, FileText, Inbox, Info, Plus, Wallet, Zap } from "lucide-react";
import { REASON_LABEL, SHORT } from "../copy";
import { buildCases, computeMetrics, type InvoiceCase } from "../lib/analytics";
import { money, statusLabel } from "../lib/engine";
import { Shell } from "../Shell";
import { AttentionRow, go, prioritise } from "../tables";
import { Empty, STATUS_COLOR, SkeletonRows, StatusBadge, fmtDate, fmtSecs, timeAgo, topFinding, useRuns } from "../ui";

const DIST = [
  { key: "approved", label: "Approved" },
  { key: "needs_review", label: "Needs review" },
  { key: "payment_hold", label: "Payment hold" },
  { key: "rejected", label: "Rejected" },
] as const;

function greeting(): string {
  const h = new Date().getHours(); // browser local time
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function Overview() {
  const { runs, loaded } = useRuns();
  const queue = prioritise(runs);
  const m = useMemo(() => computeMetrics(runs), [runs]);
  const cases = useMemo(() => buildCases(runs), [runs]);
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

  return (
    <Shell page="overview" openCount={m.awaiting}>
      <header className="page-head">
        <div>
          <h1 className="h1">{greeting()}, AP team</h1>
          <p className="sub">Here's what needs your attention today.</p>
        </div>
        <a className="btn btn-primary btn-lg" href="/process">
          <Plus size={18} /> Process invoice
        </a>
      </header>

      <About />

      <div className="kpis">
        <Kpi icon={<FileText size={18} />} tone="indigo" label="Unique invoices" value={String(m.cases)} sub={m.repeatAttempts ? `${m.attempts} processing attempts · ${m.repeatAttempts} repeat upload${m.repeatAttempts > 1 ? "s" : ""}` : `${m.attempts} processing attempt${m.attempts === 1 ? "" : "s"}`} />
        <Kpi icon={<Zap size={18} />} tone="teal" label="Straight-through processing" value={pct(m.stpRate)} sub={`${m.autoApproved} of ${m.eligible} eligible invoice${m.eligible === 1 ? "" : "s"} auto-approved`} />
        <Kpi icon={<Inbox size={18} />} tone="amber" label="Awaiting action" value={String(m.awaiting)} sub={m.holds ? `${m.holds} on payment hold` : "invoices in the review queue"} />
        <Kpi icon={<Wallet size={18} />} tone="orange" label="Value requiring intervention" value={money(m.valueRequiringIntervention)} sub="unresolved invoices only" />
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
          <RecentActivity cases={cases} loaded={loaded} />
        </div>

        <section className="card health">
          <div className="card-head">
            <h2 className="h2">Processing health</h2>
          </div>
          <div className="health-body">
            <div className="health-top">
              <div>
                <div className="big">{pct(m.stpRate)}</div>
                <div className="muted small">
                  straight-through · {m.autoApproved}/{m.eligible} eligible
                </div>
              </div>
              <div>
                <div className="big big-2">{m.avgDecisionMs === null ? "—" : fmtSecs(m.avgDecisionMs)}</div>
                <div className="muted small">avg. upload → decision</div>
              </div>
            </div>
            <h3 className="h3">Current status of {m.cases} invoice{m.cases === 1 ? "" : "s"}</h3>
            {m.cases ? (
              <div className="dist">
                {DIST.map((d) => (
                  <div key={d.key} className="dist-row" title={`${d.label}: ${m.byStatus[d.key]}`}>
                    <span className="dist-l">{d.label}</span>
                    <span className="dist-track">
                      <span style={{ width: `${(m.byStatus[d.key] / m.cases) * 100}%`, background: STATUS_COLOR[d.key] }} />
                    </span>
                    <span className="dist-n">{m.byStatus[d.key]}</span>
                    <span className="dist-p">{Math.round((m.byStatus[d.key] / m.cases) * 100)}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No invoices yet.</p>
            )}
            <h3 className="h3">Most common exceptions</h3>
            {m.topExceptions.length ? (
              <ol className="topex">
                {m.topExceptions.map(([c, n]) => (
                  <li key={c}>
                    <span>{REASON_LABEL[c]}</span>
                    <b>{n}</b>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">None recorded.</p>
            )}
            <p className="muted small" style={{ marginTop: 12 }}>
              Straight-through = auto-approved with no human action ÷ unique invoices, excluding resubmissions of invoices already on file.
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}

function About() {
  return (
    <details className="about">
      <summary>
        <Info size={15} aria-hidden /> About this workflow <ChevronDown size={15} className="acc-chev" aria-hidden />
      </summary>
      <dl>
        <div>
          <dt>Built for</dt>
          <dd>Accounts payable teams at mid-sized, PO-driven companies.</dd>
        </div>
        <div>
          <dt>Problem</dt>
          <dd>Checking every invoice against purchase orders, approved vendors and payment history by hand is repetitive and error-prone.</dd>
        </div>
        <div>
          <dt>Approach</dt>
          <dd>AI extracts the invoice. Deterministic rules verify it and decide. People resolve the exceptions, with every step on the audit trail.</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>Invoice validation and decision support. It approves invoices for the payment run; it does not send payments.</dd>
        </div>
      </dl>
    </details>
  );
}

function RecentActivity({ cases, loaded }: { cases: InvoiceCase[]; loaded: boolean }) {
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
      ) : cases.length === 0 ? (
        <Empty title="No activity yet">Processed invoices appear here.</Empty>
      ) : (
        <ul className="feed">
          {cases.slice(0, 6).map((c) => (
            <CaseRow key={c.key} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CaseRow({ c }: { c: InvoiceCase }) {
  const [open, setOpen] = useState(false);
  const r = c.primary;
  const reviewer = [...r.audit].reverse().find((e) => e.kind === "reviewer");
  const repeats = c.attempts.length;
  return (
    <li className="feed-case">
      <div className="feed-row" tabIndex={0} role="link" onClick={() => go(r.id, "overview")} onKeyDown={(e) => e.key === "Enter" && go(r.id, "overview")}>
        <span className="feed-dot" style={{ background: STATUS_COLOR[c.status] }} />
        <span className="feed-text">
          <b>{r.vendorMatched ?? r.invoice.vendor}</b> <span className="mono muted">{r.invoice.invoiceNumber}</span> · {statusLabel(c.status).toLowerCase()} {reviewer ? `by ${reviewer.actor}` : "by rules"}
        </span>
        {repeats > 1 ? (
          <button className="feed-more" onClick={(e) => (e.stopPropagation(), setOpen((v) => !v))} onKeyDown={(e) => e.stopPropagation()} aria-expanded={open} title={`Latest: ${c.latest.repeatSubmission ? "rejected duplicate" : statusLabel(c.latest.status)}`}>
            {repeats} submissions <ChevronDown size={13} className={open ? "rot" : ""} />
          </button>
        ) : (
          <span />
        )}
        <span className="feed-amt">{money(r.invoice.total, r.invoice.currency)}</span>
        <StatusBadge status={c.status} />
        <span className="feed-time">{timeAgo(Math.max(c.latest.createdAt, r.audit.at(-1)?.at ?? 0))}</span>
      </div>
      {open && (
        <ol className="attempts">
          {c.attempts.map((a, i) => {
            const f = topFinding(a);
            return (
              <li key={a.id} tabIndex={0} onClick={() => go(a.id, "overview")} onKeyDown={(e) => e.key === "Enter" && go(a.id, "overview")}>
                <span className="muted">Attempt {i + 1}</span>
                <span>{fmtDate(a.createdAt)}</span>
                <StatusBadge status={a.status} />
                <span className="muted small">{a.repeatSubmission ? "Repeat of an invoice already on file" : f ? SHORT[f.code] ?? REASON_LABEL[f.code] : "All checks passed"}</span>
              </li>
            );
          })}
        </ol>
      )}
    </li>
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
