// Review workspace: master list grouped by what the analyst must DO, detail
// pane with the selected invoice's decision, evidence and resolution.

import { useEffect, useMemo, useState } from "react";
import { ACTION_GROUPS, REASON_LABEL, requiredAction } from "../copy";
import { Investigation } from "../investigation";
import { money } from "../lib/engine";
import { openCodes } from "../lib/review";
import { Shell } from "../Shell";
import { prioritise } from "../tables";
import { SkeletonRows, timeAgo, topFinding, useRuns, useToast } from "../ui";

export default function Queue() {
  const { runs, loaded, replace } = useRuns();
  const [toast, notify] = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("run"));
  const queue = prioritise(runs);
  const groups = useMemo(
    () =>
      ACTION_GROUPS.map((g) => ({ ...g, items: queue.filter((r) => requiredAction(r, openCodes(r)) === g.key) })).filter((g) => g.items.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs],
  );
  useEffect(() => {
    if (!selectedId && queue[0]) setSelectedId(queue[0].id);
  }, [queue, selectedId]);
  const selected = runs.find((r) => r.id === selectedId) ?? null;
  const value = queue.reduce((s, r) => s + (r.invoice.total ?? 0), 0);

  return (
    <Shell page="queue" openCount={queue.length}>
      <div className="ws">
        <aside className="ws-list" aria-label="Open exceptions">
          <div className="ws-list-head">
            <h1 className="display-sm">Review workspace</h1>
            <p className="muted small">
              {queue.length} open · {money(value)} waiting · grouped by the action needed, highest priority first
            </p>
          </div>
          {!loaded ? (
            <SkeletonRows />
          ) : groups.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Queue is clear</div>
              Nothing needs a decision. <a href="/process">Process an invoice →</a>
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key} className="ws-group">
                <div className="ws-group-head">
                  <span>{g.label}</span>
                  <b>{g.items.length}</b>
                </div>
                <div className="ws-group-hint">{g.hint}</div>
                {g.items.map((r) => {
                  const f = topFinding(r);
                  return (
                    <button key={r.id} className={`ws-item ws-${r.status} ${selectedId === r.id ? "on" : ""}`} onClick={() => setSelectedId(r.id)} aria-current={selectedId === r.id}>
                      <span className="ws-item-top">
                        <span className="ws-vendor">{r.vendorMatched ?? r.invoice.vendor}</span>
                        <span className="ws-amt">{money(r.invoice.total, r.invoice.currency)}</span>
                      </span>
                      <span className="ws-item-sub">
                        <span className="mono">{r.invoice.invoiceNumber ?? "—"}</span> · {f ? REASON_LABEL[f.code] : "Review"} · {timeAgo(r.createdAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </aside>
        <section className="ws-detail" aria-live="polite">
          {selected ? (
            <Investigation
              key={selected.id}
              run={selected}
              allRuns={runs}
              embedded
              onUpdated={replace}
              notify={notify}
              breadcrumb={
                <>
                  <span>{queue.find((q) => q.id === selected.id)?.why ?? "Closed case"}</span> · <a href={`/invoice/${selected.id}?from=queue`}>Open with document →</a>
                </>
              }
            />
          ) : (
            <div className="empty">Select an invoice to review.</div>
          )}
        </section>
      </div>
      {toast}
    </Shell>
  );
}
