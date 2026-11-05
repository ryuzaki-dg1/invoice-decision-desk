// Review workspace: compact list of invoices needing action (30%) and the
// selected invoice's decision, evidence and guided resolution (70%).

import { useEffect, useMemo, useState } from "react";
import { CircleCheckBig, Inbox } from "lucide-react";
import { ACTION_GROUPS } from "../copy";
import { Investigation } from "../investigation";
import { money } from "../lib/engine";
import { Shell } from "../Shell";
import { AttentionRow, prioritise } from "../tables";
import { Empty, SkeletonRows, useRuns, useToast } from "../ui";

export default function Queue() {
  const { runs, loaded, replace } = useRuns();
  const [toast, notify] = useToast();
  const [filter, setFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("run"));
  const queue = useMemo(() => prioritise(runs), [runs]);
  const groups = ACTION_GROUPS.map((g) => ({ ...g, n: queue.filter((q) => q.actionKey === g.key).length })).filter((g) => g.n > 0);
  const shown = filter === "all" ? queue : queue.filter((q) => q.actionKey === filter);
  useEffect(() => {
    if (loaded && !selectedId && shown[0]) setSelectedId(shown[0].id);
  }, [loaded, selectedId, shown]);
  const selected = runs.find((r) => r.id === selectedId) ?? null;
  const value = queue.reduce((s, r) => s + (r.invoice.total ?? 0), 0);

  return (
    <Shell page="queue" openCount={queue.length} wide>
      <div className="ws">
        <aside className="ws-list card" aria-label="Invoices requiring action">
          <div className="ws-head">
            <h1 className="h2">Review queue</h1>
            <p className="muted small">
              {queue.length} open · {money(value)} waiting
            </p>
          </div>
          {groups.length > 0 && (
            <div className="chips chips-wrap" role="group" aria-label="Filter by action">
              <button className={`chip ${filter === "all" ? "on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All <span>{queue.length}</span>
              </button>
              {groups.map((g) => (
                <button key={g.key} className={`chip ${filter === g.key ? "on" : ""}`} aria-pressed={filter === g.key} onClick={() => setFilter(g.key)} title={g.hint}>
                  {g.label} <span>{g.n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="ws-items">
            {!loaded ? (
              <SkeletonRows />
            ) : shown.length === 0 ? (
              <Empty icon={<CircleCheckBig size={22} />} title={queue.length ? "Nothing in this filter" : "Queue is clear"}>
                {queue.length ? "Choose another filter." : <a href="/process">Process an invoice</a>}
              </Empty>
            ) : (
              shown.map((r) => <AttentionRow key={r.id} r={r} compact selected={r.id === selectedId} onOpen={() => setSelectedId(r.id)} />)
            )}
          </div>
          <p className="ws-foot muted small">Ordered by severity, then amount, then waiting time.</p>
        </aside>
        <section className="ws-detail" aria-live="polite">
          {selected ? (
            <div className="card ws-card">
              <Investigation key={selected.id} run={selected} allRuns={runs} embedded onUpdated={replace} notify={notify} />
            </div>
          ) : (
            <div className="card">
              <Empty icon={<Inbox size={22} />} title="Select an invoice">
                Pick an item on the left to see what happened and what to do.
              </Empty>
            </div>
          )}
        </section>
      </div>
      {toast}
    </Shell>
  );
}
