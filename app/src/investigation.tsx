// Invoice investigation workspace. Document on the left (40%), decision,
// evidence and guided resolution on the right (60%). The queue uses the same
// workspace without the document pane (document opens in a viewer instead).

import { useMemo, useState, type ReactNode } from "react";
import { Ban, BadgeCheck, Check, ClipboardCheck, ExternalLink, FileSearch, Landmark, MessageSquareText, PauseCircle, PencilLine, ShieldCheck, ZoomIn, ZoomOut } from "lucide-react";
import { ACTION_GROUPS, REASON_LABEL, SHORT, nextStep, requiredAction } from "./copy";
import { PURCHASE_ORDERS } from "./data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "./data/vendors";
import { EvidenceStack } from "./evidence";
import { buildLedger, expectedTotal, isOpen, money, statusLabel, suggestPos } from "./lib/engine";
import { DEFAULT_RULES } from "./lib/rules";
import { availableActions, openCodes, type ActionOption, type ReviewActionId } from "./lib/review";
import { submitCorrection, submitReview } from "./lib/runsApi";
import { AuditTrail, Findings, Timeline, VendorComms, decidedBy } from "./runView";
import type { Invoice, RunRecord, StageId } from "./types";
import { Attribution, Modal, SEVERITY, StatusBadge, fmtDate, fmtSecs, useDensity, useReviewer } from "./ui";

// ---------------- Document viewer ----------------

export function DocumentViewer({ src, href, title, meta, sticky = true }: { src: string | null; href?: string; title: string; meta: string; sticky?: boolean }) {
  const [zoom, setZoom] = useState(100);
  return (
    <section className={`doc ${sticky ? "doc-sticky" : ""}`} aria-label="Original invoice">
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
      <div className="doc-view">{src ? <img src={src} alt={`Page 1 of ${title}`} style={{ width: `${zoom}%` }} /> : <p className="muted small">No page image stored for this run.</p>}</div>
    </section>
  );
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

function FieldsPanel({ run, editing, setEditing, patch, onSaved, onError }: { run: RunRecord; editing: boolean; setEditing: (b: boolean) => void; patch?: Partial<Draft> | null; onSaved: (r: RunRecord) => void; onError: (m: string) => void }) {
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
  const Cell = ({ field, label, value, shown, bad }: { field: string; label: string; value: unknown; shown?: ReactNode; bad?: boolean }) => {
    const [cls, tag] = state(field, value, bad);
    return (
      <div className={`fv ${cls}`}>
        <span className="fv-k">
          {label} {tag && <em>{tag}</em>}
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
          <div className="fgrid">
            <Cell field="invoiceNumber" label="Invoice no." value={inv.invoiceNumber} />
            <Cell field="issueDate" label="Date" value={inv.issueDate} />
            <Cell field="poReference" label="PO reference" value={inv.poReference ?? ""} shown={inv.poReference ?? <span className="muted">Not printed</span>} />
            <Cell field="subtotal" label="Subtotal" value={inv.subtotal} shown={money(inv.subtotal, c)} />
            <Cell field="tax" label="Tax" value={inv.tax} shown={money(inv.tax, c)} />
            <Cell field="total" label="Total" value={inv.total} shown={money(inv.total, c)} bad={totalOff} />
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
  verify_bank: { icon: Landmark, help: "Record that you called the vendor on the number in the vendor master and they confirmed the new account. This clears the security hold; approval is a separate step." },
  confirm_po: { icon: ClipboardCheck, help: "Record that the PO owner confirmed this invoice belongs to the suggested PO." },
  confirm_fields: { icon: BadgeCheck, help: "Record that you checked every extracted figure against the original document." },
  approve: { icon: ShieldCheck, help: "Approve for the next payment run. Only possible once every mandatory control is resolved. Approval is not payment." },
  request_info: { icon: MessageSquareText, help: "Mark the invoice as waiting on the vendor. Use the draft email in Detailed view." },
  keep_on_hold: { icon: PauseCircle, help: "Keep the payment hold in place and record why." },
  reject: { icon: Ban, help: "Reject the submission. No payable is created and the case closes." },
};

function GuidedActions({ run, onUpdated, onError, onCorrect }: { run: RunRecord; onUpdated: (r: RunRecord, msg: string) => void; onError: (m: string) => void; onCorrect: () => void }) {
  const options = availableActions(run);
  const [active, setActive] = useState<ReviewActionId | null>(null);
  const [reviewer, setReviewer] = useReviewer();
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const vendor = VENDORS.find((v) => v.id === run.vendorId);

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
  const errors = touched ? [!reviewer.trim() && "Enter your name.", note.trim().length < 5 && "Add a short justification (5+ characters).", opt?.needsVerification && !verified && "Confirm the independent call-back."].filter(Boolean) : [];
  const submit = async (o: ActionOption) => {
    setTouched(true);
    if (!reviewer.trim() || note.trim().length < 5 || (o.needsVerification && !verified)) return;
    setBusy(true);
    try {
      const r = await submitReview(run.id, { action: o.id, reviewer, justification: note, verificationConfirmed: verified });
      setActive(null);
      setNote("");
      setVerified(false);
      setTouched(false);
      onUpdated(r, `${o.label} · recorded. Now ${statusLabel(r.status)}.`);
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
      <button key={o.id} className={`act ${active === o.id ? "on" : ""} ${o.tone === "danger" ? "act-danger" : ""}`} disabled={!o.allowed} aria-pressed={active === o.id} onClick={() => (setActive(active === o.id ? null : o.id), setTouched(false))} title={o.blockedReason}>
        <I size={18} aria-hidden />
        <span className="act-label">{o.label}</span>
        {!o.allowed && <span className="act-lock">Locked</span>}
      </button>
    );
  };
  return (
    <section className="sec">
      <div className="sec-head">
        <h3>Resolve</h3>
        <span className="muted small">Choose an action. Every decision is logged with your name and reason.</span>
      </div>
      <div className="acts">
        {primary.map(card)}
        {isOpen(run.status) && (
          <button className="act" onClick={onCorrect}>
            <PencilLine size={18} aria-hidden />
            <span className="act-label">Correct extracted fields</span>
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

// ---------------- Control checklist (Detailed view) ----------------

const CONTROLS: { stage: StageId; label: string }[] = [
  { stage: "validate", label: "Document & arithmetic" },
  { stage: "vendor", label: "Vendor & bank account" },
  { stage: "po_match", label: "Purchase order" },
  { stage: "duplicates", label: "Duplicates" },
];

function Checklist({ run }: { run: RunRecord }) {
  const resolved = run.resolvedCodes ?? [];
  return (
    <ul className="checks">
      {CONTROLS.map((c) => {
        const fs = run.findings.filter((f) => f.stage === c.stage && f.action !== "info");
        const open = fs.filter((f) => !resolved.includes(f.code));
        const worst = open.reduce((m, f) => Math.max(m, SEVERITY[f.action].rank), 0);
        const cls = !open.length ? "ck-ok" : worst >= 2 ? "ck-bad" : "ck-warn";
        return (
          <li key={c.stage} className={cls}>
            <span className="ck-i">{!open.length ? <Check size={14} strokeWidth={3} /> : "!"}</span>
            <span className="ck-l">{c.label}</span>
            <span className="ck-r">{!open.length ? (fs.length ? "Resolved by reviewer" : "Passed") : open.map((f) => REASON_LABEL[f.code]).join(", ")}</span>
          </li>
        );
      })}
    </ul>
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
}: {
  run: RunRecord;
  allRuns: RunRecord[];
  previewSrc?: string | null;
  breadcrumb?: ReactNode;
  embedded?: boolean;
  onUpdated: (r: RunRecord) => void;
  notify: (m: string, kind?: "ok" | "err") => void;
  headerExtra?: ReactNode;
}) {
  const [density, setDensity] = useDensity();
  const detailed = density === "detailed";
  const [editing, setEditing] = useState(false);
  const [poPatch, setPoPatch] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const open = openCodes(run);
  const resolved = run.resolvedCodes ?? [];
  const primary = run.findings.find((f) => run.decision.decidingCodes.includes(f.code) && !resolved.includes(f.code)) ?? run.findings.find((f) => f.action !== "info" && !resolved.includes(f.code));
  const lastReview = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  const src = previewSrc ?? (run.hasPreview ? `/api/runs/${run.id}/preview` : null);
  const href = run.hasPreview ? `/api/runs/${run.id}/preview` : undefined;
  const fieldsMatter = editing || open.some((c) => ["HANDWRITTEN_DOCUMENT", "LOW_EXTRACTION_CONFIDENCE", "ARITHMETIC_MISMATCH", "MISSING_FIELD"].includes(c));
  const poMatters = open.some((c) => ["PO_MATCH_UNCONFIRMED", "MISSING_PO_REFERENCE", "UNKNOWN_PO"].includes(c));
  const others = run.findings.filter((f) => f !== primary && (detailed || f.action !== "info"));
  const actionLabel = isOpen(run.status) ? ACTION_GROUPS.find((g) => g.key === requiredAction(run, open))?.label : null;
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
        <div className="decision-status">{statusLabel(run.status)}</div>
        <h2 className="decision-title">{decisionTitle}</h2>
        <p className="decision-line">{decisionLine}</p>
        <div className="next">
          <span className="next-k">{actionLabel ?? "Next step"}</span>
          <span>{nextStep(run, open)}</span>
        </div>
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

      {detailed && (
        <section className="sec">
          <div className="sec-head">
            <h3>All validation checks</h3>
          </div>
          <Checklist run={run} />
        </section>
      )}

      <section className="sec">
        <div className="sec-head">
          <h3>Evidence</h3>
          {!detailed && <span className="muted small">Most important comparison</span>}
        </div>
        <EvidenceStack run={run} limit={detailed ? undefined : 1} />
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

      {(detailed || fieldsMatter) && <FieldsPanel run={run} editing={editing} setEditing={setEditing} patch={poPatch ? { poReference: poPatch } : null} onSaved={(r) => saved(r, `Fields corrected · all checks re-run · now ${statusLabel(r.status)}`)} onError={(m) => notify(m, "err")} />}

      <GuidedActions run={run} onUpdated={saved} onError={(m) => notify(m, "err")} onCorrect={startCorrect} />

      {others.length > 0 && (
        <section className="sec">
          <div className="sec-head">
            <h3>{detailed ? "All rule findings" : "Other findings"}</h3>
            <span className="muted small">{others.length}</span>
          </div>
          <Findings findings={others} run={run} resolved={resolved} showCodes={detailed} />
        </section>
      )}

      {detailed && (
        <>
          <section className="sec">
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
            <details className="acc-item" open>
              <summary>
                <span className="acc-title">Audit history · {run.audit.length + 1} events</span>
              </summary>
              <div className="acc-body">
                <AuditTrail run={run} />
              </div>
            </details>
          </section>
        </>
      )}
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
            <button className="btn btn-sm" onClick={() => setDocOpen(true)}>
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
          <DocumentViewer src={src} href={href} title={run.fileName} meta={`${run.pageCount} page${run.pageCount > 1 ? "s" : ""} · ${run.invoice.documentType}`} />
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
