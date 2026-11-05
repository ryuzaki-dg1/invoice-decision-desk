import { RotateCcw } from "lucide-react";
import { isOpen } from "../lib/engine";
import { resetRuns } from "../lib/runsApi";
import { Shell } from "../Shell";
import { RunsTable } from "../tables";
import { useRuns, useToast } from "../ui";

export default function History() {
  const { runs, loaded, reload } = useRuns();
  const [toast, notify] = useToast();
  return (
    <Shell page="history" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <header className="page-head">
        <div>
          <h1 className="h1">Invoice history</h1>
          <p className="sub">Every submission and its decision. Open one to see the evidence and audit trail.</p>
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
