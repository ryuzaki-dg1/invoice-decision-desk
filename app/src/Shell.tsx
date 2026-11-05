import { useEffect, useState, type ReactNode } from "react";
import { checkHealth, type HealthResult } from "./lib/llm";
import { Icon } from "./ui";

export type Page = "overview" | "process" | "queue" | "history" | "reference" | "policy";

const NAV: { id: Page; label: string; href: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", href: "/", icon: Icon.overview },
  { id: "process", label: "Process Invoice", href: "/process", icon: Icon.process },
  { id: "queue", label: "Review Queue", href: "/queue", icon: Icon.queue },
  { id: "history", label: "Invoice History", href: "/history", icon: Icon.history },
];
const NAV2: { id: Page; label: string; href: string; icon: ReactNode }[] = [
  { id: "reference", label: "Reference Data", href: "/reference", icon: Icon.data },
  { id: "policy", label: "Policy Rules", href: "/policy", icon: Icon.policy },
];

export function Shell({ page, openCount, children }: { page: Page; openCount?: number; children: ReactNode }) {
  const [health, setHealth] = useState<HealthResult | null>(null);
  useEffect(() => {
    checkHealth().then(setHealth);
  }, []);
  const item = (n: (typeof NAV)[number]) => (
    <a key={n.id} href={n.href} className={`nav-item ${page === n.id ? "nav-on" : ""}`}>
      {n.icon}
      {n.label}
      {n.id === "queue" && !!openCount && <span className="nav-count">{openCount}</span>}
    </a>
  );
  return (
    <div className="app">
      <aside className="side">
        <div className="side-brand">
          <div className="logo">ID</div>
          <div>
            <div className="side-name">Invoice Decision Desk</div>
            <div className="side-tag">Accounts payable</div>
          </div>
        </div>
        <nav className="nav">{NAV.map(item)}</nav>
        <div className="nav-sep" />
        <nav className="nav">{NAV2.map(item)}</nav>
        <div className="side-foot">
          <div className="svc" title={health?.reason ?? ""}>
            <span className={`dot ${health === null ? "dot-wait" : health.ok ? "dot-ok" : "dot-err"}`} />
            {health === null ? "Checking AI service…" : health.ok ? "AI service connected" : "AI service not configured"}
          </div>
          {health?.ok && <div className="mono" style={{ fontSize: 11.5 }}>{health.model}</div>}
          <div>
            <span className="env-tag">Demo environment</span>
          </div>
        </div>
      </aside>
      <main className="main">
        {health && !health.ok && <div className="banner-err">{health.reason}</div>}
        {children}
      </main>
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <div className="page-sub">{sub}</div>
      </div>
      {action}
    </div>
  );
}
