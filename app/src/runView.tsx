// Shared building blocks: processing timeline, findings list, vendor
// communication, audit trail, reviewer actions, tabs.

import { useState } from "react";
import { REASON_LABEL, whyItMatters } from "./copy";
import { statusLabel } from "./lib/engine";
import { STAGES } from "./lib/pipeline";
import { availableActions, openCodes, type ActionOption } from "./lib/review";
import { submitReview } from "./lib/runsApi";
import type { CaseStatus, Explanation, Finding, RunRecord, StageState } from "./types";
import { SEVERITY, Severity, fmtDate, useReviewer } from "./ui";
import { VENDORS } from "./data/vendors";

// ---------------- Timeline ----------------

const TL_ICON: Record<StageState["status"], string> = { pending: "", running: "", done: "✓", warn: "!", blocked: "■", error: "✕" };
const TL_TAG: Partial<Record<StageState["status"], [string, string]>> = {
  warn: ["Needs review", "tag-warn"],
  blocked: ["Rule triggered", "tag-hold"],
  error: ["System error", "tag-err"],
};

export function Timeline({ stages, live, compact }: { stages: StageState[]; live?: boolean; compact?: boolean }) {
  const byId = new Map(stages.map((s) => [s.id, s]));
  return (
    <ol className={`tl ${compact ? "tl-compact" : ""}`}>
      {STAGES.map((def, i) => {
        const s = byId.get(def.id) ?? { id: def.id, status: "pending" as const, lines: [] };
        const ms = s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null;
        const tag = TL_TAG[s.status];
        return (
          <li key={def.id} className={`tl-step tl-${s.status}`}>
            <span className="tl-dot">{s.status === "running" ? <span className="spinner" /> : TL_ICON[s.status] || i + 1}</span>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-label">{def.label}</span>
                {tag && <span className={`tag ${tag[1]}`}>{tag[0]}</span>}
                <span className="tl-time">{s.status === "running" && live ? "running…" : ms !== null ? (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`) : ""}</span>
              </div>
              <div className="tl-sum">{s.summary ?? def.what}</div>
              {!compact && s.lines.length > 0 && (
                <details className="tl-more">
                  <summary>Details</summary>
                  <ul>
                    {s.lines.map((l, j) => (
                      <li key={j}>{l}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function decidedBy(run: Pick<RunRecord, "audit">): string {
  const last = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  return last ? `${last.actor} (reviewer), ${fmtDate(last.at)}` : "rules engine (automated)";
}

// ---------------- Findings (compact, expandable) ----------------

export function FindingRows({ findings, run, resolved = [] }: { findings: Finding[]; run: RunRecord; resolved?: string[] }) {
  const sorted = [...findings].sort((a, b) => SEVERITY[b.action].rank - SEVERITY[a.action].rank);
  if (!sorted.length) return <div className="muted small">No findings.</div>;
  return (
    <div className="frows">
      {sorted.map((f, i) => (
        <details key={i} className={`frow frow-${f.action}`}>
          <summary>
            <span className={`dotsev dotsev-${f.action}`} aria-hidden />
            <span className="frow-title">{f.title}</span>
            {resolved.includes(f.code) && <span className="tag tag-ok">resolved</span>}
            <span className="frow-meta">
              <Severity action={f.action} /> · <span className="mono">{f.code}</span>
            </span>
          </summary>
          <div className="frow-body">
            <p>{f.detail}</p>
            {f.action !== "info" && (
              <p className="muted">
                <strong>Why it matters:</strong> {whyItMatters(f.code, run)}
              </p>
            )}
            {f.evidence && f.evidence.length > 0 && (
              <dl className="kvlist">
                {f.evidence.map((e, j) => (
                  <div key={j}>
                    <dt>{e.label}</dt>
                    <dd className={e.tone === "bad" ? "t-bad" : e.tone === "good" ? "t-ok" : ""}>{e.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function reasonOf(run: RunRecord): Finding | undefined {
  const resolved = new Set(run.resolvedCodes ?? []);
  return run.findings.find((f) => run.decision.decidingCodes.includes(f.code) && !resolved.has(f.code)) ?? run.findings.find((f) => f.action !== "info" && !resolved.has(f.code));
}
export const reasonLabel = (f?: Finding) => (f ? REASON_LABEL[f.code] : "All checks passed");

// ---------------- Vendor communication ----------------

export function VendorComms({ explanation, streaming, status }: { explanation?: Explanation; streaming?: string; status: CaseStatus }) {
  const [copied, setCopied] = useState(false);
  if (!explanation) return streaming ? <pre className="stream">{streaming}<span className="caret">▋</span></pre> : <div className="muted small">Generating…</div>;
  return (
    <div className="comms">
      <div className="eyebrow">Summary for AP {explanation.generatedBy === "template" ? "· template" : "· AI-written from the rule findings"}</div>
      <p className="lead-p">{explanation.summary}</p>
      <div className="row-between" style={{ marginTop: 16 }}>
        <div className="eyebrow">Draft email to vendor · never sent automatically</div>
        {explanation.vendorEmail && (
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(explanation.vendorEmail!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy email"}
          </button>
        )}
      </div>
      {explanation.vendorEmail ? (
        <pre className="email">{explanation.vendorEmail}</pre>
      ) : (
        <p className="muted small">
          {status === "payment_hold"
            ? "Deliberately no email: on a payment hold, verification goes through trusted contacts on file, and an email could alert a fraudster."
            : "No vendor email needed for this outcome."}
        </p>
      )}
    </div>
  );
}

// ---------------- Audit ----------------

export function AuditTrail({ run }: { run: RunRecord }) {
  return (
    <ol className="audit">
      <li>
        <span className="audit-dot" />
        <div>
          <div className="audit-what">Uploaded {run.fileName}</div>
          <div className="audit-meta">
            {fmtDate(run.createdAt)} · {run.pageCount} page(s) · {run.extractionMethod} · {run.model} · decided in {(run.durationMs / 1000).toFixed(1)} s
          </div>
        </div>
      </li>
      {run.audit.map((e, i) => (
        <li key={i} className={e.kind === "reviewer" ? "audit-rev" : ""}>
          <span className="audit-dot" />
          <div>
            <div className="audit-what">{e.action}</div>
            <div className="audit-meta">
              {e.actor} · {fmtDate(e.at)} · {e.fromStatus ? `${statusLabel(e.fromStatus)} → ` : ""}
              {statusLabel(e.toStatus)}
            </div>
            {e.note && <div className="audit-note">“{e.note}”</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------- Reviewer actions ----------------

export function ReviewPanel({ run, onUpdated, onError }: { run: RunRecord; onUpdated: (r: RunRecord) => void; onError: (m: string) => void }) {
  const [reviewer, setReviewer] = useReviewer();
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const options = availableActions(run);
  if (!options.length) {
    return (
      <div className="resolve resolve-closed">
        <span className="eyebrow">Case closed</span> {statusLabel(run.status)}. No further action is possible; the audit trail shows who decided and why.
      </div>
    );
  }
  const needsVerify = options.some((o) => o.needsVerification && o.allowed);
  const vendor = VENDORS.find((v) => v.id === run.vendorId);
  const act = async (o: ActionOption) => {
    setBusy(o.id);
    try {
      const updated = await submitReview(run.id, { action: o.id, reviewer, justification: note, verificationConfirmed: verified });
      setNote("");
      setVerified(false);
      onUpdated(updated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const open = openCodes(run);
  const ready = reviewer.trim() && note.trim().length >= 5;
  const blocked = options.filter((o) => !o.allowed && o.blockedReason);
  return (
    <div className="resolve">
      <div className="row-between">
        <span className="eyebrow">Resolve · {open.length} open control{open.length === 1 ? "" : "s"}</span>
        <span className="small muted">Demo reviewer identity, no login</span>
      </div>
      <div className="resolve-fields">
        <input className="input" aria-label="Reviewer name" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" />
        <input className="input" aria-label="Justification" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Justification for the audit trail" />
      </div>
      {needsVerify && (
        <label className="verify">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          <span>
            I verified the bank change by calling the trusted contact on file{vendor ? ` (${vendor.phone})` : ""}, not a number or email from this invoice.
          </span>
        </label>
      )}
      <div className="actions">
        {options.map((o) => (
          <button
            key={o.id}
            className={`btn ${o.tone === "primary" ? "btn-primary" : o.tone === "danger" ? "btn-danger" : ""}`}
            disabled={!o.allowed || !!busy || !ready || (o.needsVerification && !verified)}
            title={o.blockedReason}
            onClick={() => act(o)}
          >
            {busy === o.id ? "Saving…" : o.label}
          </button>
        ))}
      </div>
      {(blocked.length > 0 || !ready) && (
        <ul className="blocked">
          {blocked.map((o) => (
            <li key={o.id}>
              <strong>{o.label}</strong> locked: {o.blockedReason}
            </li>
          ))}
          {!ready && <li>Enter your name and a justification to enable actions.</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------- Tabs ----------------

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? "tab-on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab-n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
