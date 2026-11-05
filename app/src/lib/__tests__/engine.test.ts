// Deterministic engine + review-rule tests. Each demo scenario, fed the fields
// the model would extract, must land on the expected decision for the right reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PURCHASE_ORDERS } from "../../data/purchaseOrders.ts";
import { ERP_LEDGER, VENDORS } from "../../data/vendors.ts";
import type { Invoice, LedgerInvoice, RunRecord } from "../../types.ts";
import { buildLedger, checkDuplicates, checkVendor, decide, initialStatus, matchPurchaseOrder, normalizeInvoiceNumber, validateInvoice, type PriorSubmission } from "../engine.ts";
import { applyReviewAction, availableActions } from "../review.ts";
import { DEFAULT_RULES } from "../rules.ts";

const TODAY = "2026-11-05";

function inv(p: Partial<Invoice>): Invoice {
  return {
    vendor: "",
    invoiceNumber: null,
    poReference: null,
    issueDate: "2026-11-02",
    dueDate: null,
    paymentTerms: "Net 30",
    lineItems: [],
    subtotal: null,
    tax: 0,
    shipping: 0,
    otherCharges: 0,
    discount: 0,
    total: null,
    currency: "USD",
    bankAccount: null,
    documentType: "digital",
    lowConfidenceFields: [],
    ...p,
  };
}

function run(i: Invoice, ledger: LedgerInvoice[] = ERP_LEDGER, hash = "h-new", prior: PriorSubmission[] = []) {
  const findings = [...validateInvoice(i, DEFAULT_RULES)];
  const v = checkVendor(i, VENDORS);
  findings.push(...v.findings);
  const pm = matchPurchaseOrder(i, v.vendor, PURCHASE_ORDERS, ledger, DEFAULT_RULES, TODAY);
  findings.push(...pm.findings);
  const dup = checkDuplicates(i, v.vendor, ledger, DEFAULT_RULES, hash, prior);
  findings.push(...dup.findings);
  const { decision, extra } = decide(i, findings, DEFAULT_RULES, v.vendor, dup.duplicateOf, pm.poMatch);
  const all = [...findings, ...extra];
  return { decision, findings: all, poMatch: pm.poMatch, dup, vendor: v.vendor, codes: all.map((f) => f.code), blocking: all.filter((f) => f.action !== "info").map((f) => f.code) };
}

function asRun(i: Invoice, r: ReturnType<typeof run>, id: string): RunRecord {
  const status = initialStatus(r.decision.resolution);
  return {
    id,
    createdAt: Date.now(),
    durationMs: 1,
    fileName: `${id}.pdf`,
    fileHash: id,
    pageCount: 1,
    extractionMethod: "test",
    invoice: i,
    vendorId: r.vendor?.id ?? null,
    vendorMatched: r.vendor?.name ?? null,
    poMatch: r.poMatch,
    findings: r.findings,
    decision: r.decision,
    explanation: { summary: "", vendorEmail: null, generatedBy: "template" },
    stages: [],
    model: "test",
    status,
    resolvedCodes: [],
    hasPreview: false,
    repeatSubmission: false,
    audit: [{ at: 0, actor: "System", kind: "system", action: "decision", toStatus: status }],
  };
}

const HAPPY = inv({
  vendor: "Acme Industrial Supply Co.",
  invoiceNumber: "INV-1047",
  poReference: "PO-2026-0142",
  dueDate: "2026-12-02",
  lineItems: [
    { description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 },
    { description: "Lock washer M8 (box of 500)", quantity: 10, unitPrice: 18.5, total: 185 },
  ],
  subtotal: 1235,
  tax: 98.8,
  shipping: 45.85,
  total: 1379.65,
  bankAccount: "4410 2287 4821",
});

const BANK_CHANGE = inv({
  vendor: "Acme Industrial Supply",
  invoiceNumber: "INV-1052",
  poReference: "PO-2026-0198",
  lineItems: [{ description: "Stainless steel sheet 4x8 (16ga)", quantity: 20, unitPrice: 145, total: 2900 }],
  subtotal: 2900,
  tax: 232,
  shipping: 140,
  total: 3272,
  bankAccount: "8830 1177 9934",
});

test("invoice number normalisation is conservative", () => {
  assert.equal(normalizeInvoiceNumber("INV-0923"), "923");
  assert.equal(normalizeInvoiceNumber("Invoice No. 923"), "923");
  assert.equal(normalizeInvoiceNumber("inv 7712"), "7712");
  assert.equal(normalizeInvoiceNumber("SC-3390"), "SC3390");
  assert.notEqual(normalizeInvoiceNumber("SC-3390"), normalizeInvoiceNumber("3390"));
});

test("01 happy path: reconciles internally, within PO tolerance, approved", () => {
  const r = run(HAPPY);
  assert.equal(r.decision.resolution, "AUTO_APPROVE");
  assert.equal(r.poMatch.method, "explicit");
  assert.ok(!r.codes.includes("ARITHMETIC_MISMATCH"));
  assert.ok(r.codes.includes("WITHIN_TOLERANCE"));
  assert.match(r.decision.nextAction, /not yet paid/);
});

test("arithmetic: an unexplained $45 gap is flagged even though the total is within PO tolerance", () => {
  const r = run({ ...HAPPY, shipping: 0, tax: 99.65 }); // 1235 + 99.65 ≠ 1379.65
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.ok(r.blocking.includes("ARITHMETIC_MISMATCH"));
  const f = r.findings.find((x) => x.code === "ARITHMETIC_MISMATCH")!;
  assert.ok(f.evidence?.some((e) => e.label === "Difference" && e.value.includes("45.00")));
});

test("arithmetic: discounts and other charges reconcile", () => {
  const r = run({ ...HAPPY, invoiceNumber: "INV-1048", shipping: 45, otherCharges: 10, discount: 9.15, total: 1379.65 });
  assert.ok(!r.codes.includes("ARITHMETIC_MISMATCH"));
});

test("02 split PO: cumulative billing over the PO needs review, with evidence", () => {
  const r = run(
    inv({
      vendor: "Sunridge Chemicals Ltd.",
      invoiceNumber: "SC-3390",
      poReference: "PO-2026-0211",
      lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 10, unitPrice: 295, total: 2950 }],
      subtotal: 2950,
      tax: 236,
      total: 3186,
    }),
  );
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.ok(r.blocking.includes("CUMULATIVE_PO_EXCEEDED"));
  assert.ok(r.blocking.includes("QUANTITY_EXCEEDS_PO"));
  assert.equal(r.poMatch.billing?.previouslyBilled, 3823.2);
  assert.equal(r.poMatch.billing?.billedAfter, 7009.2);
  assert.match(r.decision.nextAction, /\$2,548\.80 still open on PO-2026-0211/);
});

test("02b split PO: a partial invoice that fits the remaining value is not flagged", () => {
  const r = run(
    inv({
      vendor: "Sunridge Chemicals",
      invoiceNumber: "SC-3384",
      poReference: "PO-2026-0211",
      lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 8, unitPrice: 295, total: 2360 }],
      subtotal: 2360,
      tax: 188.8,
      total: 2548.8,
    }),
  );
  assert.equal(r.decision.resolution, "AUTO_APPROVE");
});

test("03 duplicate of a PAID ERP invoice is rejected and says paid", () => {
  const r = run(
    inv({
      vendor: "Northstar Logistics",
      invoiceNumber: "7712",
      poReference: "PO-2026-0167",
      issueDate: "2026-10-20",
      lineItems: [{ description: "Freight - Chicago to Dallas (full truckload)", quantity: 4, unitPrice: 1250, total: 5000 }],
      subtotal: 5000,
      total: 5000,
      documentType: "scanned",
    }),
  );
  assert.equal(r.decision.resolution, "REJECT");
  assert.equal(r.dup.duplicateOf?.invoiceNumber, "INV-7712");
  assert.match(r.decision.nextAction, /paid \(payment record in ERP\)/);
  assert.ok(!r.codes.includes("CUMULATIVE_PO_EXCEEDED"), "the duplicate must not double-count against the PO");
});

test("re-uploading an APPROVED invoice is rejected without claiming it was paid", () => {
  const first = run(HAPPY);
  const ledger = buildLedger(ERP_LEDGER, [asRun(HAPPY, first, "run-1")]);
  const again = run(HAPPY, ledger, "run-1", [{ runId: "run-1", fileHash: "run-1", createdAt: 0, status: "approved", invoiceNumber: "INV-1047" }]);
  assert.equal(again.decision.resolution, "REJECT");
  assert.ok(again.codes.includes("REPEAT_SUBMISSION"));
  assert.match(again.decision.nextAction, /approved for payment, not yet paid/);
  assert.doesNotMatch(again.decision.nextAction, /\bpaid \(payment/);
  // The rejected repeat does not add to the ledger.
  const ledger2 = buildLedger(ERP_LEDGER, [asRun(HAPPY, first, "run-1"), asRun(HAPPY, again, "run-2")]);
  assert.equal(ledger2.filter((l) => l.invoiceNumber === "INV-1047").length, 1);
});

test("same amount but different invoice number is only a possible duplicate", () => {
  const first = run(HAPPY);
  const ledger = buildLedger(ERP_LEDGER, [asRun(HAPPY, first, "run-1")]);
  const other = run({ ...HAPPY, invoiceNumber: "INV-1049" }, ledger);
  assert.notEqual(other.decision.resolution, "REJECT");
  assert.ok(other.blocking.includes("POSSIBLE_DUPLICATE"));
});

test("04 handwritten, no PO: PO is a suggestion and routes to review", () => {
  const r = run(
    inv({
      vendor: "Rao Electricals",
      invoiceNumber: "118",
      lineItems: [
        { description: "Panel rewiring Plant 2 labour", quantity: 1, unitPrice: 1850, total: 1850 },
        { description: "Cable breakers fittings materials", quantity: 1, unitPrice: 640, total: 640 },
      ],
      subtotal: 2490,
      tax: 199.2,
      total: 2689.2,
      documentType: "handwritten",
    }),
  );
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.equal(r.poMatch.method, "inferred");
  assert.equal(r.poMatch.po?.id, "PO-2026-0225");
  assert.ok(r.blocking.includes("PO_MATCH_UNCONFIRMED"));
  assert.ok(r.blocking.includes("HANDWRITTEN_DOCUMENT"));
});

test("05 bank change: payment hold with masked accounts", () => {
  const r = run(BANK_CHANGE);
  assert.equal(r.decision.resolution, "ESCALATE");
  assert.deepEqual(r.decision.decidingCodes, ["BANK_ACCOUNT_MISMATCH"]);
  const ev = r.findings.find((f) => f.code === "BANK_ACCOUNT_MISMATCH")!.evidence!.map((e) => e.value).join(" ");
  assert.match(ev, /•••• 4821/);
  assert.match(ev, /•••• 9934/);
  assert.doesNotMatch(ev, /441022874821/);
});

test("06 unknown vendor with no PO is a payment hold", () => {
  const r = run(inv({ vendor: "Brightline Supply Co", invoiceNumber: "BL-2291", lineItems: [{ description: "Consulting services", quantity: 1, unitPrice: 4800, total: 4800 }], subtotal: 4800, total: 4800 }));
  assert.equal(r.decision.resolution, "ESCALATE");
  assert.ok(r.blocking.includes("UNKNOWN_VENDOR"));
});

test("expired PO goes to review", () => {
  const r = run(
    inv({ vendor: "Westwind Office Solutions", invoiceNumber: "WW-5521", poReference: "PO-2025-0931", lineItems: [{ description: "Ergonomic chair (model EK-7)", quantity: 12, unitPrice: 380, total: 4560 }], subtotal: 4560, tax: 364.8, shipping: 200, total: 5124.8 }),
  );
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.ok(r.blocking.includes("EXPIRED_PO"));
});

// ---------- Review workflow ----------

test("bank hold: approve is blocked until independent verification is recorded", () => {
  const r = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-b");
  assert.equal(r.status, "payment_hold");
  assert.equal(applyReviewAction(r, { action: "approve", reviewer: "Priya", justification: "Looks fine to me" }).ok, false);
  assert.equal(applyReviewAction(r, { action: "verify_bank", reviewer: "Priya", justification: "Looks fine to me" }).ok, false, "needs verification checkbox");
  assert.equal(applyReviewAction(r, { action: "verify_bank", reviewer: " ", justification: "Called (216) 555-0190", verificationConfirmed: true }).ok, false, "needs a name");
  const verified = applyReviewAction(r, { action: "verify_bank", reviewer: "Priya", justification: "Called Acme on (216) 555-0190, controller confirmed new account", verificationConfirmed: true });
  assert.ok(verified.ok);
  if (!verified.ok) return;
  assert.equal(verified.run.status, "needs_review", "verification clears the hold; approval is a separate, explicit step");
  assert.equal(verified.run.audit.at(-1)?.fromStatus, "payment_hold");
  const approved = applyReviewAction(verified.run, { action: "approve", reviewer: "Priya", justification: "All controls resolved" });
  assert.ok(approved.ok && approved.run.status === "approved");
});

test("inferred PO must be confirmed before approval", () => {
  const i = inv({
    vendor: "Rao Electricals",
    invoiceNumber: "118",
    lineItems: [
      { description: "Panel rewiring Plant 2 labour", quantity: 1, unitPrice: 1850, total: 1850 },
      { description: "Cable breakers fittings materials", quantity: 1, unitPrice: 640, total: 640 },
    ],
    subtotal: 2490,
    tax: 199.2,
    total: 2689.2,
    documentType: "handwritten",
  });
  const r = asRun(i, run(i), "run-r");
  assert.equal(applyReviewAction(r, { action: "approve", reviewer: "Priya", justification: "fine" }).ok, false);
  const c = applyReviewAction(r, { action: "confirm_po", reviewer: "Priya", justification: "Plant manager confirmed PO-2026-0225" });
  assert.ok(c.ok && c.run.status === "needs_review");
  if (!c.ok) return;
  const a = applyReviewAction(c.run, { action: "approve", reviewer: "Priya", justification: "Checked handwritten figures against original" });
  assert.ok(a.ok && a.run.status === "approved");
});

test("unknown-vendor hold cannot be approved by a reviewer", () => {
  const i = inv({ vendor: "Brightline Supply Co", invoiceNumber: "BL-2291", lineItems: [{ description: "Consulting", quantity: 1, unitPrice: 4800, total: 4800 }], subtotal: 4800, total: 4800 });
  const r = asRun(i, run(i), "run-u");
  assert.ok(!availableActions(r).some((a) => a.id === "verify_bank"));
  assert.equal(applyReviewAction(r, { action: "approve", reviewer: "Priya", justification: "seems legit" }).ok, false);
  const req = applyReviewAction(r, { action: "request_info", reviewer: "Priya", justification: "Sent onboarding pack" });
  assert.equal(req.ok && req.run.status, "awaiting_info");
  if (req.ok) assert.equal(applyReviewAction(req.run, { action: "approve", reviewer: "Priya", justification: "seems legit" }).ok, false, "still blocked while waiting");
});

test("rejected and approved cases are final", () => {
  const r = asRun(HAPPY, run(HAPPY), "run-h");
  assert.equal(availableActions(r).length, 0);
  assert.equal(applyReviewAction(r, { action: "reject", reviewer: "Priya", justification: "changed my mind" }).ok, false);
});
