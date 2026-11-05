import { useState } from "react";
import { money } from "../lib/engine";
import { PageHead, Shell } from "../Shell";
import { AttentionTable, attentionOrder } from "../tables";
import type { CaseStatus } from "../types";
import { useRuns } from "../ui";

type F = "all" | CaseStatus;

export default function Queue() {
  const { runs, loaded } = useRuns();
  const [f, setF] = useState<F>("all");
  const open = attentionOrder(runs);
  const shown = f === "all" ? open : open.filter((r) => r.status === f);
  const count = (s: CaseStatus) => open.filter((r) => r.status === s).length;
  const value = open.reduce((s, r) => s + (r.invoice.total ?? 0), 0);
  return (
    <Shell page="queue" openCount={open.length}>
      <PageHead title="Review queue" sub={`${open.length} unresolved exception${open.length === 1 ? "" : "s"} · ${money(value)} waiting on a decision. Most severe first.`} />
      <section className="card">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Filter queue">
            {(
              [
                ["all", `All open (${open.length})`],
                ["payment_hold", `Payment hold (${count("payment_hold")})`],
                ["needs_review", `Needs review (${count("needs_review")})`],
                ["awaiting_info", `Awaiting vendor (${count("awaiting_info")})`],
              ] as [F, string][]
            ).map(([k, l]) => (
              <button key={k} className={f === k ? "seg-on" : ""} onClick={() => setF(k)}>
                {l}
              </button>
            ))}
          </div>
          <span className="small muted" style={{ marginLeft: "auto" }}>
            Rejected invoices are closed and not shown here.
          </span>
        </div>
        <AttentionTable runs={shown} loaded={loaded} from="queue" />
      </section>
    </Shell>
  );
}
