// Small shared UI primitives and hooks.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { statusLabel } from "./lib/engine";
import { fetchRuns } from "./lib/runsApi";
import type { CaseStatus, CheckAction, Resolution, RunRecord } from "./types";

// Validated as a set for charts; always shown with a text label.
export const STATUS_COLOR: Record<CaseStatus, string> = {
  approved: "#14a06f",
  needs_review: "#e9a23b",
  awaiting_info: "#e9a23b",
  payment_hold: "#d9622b",
  rejected: "#8e1d2c",
};

export const resolutionToStatus = (r: Resolution): CaseStatus =>
  r === "AUTO_APPROVE" ? "approved" : r === "REJECT" ? "rejected" : r === "ESCALATE" ? "payment_hold" : "needs_review";

export function StatusBadge({ status, large }: { status: CaseStatus; large?: boolean }) {
  return (
    <span className={`badge st-${status} ${large ? "badge-lg" : ""}`}>
      <i aria-hidden /> {statusLabel(status)}
    </span>
  );
}

export const SEVERITY: Record<CheckAction, { label: string; rank: number }> = {
  reject: { label: "Critical", rank: 3 },
  escalate: { label: "High", rank: 2 },
  review: { label: "Medium", rank: 1 },
  info: { label: "Info", rank: 0 },
};

export function Severity({ action }: { action: CheckAction }) {
  return <span className={`sev sev-${action}`}>{SEVERITY[action].label}</span>;
}

// Most severe finding that is still open (reviewer-resolved controls excluded).
export function topFinding(run: RunRecord) {
  const resolved = new Set(run.resolvedCodes ?? []);
  return run.findings.filter((f) => f.action !== "info" && !resolved.has(f.code)).sort((a, b) => SEVERITY[b.action].rank - SEVERITY[a.action].rank)[0];
}

// Short "why" for tables, consistent with the current status.
export function primaryReason(run: RunRecord, label: (f: NonNullable<ReturnType<typeof topFinding>>) => string): string {
  const reviewer = [...run.audit].reverse().find((e) => e.kind === "reviewer");
  if (run.status === "approved") return reviewer ? `Cleared by ${reviewer.actor}` : "All checks passed";
  if (run.status === "rejected" && reviewer) return `Rejected by ${reviewer.actor}`;
  const f = topFinding(run);
  return f ? label(f) : "—";
}

export function useRuns() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    return fetchRuns()
      .then((r) => {
        setRuns(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const replace = useCallback((r: RunRecord) => setRuns((prev) => prev.map((x) => (x.id === r.id ? r : x))), []);
  return { runs, loaded, error, reload, replace, setRuns };
}

export function useReviewer(): [string, (s: string) => void] {
  const [name, setName] = useState(() => localStorage.getItem("demo_reviewer") ?? "");
  return [
    name,
    (s: string) => {
      setName(s);
      localStorage.setItem("demo_reviewer", s);
    },
  ];
}

export function useToast(): [ReactNode, (msg: string, kind?: "ok" | "err") => void] {
  const [t, setT] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3200);
    return () => clearTimeout(id);
  }, [t]);
  const node = t ? (
    <div className={`toast ${t.kind === "err" ? "toast-err" : ""}`} role="status">
      {t.msg}
    </div>
  ) : null;
  return [node, (msg, kind = "ok") => setT({ msg, kind })];
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 10 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18 }} />
      ))}
    </div>
  );
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export const fmtDate = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---- Icons (inline, 16px) ----
const I = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
export const Icon = {
  overview: I(
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>,
  ),
  process: I(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 17v-6M9 14l3-3 3 3" />
    </>,
  ),
  queue: I(
    <>
      <path d="M4 5h16M4 12h10M4 19h7" />
      <circle cx="18" cy="17" r="3" />
    </>,
  ),
  history: I(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 3" />
    </>,
  ),
  data: I(
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>,
  ),
  policy: I(
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>,
  ),
  search: I(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
  ),
  arrow: I(<path d="M5 12h14M13 6l6 6-6 6" />),
  close: I(<path d="M6 6l12 12M18 6L6 18" />),
};
