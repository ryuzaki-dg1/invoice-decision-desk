// The invoice investigation workspace: source document on the left, decision,
// evidence, editable fields and resolution on the right. Used after a live
// run, on the invoice page, and (without the document pane) in the queue.

import { useMemo, useState, type ReactNode } from "react";
import { REASON_LABEL, whyItMatters } from "./copy";
import { PURCHASE_ORDERS } from "./data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "./data/vendors";
import { EvidenceStack } from "./evidence";
import { buildLedger, expectedTotal, fmtPct, isOpen, money, suggestPos } from "./lib/engine";
import { DEFAULT_RULES } from "./lib/rules";
import { submitCorrection } from "./lib/runsApi";
import { AuditTrail, FindingRows, ReviewPanel, Timeline, VendorComms, decidedBy, reasonOf } from "./runView";
import type { Invoice, RunRecord } from "./types";
import { openCodes } from "./lib/review";
import { StatusBadge, fmtDate, useReviewer, useViewMode } from "./ui";

// ---------------- Document pane ----------------

const ZOOMS = [100, 150, 200];

export function DocumentPane({ src, href, title, meta }: { src: string | null; href?: string; title: string; meta: string }) {
  const [zoom, setZoom] = useState(100);
  return (
    <section className="docpane" aria-label="Source document">
      <div className="docpane-bar">
        <div className="docpane-name" title={title}>
          {title}
          <span>{meta}</span>
        </div>
        <div className="zoom" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} className={zoom === z ? "on" : ""} onClick={() => setZoom(z)}>
              {z === 100 ? "Fit" : `${z}%`}
            </button>
          ))}
        </div>
        {href && (
          <a className="btn btn-sm btn-ghost" href={href} target="_blank" rel="noreferrer">
            Open original
          </a>
        )}
      </div>
      <div className="docpane-view">{src ? <img src={src} alt={`Page 1 of ${title}`} style={{ width: `${zoom}%` }} /> : <div className="muted small" style={{ padding: 24 }}>No page image stored for this run.</div>}</div>
    </section>
  );
}

// ---------------- Fields: review + correction ----------------

type Draft = {
  invoiceNumber: string;
  issueDate: string;
  poReference: string;
  subtotal: string;
  tax: string;
  shipping: string;
  discount: string;
  total: string;
  lines: { quantity: string; unitPrice: string; total: string }[];
};

const s = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(v));
function toDraft(inv: Invoice): Draft {
  return {
    invoiceNumber: s(inv.invoiceNumber),
    issueDate: s(inv.issueDate),
    poReference: s(inv.poReference),
    subtotal: s(inv.subtotal),
    tax: s(inv.tax),
    shipping: s(inv.shipping),
    discount: s(inv.discount),
    total: s(inv.total),
    lines: inv.lineItems.map((l) => ({ quantity: s(l.quantity), unitPrice: s(l.unitPrice), total: s(l.total) })),
  };
}

function FieldsPanel({ run, onUpdated, onError, editOpen, setEditOpen, draftPatch }: { run: RunRecord; onUpdated: (r: RunRecord) => void; onError: (m: string) => void; editOpen: boolean; setEditOpen: (b: boolean) => void; draftPatch?: Partial<Draft> | null }) {
  const inv = run.invoice;
  const c = inv.currency;
  const [reviewer, setReviewer] = useReviewer();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({ ...toDraft(inv), ...(draftPatch ?? {}) }));
  const [lastKey, setLastKey] = useState(run.audit.length + JSON.stringify(draftPatch ?? {}));
  const key = run.audit.length + JSON.stringify(draftPatch ?? {});
  if (key !== lastKey) {
    setLastKey(key);
    setDraft({ ...toDraft(inv), ...(draftPatch ?? {}) });
  }

  const low = new Set(inv.lowConfidenceFields.map((f) => f.split(/[.[]/)[0]));
  const lowExact = new Set(inv.lowConfidenceFields);
  const corrected = new Set((run.corrections ?? []).flatMap((x) => x.changes.map((ch) => ch.field)));
  const needsConfirm = (inv.documentType !== "digital" || inv.lowConfidenceFields.length > 0) && run.findings.some((f) => (f.code === "HANDWRITTEN_DOCUMENT" || f.code === "LOW_EXTRACTION_CONFIDENCE") && f.action !== "info") && !(run.resolvedCodes ?? []).includes("HANDWRITTEN_DOCUMENT");
  const exp = expectedTotal(inv);
  const totalOff = exp !== null && inv.total !== null && Math.abs(inv.total - exp) > 1;
  const canEdit = isOpen(run.status);

  const state = (field: string, value: unknown, opts: { inconsistent?: boolean } = {}): { cls: string; tag?: string } => {
    if (value === null || value === undefined || value === "") return { cls: "fv-missing", tag: "missing" };
    if (opts.inconsistent) return { cls: "fv-bad", tag: "doesn't add up" };
    if (corrected.has(field)) return { cls: "fv-fixed", tag: "corrected" };
    if (lowExact.has(field) || low.has(field.split(/[.[]/)[0])) return { cls: "fv-low", tag: "model unsure" };
    if (needsConfirm) return { cls: "fv-unconf", tag: "unconfirmed" };
    return { cls: "" };
  };
  const Cell = ({ field, label, value, display, inconsistent }: { field: string; label: string; value: unknown; display?: ReactNode; inconsistent?: boolean }) => {
    const st = state(field, value, { inconsistent });
    return (
      <div className={`fv ${st.cls}`}>
        <span className="fv-k">
          {label}
          {st.tag && <em>{st.tag}</em>}
        </span>
        <span className="fv-v">{display ?? (value === null || value === undefined || value === "" ? "—" : String(value))}</span>
      </div>
    );
  };

  const save = async () => {
    setBusy(true);
    try {
      const updated = await submitCorrection(run.id, {
        reviewer,
        reason,
        invoice: {
          invoiceNumber: draft.invoiceNumber || null,
          issueDate: draft.issueDate || null,
          poReference: draft.poReference || null,
          subtotal: draft.subtotal === "" ? null : Number(draft.subtotal),
          tax: Number(draft.tax || 0),
          shipping: Number(draft.shipping || 0),
          discount: Number(draft.discount || 0),
          total: draft.total === "" ? null : Number(draft.total),
          lineItems: draft.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), total: Number(l.total) })),
        },
      });
      setReason("");
      setEditOpen(false);
      onUpdated(updated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Live preview of the arithmetic while editing (the server re-checks on save).
  const dn = (v: string) => (v === "" ? 0 : Number(v));
  const draftExp = dn(draft.subtotal) + dn(draft.tax) + dn(draft.shipping) - dn(draft.discount) + (inv.otherCharges || 0);
  const draftLineSum = draft.lines.reduce((a, l) => a + dn(l.total), 0);
  const draftOk = Math.abs(draftExp - dn(draft.total)) <= 1 && (!draft.lines.length || Math.abs(draftLineSum - dn(draft.subtotal)) <= 1);
  const inp = (k: keyof Omit<Draft, "lines">, label: string, type = "text") => (
    <label className={`ef ${lowExact.has(k) || low.has(k) ? "ef-low" : ""}`}>
      <span>{label}</span>
      <input className="input" type={type} inputMode={type === "text" ? undefined : "decimal"} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </label>
  );

  return (
    <section className="block" id="fields">
      <div className="block-head">
        <h3>Extracted fields</h3>
        <span className="small muted">
          {run.extractionMethod} · {inv.documentType}
          {run.corrections?.length ? ` · ${run.corrections.length} correction${run.corrections.length > 1 ? "s" : ""}` : ""}
        </span>
        {canEdit && !editOpen && (
          <button className="btn btn-sm" onClick={() => setEditOpen(true)}>
            Correct fields
          </button>
        )}
      </div>

      {!editOpen ? (
        <>
          <div className="fgrid">
            <Cell field="invoiceNumber" label="Invoice no." value={inv.invoiceNumber} />
            <Cell field="issueDate" label="Date" value={inv.issueDate} />
            <Cell field="poReference" label="PO reference" value={inv.poReference ?? ""} display={inv.poReference ?? <span className="muted">not printed</span>} />
            <Cell field="subtotal" label="Subtotal" value={inv.subtotal} display={money(inv.subtotal, c)} />
            <Cell field="tax" label="Tax" value={inv.tax} display={money(inv.tax, c)} />
            <Cell field="total" label="Total" value={inv.total} display={money(inv.total, c)} inconsistent={totalOff} />
          </div>
          <table className="dense lines">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lineItems.map((l, i) => {
                const off = Math.abs(l.quantity * l.unitPrice - l.total) > 1;
                const cls = (f: string) => state(`lineItems[${i}].${f}`, (l as unknown as Record<string, unknown>)[f], { inconsistent: off && f === "total" }).cls;
                return (
                  <tr key={i}>
                    <td>{l.description}</td>
                    <td className={`num ${cls("quantity")}`}>{l.quantity}</td>
                    <td className={`num ${cls("unitPrice")}`}>{money(l.unitPrice, c)}</td>
                    <td className={`num ${cls("total")}`}>{money(l.total, c)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="legend-row">
            <span>
              <i className="lg lg-missing" /> missing
            </span>
            <span>
              <i className="lg lg-bad" /> inconsistent
            </span>
            <span>
              <i className="lg lg-low" /> model unsure (self-reported, not a score)
            </span>
            <span>
              <i className="lg lg-unconf" /> not yet confirmed by a reviewer
            </span>
            <span>
              <i className="lg lg-fixed" /> corrected
            </span>
          </div>
          {run.originalInvoice && run.corrections?.length ? (
            <details className="more">
              <summary>Original extraction vs current ({run.corrections.flatMap((x) => x.changes).length} changes)</summary>
              <table className="dense">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Model read</th>
                    <th>Corrected to</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {run.corrections.flatMap((x) =>
                    x.changes.map((ch, j) => (
                      <tr key={`${x.at}-${j}`}>
                        <td className="mono">{ch.field}</td>
                        <td className="tabnum">{ch.from}</td>
                        <td className="tabnum t-ok">{ch.to}</td>
                        <td className="small">
                          {x.reviewer}, {fmtDate(x.at)}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </details>
          ) : null}
        </>
      ) : (
        <div className="editor">
          <p className="small muted" style={{ marginTop: 0 }}>
            Type what the document actually says. Saving re-runs every check (arithmetic, vendor, PO, duplicates, price, quantity, cumulative billing). Vendor and bank account are not editable.
          </p>
          <div className="egrid">
            {inp("invoiceNumber", "Invoice no.")}
            {inp("issueDate", "Date (yyyy-mm-dd)")}
            {inp("poReference", "PO reference")}
          </div>
          <table className="dense elines">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lineItems.map((l, i) => (
                <tr key={i}>
                  <td>{l.description}</td>
                  {(["quantity", "unitPrice", "total"] as const).map((f) => (
                    <td key={f} className={lowExact.has(`lineItems[${i}].${f}`) ? "ef-low" : ""}>
                      <input
                        className="input input-num"
                        inputMode="decimal"
                        aria-label={`Line ${i + 1} ${f}`}
                        value={draft.lines[i]?.[f] ?? ""}
                        onChange={(e) => {
                          const lines = draft.lines.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x));
                          setDraft({ ...draft, lines });
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="egrid egrid-4">
            {inp("subtotal", "Subtotal", "number")}
            {inp("tax", "Tax", "number")}
            {inp("shipping", "Freight", "number")}
            {inp("discount", "Discount", "number")}
            {inp("total", "Total", "number")}
            <div className={`ecalc ${draftOk ? "t-ok" : "t-bad"}`}>
              Lines {money(draftLineSum, c)} · expected {money(draftExp, c)} · {draftOk ? "reconciles" : "does not reconcile"}
            </div>
          </div>
          <div className="resolve-fields" style={{ marginTop: 12 }}>
            <input className="input" aria-label="Reviewer name" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" />
            <input className="input" aria-label="Reason for correction" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. labour amount reads 1850 on the photo" />
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !reviewer.trim() || reason.trim().length < 5} onClick={save}>
              {busy ? "Re-running checks…" : "Save corrections & re-run checks"}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- PO suggestions ----------------

function PoSuggestions({ run, allRuns, onUse }: { run: RunRecord; allRuns: RunRecord[]; onUse: (poId: string) => void }) {
  const vendor = VENDORS.find((v) => v.id === run.vendorId) ?? null;
  const list = useMemo(() => suggestPos(run.invoice, vendor, PURCHASE_ORDERS, buildLedger(ERP_LEDGER, allRuns.filter((r) => r.id !== run.id)), { ...DEFAULT_RULES, ...(run.rules ?? {}) }), [run, vendor, allRuns]);
  if (!vendor || run.poMatch.method === "explicit" || !list.length) return null;
  return (
    <section className="block">
      <div className="block-head">
        <h3>PO suggestions</h3>
        <span className="small muted">No PO printed. Ranked by vendor, amount and lines; none is applied without a reviewer.</span>
      </div>
      <div className="sugg">
        {list.slice(0, 3).map((sg, i) => (
          <div key={sg.poId} className={`sugg-row ${i === 0 ? "sugg-top" : ""}`}>
            <div>
              <div className="sugg-id">
                {sg.poId} {run.poMatch.po?.id === sg.poId && <span className="tag tag-warn">engine's suggestion</span>}
              </div>
              <ul>
                {sg.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                {!sg.withinValue && <li className="t-bad">Invoice exceeds the open value</li>}
              </ul>
            </div>
            <div className="sugg-fit">
              <span className="tabnum">{sg.amountFitPct}%</span>
              <small>amount fit</small>
            </div>
            {isOpen(run.status) && (
              <button className="btn btn-sm" onClick={() => onUse(sg.poId)}>
                Use as PO reference
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------- Investigation ----------------

export function Investigation({
  run,
  allRuns,
  previewSrc,
  breadcrumb,
  embedded,
  onUpdated,
  notify,
  extraHeader,
}: {
  run: RunRecord;
  allRuns: RunRecord[];
  previewSrc?: string | null;
  breadcrumb?: ReactNode;
  embedded?: boolean;
  onUpdated: (r: RunRecord) => void;
  notify: (m: string, kind?: "ok" | "err") => void;
  extraHeader?: ReactNode;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [poPatch, setPoPatch] = useState<string | null>(null);
  const [view, setView] = useViewMode();
  const detailed = view === "detailed";
  const open = openCodes(run);
  // Decision view still shows the fields when the job is about the fields.
  const fieldsMatter = editOpen || open.some((c) => ["HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE", "ARITHMETIC_MISMATCH", "MISSING_FIELD"].includes(c));
  const poMatters = open.some((c) => ["PO_MATCH_UNCONFIRMED", "MISSING_PO_REFERENCE", "UNKNOWN_PO"].includes(c));
  const reason = reasonOf(run);
  const lastReview = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  const closedByReviewer = lastReview && (run.status === "approved" || run.status === "rejected");
  const src = previewSrc ?? (run.hasPreview ? `/api/runs/${run.id}/preview` : null);
  const resolved = run.resolvedCodes ?? [];
  const otherFindings = run.findings.filter((f) => f !== reason);
  const b = run.poMatch.billing;
  const updated = (r: RunRecord) => {
    onUpdated(r);
    const last = r.audit.at(-1);
    notify(last?.action.startsWith("Corrected") ? `Re-validated: now ${r.decision.headline}` : `Saved: ${last?.action}`);
  };

  const right = (
    <div className="inv-right">
      {/* Decision */}
      <section className={`decision dec-${run.status}`}>
        {closedByReviewer ? (
          <>
            <div className="dec-what">
              {lastReview!.action} by {lastReview!.actor}
            </div>
            <div className="dec-why">“{lastReview!.note}”</div>
            <div className="dec-next">
              <span className="eyebrow">Original automated decision</span>
              {run.decision.headline}. {run.status === "approved" ? "Now eligible for the payment run; not yet paid." : "Closed; no payable created."}
            </div>
          </>
        ) : (
          <>
            <div className="dec-what">{run.status === "approved" ? "All mandatory checks passed" : reason ? reason.title : run.decision.headline}</div>
            {reason && run.status !== "approved" && <div className="dec-why">{whyItMatters(reason.code, run)}</div>}
            {run.status === "approved" && b && (
              <div className="dec-why">
                Totals reconcile · vendor and bank verified · {fmtPct(b.poTotal ? (b.billedAfter - b.poTotal) / b.poTotal : 0)} vs PO (tolerance {fmtPct(b.tolerancePct, false)}) · no duplicate
              </div>
            )}
            <div className="dec-next">
              <span className="eyebrow">{run.status === "approved" ? "Next" : "Required action"}</span>
              {run.decision.nextAction}
            </div>
          </>
        )}
      </section>

      {/* Evidence */}
      <section className="block">
        <div className="block-head">
          <h3>Evidence</h3>
          {!detailed && <span className="small muted">Most relevant comparison · Detailed view shows all</span>}
        </div>
        <EvidenceStack run={run} limit={detailed ? undefined : 1} />
      </section>

      {(detailed || poMatters) && (
        <PoSuggestions
          run={run}
          allRuns={allRuns}
          onUse={(poId) => {
            setPoPatch(poId);
            setEditOpen(true);
            document.getElementById("fields")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
      )}

      {(detailed || fieldsMatter) && <FieldsPanel run={run} onUpdated={updated} onError={(m) => notify(m, "err")} editOpen={editOpen} setEditOpen={setEditOpen} draftPatch={poPatch ? { poReference: poPatch } : null} />}

      <section className="block">
        <ReviewPanel run={run} onUpdated={updated} onError={(m) => notify(m, "err")} />
      </section>

      {!detailed && (
        <button className="link-btn more-link" onClick={() => setView("detailed")}>
          Show full evidence, all {run.findings.length} rule findings, extracted fields, processing log and audit trail →
        </button>
      )}

      {detailed && otherFindings.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h3>All rule findings</h3>
            <span className="small muted">{run.findings.filter((f) => f.action !== "info").length} blocking · {run.findings.filter((f) => f.action === "info").length} recorded</span>
          </div>
          <FindingRows findings={run.findings} run={run} resolved={resolved} />
        </section>
      )}

      {detailed && (
        <>
          <details className="more">
            <summary>Vendor communication</summary>
            <VendorComms explanation={run.explanation} status={run.status} />
          </details>
          <details className="more">
            <summary>
              Processing activity · 8 steps · {(run.durationMs / 1000).toFixed(1)} s
            </summary>
            <Timeline stages={run.stages} compact />
          </details>
          <details className="more" open={run.audit.length > 1}>
            <summary>Audit trail · {run.audit.length + 1} events</summary>
            <AuditTrail run={run} />
          </details>
        </>
      )}
    </div>
  );

  const toggle = (
    <div className="seg view-toggle" role="group" aria-label="View">
      <button className={!detailed ? "on" : ""} aria-pressed={!detailed} onClick={() => setView("decision")}>
        Decision view
      </button>
      <button className={detailed ? "on" : ""} aria-pressed={detailed} onClick={() => setView("detailed")}>
        Detailed view
      </button>
    </div>
  );

  return (
    <div className={`inv ${embedded ? "inv-embedded" : ""}`}>
      <header className="inv-head">
        <div className="row-between">
          {breadcrumb ? <div className="crumbs">{breadcrumb}</div> : <span />}
          {toggle}
        </div>
        <div className="inv-title-row">
          <div>
            <h1 className="inv-vendor">{run.vendorMatched ?? (run.invoice.vendor || "Unknown vendor")}</h1>
            <div className="inv-meta">
              <span className="mono">{run.invoice.invoiceNumber ?? "no invoice no."}</span>
              <span>Processed {fmtDate(run.createdAt)}</span>
              <span>
                {run.poMatch.po ? (
                  <>
                    <span className="mono">{run.poMatch.po.id}</span> {run.poMatch.method === "inferred" ? "(suggested)" : ""}
                  </>
                ) : (
                  "No PO"
                )}
              </span>
              <span>Decided by {decidedBy(run)}</span>
              {run.repeatSubmission && <span className="tag tag-warn">repeat submission</span>}
            </div>
          </div>
          <div className="inv-amount">
            <div className="amount">{money(run.invoice.total, run.invoice.currency)}</div>
            <StatusBadge status={run.status} large />
          </div>
        </div>
        {extraHeader}
        {detailed && reason && !closedByReviewer && run.status !== "approved" && (
          <div className="inv-reason">
            <span className="eyebrow">Why it was stopped</span> {REASON_LABEL[reason.code]}: {reason.detail}
          </div>
        )}
      </header>
      {embedded ? (
        right
      ) : (
        <div className="inv-split">
          <DocumentPane src={src} href={run.hasPreview ? `/api/runs/${run.id}/preview` : undefined} title={run.fileName} meta={`${run.pageCount} page${run.pageCount > 1 ? "s" : ""} · ${run.invoice.documentType}`} />
          {right}
        </div>
      )}
    </div>
  );
}
