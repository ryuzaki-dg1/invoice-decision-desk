// Shared building blocks: processing timeline, findings accordion, vendor
// communication, audit trail, tabs.

import { useState } from "react";
import { Check, ChevronDown, Copy, Loader2, OctagonPause, TriangleAlert, X } from "lucide-react";
import { SHORT, whyItMatters } from "./copy";
import { statusLabel } from "./lib/engine";
import { STAGES } from "./lib/pipeline";
import type { CaseStatus, Explanation, Finding, RunRecord, StageState } from "./types";
import { SEVERITY, SeverityDot, fmtDate, fmtSecs } from "./ui";

// ---------------- Timeline ----------------

function StageIcon({ s, n }: { s: StageState["status"]; n: number }) {
  if (s === "running") return <Loader2 size={15} className="spin" />;
  if (s === "done") return <Check size={15} strokeWidth={3} />;
  if (s === "warn") return <TriangleAlert size={14} strokeWidth={2.5} />;
  if (s === "blocked") return <OctagonPause size={14} strokeWidth={2.5} />;
  if (s === "error") return <X size={15} strokeWidth={3} />;
  return <>{n}</>;
}

const TAG: Partial<Record<StageState["status"], [string, string]>> = {
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
        const tag = TAG[s.status];
        return (
          <li key={def.id} className={`tl-step tl-${s.status}`}>
            <span className="tl-dot">
              <StageIcon s={s.status} n={i + 1} />
            </span>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-label">{def.label}</span>
                {def.id === "extract" || def.id === "explain" ? <span className="mini-attr">AI</span> : def.id !== "ingest" ? <span className="mini-attr mini-rules">Rules</span> : null}
                {tag && <span className={`tag ${tag[1]}`}>{tag[0]}</span>}
                <span className="tl-time">{s.status === "running" && live ? "running…" : ms !== null ? fmtSecs(ms) : ""}</span>
              </div>
              <div className="tl-sum">{s.summary ?? def.what}</div>
              {!compact && s.lines.length > 0 && s.status !== "running" && (
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
  return last ? `${last.actor}, ${fmtDate(last.at)}` : "Rules engine";
}

// ---------------- Findings accordion ----------------

export function Findings({ findings, run, resolved = [], showCodes }: { findings: Finding[]; run: RunRecord; resolved?: string[]; showCodes?: boolean }) {
  const sorted = [...findings].sort((a, b) => SEVERITY[b.action].rank - SEVERITY[a.action].rank);
  if (!sorted.length) return <p className="muted small">No other findings.</p>;
  return (
    <div className="acc">
      {sorted.map((f, i) => (
        <details key={i} className="acc-item">
          <summary>
            <SeverityDot action={f.action} />
            <span className="acc-title">{f.title}</span>
            {resolved.includes(f.code) && <span className="tag tag-ok">Resolved</span>}
            {showCodes && <code className="code">{f.code}</code>}
            <ChevronDown size={16} className="acc-chev" aria-hidden />
          </summary>
          <div className="acc-body">
            <p>{SHORT[f.code] ?? f.detail}</p>
            {SHORT[f.code] && <p className="muted">{f.detail}</p>}
            {f.action !== "info" && (
              <p className="muted">
                <b>Why it matters:</b> {whyItMatters(f.code, run)}
              </p>
            )}
            {f.evidence && f.evidence.length > 0 && (
              <dl className="kv">
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

// ---------------- Vendor communication ----------------

export function VendorComms({ explanation, status }: { explanation: Explanation; status: CaseStatus }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="comms">
      <p className="lead-p">{explanation.summary}</p>
      <p className="muted small" style={{ marginTop: 6 }}>
        {explanation.generatedBy === "template" ? "Template summary" : "Written by AI from the rule findings; it cannot change the decision."}
      </p>
      <div className="row-between" style={{ marginTop: 16 }}>
        <b className="small">Draft email to vendor · never sent automatically</b>
        {explanation.vendorEmail && (
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(explanation.vendorEmail!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {explanation.vendorEmail ? (
        <pre className="email">{explanation.vendorEmail}</pre>
      ) : (
        <p className="muted small">
          {status === "payment_hold"
            ? "No email on purpose: payment holds are verified through contacts on file, and an email could alert a fraudster."
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
            {fmtDate(run.createdAt)} · {run.extractionMethod} · {run.model} · decided in {fmtSecs(run.durationMs)}
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

// ---------------- Tabs ----------------

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? "on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab-n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
