import { useCallback, useRef, useState } from "react";
import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { SAMPLES, type Sample } from "../data/samples";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { prepareDocument, type PreparedDocument } from "../lib/document";
import { buildLedger, initialStatus, isOpen } from "../lib/engine";
import { checkHealth } from "../lib/llm";
import { runPipeline } from "../lib/pipeline";
import { loadRules } from "../lib/rules";
import { fetchRuns, saveRun } from "../lib/runsApi";
import { ControlStrip, DecisionHeader, DuplicateEvidence, ExtractedData, FindingsList, PoComparison, Tabs, Timeline, VendorComms, VendorEvidence } from "../runView";
import { PageHead, Shell } from "../Shell";
import type { Decision, Explanation, Finding, Invoice, PoMatch, RunRecord, StageState } from "../types";
import { Icon, StatusBadge, resolutionToStatus, useRuns } from "../ui";

type Tab = "findings" | "evidence" | "extracted" | "comms";

export default function Process() {
  const { runs, setRuns } = useRuns();
  const [doc, setDoc] = useState<PreparedDocument | null>(null);
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [showSamples, setShowSamples] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [streaming, setStreaming] = useState("");
  const [result, setResult] = useState<{ poMatch: PoMatch; explanation: Explanation } | null>(null);
  const [saved, setSaved] = useState<RunRecord | null>(null);
  const [tab, setTab] = useState<Tab>("findings");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStages([]);
    setInvoice(null);
    setFindings([]);
    setDecision(null);
    setStreaming("");
    setResult(null);
    setSaved(null);
    setError(null);
    setTab("findings");
  };

  const loadFile = async (file: File, sample: string | null) => {
    reset();
    setPreparing(true);
    setActiveSample(sample);
    try {
      setDoc(await prepareDocument(file));
      if (sample) setShowSamples(false);
    } catch (e) {
      setDoc(null);
      setError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const loadSample = async (s: Sample) => {
    const blob = await (await fetch(`/samples/${s.file}`)).blob();
    await loadFile(new File([blob], s.file, { type: blob.type || (s.file.endsWith(".pdf") ? "application/pdf" : "image/jpeg") }), s.file);
  };

  const run = useCallback(async () => {
    if (!doc) return;
    reset();
    setRunning(true);
    try {
      const health = await checkHealth();
      if (!health.ok) throw new Error(health.reason ?? "AI service not configured");
      const history = await fetchRuns().catch(() => runs);
      const out = await runPipeline(
        doc,
        {
          vendors: VENDORS,
          purchaseOrders: PURCHASE_ORDERS,
          ledger: buildLedger(ERP_LEDGER, history),
          priorSubmissions: history.map((r) => ({ runId: r.id, fileHash: r.fileHash, createdAt: r.createdAt, status: r.status, invoiceNumber: r.invoice.invoiceNumber })),
          rules: loadRules(),
          today: new Date().toISOString().slice(0, 10),
          model: `${health.provider}/${health.model}`,
        },
        {
          onStage: (s) => setStages((prev) => [...prev.filter((p) => p.id !== s.id), s]),
          onInvoice: setInvoice,
          onFindings: setFindings,
          onDecision: setDecision,
          onExplainToken: (t) => setStreaming((p) => p + t),
        },
      );
      setResult({ poMatch: out.poMatch, explanation: out.explanation });
      const rec = await saveRun(out, doc.pageImages[0]);
      setSaved(rec);
      setRuns((p) => [rec, ...p]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [doc, runs, setRuns]);

  const status = saved?.status ?? (decision ? initialStatus(decision.resolution) : null);
  const openCount = runs.filter((r) => isOpen(r.status)).length;

  return (
    <Shell page="process" openCount={openCount}>
      <PageHead title="Process invoice" sub="Upload a vendor invoice. Each control runs live and the decision comes with its evidence." />

      <section className="card">
        <div className="intake">
          <div
            className={`drop ${dragOver ? "drop-on" : ""}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) loadFile(f, null);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f, null);
                e.target.value = "";
              }}
            />
            <div className="drop-title">Drop an invoice PDF or photo</div>
            <div className="small muted">Digital, scanned or handwritten · click to browse</div>
          </div>

          {preparing ? (
            <div className="doc">
              <div className="skeleton doc-thumb" />
              <div className="doc-meta" style={{ flex: 1 }}>
                <div className="skeleton" style={{ height: 16, width: "70%" }} />
                <div className="skeleton" style={{ height: 14, width: "50%" }} />
              </div>
            </div>
          ) : doc ? (
            <div className="doc">
              <a href={doc.pageImages[0]} target="_blank" rel="noreferrer" title="Open full page">
                <img src={doc.pageImages[0]} alt="Invoice preview" className="doc-thumb" />
              </a>
              <div className="doc-meta">
                <div className="doc-name">{doc.fileName}</div>
                <div className="small muted">{doc.hasTextLayer ? "Digital PDF · text layer found" : doc.mimeType === "application/pdf" ? "Scanned PDF · no text layer" : "Image · read visually"}</div>
                <div className="small muted">
                  {doc.pageCount} page{doc.pageCount > 1 ? "s" : ""}
                </div>
              </div>
            </div>
          ) : (
            <div className="doc muted small">No document selected. Drop a file or pick a demo scenario below.</div>
          )}

          <div className="intake-run">
            <button className="btn btn-primary btn-lg" onClick={run} disabled={!doc || running || preparing}>
              {running ? (
                <>
                  <span className="spinner" style={{ borderTopColor: "#fff" }} /> Processing…
                </>
              ) : (
                <>Run process {Icon.arrow}</>
              )}
            </button>
            <div className="small muted" style={{ textAlign: "center" }}>
              8 controls · ~10–40 s
            </div>
          </div>
        </div>
        <div className="samples-bar">
          <button className="link-btn" onClick={() => setShowSamples((s) => !s)}>
            {showSamples ? "▾" : "▸"} Demo scenarios ({SAMPLES.length})
          </button>
          {showSamples && (
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s.file} className={`sample ${activeSample === s.file ? "sample-on" : ""}`} onClick={() => loadSample(s)} disabled={running || preparing}>
                  <div className="row-between">
                    <span className="sample-title">{s.title}</span>
                    <StatusBadge status={resolutionToStatus(s.expect)} />
                  </div>
                  <div className="sample-desc">{s.scenario}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        {error && (
          <div style={{ padding: "0 20px 16px" }}>
            <div className="alert alert-err">
              <strong>Processing error (system, not a business rule):</strong> {error}
            </div>
          </div>
        )}
      </section>

      {stages.length > 0 && (
        <div className="workspace">
          <section className="card">
            <div className="card-head">
              <div className="card-title">Live processing</div>
              <span className="small muted">{running ? "running" : stages.some((s) => s.status === "error") ? "stopped" : "complete"}</span>
            </div>
            <Timeline stages={stages} live={running} />
          </section>

          <section className="card">
            {decision && invoice && status ? (
              <>
                <DecisionHeader
                  status={status}
                  invoice={invoice}
                  decision={decision}
                  findings={findings}
                  vendorName={saved?.vendorMatched ?? null}
                  run={saved ?? undefined}
                  meta={saved ? "Decided by rules engine" : "Writing explanation…"}
                />
                <div style={{ padding: "14px 24px", borderBottom: "1px solid var(--border)" }} className="row-between">
                  <ControlStrip findings={findings} />
                  {saved && (
                    <a className="btn btn-sm" href={`/invoice/${saved.id}?from=process`}>
                      {resolutionToStatus(decision.resolution) === "approved" ? "Open invoice" : "Resolve exception"} {Icon.arrow}
                    </a>
                  )}
                </div>
                <Tabs<Tab>
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: "findings", label: "Decision & findings", count: findings.filter((f) => f.action !== "info").length },
                    { id: "evidence", label: "Validation evidence" },
                    { id: "extracted", label: "Extracted data" },
                    { id: "comms", label: "Vendor communication" },
                  ]}
                />
                <div className="tab-body">
                  {tab === "findings" && <FindingsList findings={findings} run={saved ?? undefined} />}
                  {tab === "evidence" && (
                    <div style={{ display: "grid", gap: 18 }}>
                      <div>
                        <div className="subhead" style={{ marginTop: 0 }}>Invoice vs purchase order</div>
                        {result ? <PoComparison poMatch={result.poMatch} currency={invoice.currency} /> : <div className="skeleton" style={{ height: 80 }} />}
                      </div>
                      <div>
                        <div className="subhead">Vendor identity and bank account</div>
                        <VendorEvidence run={{ invoice, vendorId: saved?.vendorId ?? null, findings }} />
                      </div>
                      {saved && (
                        <div>
                          <div className="subhead">Duplicate check</div>
                          <DuplicateEvidence run={saved} />
                        </div>
                      )}
                    </div>
                  )}
                  {tab === "extracted" && <ExtractedData invoice={invoice} extractionMethod={saved?.extractionMethod} />}
                  {tab === "comms" && <VendorComms explanation={result?.explanation} streaming={streaming} status={status} />}
                </div>
              </>
            ) : (
              <div className="card-pad">
                <div className="card-title" style={{ marginBottom: 12 }}>
                  Decision
                </div>
                <div className="skeleton" style={{ height: 28, width: 160, marginBottom: 12 }} />
                <div className="skeleton" style={{ height: 18, width: "80%", marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 18, width: "60%" }} />
                <div className="small muted" style={{ marginTop: 14 }}>
                  {stages.find((s) => s.status === "running")?.id === "extract" ? "Reading the document…" : "Running controls…"}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
