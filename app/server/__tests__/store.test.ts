// Server-side guarantees: the store re-runs the deterministic checks itself, so
// a forged or stale client record, a retry or two simultaneous uploads cannot
// create an approved or duplicate payable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Invoice, RunRecord } from "../../src/types.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "zamp-store-"));
const store = await import("../store.ts");

function invoice(p: Partial<Invoice>): Invoice {
  return { vendor: "Acme Industrial Supply Co.", invoiceNumber: "INV-1047", poReference: "PO-2026-0142", issueDate: "2026-11-02", dueDate: "2026-12-02", paymentTerms: "Net 30", lineItems: [{ description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 }, { description: "Lock washer M8 (box of 500)", quantity: 10, unitPrice: 18.5, total: 185 }], subtotal: 1235, tax: 98.8, shipping: 45.85, otherCharges: 0, discount: 0, total: 1379.65, currency: "USD", bankAccount: "4410 2287 4821", documentType: "digital", lowConfidenceFields: [], ...p };
}

// What a (possibly stale or tampered) browser would send: it claims "approved".
function forged(inv: Invoice, fileHash: string): Omit<RunRecord, "id"> {
  return {
    createdAt: Date.now(),
    durationMs: 1,
    fileName: "x.pdf",
    fileHash,
    pageCount: 1,
    extractionMethod: "test",
    invoice: inv,
    vendorId: "V-001",
    vendorMatched: "Acme Industrial Supply Co.",
    poMatch: { po: null, method: "none" },
    findings: [],
    decision: { resolution: "AUTO_APPROVE", headline: "Approved: all checks passed", decidingCodes: [], nextAction: "" },
    explanation: { summary: "forged", vendorEmail: null, generatedBy: "template" },
    stages: [],
    model: "test",
    status: "approved",
    resolvedCodes: ["BANK_ACCOUNT_MISMATCH"],
    hasPreview: false,
    repeatSubmission: false,
    audit: [{ at: 0, actor: "Mallory", kind: "reviewer", action: "Approved", toStatus: "approved" }],
  };
}

test("a forged 'approved' record with a changed bank account is re-decided as a payment hold", async () => {
  const run = await store.addRun(forged(invoice({ invoiceNumber: "INV-9001", bankAccount: "8830 1177 9934" }), "forged-1"));
  assert.equal(run.status, "payment_hold");
  assert.ok(run.findings.some((f) => f.code === "BANK_ACCOUNT_MISMATCH"));
  assert.deepEqual(run.resolvedCodes, [], "client-supplied resolutions are discarded");
  assert.equal(run.audit.length, 1);
  assert.equal(run.audit[0].actor, "System", "client-supplied audit events are discarded");
});

test("a retried upload (same invoice, new request) and two simultaneous uploads create one payable", async () => {
  const inv = invoice({ invoiceNumber: "INV-9100" });
  const [a, b] = await Promise.all([store.addRun(forged(inv, "race-a")), store.addRun(forged(inv, "race-b"))]);
  assert.equal([a, b].filter((r) => r.status === "rejected").length, 1, "exactly one survives, the other is a blocked duplicate");
  const loser = a.status === "rejected" ? a : b;
  assert.ok(loser.findings.some((f) => f.code === "DUPLICATE_INVOICE"));
  const retry = await store.addRun(forged(inv, "race-a")); // same file again
  assert.equal(retry.status, "rejected");
  assert.equal(retry.repeatSubmission, true);
  const all = await store.listRuns();
  assert.equal(all.filter((r) => r.invoice.invoiceNumber === "INV-9100" && r.status !== "rejected").length, 1, "counted once toward the PO");
  assert.equal(all.length, new Set(all.map((r) => r.id)).size, "no record was lost or overwritten");
});

test("approving after another invoice used the PO re-checks and blocks instead of overspending", async () => {
  const line = (q: number) => ({ description: 'PCB assembly rev 3.2 - "Orion"', quantity: q, unitPrice: 87.5, total: q * 87.5 });
  const base = { vendor: "Bluepeak Components Inc.", poReference: "PO-2026-0184", otherCharges: 0, discount: 0 };
  const A = await store.addRun(forged(invoice({ ...base, invoiceNumber: "SRV-A", lineItems: [line(60)], subtotal: 5250, tax: 420, shipping: 120, total: 5790, bankAccount: "5550 1234 7777" }), "srv-a"));
  assert.equal(A.status, "payment_hold");
  const B = await store.addRun(forged(invoice({ ...base, invoiceNumber: "SRV-B", lineItems: [line(45)], subtotal: 3937.5, tax: 315, shipping: 0, total: 4252.5, bankAccount: null }), "srv-b"));
  // B conflicts with the pending A, so it needs review; authorise and approve it first.
  const po = await store.actOnRun(B.id, { action: "resolve_po", reviewer: "Sam", justification: "Owner authorised the combined spend", authorizedBy: "a.patel", reference: "AMD-1" });
  assert.equal(po.status, 200);
  const bApproved = await store.actOnRun(B.id, { action: "approve", reviewer: "Sam", justification: "All controls resolved and recorded" });
  assert.equal(bApproved.status, 200);
  await store.actOnRun(A.id, { action: "verify_bank", reviewer: "Priya", justification: "Called Bluepeak on the master number", verificationConfirmed: true, verificationReference: "Call 9 Nov, A. Rao" });
  const res = await store.actOnRun(A.id, { action: "approve", reviewer: "Priya", justification: "Bank verified and everything else is resolved" });
  assert.equal(res.status, 409, "approval refused");
  assert.match((res.body as { error: string }).error, /CUMULATIVE_PO_EXCEEDED|QUANTITY_EXCEEDS_PO/);
  const stored = (await store.listRuns()).find((r) => r.id === A.id)!;
  assert.notEqual(stored.status, "approved");
  assert.ok(stored.findings.some((f) => f.code === "CUMULATIVE_PO_EXCEEDED"), "new blocker recorded on the case");
  assert.equal(stored.audit.length, 3, "history kept (decision, bank verification) and extended (stale check)");
  assert.equal(stored.audit.at(-1)!.kind, "system");
  assert.equal((await store.actOnRun(A.id, { action: "approve", reviewer: "Priya", justification: "Trying to approve again anyway" })).status, 409, "still blocked");
});

test("a browser-supplied policy snapshot is ignored on new runs and on later corrections", async () => {
  const run = await store.addRun({ ...forged(invoice({ invoiceNumber: "INV-9100", total: 90000, subtotal: 89000, tax: 0, shipping: 1000, lineItems: [{ description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 3560, total: 89000 }] }), "rules-1"), rules: { autoApproveLimit: 10_000_000, amountTolerancePct: 9, priceTolerancePct: 9, quantityTolerance: 9999, arithmeticToleranceAbs: 9999, duplicateWindowDays: 0, reviewHandwritten: false } });
  assert.equal(run.rules?.autoApproveLimit, 25000);
  assert.notEqual(run.status, "approved");
  const res = await store.correctRun(run.id, { reviewer: "Dana", reason: "Typo fixed per the printed document", source: "Page 1 total line", changes: [{ field: "shipping", value: "1000" }] } as never);
  const body = res.body as RunRecord;
  if (res.status === 200) assert.equal(body.rules?.autoApproveLimit, 25000);
  assert.notEqual(body.status ?? "needs_review", "approved");
});
