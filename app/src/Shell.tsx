import { useEffect, useState, type ReactNode } from "react";
import { checkHealth, type HealthResult } from "./lib/llm";

export function Shell({ active, pending, children }: { active: "process" | "dashboard"; pending: number; children: ReactNode }) {
  const [health, setHealth] = useState<HealthResult | null>(null);
  useEffect(() => {
    checkHealth().then(setHealth);
  }, []);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">AP</div>
          <div>
            <div className="brand-name">Invoice Decision Desk</div>
            <div className="brand-sub">PDF in → checked against POs, vendors and history → reasoned decision out</div>
          </div>
        </div>
        <nav className="tabs">
          <a className={`tab ${active === "process" ? "tab-on" : ""}`} href="/">
            Process invoice
          </a>
          <a className={`tab ${active === "dashboard" ? "tab-on" : ""}`} href="/dashboard">
            Dashboard {pending > 0 && <span className="count">{pending}</span>}
          </a>
        </nav>
        <div className="health" title={health?.reason ?? ""}>
          <span className={`dot ${health === null ? "dot-wait" : health.ok ? "dot-ok" : "dot-err"}`} />
          {health === null ? "checking…" : health.ok ? `${health.provider} · ${health.model}` : "LLM not configured"}
        </div>
      </header>
      {health && !health.ok && <div className="banner-err">{health.reason}</div>}
      {children}
    </div>
  );
}
