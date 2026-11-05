// Shared UI primitives and hooks.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, CirclePause, Clock3, Scale, Sparkles, XCircle, X } from "lucide-react";
import { statusLabel } from "./lib/engine";
import { fetchRuns } from "./lib/runsApi";
import type { CaseStatus, CheckAction, Resolution, RunRecord } from "./types";

export const STATUS_COLOR: Record<CaseStatus, string> = {
  approved: "#059669",
  needs_review: "#D97706",
  awaiting_info: "#D97706",
  payment_hold: "#EA580C",
  rejected: "#DC2626",
};

const STATUS_ICON: Record<CaseStatus, typeof CheckCircle2> = {
  approved: CheckCircle2,
  needs_review: CircleAlert,
  awaiting_info: Clock3,
  payment_hold: CirclePause,
  rejected: XCircle,
};

export const resolutionToStatus = (r: Resolution): CaseStatus =>
  r === "AUTO_APPROVE" ? "approved" : r === "REJECT" ? "rejected" : r === "ESCALATE" ? "payment_hold" : "needs_review";

export function StatusBadge({ status, large }: { status: CaseStatus; large?: boolean }) {
  const I = STATUS_ICON[status];
  return (
    <span className={`badge st-${status} ${large ? "badge-lg" : ""}`}>
      <I size={large ? 16 : 13} strokeWidth={2.4} aria-hidden /> {statusLabel(status)}
    </span>
  );
}

export const SEVERITY: Record<CheckAction, { label: string; rank: number }> = {
  reject: { label: "Critical", rank: 3 },
  escalate: { label: "High", rank: 2 },
  review: { label: "Medium", rank: 1 },
  info: { label: "Info", rank: 0 },
};

export function SeverityDot({ action, withLabel }: { action: CheckAction; withLabel?: boolean }) {
  return (
    <span className={`sevdot sev-${action}`} title={`${SEVERITY[action].label} severity`}>
      <i aria-hidden />
      {withLabel && SEVERITY[action].label}
    </span>
  );
}

// Makes "who did what" explicit everywhere: AI reads, rules decide.
export function Attribution({ kind, children }: { kind: "ai" | "rules" | "human"; children?: ReactNode }) {
  return (
    <span className={`attr attr-${kind}`}>
      {kind === "ai" ? <Sparkles size={13} aria-hidden /> : <Scale size={13} aria-hidden />}
      {children ?? (kind === "ai" ? "Read by AI" : kind === "rules" ? "Decided by rules" : "Reviewer")}
    </span>
  );
}

export function topFinding(run: RunRecord) {
  const resolved = new Set(run.resolvedCodes ?? []);
  return run.findings.filter((f) => f.action !== "info" && !resolved.has(f.code)).sort((a, b) => SEVERITY[b.action].rank - SEVERITY[a.action].rank)[0];
}

export function useRuns() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(
    () =>
      fetchRuns()
        .then(setRuns)
        .catch(() => setRuns([]))
        .finally(() => setLoaded(true)),
    [],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  const replace = useCallback((r: RunRecord) => setRuns((prev) => prev.map((x) => (x.id === r.id ? r : x))), []);
  return { runs, loaded, reload, replace, setRuns };
}

// One demo reviewer identity shared by every panel on the page.
const reviewerListeners = new Set<(s: string) => void>();
export function useReviewer(): [string, (s: string) => void] {
  const [name, setName] = useState(() => localStorage.getItem("demo_reviewer") ?? "");
  useEffect(() => {
    reviewerListeners.add(setName);
    return () => {
      reviewerListeners.delete(setName);
    };
  }, []);
  return [
    name,
    (s: string) => {
      localStorage.setItem("demo_reviewer", s);
      reviewerListeners.forEach((fn) => fn(s));
    },
  ];
}

export function useDensity(): ["summary" | "detailed", (v: "summary" | "detailed") => void] {
  const [v, setV] = useState<"summary" | "detailed">(() => (localStorage.getItem("density") === "detailed" ? "detailed" : "summary"));
  return [
    v,
    (n) => {
      setV(n);
      localStorage.setItem("density", n);
    },
  ];
}

export function useToast(): [ReactNode, (msg: string, kind?: "ok" | "err") => void] {
  const [t, setT] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3600);
    return () => clearTimeout(id);
  }, [t]);
  const node = t ? (
    <div className={`toast ${t.kind === "err" ? "toast-err" : ""}`} role="status">
      {t.kind === "err" ? <XCircle size={16} /> : <CheckCircle2 size={16} />} {t.msg}
    </div>
  ) : null;
  return [node, (msg, kind = "ok") => setT({ msg, kind })];
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-sub">{children}</div>}
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
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const fmtDate = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtSecs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
