import { Investigation } from "../investigation";
import { isOpen } from "../lib/engine";
import { Shell } from "../Shell";
import { Empty, SkeletonRows, useRuns, useToast } from "../ui";

const BACK: Record<string, [string, string]> = {
  queue: ["/queue", "Review queue"],
  history: ["/history", "Invoices"],
  process: ["/process", "Process invoice"],
  overview: ["/", "Overview"],
};

export default function InvoicePage({ id }: { id: string }) {
  const { runs, loaded, replace } = useRuns();
  const [toast, notify] = useToast();
  const run = runs.find((r) => r.id === id);
  const from = new URLSearchParams(window.location.search).get("from") ?? "history";
  const [backHref, backLabel] = BACK[from] ?? BACK.history;
  const page = from === "queue" ? "queue" : from === "overview" ? "overview" : "history";
  const openCount = runs.filter((r) => isOpen(r.status)).length;

  if (!loaded || !run) {
    return (
      <Shell page={page} openCount={openCount}>
        <div className="crumbs">
          <a href={backHref}>{backLabel}</a>
        </div>
        <div className="surface" style={{ marginTop: 12 }}>
          {loaded ? <Empty title="Invoice not found">It may have been cleared with “Reset demo data”.</Empty> : <SkeletonRows n={6} />}
        </div>
      </Shell>
    );
  }
  return (
    <Shell page={page} openCount={openCount}>
      <Investigation
        run={run}
        allRuns={runs}
        onUpdated={replace}
        notify={notify}
        breadcrumb={
          <>
            <a href={backHref}>{backLabel}</a> / <span>{run.invoice.invoiceNumber ?? run.fileName}</span>
          </>
        }
      />
      {toast}
    </Shell>
  );
}
