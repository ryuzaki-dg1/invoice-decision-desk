import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { DecisionPanel, ExplanationPanel, InvoiceView, StageList, DecisionBadge } from "./components";
import { PURCHASE_ORDERS } from "./data/purchaseOrders";
import { SAMPLES, type Sample } from "./data/samples";
import { ERP_LEDGER, VENDORS } from "./data/vendors";
import { prepareDocument, type PreparedDocument } from "./lib/document";
import { buildLedger, money } from "./lib/engine";
import { checkHealth } from "./lib/llm";
import { runPipeline } from "./lib/pipeline";
import { DEFAULT_RULES, loadRules, saveRules, type Rules } from "./lib/rules";
import { fetchRuns, saveRun } from "./lib/runsApi";
import { Shell } from "./Shell";
import type { Decision, Explanation, Finding, Invoice, PoMatch, ReviewStatus, RunRecord, StageId, StageState } from "./types";

export default function App() {
  const [rules, setRules] = useState<Rules>(() => loadRules());
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [doc, setDoc] = useState<PreparedDocument | null>(null);
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [poMatch, setPoMatch] = useState<PoMatch | undefined>();
  const [streaming, setStreaming] = useState("");
  const [explanation, setExplanation] = useState<Explanation | undefined>();
  const [savedRun, setSavedRun] = useState<RunRecord | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => saveRules(rules), [rules]);
  useEffect(() => {
    fetchRuns().then(setRuns).catch(() => setRuns([]));
  }, []);

  const pending = runs.filter((r) => r.reviewStatus === "pending").length;
  const ledger = useMemo(() => buildLedger(ERP_LEDGER, runs), [runs]);

  const resetRunView = () => {
    setStages([]);
    setInvoice(null);
    setFindings([]);
    setDecision(null);
    setPoMatch(undefined);
    setStreaming("");
    setExplanation(undefined);
    setSavedRun(null);
    setError(null);
  };

  const loadFile = async (file: File, sampleFile: string | null) => {
    resetRunView();
    setPreparing(true);
    setActiveSample(sampleFile);
    try {
      setDoc(await prepareDocument(file));
    } catch (err) {
      setDoc(null);
      setError((err as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const loadSample = async (s: Sample) => {
    const res = await fetch(`/samples/${s.file}`);
    const blob = await res.blob();
    await loadFile(new File([blob], s.file, { type: blob.type || (s.file.endsWith(".pdf") ? "application/pdf" : "image/jpeg") }), s.file);
  };

  const run = useCallback(async () => {
    if (!doc) return;
    resetRunView();
    setRunning(true);
    try {
      const health = await checkHealth();
      if (!health.ok) throw new Error(health.reason ?? "LLM not configured");
      const latestRuns = await fetchRuns().catch(() => runs);
      const result = await runPipeline(
        doc,
        {
          vendors: VENDORS,
          purchaseOrders: PURCHASE_ORDERS,
          ledger: buildLedger(ERP_LEDGER, latestRuns),
          rules,
          today: new Date().toISOString().slice(0, 10),
          model: `${health.provider}/${health.model}`,
        },
        {
          onStage: (s) =>
            setStages((prev) => {
              const others = prev.filter((p) => p.id !== s.id);
              return [...others, s];
            }),
          onInvoice: setInvoice,
          onFindings: setFindings,
          onDecision: setDecision,
          onExplainToken: (t) => setStreaming((prev) => prev + t),
        },
      );
      setPoMatch(result.poMatch);
      setExplanation(result.explanation);
      const reviewStatus: ReviewStatus =
        result.decision.resolution === "AUTO_APPROVE" ? "auto_approved" : result.decision.resolution === "REJECT" ? "rejected" : "pending";
      const saved = await saveRun({ ...result, reviewStatus });
      setSavedRun(saved);
      setRuns((prev) => [saved, ...prev]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [doc, rules, runs]);

  const stageFor = (id: StageId) => stages.find((s) => s.id === id);
  const started = stages.length > 0;

  return (
    <Shell active="process" pending={pending}>
      <div className="process">
        <aside className="left">
          <section className="card">
            <h2>1 · Choose an invoice</h2>
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
              <div className="drop-title">Drop a PDF or photo here</div>
              <div className="muted">digital, scanned or handwritten · or click to browse</div>
            </div>

            <div className="label" style={{ marginTop: 14 }}>
              Demo invoices
            </div>
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s.file} className={`sample ${activeSample === s.file ? "sample-on" : ""}`} onClick={() => loadSample(s)} disabled={running || preparing}>
                  <div className="sample-top">
                    <span className="sample-title">{s.title}</span>
                    <DecisionBadge resolution={s.expect} />
                  </div>
                  <div className="sample-desc">{s.scenario}</div>
                </button>
              ))}
            </div>
          </section>

          <ReferenceData rules={rules} setRules={setRules} ledgerTotals={ledger} />
        </aside>

        <main className="right">
          <section className="card input-card">
            <div className="row-between">
              <h2>2 · Run the process</h2>
              <button className="btn-primary" onClick={run} disabled={!doc || running || preparing}>
                {running ? "Running…" : preparing ? "Reading file…" : "Run ▶"}
              </button>
            </div>
            {doc ? (
              <div className="doc">
                <img src={doc.pageImages[0]} alt="Invoice preview" className="doc-thumb" />
                <div className="doc-meta">
                  <div className="doc-name">{doc.fileName}</div>
                  <div className="muted">
                    {doc.pageCount} page{doc.pageCount > 1 ? "s" : ""} · {doc.hasTextLayer ? "digital PDF (text layer found)" : doc.mimeType === "application/pdf" ? "scanned PDF (no text layer)" : "image"}
                  </div>
                  <a className="link" href={doc.pageImages[0]} target="_blank" rel="noreferrer">
                    Open full page
                  </a>
                </div>
              </div>
            ) : (
              <div className="muted">Pick a demo invoice or drop your own file to begin.</div>
            )}
            {error && <div className="error">{error}</div>}
          </section>

          {started && (
            <div className="run-grid">
              <section className="card">
                <div className="row-between">
                  <h2>Live run</h2>
                  {savedRun && (
                    <a className="link" href={`/dashboard?run=${savedRun.id}`}>
                      Saved · view in dashboard →
                    </a>
                  )}
                </div>
                <StageList stages={stages} live={running} />
              </section>

              <div className="stack">
                {decision ? (
                  <section className="card">
                    <h2>Decision</h2>
                    <DecisionPanel decision={decision} findings={findings} />
                  </section>
                ) : (
                  <section className="card muted-card">
                    <h2>Decision</h2>
                    <div className="muted">{stageFor("extract")?.status === "running" ? "Reading the document…" : "Running checks…"}</div>
                  </section>
                )}
                {(streaming || explanation) && (
                  <section className="card">
                    <h2>Explanation</h2>
                    <ExplanationPanel explanation={explanation} streaming={streaming} />
                  </section>
                )}
                {invoice && (
                  <section className="card">
                    <h2>What was extracted</h2>
                    <InvoiceView invoice={invoice} poMatch={poMatch} />
                  </section>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </Shell>
  );
}

function ReferenceData({ rules, setRules, ledgerTotals }: { rules: Rules; setRules: (r: Rules) => void; ledgerTotals: ReturnType<typeof buildLedger> }) {
  const [open, setOpen] = useState<"po" | "vendors" | "rules" | null>(null);
  const billed = (poId: string) => ledgerTotals.filter((l) => l.poId === poId).reduce((s, l) => s + l.total, 0);
  const num = (k: keyof Rules, label: string, scale = 1, step = 1) => (
    <label className="rule">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={Number(rules[k]) * scale}
        onChange={(e) => setRules({ ...rules, [k]: Number(e.target.value) / scale })}
      />
    </label>
  );
  return (
    <section className="card">
      <h2>Reference data the process checks against</h2>
      <button className="disclosure" onClick={() => setOpen(open === "po" ? null : "po")}>
        {open === "po" ? "▾" : "▸"} Purchase orders ({PURCHASE_ORDERS.length})
      </button>
      {open === "po" && (
        <table className="mini">
          <tbody>
            {PURCHASE_ORDERS.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="mono">{p.id}</div>
                  <div className="muted">{p.vendor}</div>
                </td>
                <td className="num">
                  <div>{money(p.total, p.currency)}</div>
                  <div className="muted">billed {money(billed(p.id), p.currency)}</div>
                </td>
                <td>
                  <span className={`chip chip-${p.status}`}>{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="disclosure" onClick={() => setOpen(open === "vendors" ? null : "vendors")}>
        {open === "vendors" ? "▾" : "▸"} Vendor master ({VENDORS.length})
      </button>
      {open === "vendors" && (
        <table className="mini">
          <tbody>
            {VENDORS.map((v) => (
              <tr key={v.id}>
                <td>
                  <div>{v.name}</div>
                  <div className="muted">aka {v.aliases.join(", ")}</div>
                </td>
                <td className="num muted">
                  {v.bankName}
                  <br />…{v.bankAccount.slice(-4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="disclosure" onClick={() => setOpen(open === "rules" ? null : "rules")}>
        {open === "rules" ? "▾" : "▸"} Policy thresholds
      </button>
      {open === "rules" && (
        <div className="rules">
          {num("amountTolerancePct", "Amount tolerance vs PO (%)", 100, 0.5)}
          {num("priceTolerancePct", "Unit price tolerance (%)", 100, 0.5)}
          {num("quantityTolerance", "Quantity tolerance (units)")}
          {num("arithmeticToleranceAbs", "Arithmetic tolerance ($)", 1, 0.5)}
          {num("duplicateWindowDays", "Same-amount duplicate window (days)")}
          {num("autoApproveLimit", "Auto-approve limit ($)", 1, 1000)}
          <label className="rule">
            <span>Always review handwritten invoices</span>
            <input type="checkbox" checked={rules.reviewHandwritten} onChange={(e) => setRules({ ...rules, reviewHandwritten: e.target.checked })} />
          </label>
          <button className="btn-ghost" onClick={() => setRules(DEFAULT_RULES)}>
            Restore defaults
          </button>
        </div>
      )}
    </section>
  );
}
