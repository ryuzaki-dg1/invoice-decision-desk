import { PURCHASE_ORDERS } from "../data/purchaseOrders";
import { ERP_LEDGER, VENDORS } from "../data/vendors";
import { buildLedger, isOpen, maskAccount, money } from "../lib/engine";
import { PageHead, Shell } from "../Shell";
import { useRuns } from "../ui";

export default function Reference() {
  const { runs } = useRuns();
  const ledger = buildLedger(ERP_LEDGER, runs);
  const billed = (id: string) => ledger.filter((l) => l.poId === id).reduce((s, l) => s + l.total, 0);
  return (
    <Shell page="reference" openCount={runs.filter((r) => isOpen(r.status)).length}>
      <PageHead title="Reference data" sub="The records every invoice is checked against. Demo data standing in for the ERP." />
      <div className="ref-grid">
        <section className="card">
          <div className="card-head">
            <div className="card-title">Purchase orders</div>
            <span className="small muted">Billed = paid ERP invoices + invoices processed here that were not rejected</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Vendor</th>
                  <th>Lines</th>
                  <th className="num">PO value</th>
                  <th className="num">Billed</th>
                  <th className="num">Remaining</th>
                  <th>Expires</th>
                  <th>Owner</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {PURCHASE_ORDERS.map((p) => {
                  const b = billed(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="mono cell-strong">{p.id}</td>
                      <td>{p.vendor}</td>
                      <td className="small">{p.lineItems.map((l) => `${l.quantity} × ${l.description}`).join("; ")}</td>
                      <td className="num">{money(p.total, p.currency)}</td>
                      <td className="num">{money(b, p.currency)}</td>
                      <td className="num" style={p.total - b < 0 ? { color: "var(--bad-ink)" } : undefined}>
                        {money(p.total - b, p.currency)}
                      </td>
                      <td className="tabnum">{p.expirationDate}</td>
                      <td>{p.approvedBy}</td>
                      <td>
                        <span className="chip">{p.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-title">Vendor master</div>
            <span className="small muted">Approved payees, the bank account we pay to, and the trusted contact for call-back verification</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Vendor</th>
                  <th>Also known as</th>
                  <th>Bank account</th>
                  <th>Trusted contact</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {VENDORS.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.id}</td>
                    <td className="cell-strong">{v.name}</td>
                    <td className="small muted">{v.aliases.join(", ")}</td>
                    <td>
                      {maskAccount(v.bankAccount)} <span className="muted small">· {v.bankName}</span>
                    </td>
                    <td className="tabnum">{v.phone}</td>
                    <td>
                      <span className="chip">{v.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-title">ERP payment history</div>
            <span className="env-tag">Demo data</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th>PO</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ERP_LEDGER.map((l) => (
                  <tr key={l.invoiceNumber}>
                    <td className="mono cell-strong">{l.invoiceNumber}</td>
                    <td>{l.vendor}</td>
                    <td className="mono">{l.poId ?? "—"}</td>
                    <td className="tabnum">{l.issueDate}</td>
                    <td className="num">{money(l.total)}</td>
                    <td>
                      <span className="chip">Paid (payment record)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  );
}
