import { isOpen } from "../lib/engine";
import { resetRuns } from "../lib/runsApi";
import { PageHead, Shell } from "../Shell";
import { RunsTable } from "../tables";
import { useRuns, useToast } from "../ui";

export default function History() {
  const { runs, loaded, reload } = useRuns();
  const [toast, notify] = useToast();
  return (
    <Shell page="history" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <PageHead
        title="Invoice history"
        sub="Every submission, its current status and full audit trail."
        action={
          <button
            className="btn"
            onClick={async () => {
              if (!confirm("Clear all processed invoices and reviewer actions? Seeded ERP history (demo data) stays.")) return;
              await resetRuns();
              await reload();
              notify("Demo data reset");
            }}
          >
            Reset demo data
          </button>
        }
      />
      <section className="card">
        <RunsTable runs={runs} loaded={loaded} from="history" />
      </section>
      {toast}
    </Shell>
  );
}
