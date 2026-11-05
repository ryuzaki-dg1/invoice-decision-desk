import { useEffect, useState, type ReactNode } from "react";
import { Database, FileUp, History, Inbox, LayoutDashboard, ShieldCheck } from "lucide-react";
import { checkHealth, type HealthResult } from "./lib/llm";

export type Page = "overview" | "process" | "queue" | "history" | "reference" | "policy";

const NAV: { id: Page; label: string; href: string; icon: typeof Inbox }[] = [
  { id: "overview", label: "Overview", href: "/", icon: LayoutDashboard },
  { id: "process", label: "Process invoice", href: "/process", icon: FileUp },
  { id: "queue", label: "Review queue", href: "/queue", icon: Inbox },
  { id: "history", label: "Invoice history", href: "/history", icon: History },
];
const NAV2: typeof NAV = [
  { id: "reference", label: "Reference data", href: "/reference", icon: Database },
  { id: "policy", label: "Policy rules", href: "/policy", icon: ShieldCheck },
];

export function Shell({ page, openCount, children, wide }: { page: Page; openCount?: number; children: ReactNode; wide?: boolean }) {
  const [health, setHealth] = useState<HealthResult | null>(null);
  useEffect(() => {
    checkHealth().then(setHealth);
  }, []);
  const item = (n: (typeof NAV)[number]) => {
    const I = n.icon;
    return (
      <a key={n.id} href={n.href} className={`nav-item ${page === n.id ? "on" : ""}`} aria-current={page === n.id ? "page" : undefined}>
        <I size={18} strokeWidth={2} aria-hidden />
        <span>{n.label}</span>
        {n.id === "queue" && !!openCount && <span className="nav-count">{openCount}</span>}
      </a>
    );
  };
  return (
    <div className="app">
      <aside className="side">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M6 3h9l4 4v14H6z" fill="#fff" fillOpacity=".25" />
              <path d="M6 3h9l4 4v14H6zM15 3v4h4" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
              <path d="M9.5 14.5l2 2 3.5-4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            <span className="brand-name">Invoice Decision Desk</span>
            <span className="brand-sub">Accounts Payable</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(item)}
        </nav>
        <div className="nav-label">Configuration</div>
        <nav className="nav">{NAV2.map(item)}</nav>
        <div className="side-foot">
          <div className="svc" title={health?.reason ?? health?.model ?? ""}>
            <span className={`dot ${health === null ? "dot-wait" : health.ok ? "dot-ok" : "dot-err"}`} />
            <span>
              {health === null ? "Checking AI…" : health.ok ? "AI extraction online" : "AI not configured"}
              {health?.ok && <small>{health.model}</small>}
            </span>
          </div>
          <span className="env">Demo environment</span>
        </div>
      </aside>
      <main className={`main ${wide ? "main-wide" : ""}`}>
        {health && !health.ok && <div className="alert alert-err">{health.reason}</div>}
        {children}
      </main>
    </div>
  );
}
