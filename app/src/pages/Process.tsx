// Three states: intake → live processing → investigation workspace.

import { useCallback, useRef, useState } from "react";
import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { SAMPLES, type Sample } from "../data/samples";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { DocumentPane, Investigation } from "../investigation";
import { prepareDocument, type PreparedDocument } from "../lib/document";
import { buildLedger, isOpen, money } from "../lib/engine";
import { checkHealth } from "../lib/llm";
import { runPipeline } from "../lib/pipeline";
import { loadRules } from "../lib/rules";
import { fetchRuns, saveRun } from "../lib/runsApi";
import { Timeline } from "../runView";
import { Shell } from "../Shell";
import type { Invoice, RunRecord, StageState } from "../types";
import { Icon, StatusBadge, resolutionToStatus, useRuns, useToast } from "../ui";

export default function Process() {
  const { runs, setRuns, replace } = useRuns();
  const [doc, setDoc] = useState<PreparedDocument | null>(null);
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [streaming, setStreaming] = useState("");
  const [saved, setSaved] = useState<RunRecord | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [toast, notify] = useToast();

  const reset = () => {
    setStages([]);
    setInvoice(null);
    setStreaming("");
    setSaved(null);
    setError(null);
  };

  const loadFile = async (file: File, sample: string | null) => {
    reset();
    setPreparing(true);
    setActiveSample(sample);
    try {
      setDoc(await prepareDocument(file));
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
          onExplainToken: (t) => setStreaming((p) => p + t),
        },
      );
      const rec = await saveRun(out, doc.pageImages[0]);
      setSaved(rec);
      setRuns((p) => [rec, ...p]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [doc, runs, setRuns]);

  const openCount = runs.filter((r) => isOpen(r.status)).length;
  const phase: "intake" | "running" | "done" = saved ? "done" : running || stages.length ? "running" : "intake";

  // ---------- State C: investigation ----------
  if (phase === "done" && saved) {
    return (
      <Shell page="process" openCount={openCount}>
        <Investigation
          run={saved}
          allRuns={runs}
          previewSrc={doc?.pageImages[0]}
          onUpdated={(r) => {
            setSaved(r);
            replace(r);
          }}
          notify={notify}
          breadcrumb={
            <>
              <a href="/history">Invoices</a> / <span>{saved.invoice.invoiceNumber ?? saved.fileName}</span>
            </>
          }
          extraHeader={
            <div className="inv-after">
              <span className="small muted">Just processed in {(saved.durationMs / 1000).toFixed(1)} s</span>
              <button
                className="btn btn-sm"
                onClick={() => {
                  reset();
                  setDoc(null);
                  setActiveSample(null);
                }}
              >
                Process another invoice
              </button>
            </div>
          }
        />
        {toast}
      </Shell>
    );
  }

  // ---------- State B: processing ----------
  if (phase === "running" && doc) {
    const active = stages.find((s) => s.status === "running");
    return (
      <Shell page="process" openCount={openCount}>
        <div className="crumbs">
          <a href="/process">Process invoice</a> / <span>{doc.fileName}</span>
        </div>
        <div className="inv-split" style={{ marginTop: 12 }}>
          <DocumentPane src={doc.pageImages[0]} title={doc.fileName} meta={`${doc.pageCount} page${doc.pageCount > 1 ? "s" : ""} · ${doc.hasTextLayer ? "digital" : "no text layer"}`} />
          <section className="running">
            <div className="eyebrow">{error ? "Stopped" : running ? "Processing" : "Finishing"}</div>
            <h1 className="display-sm">{invoice ? `${invoice.vendor} · ${money(invoice.total, invoice.currency)}` : "Reading the document…"}</h1>
            <p className="muted">{active ? `Now: ${active.summary ?? ""}` : error ? "" : "Saving the decision…"}</p>
            <Timeline stages={stages} live={running} />
            {streaming && (
              <div className="streambox">
                <div className="eyebrow">Explanation (AI, written from the rule findings)</div>
                <pre className="stream">
                  {streaming}
                  <span className="caret">▋</span>
                </pre>
              </div>
            )}
            {error && (
              <div className="alert alert-err" role="alert">
                <strong>System error, not a business rule.</strong> {error}
                <div className="actions" style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={run}>
                    Try again
                  </button>
                  <button className="btn btn-sm" onClick={reset}>
                    Back
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </Shell>
    );
  }

  // ---------- State A: intake ----------
  return (
    <Shell page="process" openCount={openCount}>
      <div className="intake">
        <section className="intake-main">
          <div className="eyebrow">Process invoice</div>
          <h1 className="display">Process an invoice</h1>
          <p className="hero-sub">Each control runs live; the decision comes with its evidence and the next action.</p>
          <div
            className={`dropzone ${dragOver ? "on" : ""} ${doc ? "has-doc" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
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
            {preparing ? (
              <div className="dz-doc">
                <div className="skeleton dz-thumb" />
                <div style={{ flex: 1, display: "grid", gap: 8 }}>
                  <div className="skeleton" style={{ height: 18, width: "60%" }} />
                  <div className="skeleton" style={{ height: 14, width: "40%" }} />
                </div>
              </div>
            ) : doc ? (
              <div className="dz-doc">
                <img src={doc.pageImages[0]} alt="Selected invoice" className="dz-thumb" />
                <div>
                  <div className="dz-name">{doc.fileName}</div>
                  <div className="muted small">
                    {doc.hasTextLayer ? "Digital PDF · text layer found" : doc.mimeType === "application/pdf" ? "Scanned PDF · read from the image" : "Photo / image · read from the image"} · {doc.pageCount} page{doc.pageCount > 1 ? "s" : ""}
                  </div>
                  <div className="link small" style={{ marginTop: 8 }}>
                    Replace file
                  </div>
                </div>
              </div>
            ) : (
              <div className="dz-empty">
                <div className="dz-icon">{Icon.process}</div>
                <div className="dz-title">Drop an invoice here, or click to browse</div>
                <div className="muted small">PDF (digital or scanned) or a photo · up to 3 pages are read</div>
              </div>
            )}
          </div>
          {error && (
            <div className="alert alert-err" role="alert" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
          <div className="intake-go">
            <button className="btn btn-primary btn-xl" onClick={run} disabled={!doc || preparing}>
              Run process {Icon.arrow}
            </button>
            <span className="muted small">8 controls · decision in ~10–40 s</span>
          </div>
        </section>

        <aside className="intake-samples" aria-label="Demo invoices">
          <div className="eyebrow">Or pick a demo invoice</div>
          <ul className="samples">
            {SAMPLES.map((s, i) => (
              <li key={s.file}>
                <button className={`sample ${activeSample === s.file ? "on" : ""}`} onClick={() => loadSample(s)} disabled={preparing}>
                  <span className="sample-n">{i + 1}</span>
                  <span className="sample-body">
                    <span className="sample-title">{s.title}</span>
                    <span className="sample-desc">{s.scenario}</span>
                  </span>
                  <StatusBadge status={resolutionToStatus(s.expect)} />
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Expected outcome shown on the right; each runs through the real pipeline.</p>
        </aside>
      </div>
    </Shell>
  );
}
