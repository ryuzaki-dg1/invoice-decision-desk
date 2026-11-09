// Three states: A) intake, B) live processing, C) investigation workspace.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, FileText, Loader2, PenLine, RotateCcw, ScanLine, Sparkles, UploadCloud } from "lucide-react";
import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { SAMPLES, type Sample } from "../data/samples";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { DocumentViewer, Investigation } from "../investigation";
import { prepareDocument, type PreparedDocument } from "../lib/document";
import { buildLedger, money } from "../lib/engine";
import { openCases } from "../lib/analytics";
import { checkHealth } from "../lib/llm";
import { STAGES, runPipeline } from "../lib/pipeline";
import { DEFAULT_RULES } from "../lib/rules";
import { fetchRuns, saveRun } from "../lib/runsApi";
import { Timeline } from "../runView";
import { Shell } from "../Shell";
import type { Invoice, RunRecord, StageState } from "../types";
import { StatusBadge, resolutionToStatus, useRuns, useToast } from "../ui";

// Technical failures are never business decisions: nothing is saved, no
// fields are invented, and the same document can be retried.
function classifyError(msg: string): { title: string; body: string; tone: "warn" | "err" } {
  if (/\b(503|429|500|502|504)\b|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|rate.?limit|Failed to fetch|network/i.test(msg)) {
    return { tone: "warn", title: "AI service temporarily unavailable", body: "The extraction service is busy or unreachable (it already retried with backup models). No decision was made and nothing was saved. Your document is still loaded, so you can retry." };
  }
  if (/JSON|parse|Empty|not configured/i.test(msg)) {
    return { tone: "err", title: "Extraction failed", body: "The document couldn't be read into structured fields. No decision was made and nothing was saved. Retry, or check the file is a readable invoice." };
  }
  if (/not saved/i.test(msg)) {
    return { tone: "err", title: "Decision computed but not saved", body: "The checks ran but the record couldn't be stored. Retry to process and save it again." };
  }
  return { tone: "err", title: "System error, not a business rule", body: "Processing stopped for a technical reason. No decision was made." };
}

const KIND_ICON ={ "Digital PDF": FileText, "Scanned PDF": ScanLine, "Handwritten photo": PenLine };

export default function Process() {
  const { runs, setRuns, replace } = useRuns();
  const [doc, setDoc] = useState<PreparedDocument | null>(null);
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [showDemos, setShowDemos] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [saved, setSaved] = useState<RunRecord | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [toast, notify] = useToast();

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [running]);

  const reset = () => {
    setStages([]);
    setInvoice(null);
    setSaved(null);
    setError(null);
    setStartedAt(null);
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
    setStartedAt(Date.now());
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
          rules: DEFAULT_RULES, // the server re-decides with its own thresholds
          today: new Date().toISOString().slice(0, 10),
          model: `${health.provider}/${health.model}`,
        },
        { onStage: (s) => setStages((p) => [...p.filter((x) => x.id !== s.id), s]), onInvoice: setInvoice },
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

  const openCount = openCases(runs).length;
  const phase: "intake" | "running" | "done" = saved ? "done" : running || stages.length ? "running" : "intake";

  // ---------- C: decision ready ----------
  if (phase === "done" && saved) {
    return (
      <Shell page="process" openCount={openCount} wide>
        <Investigation
          run={saved}
          allRuns={runs}
          previewSrc={doc?.pageImages[0]}
          onUpdated={(r) => (setSaved(r), replace(r))}
          notify={notify}
          breadcrumb={
            <>
              <a href="/process">Process invoice</a>
              <span>/</span>
              <span className="crumb-cur">{saved.invoice.invoiceNumber ?? saved.fileName}</span>
            </>
          }
          headerExtra={
            <div className="inv-tools">
              <button className="btn btn-sm" onClick={() => (reset(), setDoc(null), setActiveSample(null))}>
                <RotateCcw size={14} /> Process another invoice
              </button>
            </div>
          }
        />
        {toast}
      </Shell>
    );
  }

  // ---------- B: processing ----------
  if (phase === "running" && doc) {
    const done = stages.filter((s) => s.endedAt).length;
    const active = stages.find((s) => s.status === "running");
    const activeDef = STAGES.find((d) => d.id === active?.id);
    const elapsed = ((startedAt ? (running ? now : stages.reduce((m, s) => Math.max(m, s.endedAt ?? 0), startedAt)) - startedAt : 0) / 1000).toFixed(1);
    return (
      <Shell page="process" openCount={openCount} wide>
        <div className="crumbs">
          <a href="/process">Process invoice</a>
          <span>/</span>
          <span className="crumb-cur">{doc.fileName}</span>
        </div>
        <div className="inv-split" style={{ marginTop: 16 }}>
          <DocumentViewer src={doc.pageImages[0]} title={doc.fileName} meta={`${doc.pageCount} page${doc.pageCount > 1 ? "s" : ""}`} />
          <section className="card proc">
            <div className="proc-head">
              <div>
                <div className="proc-k">{error ? "Stopped" : running ? "Processing invoice" : "Saving decision"}</div>
                <h1 className="h1">{invoice ? `${invoice.vendor || "Unknown vendor"} · ${money(invoice.total, invoice.currency)}` : "Reading the document"}</h1>
              </div>
              <div className="proc-clock" aria-live="off">
                <b>{elapsed}s</b>
                <small>elapsed</small>
              </div>
            </div>
            <div className="proc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={8} aria-valuenow={done} aria-label="Checks completed">
              <span style={{ width: `${(done / STAGES.length) * 100}%` }} />
            </div>
            <div className="proc-now">
              {running && active ? (
                <>
                  <Loader2 size={16} className="spin" /> <b>{activeDef?.label}</b> <span className="muted">{active.id === "extract" || active.id === "explain" ? "· AI" : "· rules"}</span>
                </>
              ) : (
                <span className="muted">
                  {done} of {STAGES.length} checks complete
                </span>
              )}
            </div>
            <Timeline stages={stages} live={running} />
            {error && (() => {
              const kind = classifyError(error);
              return (
                <div className={`sys-err sys-${kind.tone}`} role="alert">
                  <div className="sys-title">{kind.title}</div>
                  <p>{kind.body}</p>
                  <details>
                    <summary>Technical detail</summary>
                    <code>{error.slice(0, 400)}</code>
                  </details>
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button className="btn btn-primary btn-sm" onClick={run}>
                      <RotateCcw size={14} /> Retry with the same document
                    </button>
                    <button className="btn btn-sm" onClick={reset}>
                      Back
                    </button>
                  </div>
                </div>
              );
            })()}
          </section>
        </div>
      </Shell>
    );
  }

  // ---------- A: intake ----------
  return (
    <Shell page="process" openCount={openCount}>
      <div className="intake">
        <div className="intake-hero">
          <span className="intake-badge">
            <Sparkles size={14} /> AI reads the document · rules make the decision
          </span>
          <h1 className="h-display">Let's process an invoice</h1>
          <p className="sub">Upload a document. We'll extract the details, verify the records, and explain the decision.</p>
        </div>

        <div
          className={`drop ${dragOver ? "on" : ""} ${doc ? "has" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
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
            <div className="drop-doc">
              <div className="skeleton drop-thumb" />
              <div style={{ flex: 1, display: "grid", gap: 8 }}>
                <div className="skeleton" style={{ height: 20, width: "55%" }} />
                <div className="skeleton" style={{ height: 14, width: "35%" }} />
              </div>
            </div>
          ) : doc ? (
            <div className="drop-doc">
              <img src={doc.pageImages[0]} alt="Selected invoice" className="drop-thumb" />
              <div className="drop-meta">
                <div className="drop-name">{doc.fileName}</div>
                <div className="muted">
                  {doc.hasTextLayer ? "Digital PDF · text layer found" : doc.mimeType === "application/pdf" ? "Scanned PDF · will be read from the image" : "Photo · will be read from the image"} · {doc.pageCount} page{doc.pageCount > 1 ? "s" : ""}
                </div>
                <div className="actions" style={{ marginTop: 16 }}>
                  <button className="btn btn-primary btn-lg" onClick={run}>
                    Run process <ArrowRight size={18} />
                  </button>
                  <button className="btn btn-lg" onClick={() => fileInput.current?.click()}>
                    Choose another file
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="drop-empty">
              <span className="drop-icon">
                <UploadCloud size={30} />
              </span>
              <div className="drop-title">Drag & drop an invoice here</div>
              <div className="muted">PDF (digital or scanned), JPG, PNG or WEBP · up to 3 pages are read</div>
              <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                Browse files
              </button>
            </div>
          )}
        </div>
        {error && (
          <div className="alert alert-err" role="alert">
            {error}
          </div>
        )}

        <section className="demos">
          <button className="demos-toggle" aria-expanded={showDemos} onClick={() => setShowDemos((v) => !v)}>
            <span>
              <b>Try a demo invoice</b> <span className="muted">· six realistic scenarios, each runs through the real pipeline</span>
            </span>
            <ChevronDown size={18} className={showDemos ? "rot" : ""} />
          </button>
          {showDemos && (
            <div className="demo-grid">
              {SAMPLES.map((s) => {
                const I = KIND_ICON[s.kind];
                const [vendor] = s.title.split(" · ");
                return (
                  <button key={s.file} className={`demo ${activeSample === s.file ? "on" : ""}`} onClick={() => loadSample(s)} disabled={preparing || running} title={`${s.title}: ${s.scenario}`}>
                    <span className={`demo-icon k-${s.kind.split(" ")[0].toLowerCase()}`}>
                      <I size={18} />
                    </span>
                    <span className="demo-body">
                      <span className="demo-vendor">{s.short}</span>
                      <span className="demo-kind">
                        {s.kind} · {vendor}
                      </span>
                      <span className="demo-desc demo-desc-1">{s.complication}</span>
                      <span className="demo-exp">
                        <span className="muted">Expected</span> <StatusBadge status={resolutionToStatus(s.expect)} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
