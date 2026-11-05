import { useEffect, useState, type ReactNode } from "react";
import { checkHealth, type HealthResult } from "./lib/llm";
import { Icon } from "./ui";

export type Page = "overview" | "process" | "queue" | "history" | "reference" | "policy";

const NAV: { id: Page; label: string; href: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", href: "/", icon: Icon.overview },
  { id: "process", label: "Process invoice", href: "/process", icon: Icon.process },
  { id: "queue", label: "Review queue", href: "/queue", icon: Icon.queue },
  { id: "history", label: "Invoice history", href: "/history", icon: Icon.history },
];
const NAV2: { id: Page; label: string; href: string; icon: ReactNode }[] = [
  { id: "reference", label: "Reference data", href: "/reference", icon: Icon.data },
  { id: "policy", label: "Policy rules", href: "/policy", icon: Icon.policy },
];

export function Shell({ page, openCount, children }: { page: Page; openCount?: number; children: ReactNode }) {
  const [health, setHealth] = useState<HealthResult | null>(null);
  useEffect(() => {
    checkHealth().then(setHealth);
  }, []);
  const item = (n: (typeof NAV)[number]) => (
    <a key={n.id} href={n.href} className={`nav-item ${page === n.id ? "on" : ""}`} aria-current={page === n.id ? "page" : undefined}>
      {n.icon}
      <span>{n.label}</span>
      {n.id === "queue" && !!openCount && <span className="nav-count">{openCount}</span>}
    </a>
  );
  return (
    <div className="app">
      <aside className="side">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden>
            ID
          </span>
          <span>
            <span className="brand-name">Invoice Decision Desk</span>
            <span className="brand-sub">Accounts payable</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(item)}
          <div className="nav-sep" />
          {NAV2.map(item)}
        </nav>
        <div className="side-foot">
          <div className="svc" title={health?.reason ?? ""}>
            <span className={`dot ${health === null ? "dot-wait" : health.ok ? "dot-ok" : "dot-err"}`} />
            {health === null ? "Checking AI service" : health.ok ? "AI service connected" : "AI service not configured"}
          </div>
          {health?.ok && <div className="svc-model">{health.model}</div>}
          <span className="env">Demo environment</span>
        </div>
      </aside>
      <main className="main">
        {health && !health.ok && <div className="alert alert-err" style={{ marginBottom: 16 }}>{health.reason}</div>}
        {children}
      </main>
    </div>
  );
}
