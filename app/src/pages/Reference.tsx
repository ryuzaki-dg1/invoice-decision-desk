import { useState } from "react";
import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { buildLedger, isConfirmed, isOpen, maskAccount, money } from "../lib/engine";
import { Tabs } from "../runView";
import { Shell } from "../Shell";
import { Icon, useRuns } from "../ui";

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
    <Shell page="reference" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <header className="page-head">
        <div>
          <div className="eyebrow">Reference data · demo data standing in for the ERP</div>
          <h1 className="display-sm">What every invoice is checked against</h1>
        </div>
      </header>
      <section className="surface">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "po", label: "Purchase orders", count: PURCHASE_ORDERS.length },
            { id: "vendors", label: "Vendor master", count: VENDORS.length },
            { id: "payments", label: "Payment history", count: ERP_LEDGER.length },
          ]}
        />
        <div className="toolbar">
          <label className="search">
            {Icon.search}
            <input className="input" placeholder="Search" aria-label="Search reference data" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {tab === "po" && <span className="small muted">Confirmed = paid in ERP or approved here. Pending = in review or on hold here; not committed spend.</span>}
        </div>
        <div className="table-wrap">
          {tab === "po" && (
            <table className="dense">
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Vendor</th>
                  <th>Ordered</th>
                  <th className="num">PO value</th>
                  <th className="num">Confirmed billed</th>
                  <th className="num">Pending</th>
                  <th className="num">Remaining</th>
                  <th>Expires</th>
                  <th>Owner</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {PURCHASE_ORDERS.filter((p) => hit(p.id, p.vendor, p.approvedBy, ...p.lineItems.map((l) => l.description))).map((p) => {
                  const cb = confirmed(p.id);
                  const pb = pending(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="mono strong">{p.id}</td>
                      <td>{p.vendor}</td>
                      <td className="muted">{p.lineItems.map((l) => `${l.quantity} × ${l.description}`).join("; ")}</td>
                      <td className="num">{money(p.total, p.currency)}</td>
                      <td className="num">{money(cb, p.currency)}</td>
                      <td className="num muted">{pb ? money(pb, p.currency) : "—"}</td>
                      <td className={`num ${p.total - cb < 0 ? "t-bad" : ""}`}>{money(p.total - cb, p.currency)}</td>
                      <td className="tabnum">{p.expirationDate}</td>
                      <td>{p.approvedBy}</td>
                      <td>
                        <span className={`tag ${p.status === "open" ? "tag-ok" : "tag-warn"}`}>{p.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {tab === "vendors" && (
            <table className="dense">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Vendor</th>
                  <th>Also known as</th>
                  <th>Bank account we pay to</th>
                  <th>Trusted contact</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {VENDORS.filter((v) => hit(v.id, v.name, ...v.aliases)).map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.id}</td>
                    <td className="strong">{v.name}</td>
                    <td className="muted">{v.aliases.join(", ")}</td>
                    <td className="tabnum">
                      {maskAccount(v.bankAccount)} <span className="muted">· {v.bankName}</span>
                    </td>
                    <td className="tabnum">{v.phone}</td>
                    <td>
                      <span className="tag tag-ok">{v.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "payments" && (
            <table className="dense">
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
                      <span className="tag tag-ok">Paid · payment record</span>
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
