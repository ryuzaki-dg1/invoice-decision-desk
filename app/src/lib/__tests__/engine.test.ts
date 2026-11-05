// Deterministic engine tests: each demo scenario, fed the fields the model
// would extract, must land on the expected decision for the expected reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PURCHASE_ORDERS } from "../../data/purchaseOrders.ts";
import { ERP_LEDGER, VENDORS } from "../../data/vendors.ts";
import type { Invoice, LedgerInvoice } from "../../types.ts";
import { checkDuplicates, checkVendor, decide, matchPurchaseOrder, normalizeInvoiceNumber, validateInvoice } from "../engine.ts";
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
    total: null,
    currency: "USD",
    bankAccount: null,
    documentType: "digital",
    lowConfidenceFields: [],
    ...p,
  };
}

function run(i: Invoice, ledger: LedgerInvoice[] = ERP_LEDGER) {
  const findings = [...validateInvoice(i, DEFAULT_RULES)];
  const v = checkVendor(i, VENDORS);
  findings.push(...v.findings);
  const pm = matchPurchaseOrder(i, v.vendor, PURCHASE_ORDERS, ledger, DEFAULT_RULES, TODAY);
  findings.push(...pm.findings);
  findings.push(...checkDuplicates(i, v.vendor, ledger, DEFAULT_RULES).findings);
  const { decision, extra } = decide(i, findings, DEFAULT_RULES);
  return { decision, findings: [...findings, ...extra], poMatch: pm.poMatch, codes: [...findings, ...extra].map((f) => f.code) };
}

test("invoice number normalisation", () => {
  assert.equal(normalizeInvoiceNumber("INV-0923"), "923");
  assert.equal(normalizeInvoiceNumber("Invoice No. 923"), "923");
  assert.equal(normalizeInvoiceNumber("inv 7712"), "7712");
  assert.equal(normalizeInvoiceNumber("SC-3390"), "SC3390");
});

test("01 happy path: exact PO match with $0.85 tax rounding auto-approves", () => {
  const r = run(
    inv({
      vendor: "Acme Industrial Supply Co.",
      invoiceNumber: "INV-1047",
      poReference: "PO-2026-0142",
      lineItems: [
        { description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 },
        { description: "Lock washer M8 (box of 500)", quantity: 10, unitPrice: 18.5, total: 185 },
      ],
      subtotal: 1235,
      tax: 99.65,
      shipping: 45,
      total: 1379.65,
      bankAccount: "4410 2287 4821",
    }),
  );
  assert.equal(r.decision.resolution, "AUTO_APPROVE");
  assert.equal(r.poMatch.method, "explicit");
  assert.ok(r.codes.includes("WITHIN_TOLERANCE"));
});

test("02 split PO: second partial invoice pushes cumulative billing over the PO", () => {
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
  assert.ok(r.codes.includes("CUMULATIVE_OVERBILLING"));
  assert.ok(r.codes.includes("QUANTITY_OVER_PO"));
  assert.equal(r.poMatch.billing?.previouslyBilled, 3823.2);
});

test("02b split PO: a partial invoice that fits the remaining value is NOT flagged", () => {
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

test("03 duplicate: scanned resubmission with different number format is rejected", () => {
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
  assert.ok(r.codes.includes("DUPLICATE_INVOICE"));
  // The duplicate itself must not count as prior billing on the PO.
  assert.ok(!r.codes.includes("CUMULATIVE_OVERBILLING"));
});

test("04 handwritten, no PO: PO inferred but routed to a human", () => {
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
  assert.ok(r.codes.includes("PO_INFERRED"));
  assert.ok(r.codes.includes("HANDWRITTEN_DOCUMENT"));
});

test("05 bank change: perfect match but new remit-to account is a payment hold", () => {
  const r = run(
    inv({
      vendor: "Acme Industrial Supply",
      invoiceNumber: "INV-1052",
      poReference: "PO-2026-0198",
      lineItems: [{ description: "Stainless steel sheet 4x8 (16ga)", quantity: 20, unitPrice: 145, total: 2900 }],
      subtotal: 2900,
      tax: 232,
      shipping: 140,
      total: 3272,
      bankAccount: "8830 1177 9934",
    }),
  );
  assert.equal(r.decision.resolution, "ESCALATE");
  assert.deepEqual(r.decision.decidingCodes, ["BANK_DETAILS_CHANGED"]);
});

test("06 unknown vendor with no PO is held", () => {
  const r = run(
    inv({
      vendor: "Brightline Supply Co",
      invoiceNumber: "BL-2291",
      lineItems: [{ description: "Consulting services", quantity: 1, unitPrice: 4800, total: 4800 }],
      subtotal: 4800,
      total: 4800,
    }),
  );
  assert.equal(r.decision.resolution, "ESCALATE");
  assert.ok(r.codes.includes("VENDOR_NOT_IN_MASTER"));
});

test("arithmetic mismatch and missing fields go to review", () => {
  const r = run(
    inv({
      vendor: "Acme Industrial Supply",
      invoiceNumber: null,
      poReference: "PO-2026-0142",
      lineItems: [
        { description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 },
        { description: "Lock washer M8 (box of 500)", quantity: 10, unitPrice: 18.5, total: 185 },
      ],
      subtotal: 1235,
      tax: 98.8,
      shipping: 45,
      total: 1328.8,
    }),
  );
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.ok(r.codes.includes("MISSING_FIELD"));
  assert.ok(r.codes.includes("ARITHMETIC_MISMATCH"));
});

test("expired PO goes to review", () => {
  const r = run(
    inv({
      vendor: "Westwind Office Solutions",
      invoiceNumber: "WW-5521",
      poReference: "PO-2025-0931",
      lineItems: [{ description: "Ergonomic chair (model EK-7)", quantity: 12, unitPrice: 380, total: 4560 }],
      subtotal: 4560,
      tax: 364.8,
      shipping: 200,
      total: 5124.8,
    }),
  );
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
  assert.ok(r.codes.includes("EXPIRED_PO"));
});
