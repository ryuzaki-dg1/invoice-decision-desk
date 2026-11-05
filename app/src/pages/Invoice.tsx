// Flagship screen: one invoice case, decision first. Original document on the
// left as supporting evidence; decision, evidence and resolution on the right.

import { useState } from "react";
import { isOpen } from "../lib/engine";
import { openCodes } from "../lib/review";
import { AuditTrail, ControlStrip, DecisionHeader, DuplicateEvidence, ExtractedData, FindingsList, PoComparison, ReviewPanel, Tabs, Timeline, VendorComms, VendorEvidence, decidedBy } from "../runView";
import { Shell } from "../Shell";
import { Empty, SkeletonRows, fmtDate, useRuns, useToast } from "../ui";

type Tab = "findings" | "timeline" | "audit" | "comms";
const BACK: Record<string, [string, string]> = {
  queue: ["/queue", "Review queue"],
  history: ["/history", "Invoice history"],
  process: ["/process", "Process invoice"],
  overview: ["/", "Overview"],
};

export default function InvoicePage({ id }: { id: string }) {
  const { runs, loaded, replace } = useRuns();
  const [tab, setTab] = useState<Tab>("findings");
  const [toast, notify] = useToast();
  const run = runs.find((r) => r.id === id);
  const from = new URLSearchParams(window.location.search).get("from") ?? "history";
  const [backHref, backLabel] = BACK[from] ?? BACK.history;
  const openCount = runs.filter((r) => isOpen(r.status)).length;

  if (!loaded || !run) {
    return (
      <Shell page={from === "queue" ? "queue" : "history"} openCount={openCount}>
        <a className="small" href={backHref}>
          ← {backLabel}
        </a>
        <div className="card" style={{ marginTop: 12 }}>
          {loaded ? <Empty title="Invoice not found">It may have been cleared with “Reset demo data”.</Empty> : <SkeletonRows n={6} />}
        </div>
      </Shell>
    );
  }

  const resolved = run.resolvedCodes ?? [];
  const blockingCount = run.findings.filter((f) => f.action !== "info").length;
  return (
    <Shell page={from === "queue" ? "queue" : "history"} openCount={openCount}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <a className="small" href={backHref}>
          ← {backLabel}
        </a>
        <span className="small muted">
          Processed {fmtDate(run.createdAt)} · {run.fileName}
          {run.repeatSubmission ? " · repeat submission" : ""}
        </span>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <DecisionHeader status={run.status} invoice={run.invoice} decision={run.decision} findings={run.findings} vendorName={run.vendorMatched} run={run} meta={<>Decided by {decidedBy(run)}</>} />
        <div style={{ padding: "14px 24px" }}>
          <ControlStrip findings={run.findings} resolved={resolved} />
        </div>
      </section>

      <div className="workspace" style={{ gridTemplateColumns: "minmax(320px, 0.85fr) 1.15fr", marginTop: 0 }}>
        <section className="card">
          <div className="card-head">
            <div className="card-title">Original document</div>
            {run.hasPreview && (
              <a className="small" href={`/api/runs/${run.id}/preview`} target="_blank" rel="noreferrer">
                Open full size
              </a>
            )}
          </div>
          <div className="card-pad">
            {run.hasPreview ? (
              <img src={`/api/runs/${run.id}/preview`} alt={`First page of ${run.fileName}`} style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 6 }} />
            ) : (
              <div className="muted small">No preview stored for this run.</div>
            )}
            <div className="subhead">Extracted fields</div>
            <ExtractedData invoice={run.invoice} extractionMethod={run.extractionMethod} />
            <div className="small muted" style={{ marginTop: 10 }}>
              Highlighted cells are fields the model flagged as uncertain or missing. Source-position highlighting on the page is not supported by this extraction method.
            </div>
          </div>
        </section>

        <div style={{ display: "grid", gap: 16 }}>
          {isOpen(run.status) && (
            <ReviewPanel
              run={run}
              onUpdated={(r) => {
                replace(r);
                notify(`Saved: ${r.audit.at(-1)?.action}`);
              }}
              onError={(m) => notify(m, "err")}
            />
          )}
          <section className="card">
            <div className="card-head">
              <div className="card-title">Evidence</div>
              <span className="small muted">{openCodes(run).length} open control(s)</span>
            </div>
            <div className="card-pad" style={{ display: "grid", gap: 18 }}>
              <div>
                <div className="subhead" style={{ marginTop: 0 }}>Invoice vs purchase order</div>
                <PoComparison poMatch={run.poMatch} currency={run.invoice.currency} />
              </div>
              <div>
                <div className="subhead" style={{ marginTop: 0 }}>Vendor identity and bank account</div>
                <VendorEvidence run={run} />
              </div>
              <div>
                <div className="subhead" style={{ marginTop: 0 }}>Duplicate check</div>
                <DuplicateEvidence run={run} />
              </div>
            </div>
          </section>
          {!isOpen(run.status) && <ReviewPanel run={run} onUpdated={replace} onError={(m) => notify(m, "err")} />}
        </div>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "findings", label: "Rule findings", count: blockingCount },
            { id: "audit", label: "Audit trail", count: run.audit.length },
            { id: "timeline", label: "Processing timeline" },
            { id: "comms", label: "Vendor communication" },
          ]}
        />
        <div className="tab-body">
          {tab === "findings" && <FindingsList findings={run.findings} run={run} resolved={resolved} />}
          {tab === "audit" && <AuditTrail run={run} />}
          {tab === "timeline" && <Timeline stages={run.stages} />}
          {tab === "comms" && <VendorComms explanation={run.explanation} status={run.status} />}
        </div>
      </section>
      {toast}
    </Shell>
  );
}
