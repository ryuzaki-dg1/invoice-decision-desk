// Invoice investigation workspace. Document on the left (40%), decision,
// evidence and guided resolution on the right (60%). The queue uses the same
// workspace without the document pane (document opens in a viewer instead).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Ban, BadgeCheck, Check, CircleDashed, ClipboardCheck, ExternalLink, FileSearch, History, Landmark, Lock, MapPin, MessageSquareText, PauseCircle, PencilLine, ShieldCheck, TriangleAlert, X, ZoomIn, ZoomOut } from "lucide-react";
import { attemptKind, deriveControls, invoiceChecks, paymentReadiness, PASS_TEXT, type ControlAction } from "./lib/controls";
import { locate, type LocateKind } from "./lib/locate";
import { REASON_LABEL, SHORT, nextStep, requiredAction } from "./copy";
import { PURCHASE_ORDERS } from "./data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "./data/vendors";
import { EvidenceStack } from "./evidence";
import { buildLedger, expectedTotal, isOpen, money, statusLabel, suggestPos } from "./lib/engine";
import { DEFAULT_RULES } from "./lib/rules";
import { NEEDS_CORRECTION, availableActions, openCodes, type ActionOption, type ReviewActionId } from "./lib/review";
import { submitCorrection, submitReview } from "./lib/runsApi";
import { AuditTrail, Findings, Timeline, VendorComms, decidedBy } from "./runView";
import type { Invoice, RunRecord, TextBox } from "./types";
import { Attribution, Modal, StatusBadge, fmtDate, fmtSecs, useDensity, useReviewer } from "./ui";

// ---------------- Document viewer ----------------

export interface Highlight {
  label: string;
  boxes: TextBox[];
  note?: string; // shown when the value can't be located
}

export function DocumentViewer({ src, href, title, meta, sticky = true, highlight, onClearHighlight }: { src: string | null; href?: string; title: string; meta: string; sticky?: boolean; highlight?: Highlight | null; onClearHighlight?: () => void }) {
  const [zoom, setZoom] = useState(100);
  const firstBox = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    firstBox.current?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, [highlight, zoom]);
  return (
    <section className={`doc ${sticky ? "doc-sticky" : ""}`} aria-label="Original invoice">
      {highlight && (
        <div className={`doc-hl ${highlight.boxes.length ? "" : "doc-hl-none"}`} role="status">
          {highlight.boxes.length ? (
            <>
              <MapPin size={14} /> Showing <b>{highlight.label}</b> on the page{highlight.boxes.length > 1 ? ` · ${highlight.boxes.length} matches` : ""}
            </>
          ) : (
            <>
              <MapPin size={14} /> {highlight.note ?? `Couldn't locate “${highlight.label}” in the document's text. Compare visually.`}
            </>
          )}
          {onClearHighlight && (
            <button className="icon-btn" aria-label="Clear highlight" onClick={onClearHighlight}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
      <div className="doc-bar">
        <div className="doc-name" title={title}>
          <b>{title}</b>
          <span>{meta}</span>
        </div>
        <div className="doc-tools">
          <button className="icon-btn" aria-label="Zoom out" disabled={zoom <= 100} onClick={() => setZoom((z) => Math.max(100, z - 25))}>
            <ZoomOut size={16} />
          </button>
          <span className="zoom-val">{zoom}%</span>
          <button className="icon-btn" aria-label="Zoom in" disabled={zoom >= 250} onClick={() => setZoom((z) => Math.min(250, z + 25))}>
            <ZoomIn size={16} />
          </button>
          {href && (
            <a className="icon-btn" href={href} target="_blank" rel="noreferrer" aria-label="Open full document" title="Open full document">
              <ExternalLink size={16} />
            </a>
          )}
        </div>
      </div>
      <div className="doc-view">
        {src ? (
          <div className="doc-page" style={{ width: `${zoom}%` }}>
            <img src={src} alt={`Page 1 of ${title}`} />
            {highlight?.boxes.map((b, i) => (
              <span
                key={i}
                ref={i === 0 ? firstBox : undefined}
                className="hl-box"
                style={{ left: `${b.x * 100 - 0.4}%`, top: `${b.y * 100 - 0.3}%`, width: `${b.w * 100 + 0.8}%`, height: `${b.h * 100 + 0.6}%` }}
                title={b.s}
              />
            ))}
          </div>
        ) : (
          <p className="muted small">No page image stored for this run.</p>
        )}
      </div>
    </section>
  );
}

// Builds a highlight from the run's stored text positions (digital PDFs only).
export function locateField(run: RunRecord, label: string, kind: LocateKind, value: string | number | null | undefined): Highlight {
  if (!run.textBoxes?.length) {
    return { label, boxes: [], note: `This ${run.invoice.documentType} document has no text layer, so exact positions aren't available. Compare “${label}” against the page.` };
  }
  return { label, boxes: locate(run.textBoxes, kind, value) };
}

// ---------------- Fields: review + correction ----------------

type Draft = { invoiceNumber: string; issueDate: string; poReference: string; subtotal: string; tax: string; shipping: string; discount: string; total: string; lines: { quantity: string; unitPrice: string; total: string }[] };
const s = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(v));
const toDraft = (inv: Invoice): Draft => ({
  invoiceNumber: s(inv.invoiceNumber),
  issueDate: s(inv.issueDate),
  poReference: s(inv.poReference),
  subtotal: s(inv.subtotal),
  tax: s(inv.tax),
  shipping: s(inv.shipping),
  discount: s(inv.discount),
  total: s(inv.total),
  lines: inv.lineItems.map((l) => ({ quantity: s(l.quantity), unitPrice: s(l.unitPrice), total: s(l.total) })),
});

function FieldsPanel({
  run,
  editing,
  setEditing,
  patch,
  onSaved,
  onError,
  onLocate,
  selected,
}: {
  run: RunRecord;
  editing: boolean;
  setEditing: (b: boolean) => void;
  patch?: Partial<Draft> | null;
  onSaved: (r: RunRecord) => void;
  onError: (m: string) => void;
  onLocate?: (field: string, label: string, kind: LocateKind, value: string | number | null) => void;
  selected?: string | null;
}) {
  const inv = run.invoice;
  const c = inv.currency;
  const [reviewer, setReviewer] = useReviewer();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({ ...toDraft(inv), ...(patch ?? {}) }));
  const key = run.audit.length + JSON.stringify(patch ?? {});
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setDraft({ ...toDraft(inv), ...(patch ?? {}) });
  }
  const low = new Set(inv.lowConfidenceFields.map((f) => f.split(/[.[]/)[0]));
  const lowExact = new Set(inv.lowConfidenceFields);
  const corrected = new Set((run.corrections ?? []).flatMap((x) => x.changes.map((ch) => ch.field)));
  const unconfirmed = run.findings.some((f) => (f.code === "HANDWRITTEN_DOCUMENT" || f.code === "LOW_EXTRACTION_CONFIDENCE") && f.action !== "info") && !(run.resolvedCodes ?? []).includes("HANDWRITTEN_DOCUMENT");
  const exp = expectedTotal(inv);
  const totalOff = exp !== null && inv.total !== null && Math.abs(inv.total - exp) > 1;

  const state = (field: string, value: unknown, bad?: boolean): [string, string?] => {
    if (value === null || value === undefined || value === "") return ["fv-missing", "Missing"];
    if (bad) return ["fv-bad", "Doesn't add up"];
    if (corrected.has(field)) return ["fv-fixed", "Corrected"];
    if (lowExact.has(field) || low.has(field.split(/[.[]/)[0])) return ["fv-low", "AI unsure"];
    if (unconfirmed) return ["fv-unconf", "Unconfirmed"];
    return [""];
  };
  const Cell = ({ field, label, value, shown, bad, kind }: { field: string; label: string; value: unknown; shown?: ReactNode; bad?: boolean; kind?: LocateKind }) => {
    const [cls, tag] = state(field, value, bad);
    const can = !!onLocate && kind && value !== null && value !== undefined && value !== "";
    const go = () => can && onLocate!(field, label, kind!, value as string | number);
    return (
      <div
        className={`fv ${cls} ${can ? "fv-loc" : ""} ${selected === field ? "fv-sel" : ""}`}
        role={can ? "button" : undefined}
        tabIndex={can ? 0 : undefined}
        title={can ? "Show where this appears in the document" : undefined}
        onClick={go}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      >
        <span className="fv-k">
          {label} {tag && <em>{tag}</em>}
          {can && <MapPin size={12} className="fv-pin" aria-hidden />}
        </span>
        <span className="fv-v">{shown ?? (value === null || value === undefined || value === "" ? "—" : String(value))}</span>
      </div>
    );
  };

  const dn = (v: string) => (v === "" ? 0 : Number(v));
  const draftExp = dn(draft.subtotal) + dn(draft.tax) + dn(draft.shipping) - dn(draft.discount) + (inv.otherCharges || 0);
  const draftLines = draft.lines.reduce((a, l) => a + dn(l.total), 0);
  const draftOk = Math.abs(draftExp - dn(draft.total)) <= 1 && (!draft.lines.length || Math.abs(draftLines - dn(draft.subtotal)) <= 1);
  const inp = (k: keyof Omit<Draft, "lines">, label: string, num?: boolean) => (
    <label className={`ef ${lowExact.has(k) || low.has(k) ? "ef-low" : ""}`}>
      <span>{label}</span>
      <input className={`input ${num ? "input-num" : ""}`} inputMode={num ? "decimal" : undefined} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </label>
  );
  const save = async () => {
    setBusy(true);
    try {
      const r = await submitCorrection(run.id, {
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
      setEditing(false);
      onSaved(r);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sec" id="fields">
      <div className="sec-head">
        <h3>Extracted data</h3>
        <Attribution kind="ai">{run.extractionMethod}</Attribution>
        {isOpen(run.status) && !editing && (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            <PencilLine size={14} /> Correct fields
          </button>
        )}
      </div>
      {!editing ? (
        <>
          {onLocate && <p className="muted small" style={{ margin: "0 0 8px" }}>Click a value to see where it appears in the original.</p>}
          <div className="fgrid">
            <Cell field="vendor" label="Vendor" value={inv.vendor} kind="vendor" />
            <Cell field="invoiceNumber" label="Invoice no." value={inv.invoiceNumber} kind="text" />
            <Cell field="issueDate" label="Date" value={inv.issueDate} kind="date" />
            <Cell field="poReference" label="PO reference" value={inv.poReference ?? ""} shown={inv.poReference ?? <span className="muted">Not printed</span>} kind="text" />
            <Cell field="bankAccount" label="Remit-to account" value={inv.bankAccount ?? ""} shown={inv.bankAccount ? `•••• ${inv.bankAccount.replace(/\D/g, "").slice(-4)}` : <span className="muted">Not printed</span>} kind="digits" />
            <Cell field="subtotal" label="Subtotal" value={inv.subtotal} shown={money(inv.subtotal, c)} kind="money" />
            <Cell field="tax" label="Tax" value={inv.tax} shown={money(inv.tax, c)} kind="money" />
            <Cell field="shipping" label="Freight" value={inv.shipping} shown={money(inv.shipping, c)} kind={inv.shipping ? "money" : undefined} />
            <Cell field="total" label="Total" value={inv.total} shown={money(inv.total, c)} bad={totalOff} kind="money" />
          </div>
          <table className="tbl tbl-sm" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Line item</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lineItems.map((l, i) => {
                const off = Math.abs(l.quantity * l.unitPrice - l.total) > 1;
                const cls = (f: "quantity" | "unitPrice" | "total") => state(`lineItems[${i}].${f}`, l[f], off && f === "total")[0];
                const loc = (f: "unitPrice" | "total") =>
                  onLocate
                    ? {
                        role: "button" as const,
                        tabIndex: 0,
                        title: "Show where this appears in the document",
                        onClick: () => onLocate(`lineItems[${i}].${f}`, `${l.description} ${f === "total" ? "amount" : "unit price"}`, "money", l[f]),
                        onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && onLocate(`lineItems[${i}].${f}`, `${l.description} ${f === "total" ? "amount" : "unit price"}`, "money", l[f]),
                      }
                    : {};
                return (
                  <tr key={i}>
                    <td>{l.description}</td>
                    <td className={`num ${cls("quantity")}`}>{l.quantity}</td>
                    <td className={`num ${cls("unitPrice")} ${onLocate ? "td-loc" : ""} ${selected === `lineItems[${i}].unitPrice` ? "td-sel" : ""}`} {...loc("unitPrice")}>
                      {money(l.unitPrice, c)}
                    </td>
                    <td className={`num ${cls("total")} ${onLocate ? "td-loc" : ""} ${selected === `lineItems[${i}].total` ? "td-sel" : ""}`} {...loc("total")}>
                      {money(l.total, c)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="legend">
            <span><i className="lg fv-missing" />Missing</span>
            <span><i className="lg fv-bad" />Doesn't add up</span>
            <span><i className="lg fv-low" />AI unsure (self-reported)</span>
            <span><i className="lg fv-unconf" />Not yet confirmed</span>
            <span><i className="lg fv-fixed" />Corrected</span>
          </div>
          {run.corrections?.length ? (
            <details className="acc-item" style={{ marginTop: 12 }}>
              <summary>
                <span className="acc-title">Corrections ({run.corrections.flatMap((x) => x.changes).length})</span>
              </summary>
              <div className="acc-body">
                <table className="tbl tbl-sm">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>AI read</th>
                      <th>Corrected to</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.corrections.flatMap((x) =>
                      x.changes.map((ch, j) => (
                        <tr key={`${x.at}-${j}`}>
                          <td><code className="code">{ch.field}</code></td>
                          <td className="tabnum">{ch.from}</td>
                          <td className="tabnum t-ok">{ch.to}</td>
                          <td className="small">{x.reviewer} · {fmtDate(x.at)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <div className="editor">
          <p className="small muted" style={{ marginTop: 0 }}>
            Enter what the document actually says. Saving re-runs every rule; vendor and bank account can't be edited.
          </p>
          <div className="egrid">
            {inp("invoiceNumber", "Invoice no.")}
            {inp("issueDate", "Date (yyyy-mm-dd)")}
            {inp("poReference", "PO reference")}
          </div>
          <table className="tbl tbl-sm">
            <thead>
              <tr>
                <th>Line item</th>
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
                      <input className="input input-num" inputMode="decimal" aria-label={`Line ${i + 1} ${f}`} value={draft.lines[i]?.[f] ?? ""} onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x)) })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="egrid" style={{ marginTop: 12 }}>
            {inp("subtotal", "Subtotal", true)}
            {inp("tax", "Tax", true)}
            {inp("shipping", "Freight", true)}
            {inp("discount", "Discount", true)}
            {inp("total", "Total", true)}
            <div className={`ecalc ${draftOk ? "t-ok" : "t-bad"}`}>
              {draftOk ? <Check size={14} /> : null} Expected {money(draftExp, c)} · {draftOk ? "adds up" : "doesn't add up yet"}
            </div>
          </div>
          <div className="form-row">
            <input className="input" aria-label="Reviewer name" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" />
            <input className="input" aria-label="Reason for correction" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. labour amount reads 1850 on the photo" />
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !reviewer.trim() || reason.trim().length < 5} onClick={save}>
              {busy ? "Re-running checks…" : "Save & re-run checks"}
            </button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>
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
    <section className="sec">
      <div className="sec-head">
        <h3>Suggested purchase orders</h3>
        <span className="muted small">Ranked by vendor, amount and lines. Nothing is applied without you.</span>
      </div>
      <div className="sugg">
        {list.slice(0, 3).map((sg) => (
          <div key={sg.poId} className="sugg-row">
            <div className="sugg-fit">
              <b>{sg.amountFitPct}%</b>
              <small>fit</small>
            </div>
            <div>
              <div className="sugg-id">
                {sg.poId} {run.poMatch.po?.id === sg.poId && <span className="tag tag-warn">Engine's suggestion</span>}
              </div>
              <div className="muted small">{sg.reasons.join(" · ")}</div>
              {!sg.withinValue && <div className="t-bad small">Invoice exceeds the open value</div>}
            </div>
            {isOpen(run.status) && (
              <button className="btn btn-sm" onClick={() => onUse(sg.poId)}>
                Use this PO
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------- Guided actions ----------------

const ACTION_META: Record<ReviewActionId, { icon: typeof Check; help: string }> = {
  verify_bank: { icon: Landmark, help: "Record that you called the vendor on the number in the vendor master and they confirmed the new account. This clears only the security hold; any other open finding stays open." },
  confirm_po: { icon: ClipboardCheck, help: "Record that the PO owner confirmed this invoice belongs to the suggested PO. Other findings stay open." },
  confirm_fields: { icon: BadgeCheck, help: "Record that you checked every extracted figure against the original document. This does not approve the invoice; correct any wrong value with “Correct extracted fields” first." },
  resolve_po: { icon: ClipboardCheck, help: "Record an authorised PO amendment or approval for the discrepancy below. The PO record itself isn't changed here. If the vendor sends a corrected invoice instead, use “Correct extracted fields” and every rule re-runs." },
  approve: { icon: ShieldCheck, help: "Approve for the next payment run. Only possible once every mandatory control is resolved. Approval is not payment." },
  request_info: { icon: MessageSquareText, help: "Mark the invoice as waiting on the vendor. Use the draft email in Detailed view." },
  keep_on_hold: { icon: PauseCircle, help: "Keep the payment hold in place and record why." },
  reject: { icon: Ban, help: "Reject the submission. No payable is created and the case closes." },
};

function GuidedActions({
  run,
  onUpdated,
  onError,
  onCorrect,
  request,
}: {
  run: RunRecord;
  onUpdated: (r: RunRecord, msg: string) => void;
  onError: (m: string) => void;
  onCorrect: () => void;
  request?: { id: ReviewActionId; n: number } | null; // opened from the checklist
}) {
  const options = availableActions(run);
  const [active, setActive] = useState<ReviewActionId | null>(null);
  const formRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!request) return;
    setActive(request.id);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }, [request]);
  const [reviewer, setReviewer] = useReviewer();
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const [authorizedBy, setAuthorizedBy] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const vendor = VENDORS.find((v) => v.id === run.vendorId);
  const open = openCodes(run);
  const needsCorrection = open.some((c) => NEEDS_CORRECTION.includes(c));
  const recommended: ReviewActionId | "correct" | null = (() => {
    const k = requiredAction(run, open);
    if (k === "bank") return "verify_bank";
    if (k === "onboard") return "request_info";
    if (needsCorrection) return "correct";
    if (k === "fields") return "confirm_fields";
    if (k === "po") return "confirm_po";
    if (k === "po_amount") return "resolve_po";
    return "approve";
  })();

  if (!options.length) {
    const last = [...run.audit].reverse().find((e) => e.kind === "reviewer");
    return (
      <section className="sec">
        <div className="closed">
          <Check size={18} /> Case closed · {statusLabel(run.status)}
          {last ? ` by ${last.actor}` : " by the rules engine"}. {run.status === "approved" ? "Eligible for payment; not yet paid." : "No payable created."}
        </div>
      </section>
    );
  }
  const opt = options.find((o) => o.id === active);
  const errors = touched
    ? [
        !reviewer.trim() && "Enter your name.",
        note.trim().length < 5 && "Add a short justification (5+ characters).",
        opt?.needsVerification && !verified && "Confirm the independent call-back.",
        opt?.needsAuthorization && !authorizedBy.trim() && "Enter who authorised the PO change.",
        opt?.needsAuthorization && !reference.trim() && "Enter the amendment or approval reference.",
      ].filter(Boolean)
    : [];
  const submit = async (o: ActionOption) => {
    setTouched(true);
    if (!reviewer.trim() || note.trim().length < 5 || (o.needsVerification && !verified) || (o.needsAuthorization && (!authorizedBy.trim() || !reference.trim()))) return;
    setBusy(true);
    try {
      const r = await submitReview(run.id, { action: o.id, reviewer, justification: note, verificationConfirmed: verified, authorizedBy, reference });
      setActive(null);
      setNote("");
      setVerified(false);
      setAuthorizedBy("");
      setReference("");
      setTouched(false);
      const still = openCodes(r).length;
      onUpdated(r, `${o.label} · recorded. Now ${statusLabel(r.status)}${still && r.status !== "approved" && r.status !== "rejected" ? ` · ${still} finding${still > 1 ? "s" : ""} still open` : ""}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const primary = options.filter((o) => o.tone === "primary");
  const secondary = options.filter((o) => o.tone !== "primary");
  const card = (o: ActionOption) => {
    const I = ACTION_META[o.id].icon;
    return (
      <button key={o.id} className={`act ${active === o.id ? "on" : ""} ${o.tone === "danger" ? "act-danger" : ""} ${recommended === o.id ? "act-rec" : ""}`} disabled={!o.allowed} aria-pressed={active === o.id} onClick={() => (setActive(active === o.id ? null : o.id), setTouched(false))} title={o.blockedReason}>
        <I size={18} aria-hidden />
        <span className="act-label">{o.label}</span>
        {!o.allowed ? <span className="act-lock">Locked</span> : recommended === o.id ? <span className="act-tag">Recommended</span> : null}
      </button>
    );
  };
  return (
    <section className="sec" id="resolve" ref={formRef}>
      <div className="sec-head">
        <h3>Resolve</h3>
        <span className="muted small">Every action is logged with your name and reason.</span>
      </div>
      <div className="next">
        <span className="next-k">Recommended next step</span>
        <span>{nextStep(run, open)}</span>
      </div>
      <div className="acts">
        {primary.map(card)}
        {isOpen(run.status) && (
          <button className={`act ${recommended === "correct" ? "act-rec" : ""}`} onClick={onCorrect}>
            <PencilLine size={18} aria-hidden />
            <span className="act-label">Correct extracted fields</span>
            {recommended === "correct" && <span className="act-tag">Recommended</span>}
          </button>
        )}
      </div>
      <div className="acts acts-2">{secondary.map(card)}</div>
      {options
        .filter((o) => !o.allowed && o.blockedReason)
        .map((o) => (
          <p key={o.id} className="locked-note">
            <b>{o.label}</b> is locked: {o.blockedReason}
          </p>
        ))}
      {opt && opt.allowed && (
        <div className="act-form" role="region" aria-label={opt.label}>
          <p className="act-help">{ACTION_META[opt.id].help}</p>
          {opt.id === "resolve_po" && run.poMatch.billing && (
            <div className="po-gap">
              {(run.poMatch.lines ?? [])
                .filter((l) => l.status !== "ok")
                .map((l, i) => (
                  <div key={i}>
                    <b>{l.description}</b>: ordered {l.poQty ?? "—"}, previously billed {l.priorQty}, this invoice {l.invoiceQty}
                    {l.poQty !== null && l.priorQty + l.invoiceQty > l.poQty ? <span className="t-bad"> → {l.priorQty + l.invoiceQty - l.poQty} over</span> : null}
                    {l.status === "price_over" && l.poUnitPrice !== null && <span className="t-bad"> · price {money(l.invoiceUnitPrice, run.invoice.currency)} vs {money(l.poUnitPrice, run.invoice.currency)}</span>}
                  </div>
                ))}
              <div>
                Value: {money(run.poMatch.billing.billedAfter, run.invoice.currency)} billed against a {money(run.poMatch.billing.poTotal, run.invoice.currency)} PO
                {run.poMatch.billing.billedAfter > run.poMatch.billing.poTotal && <span className="t-bad"> → {money(run.poMatch.billing.billedAfter - run.poMatch.billing.poTotal, run.invoice.currency)} over</span>}
              </div>
            </div>
          )}
          {opt.needsAuthorization && (
            <div className="form-row">
              <input className="input" aria-label="Authorised by" placeholder={`Authorised by (PO owner: ${run.poMatch.po?.approvedBy ?? "—"})`} value={authorizedBy} onChange={(e) => setAuthorizedBy(e.target.value)} />
              <input className="input" aria-label="Amendment reference" placeholder="PO amendment / approval reference" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          )}
          {opt.needsVerification && (
            <label className="verify">
              <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
              <span>
                I called {vendor ? `${vendor.name} on ${vendor.phone}` : "the vendor"} (the number on file, not one from the invoice) and they confirmed the new account.
              </span>
            </label>
          )}
          <div className="form-row">
            <input className="input" aria-label="Reviewer name" placeholder="Your name (demo identity)" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
            <input className="input" aria-label="Justification" placeholder="Justification for the audit trail" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {errors.length > 0 && (
            <ul className="form-errors" role="alert">
              {errors.map((e) => (
                <li key={String(e)}>{e}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button className={`btn ${opt.tone === "danger" ? "btn-danger-solid" : "btn-primary"}`} disabled={busy} onClick={() => submit(opt)}>
              {busy ? "Recording…" : `Confirm: ${opt.label}`}
            </button>
            <button className="btn" onClick={() => setActive(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- "Before this invoice can be approved" checklist ----------------
// Derived from the findings and their resolution state (lib/controls.ts);
// resolving a control in Resolve updates it immediately.

function ControlsChecklist({ run, onAction }: { run: RunRecord; onAction: (a: ControlAction) => void }) {
  const items = deriveControls(run);
  const unresolved = items.filter((i) => i.status === "unresolved");
  const closed = run.status === "approved" || run.status === "rejected";
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const icon = { passed: <Check size={14} strokeWidth={3} />, resolved: <Check size={14} strokeWidth={3} />, unresolved: <TriangleAlert size={13} strokeWidth={2.6} />, na: <CircleDashed size={14} /> };
  const statusText = { passed: "Passed", resolved: "Resolved", unresolved: "Unresolved", na: "Not applicable" };
  return (
    <section className="sec" id="controls">
      <div className="sec-head">
        <h3>{closed ? "Controls" : "Before this invoice can be approved"}</h3>
      </div>
      <ul className="ctl">
        {items.map((c) => {
          const text = c.status === "unresolved" ? (SHORT[c.open[0]] ?? REASON_LABEL[c.open[0]]) : c.status === "resolved" ? c.resolvedBy : PASS_TEXT[c.key];
          return (
            <li key={c.key} className={`ctl-${c.status}`}>
              <span className="ctl-i" aria-hidden>
                {icon[c.status]}
              </span>
              <div className="ctl-body">
                <div className="ctl-top">
                  <b>{c.label}</b>
                  <span className="ctl-st">{statusText[c.status]}</span>
                </div>
                <div className="ctl-text">{text}</div>
                {c.status === "unresolved" && c.open.length > 1 && <div className="ctl-more">Also: {c.open.slice(1).map((x) => REASON_LABEL[x]).join(", ")}</div>}
              </div>
              <div className="ctl-acts">
                {c.status !== "na" && (
                  <button className="link-btn small" onClick={() => jump(c.evidenceId)}>
                    Evidence
                  </button>
                )}
                {c.action && !closed && (
                  <button className="btn btn-sm" onClick={() => onAction(c.action!.id)}>
                    {c.action.label} <ArrowRight size={13} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className={`ctl-foot ${unresolved.length ? "ctl-foot-locked" : ""}`}>
        {closed ? (
          run.status === "approved" ? (
            <>
              <Check size={15} /> Approved for the payment run · not yet paid
            </>
          ) : (
            <>
              <Ban size={15} /> Closed · no payable created
            </>
          )
        ) : unresolved.length ? (
          <>
            <Lock size={15} /> {unresolved.length} unresolved control{unresolved.length > 1 ? "s" : ""} · Payment approval locked
          </>
        ) : (
          <>
            <ShieldCheck size={15} /> All controls satisfied · ready for an explicit approval
          </>
        )}
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
  headerExtra,
  onViewDocument,
  onHighlight,
}: {
  run: RunRecord;
  allRuns: RunRecord[];
  previewSrc?: string | null;
  breadcrumb?: ReactNode;
  embedded?: boolean;
  onUpdated: (r: RunRecord) => void;
  notify: (m: string, kind?: "ok" | "err") => void;
  headerExtra?: ReactNode;
  onViewDocument?: () => void; // queue: open the document in a side-by-side split instead of a modal
  onHighlight?: (h: Highlight | null) => void; // queue: show the located field in its split document
}) {
  const [density, setDensity] = useDensity();
  const detailed = density === "detailed";
  const [editing, setEditing] = useState(false);
  const [poPatch, setPoPatch] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [hl, setHl] = useState<(Highlight & { field: string }) | null>(null);
  const [request, setRequest] = useState<{ id: ReviewActionId; n: number } | null>(null);
  const showHl = (h: (Highlight & { field: string }) | null) => {
    setHl(h);
    onHighlight?.(h);
  };
  const onLocate = (field: string, label: string, kind: LocateKind, value: string | number | null) => showHl({ ...locateField(run, label, kind, value), field });
  const onControl = (a: ControlAction) => (a === "correct" ? startCorrect() : setRequest({ id: a, n: Date.now() }));
  const kind = attemptKind(run);
  const original = run.duplicateOf?.runId ? allRuns.find((r) => r.id === run.duplicateOf!.runId) : undefined;
  const checks = invoiceChecks(run);
  const ready = paymentReadiness(run);
  const open = openCodes(run);
  const resolved = run.resolvedCodes ?? [];
  const primary = run.findings.find((f) => run.decision.decidingCodes.includes(f.code) && !resolved.includes(f.code)) ?? run.findings.find((f) => f.action !== "info" && !resolved.includes(f.code));
  const lastReview = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  const src = previewSrc ?? (run.hasPreview ? `/api/runs/${run.id}/preview` : null);
  const href = run.hasPreview ? `/api/runs/${run.id}/preview` : undefined;
  const fieldsMatter = editing || open.some((c) => ["HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE", "ARITHMETIC_MISMATCH", "MISSING_FIELD"].includes(c));
  const poMatters = open.some((c) => ["PO_MATCH_UNCONFIRMED", "MISSING_PO_REFERENCE", "UNKNOWN_PO"].includes(c));
  const others = run.findings.filter((f) => f !== primary && (detailed || f.action !== "info"));
  const saved = (r: RunRecord, msg: string) => {
    onUpdated(r);
    notify(msg);
  };
  const startCorrect = () => {
    setEditing(true);
    setTimeout(() => document.getElementById("fields")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const decisionTitle = run.status === "approved" && !lastReview ? "All checks passed" : lastReview && !isOpen(run.status) ? `${lastReview.action}` : primary ? REASON_LABEL[primary.code] : run.decision.headline;
  const decisionLine = lastReview && !isOpen(run.status) ? `“${lastReview.note}” · ${lastReview.actor}` : primary ? SHORT[primary.code] ?? primary.title : "Totals reconcile, vendor and bank verified, within PO tolerance, no duplicate.";

  const right = (
    <div className="inv-right">
      <section className={`decision dec-${run.status}`}>
        <div className="decision-top">
          <div className="seg" role="group" aria-label="Information density">
            <button className={!detailed ? "on" : ""} aria-pressed={!detailed} onClick={() => setDensity("summary")}>
              Summary
            </button>
            <button className={detailed ? "on" : ""} aria-pressed={detailed} onClick={() => setDensity("detailed")}>
              Detailed
            </button>
          </div>
          <span className="attrs">
            <Attribution kind="ai" />
            <Attribution kind="rules">{lastReview ? `Decided by ${lastReview.actor}` : "Decided by rules"}</Attribution>
          </span>
        </div>
        <div className="decision-status">{kind === "original" ? statusLabel(run.status) : "Duplicate submission blocked"}</div>
        <h2 className="decision-title">{decisionTitle}</h2>
        <p className="decision-line">{decisionLine}</p>
        {kind !== "original" && run.duplicateOf && (
          <div className="dup-note">
            <div>
              <b>No second payable was created.</b> This upload repeats <span className="mono">{run.duplicateOf.invoiceNumber}</span>
              {kind === "duplicate_of_paid" ? (
                <>, which is already paid (ERP payment record).</>
              ) : original ? (
                <>
                  . The original invoice is still <StatusBadge status={original.status} />
                  {isOpen(original.status) ? " and its own controls still need resolving." : "."}
                </>
              ) : (
                <>, which is already on file.</>
              )}
            </div>
            {original && (
              <a className="btn btn-sm" href={`/invoice/${original.id}?from=history`}>
                Open original invoice <ArrowRight size={13} />
              </a>
            )}
          </div>
        )}
        {kind === "original" && (
          <div className="ready">
            <span className={`ready-pill rp-${checks === "Passed" ? "ok" : checks === "Incomplete" ? "warn" : "bad"}`}>
              <small>Invoice checks</small> {checks}
            </span>
            <span className={`ready-pill rp-${ready.label === "Ready" ? "ok" : ready.label === "Closed" ? "muted" : ready.label === "Awaiting approval" ? "info" : ready.label === "Awaiting verification" ? "warn" : "bad"}`} title={ready.detail}>
              <small>Payment readiness</small> {ready.label}
            </span>
            <span className="muted small">{ready.detail}</span>
          </div>
        )}
        {detailed && (
          <div className="decision-detail">
            <div>
              <span className="muted small">Rule outcome</span> {run.decision.headline}
            </div>
            <div>
              <span className="muted small">Deciding codes</span> {run.decision.decidingCodes.map((c) => <code key={c} className="code">{c}</code>)}
            </div>
            <div>
              <span className="muted small">Full instruction</span> {run.decision.nextAction}
            </div>
          </div>
        )}
      </section>

      {kind === "original" && <ControlsChecklist run={run} onAction={onControl} />}

      <section className="sec">
        <div className="sec-head">
          <h3>Evidence</h3>
          {!detailed && <span className="muted small">For the open controls · Detailed view shows every check</span>}
        </div>
        <EvidenceStack run={run} relevantOnly={!detailed} />
      </section>

      {(detailed || poMatters) && (
        <PoSuggestions
          run={run}
          allRuns={allRuns}
          onUse={(poId) => {
            setPoPatch(poId);
            startCorrect();
          }}
        />
      )}

      {(detailed || fieldsMatter) && (
        <FieldsPanel
          run={run}
          editing={editing}
          setEditing={setEditing}
          patch={poPatch ? { poReference: poPatch } : null}
          onSaved={(r) => saved(r, `Fields corrected · all checks re-run · now ${statusLabel(r.status)}`)}
          onError={(m) => notify(m, "err")}
          onLocate={onLocate}
          selected={hl?.field}
        />
      )}

      {kind === "original" || isOpen(run.status) ? <GuidedActions run={run} onUpdated={saved} onError={(m) => notify(m, "err")} onCorrect={startCorrect} request={request} /> : null}

      {others.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h3>{detailed ? "All rule findings" : "Other findings"}</h3>
            <span className="muted small">{others.length}</span>
          </div>
          <Findings findings={others} run={run} resolved={resolved} showCodes={detailed} />
        </section>
      )}

      <section className="sec">
        {detailed && (
          <>
            <details className="acc-item">
              <summary>
                <span className="acc-title">Vendor communication</span>
              </summary>
              <div className="acc-body">
                <VendorComms explanation={run.explanation} status={run.status} />
              </div>
            </details>
            <details className="acc-item">
              <summary>
                <span className="acc-title">Processing log · {fmtSecs(run.durationMs)}</span>
              </summary>
              <div className="acc-body">
                <Timeline stages={run.stages} compact />
              </div>
            </details>
          </>
        )}
        <details className="acc-item" open={detailed || run.audit.some((e) => e.kind === "reviewer")}>
          <summary>
            <History size={16} aria-hidden />
            <span className="acc-title">Audit history · {3 + run.audit.filter((e) => e.kind === "reviewer").length} events</span>
          </summary>
          <div className="acc-body">
            <AuditTrail run={run} />
          </div>
        </details>
      </section>
    </div>
  );

  return (
    <div className={`inv ${embedded ? "inv-embedded" : ""}`}>
      <header className="inv-head">
        {breadcrumb && <div className="crumbs">{breadcrumb}</div>}
        <div className="inv-row">
          <div className="inv-id">
            <h1>{run.vendorMatched ?? (run.invoice.vendor || "Unknown vendor")}</h1>
            <div className="inv-meta">
              <span className="mono">{run.invoice.invoiceNumber ?? "No invoice no."}</span>
              <span>·</span>
              <span>{run.poMatch.po ? `${run.poMatch.po.id}${run.poMatch.method === "inferred" ? " (suggested)" : ""}` : "No PO"}</span>
              <span>·</span>
              <span>
                Processed {fmtDate(run.createdAt)} in {fmtSecs(run.durationMs)}
              </span>
              {run.repeatSubmission && <span className="tag tag-warn">Repeat submission</span>}
            </div>
          </div>
          <div className="inv-amt">
            <div className="amount">{money(run.invoice.total, run.invoice.currency)}</div>
            <StatusBadge status={run.status} large />
          </div>
        </div>
        {embedded && (
          <div className="inv-tools">
            <button className="btn btn-sm" onClick={() => (onViewDocument ? onViewDocument() : setDocOpen(true))}>
              <FileSearch size={14} /> View original document
            </button>
            <a className="btn btn-sm btn-ghost" href={`/invoice/${run.id}?from=queue`}>
              Open full page
            </a>
            <span className="muted small">Decided by {decidedBy(run)}</span>
          </div>
        )}
        {headerExtra}
      </header>
      {embedded ? (
        right
      ) : (
        <div className="inv-split">
          <DocumentViewer src={src} href={href} title={run.fileName} meta={`${run.pageCount} page${run.pageCount > 1 ? "s" : ""} · ${run.invoice.documentType}`} highlight={hl} onClearHighlight={() => showHl(null)} />
          {right}
        </div>
      )}
      {docOpen && (
        <Modal title={run.fileName} onClose={() => setDocOpen(false)}>
          <DocumentViewer src={src} href={href} title={run.fileName} meta={run.invoice.documentType} sticky={false} />
        </Modal>
      )}
    </div>
  );
}
