import { RotateCcw } from "lucide-react";
import { computeMetrics, openCases } from "../lib/analytics";
import { resetRuns } from "../lib/runsApi";
import { Shell } from "../Shell";
import { RunsTable } from "../tables";
import { useRuns, useToast } from "../ui";

export default function History() {
  const { runs, loaded, reload } = useRuns();
  const [toast, notify] = useToast();
  return (
    <Shell page="history" openCount={openCases(runs).length}>
      <header className="page-head">
        <div>
          <h1 className="h1">Invoice history</h1>
          <p className="sub">
            {(() => {
              const m = computeMetrics(runs);
              return `${m.attempts} processing attempt${m.attempts === 1 ? "" : "s"} for ${m.cases} unique invoice${m.cases === 1 ? "" : "s"}${m.repeatAttempts ? ` · ${m.repeatAttempts} ${m.repeatAttempts === 1 ? "was a repeat upload" : "were repeat uploads"} of an invoice already processed here, so no extra payable was created` : ""}.`;
            })()}
          </p>
        </div>
        <button
          className="btn"
          onClick={async () => {
            if (!confirm("Clear all processed invoices, corrections and reviewer actions? Seeded ERP history (demo data) stays.")) return;
            await resetRuns();
            await reload();
            notify("Demo data reset");
          }}
        >
          <RotateCcw size={15} /> Reset demo data
        </button>
      </header>
      <section className="card">
        <RunsTable runs={runs} loaded={loaded} from="history" />
      </section>
      {toast}
    </Shell>
  );
}
