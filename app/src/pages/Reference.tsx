import { useState } from "react";
import { Search } from "lucide-react";
import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { buildLedger, isConfirmed, maskAccount, money } from "../lib/engine";
import { openCases } from "../lib/analytics";
import { Tabs } from "../runView";
import { Shell } from "../Shell";
import { useRuns } from "../ui";

type Tab = "po" | "vendors" | "payments";

export default function Reference() {
  const { runs } = useRuns();
  const [tab, setTab] = useState<Tab>("po");
  const [q, setQ] = useState("");
  const ledger = buildLedger(ERP_LEDGER, runs);
  const confirmed = (id: string) => ledger.filter((l) => l.poId === id && isConfirmed(l)).reduce((s, l) => s + l.total, 0);
  const pending = (id: string) => ledger.filter((l) => l.poId === id && !isConfirmed(l)).reduce((s, l) => s + l.total, 0);
  const needle = q.trim().toLowerCase();
  const hit = (...xs: (string | null | undefined)[]) => !needle || xs.some((x) => x?.toLowerCase().includes(needle));

  return (
    <Shell page="reference" openCount={openCases(runs).length}>
      <header className="page-head">
        <div>
          <h1 className="h1">Reference data</h1>
          <p className="sub">The records every invoice is checked against. Demo data standing in for the ERP.</p>
        </div>
      </header>
      <section className="card">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => (setTab(t), setQ(""))}
          tabs={[
            { id: "po", label: "Purchase orders", count: PURCHASE_ORDERS.length },
            { id: "vendors", label: "Vendors", count: VENDORS.length },
            { id: "payments", label: "Payment history", count: ERP_LEDGER.length },
          ]}
        />
        <div className="toolbar">
          <label className="search">
            <Search size={16} aria-hidden />
            <input className="input" placeholder={tab === "po" ? "Search PO, vendor or item" : tab === "vendors" ? "Search vendor" : "Search invoice or vendor"} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {tab === "po" && <span className="muted small">Billed = paid or approved. Pending = in review or on hold, not committed.</span>}
          {tab === "vendors" && <span className="muted small">Bank account we pay to, and the contact used to verify changes.</span>}
          {tab === "payments" && <span className="muted small">Invoices with an ERP payment record (demo data).</span>}
        </div>
        <div className="table-wrap">
          {tab === "po" && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Vendor</th>
                  <th>Items ordered</th>
                  <th className="num">Value</th>
                  <th className="num">Billed</th>
                  <th className="num">Pending</th>
                  <th className="num">Remaining</th>
                  <th>Owner</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {PURCHASE_ORDERS.filter((p) => hit(p.id, p.vendor, p.approvedBy, ...p.lineItems.map((l) => l.description))).map((p) => {
                  const b = confirmed(p.id);
                  const pd = pending(p.id);
                  const pct = Math.min(100, (b / p.total) * 100);
                  return (
                    <tr key={p.id}>
                      <td className="mono strong">{p.id}</td>
                      <td>{p.vendor}</td>
                      <td className="muted small">{p.lineItems.map((l) => `${l.quantity} × ${l.description}`).join("; ")}</td>
                      <td className="num">{money(p.total, p.currency)}</td>
                      <td className="num">
                        {money(b, p.currency)}
                        <span className="util" aria-hidden>
                          <span style={{ width: `${pct}%` }} />
                        </span>
                      </td>
                      <td className="num muted">{pd ? money(pd, p.currency) : "—"}</td>
                      <td className={`num strong ${p.total - b < 0 ? "t-bad" : ""}`}>{money(p.total - b, p.currency)}</td>
                      <td>{p.approvedBy}</td>
                      <td>
                        <span className={`pill ${p.status === "open" ? "pill-ok" : "pill-warn"}`}>{p.status === "open" ? "Open" : `Expired ${p.expirationDate}`}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {tab === "vendors" && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Also known as</th>
                  <th>Bank account</th>
                  <th>Verification contact</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {VENDORS.filter((v) => hit(v.id, v.name, ...v.aliases)).map((v) => (
                  <tr key={v.id}>
                    <td>
                      <div className="strong">{v.name}</div>
                      <div className="muted small mono">{v.id}</div>
                    </td>
                    <td className="muted small">{v.aliases.join(", ")}</td>
                    <td className="tabnum">
                      {maskAccount(v.bankAccount)} <span className="muted">· {v.bankName}</span>
                    </td>
                    <td className="tabnum">{v.phone}</td>
                    <td>
                      <span className="pill pill-ok">Active</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "payments" && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th>PO</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {ERP_LEDGER.filter((l) => hit(l.invoiceNumber, l.vendor, l.poId)).map((l) => (
                  <tr key={l.invoiceNumber}>
                    <td className="mono strong">{l.invoiceNumber}</td>
                    <td>{l.vendor}</td>
                    <td className="mono">{l.poId ?? "—"}</td>
                    <td className="tabnum">{l.issueDate}</td>
                    <td className="num">{money(l.total)}</td>
                    <td>
                      <span className="pill pill-ok">Paid</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </Shell>
  );
}
