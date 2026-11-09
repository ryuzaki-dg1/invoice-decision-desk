// Deterministic engine + review-rule tests. Each demo scenario, fed the fields
// the model would extract, must land on the expected decision for the right reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PURCHASE_ORDERS } from "../../data/purchaseOrders.ts";
import { ERP_LEDGER, VENDORS } from "../../data/vendors.ts";
import type { Invoice, LedgerInvoice, RunRecord } from "../../types.ts";
import { buildLedger, checkDuplicates, checkVendor, decide, fmtPct, initialStatus, matchPurchaseOrder, normalizeInvoiceNumber, suggestPos, validateInvoice, type PriorSubmission } from "../engine.ts";
import { applyReviewAction, availableActions, openCodes } from "../review.ts";
import { applyCorrections } from "../revalidate.ts";
import { buildCases, computeMetrics } from "../analytics.ts";
import { attemptKind, deriveControls, invoiceChecks, paymentReadiness } from "../controls.ts";
import { locate } from "../locate.ts";
import { runPipeline } from "../pipeline.ts";
import { DEFAULT_RULES } from "../policy.ts";
import { caseSummary } from "../status.ts";
import { refreshStale } from "../revalidate.ts";
import { nextStep, requiredAction } from "../../copy.ts";

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

test("percentages use one format everywhere ($486 / $9,570 = +5.08%)", () => {
  assert.equal(fmtPct(486 / 9570), "+5.08%");
  const r = run(
    inv({ vendor: "Bluepeak Components Inc.", invoiceNumber: "INV-4471", poReference: "PO-2026-0184", lineItems: [{ description: 'PCB assembly rev 3.2 - "Orion"', quantity: 100, unitPrice: 92, total: 9200 }], subtotal: 9200, tax: 736, shipping: 120, total: 10056 }),
  );
  const f = r.findings.find((x) => x.code === "PO_AMOUNT_EXCEEDED")!;
  assert.match(f.detail, /\+5\.08%/);
  assert.ok(f.evidence!.some((e) => e.value.includes("+5.08%")));
  assert.doesNotMatch(JSON.stringify(r.findings), /5\.1%|0\.508/);
});

test("pending (in review / on hold) invoices are not counted as billed, but conflicts are flagged", () => {
  const pendingLedger: LedgerInvoice[] = [
    ...ERP_LEDGER,
    { vendorId: "V-005", vendor: "Sunridge Chemicals Ltd.", invoiceNumber: "SC-3380", poId: "PO-2026-0211", total: 2548.8, issueDate: "2026-11-01", lineItems: [], status: "in_review", source: "run", runId: "r-x" },
  ];
  const i = inv({ vendor: "Sunridge Chemicals", invoiceNumber: "SC-3384", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 8, unitPrice: 295, total: 2360 }], subtotal: 2360, tax: 188.8, total: 2548.8 });
  const r = run(i, pendingLedger);
  assert.equal(r.poMatch.billing?.previouslyBilled, 3823.2, "pending SC-3380 is not committed spend");
  assert.equal(r.poMatch.billing?.pendingOnPo, 2548.8);
  assert.ok(r.blocking.includes("PENDING_PO_CONFLICT"));
  assert.equal(r.decision.resolution, "FLAG_FOR_REVIEW");
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

test("bank: a partially printed account ('ending 4821') matches the tail of the account on file", () => {
  assert.ok(!run({ ...HAPPY, invoiceNumber: "INV-2001", bankAccount: "4821" }).codes.includes("BANK_ACCOUNT_MISMATCH"), "Acme master ends 4821 → no mismatch");
  assert.ok(run({ ...HAPPY, invoiceNumber: "INV-2002", bankAccount: "9934" }).codes.includes("BANK_ACCOUNT_MISMATCH"), "different last digits → mismatch");
  assert.ok(run({ ...BLUEPEAK, bankAccount: "4821" }).codes.includes("BANK_ACCOUNT_MISMATCH"), "Bluepeak master ends 1147, invoice says 4821");
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
  assert.equal(applyReviewAction(r, { action: "verify_bank", reviewer: " ", justification: "Called (216) 555-0190 to confirm", verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" }).ok, false, "needs a name");
  const verified = applyReviewAction(r, { action: "verify_bank", reviewer: "Priya", justification: "Called Acme on (216) 555-0190, controller confirmed new account", verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" });
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
  assert.equal(applyReviewAction(c.run, { action: "approve", reviewer: "Priya", justification: "fine" }).ok, false, "handwritten figures still unconfirmed");
  const f = applyReviewAction(c.run, { action: "confirm_fields", reviewer: "Priya", justification: "Checked every figure against the photo" });
  assert.ok(f.ok);
  if (!f.ok) return;
  const a = applyReviewAction(f.run, { action: "approve", reviewer: "Priya", justification: "All confirmations complete" });
  assert.ok(a.ok && a.run.status === "approved");
});

// ---------- Correction + re-validation loop ----------

const RAO_MISREAD = inv({
  vendor: "Rao Electrical Contractors",
  invoiceNumber: "118",
  lineItems: [
    { description: "Panel rewiring - Plant 2 (labour)", quantity: 1, unitPrice: 1350, total: 1350 }, // overwritten 8 read as 3
    { description: "Cable, breakers & fittings (materials)", quantity: 1, unitPrice: 640, total: 640 },
  ],
  subtotal: 2490,
  tax: 199.2,
  total: 2689.2,
  documentType: "handwritten",
  lowConfidenceFields: ["lineItems[0].unitPrice"],
});

test("correction loop: a misread handwritten figure blocks approval until corrected, then every check re-runs", () => {
  const r0 = asRun(RAO_MISREAD, run(RAO_MISREAD), "run-rao");
  assert.ok(r0.findings.some((f) => f.code === "ARITHMETIC_MISMATCH"));
  assert.equal(availableActions(r0).find((a) => a.id === "approve")?.allowed, false);

  const fixed = applyCorrections(r0, { reviewer: "Priya", reason: "Labour amount is 1850 on the photo (8 written over 3)", source: "page 1 of the document", invoice: { lineItems: [{ unitPrice: 1850, total: 1850 }] } }, [r0]);
  assert.ok(fixed.ok);
  if (!fixed.ok) return;
  const r1 = fixed.run;
  assert.deepEqual(
    fixed.changes.map((c) => `${c.field}:${c.from}->${c.to}`),
    ["lineItems[0].unitPrice:1350->1850", "lineItems[0].total:1350->1850"],
  );
  assert.ok(!r1.findings.some((f) => f.code === "ARITHMETIC_MISMATCH"), "arithmetic re-checked and now reconciles");
  assert.ok(r1.findings.some((f) => f.code === "PO_MATCH_UNCONFIRMED"), "PO still only a suggestion");
  assert.ok(r1.findings.some((f) => f.code === "HANDWRITTEN_DOCUMENT"), "handwritten policy still applies");
  assert.equal(r1.status, "needs_review");
  assert.equal(r1.originalInvoice?.lineItems[0].unitPrice, 1350, "original extraction preserved");
  assert.equal(r1.corrections?.[0].reviewer, "Priya");
  assert.match(r1.audit.at(-1)!.action, /lineItems\[0\]\.unitPrice 1350 → 1850/);

  let r = r1;
  for (const action of ["confirm_fields", "confirm_po", "approve"] as const) {
    const step = applyReviewAction(r, { action, reviewer: "Priya", justification: "Checked against photo and PO owner" });
    assert.ok(step.ok, action);
    if (step.ok) r = step.run;
  }
  assert.equal(r.status, "approved");
});

test("correction loop: a correction that creates a duplicate is rejected by the re-run checks", () => {
  const i = inv({ vendor: "Sunridge Chemicals", invoiceNumber: "SC-339O", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 8, unitPrice: 295, total: 2360 }], subtotal: 2360, tax: 188.8, total: 2548.8, documentType: "scanned", lowConfidenceFields: ["invoiceNumber"] });
  const r0 = asRun(i, run(i), "run-s");
  const res = applyCorrections(r0, { reviewer: "Priya", reason: "Number on the scan is SC-3371", source: "page 1 of the document", invoice: { invoiceNumber: "SC-3371" } }, [r0]);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.run.status, "rejected");
    assert.equal(res.run.duplicateOf?.invoiceNumber, "SC-3371");
  }
});

test("correction loop: vendor and bank account cannot be edited; reason and name are required", () => {
  const r0 = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-b2");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sneaky = applyCorrections(r0, { reviewer: "Priya", reason: "use master account", source: "page 1 of the document", invoice: { bankAccount: "441022874821", vendor: "Acme" } as any }, [r0]);
  assert.equal(sneaky.ok, false);
  assert.equal(applyCorrections(r0, { reviewer: "", reason: "valid reason", source: "page 1 of the document", invoice: { tax: 1 } }, [r0]).ok, false);
  assert.equal(applyCorrections(r0, { reviewer: "Priya", reason: "", source: "page 1 of the document", invoice: { tax: 1 } }, [r0]).ok, false);
});

// ---------- Multi-finding safety ----------

const BLUEPEAK = inv({
  vendor: "Bluepeak Components Inc.",
  invoiceNumber: "INV-4471",
  poReference: "PO-2026-0184",
  lineItems: [{ description: 'PCB assembly rev 3.2 - "Orion"', quantity: 100, unitPrice: 92, total: 9200 }],
  subtotal: 9200,
  tax: 736,
  shipping: 120,
  total: 10056,
  bankAccount: "5550 1234 7777",
});

test("bank mismatch + PO overage: verifying the bank does NOT approve; PO stays open until authorised", () => {
  const r0 = asRun(BLUEPEAK, run(BLUEPEAK), "run-bp");
  assert.equal(r0.status, "payment_hold");
  const v = applyReviewAction(r0, { action: "verify_bank", reviewer: "Priya", justification: "Called Bluepeak on the file number", verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.run.status, "needs_review", "hold cleared, but not approved");
  assert.deepEqual(v.run.audit.at(-1)?.resolved, ["BANK_ACCOUNT_MISMATCH"]);
  assert.ok(v.run.audit.at(-1)?.remaining?.includes("PO_AMOUNT_EXCEEDED"), "audit lists what remains open");
  const approve = availableActions(v.run).find((a) => a.id === "approve")!;
  assert.equal(approve.allowed, false);
  assert.match(approve.blockedReason!, /PO discrepancy/);
  assert.equal(applyReviewAction(v.run, { action: "approve", reviewer: "Priya", justification: "looks fine" }).ok, false, "generic approve cannot bypass");
  assert.equal(applyReviewAction(v.run, { action: "resolve_po", reviewer: "Priya", justification: "PO increased" }).ok, false, "needs authoriser + reference");
  const po = applyReviewAction(v.run, { action: "resolve_po", reviewer: "Priya", justification: "Price increase approved by PO owner", authorizedBy: "a.patel", reference: "PO-2026-0184-A1" });
  assert.ok(po.ok);
  if (!po.ok) return;
  assert.equal(po.run.status, "needs_review", "resolving the last finding still needs an explicit approval");
  assert.match(po.run.audit.at(-1)!.reference!, /a\.patel.*PO-2026-0184-A1/);
  const ok = applyReviewAction(po.run, { action: "approve", reviewer: "Priya", justification: "All controls resolved" });
  assert.ok(ok.ok && ok.run.status === "approved");
});

test("Sunridge cumulative overage cannot be approved by justification alone", () => {
  const i = inv({ vendor: "Sunridge Chemicals Ltd.", invoiceNumber: "SC-3390", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 10, unitPrice: 295, total: 2950 }], subtotal: 2950, tax: 236, total: 3186 });
  const r0 = asRun(i, run(i), "run-sr");
  assert.equal(availableActions(r0).find((a) => a.id === "approve")?.allowed, false);
  assert.ok(availableActions(r0).some((a) => a.id === "resolve_po"));
});

test("closed cases reject further actions (idempotent close)", () => {
  const r = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-x");
  const rej = applyReviewAction(r, { action: "reject", reviewer: "Priya", justification: "Confirmed fraud attempt" });
  assert.ok(rej.ok);
  if (rej.ok) assert.equal(applyReviewAction(rej.run, { action: "reject", reviewer: "Priya", justification: "again" }).ok, false);
});

// ---------- Control checklist & readiness ----------

test("checklist: bank + PO overage → verify bank resolves only the bank control; approve stays locked", () => {
  const r0 = asRun(BLUEPEAK, run(BLUEPEAK), "c1");
  const c0 = deriveControls(r0);
  const st = (c: ReturnType<typeof deriveControls>, k: string) => c.find((x) => x.key === k)?.status;
  assert.equal(st(c0, "document"), "passed");
  assert.equal(st(c0, "payment"), "unresolved");
  assert.equal(st(c0, "po"), "unresolved");
  assert.equal(c0.find((x) => x.key === "payment")?.action?.id, "verify_bank");
  assert.equal(c0.find((x) => x.key === "po")?.action?.id, "resolve_po");
  assert.equal(invoiceChecks(r0), "Exceptions found");
  assert.equal(paymentReadiness(r0).label, "Blocked");
  const v = applyReviewAction(r0, { action: "verify_bank", reviewer: "P", justification: "called on the number on file", verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" });
  assert.ok(v.ok);
  if (!v.ok) return;
  const c1 = deriveControls(v.run);
  assert.equal(st(c1, "payment"), "resolved");
  assert.match(c1.find((x) => x.key === "payment")!.resolvedBy!, /P$/);
  assert.equal(st(c1, "po"), "unresolved", "PO control untouched");
  assert.equal(availableActions(v.run).find((a) => a.id === "approve")?.allowed, false);
});

test("readiness: a valid invoice with only a bank change is 'awaiting verification', not invoice-invalid", () => {
  const r = asRun(BANK_CHANGE, run(BANK_CHANGE), "c2");
  assert.equal(invoiceChecks(r), "Passed");
  assert.equal(paymentReadiness(r).label, "Awaiting verification");
  const ok = asRun(HAPPY, run(HAPPY), "c3");
  assert.equal(paymentReadiness(ok).label, "Ready");
  assert.match(paymentReadiness(ok).detail, /not yet paid/);
});

test("duplicate upload of an invoice still ON HOLD: blocked as a duplicate, original stays open", () => {
  const orig = asRun(BANK_CHANGE, run(BANK_CHANGE), "h1");
  const ledger = buildLedger(ERP_LEDGER, [orig]);
  const again = run(BANK_CHANGE, ledger, "h1", [{ runId: "h1", fileHash: "h1", createdAt: 0, status: "payment_hold", invoiceNumber: "INV-1052" }]);
  assert.equal(again.decision.resolution, "REJECT");
  assert.equal(again.dup.duplicateOf?.status, "in_review");
  assert.match(again.decision.nextAction, /under review/);
  const dupRun = { ...asRun(BANK_CHANGE, again, "h2"), repeatSubmission: true, duplicateOf: again.dup.duplicateOf };
  assert.equal(attemptKind(dupRun), "duplicate_submission");
  const cases = buildCases([orig, dupRun]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, "payment_hold", "rejecting the duplicate does not close the original");
  assert.equal(computeMetrics([orig, dupRun]).awaiting, 1);
});

test("re-upload under a vendor alias is still caught as the same invoice", () => {
  const first = asRun(HAPPY, run(HAPPY), "al1");
  const ledger = buildLedger(ERP_LEDGER, [first]);
  const alias = run({ ...HAPPY, vendor: "Acme Industrial", invoiceNumber: "Invoice No. 1047" }, ledger, "other-file");
  assert.equal(alias.decision.resolution, "REJECT");
  assert.equal(alias.dup.duplicateOf?.invoiceNumber, "INV-1047");
});

test("repeat uploads never consume PO balance twice", () => {
  const sr = (n: string, qty: number) =>
    inv({ vendor: "Sunridge Chemicals Ltd.", invoiceNumber: n, poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: qty, unitPrice: 295, total: 295 * qty }], subtotal: 295 * qty, tax: 23.6 * qty, total: 318.6 * qty });
  const a = sr("SC-3380", 4);
  const ra = asRun(a, run(a), "p1"); // approved partial (12 + 4 = 16 of 20 drums)
  assert.equal(ra.status, "approved");
  const dupR = run(a, buildLedger(ERP_LEDGER, [ra]), "p1", [{ runId: "p1", fileHash: "p1", createdAt: 0, status: "approved", invoiceNumber: "SC-3380" }]);
  const rdup = { ...asRun(a, dupR, "p2"), repeatSubmission: true };
  assert.equal(rdup.status, "rejected");
  const b = sr("SC-3381", 4); // 12 + 4 + 4 = 20 drums: exactly the PO if the duplicate isn't counted
  const rb = run(b, buildLedger(ERP_LEDGER, [ra, rdup]));
  assert.equal(rb.poMatch.billing?.previouslyBilled, 3823.2 + 1274.4);
  assert.ok(!rb.blocking.includes("QUANTITY_EXCEEDS_PO"));
  assert.equal(rb.poMatch.billing?.ledger?.length, 2, "ledger shows each earlier invoice once");
});

// ---------- Document-to-data locator ----------

test("locate: finds real text positions and never guesses", () => {
  const boxes = [
    { s: "INV-1047", x: 0.7, y: 0.1, w: 0.1, h: 0.02 },
    { s: "2026-11-02", x: 0.7, y: 0.12, w: 0.1, h: 0.02 },
    { s: "$1,379.65", x: 0.8, y: 0.5, w: 0.1, h: 0.02 },
    { s: "$2,950.00", x: 0.8, y: 0.4, w: 0.1, h: 0.02 },
    { s: "First Midwest Bank · Account 4410 2287 4821 · Routing 071000013", x: 0.1, y: 0.7, w: 0.6, h: 0.02 },
  ];
  assert.equal(locate(boxes, "money", 1379.65).length, 1);
  assert.equal(locate(boxes, "money", 50).length, 0, "50.00 must not match inside 2,950.00");
  assert.equal(locate(boxes, "text", "INV-1047")[0].y, 0.1);
  assert.equal(locate(boxes, "date", "2026-11-02").length, 1);
  assert.equal(locate(boxes, "digits", "441022874821").length, 1);
  assert.equal(locate(undefined, "money", 1379.65).length, 0, "no text layer (scan/photo) → no boxes");
  assert.equal(locate(boxes, "money", 999.99).length, 0);
});

// ---------- Analytics ----------

test("analytics: unique cases vs attempts, STP denominator, open value, reset", () => {
  const happy = asRun(HAPPY, run(HAPPY), "a1");
  const ledger1 = buildLedger(ERP_LEDGER, [happy]);
  const repeatR = run(HAPPY, ledger1, "a1", [{ runId: "a1", fileHash: "a1", createdAt: 0, status: "approved", invoiceNumber: "INV-1047" }]);
  const repeat = { ...asRun(HAPPY, repeatR, "a2"), repeatSubmission: true, createdAt: happy.createdAt + 1000 };
  const dupI = inv({ vendor: "Northstar Logistics", invoiceNumber: "7712", poReference: "PO-2026-0167", issueDate: "2026-10-20", lineItems: [{ description: "Freight - Chicago to Dallas (full truckload)", quantity: 4, unitPrice: 1250, total: 5000 }], subtotal: 5000, total: 5000 });
  const dup = asRun(dupI, run(dupI), "a3");
  const hold = asRun(BANK_CHANGE, run(BANK_CHANGE), "a4");
  const human = (() => {
    const r = asRun(BLUEPEAK, run(BLUEPEAK), "a5");
    let x = applyReviewAction(r, { action: "verify_bank", reviewer: "P", justification: "called on the number on file" , verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" });
    if (!x.ok) throw new Error();
    x = applyReviewAction(x.run, { action: "resolve_po", reviewer: "P", justification: "PO amended by the owner", authorizedBy: "a.patel", reference: "A1" });
    if (!x.ok) throw new Error();
    x = applyReviewAction(x.run, { action: "approve", reviewer: "P", justification: "all controls resolved" });
    if (!x.ok) throw new Error();
    return x.run;
  })();
  const m = computeMetrics([happy, repeat, dup, hold, human]);
  assert.equal(m.attempts, 5);
  assert.equal(m.cases, 4, "repeat upload grouped with its original");
  assert.equal(m.repeatAttempts, 1);
  assert.equal(m.eligible, 3, "duplicate of an invoice already on file is not an eligible invoice");
  assert.equal(m.autoApproved, 1, "human-approved invoice is not straight-through");
  assert.equal(m.awaiting, 1);
  assert.equal(m.valueRequiringIntervention, 3272);
  assert.equal(m.byStatus.approved, 2);
  assert.equal(m.byStatus.rejected, 1);
  const cases = buildCases([happy, repeat, dup, hold, human]);
  const acme = cases.find((c) => c.primary.id === "a1")!;
  assert.equal(acme.attempts.length, 2);
  assert.equal(acme.status, "approved", "a rejected repeat doesn't change the original case");
  const empty = computeMetrics([]);
  assert.equal(empty.attempts + empty.cases + empty.awaiting + empty.valueRequiringIntervention, 0);
  assert.equal(empty.stpRate, null);
});

// ---------- Policy snapshot ----------

test("corrections re-validate with the run's own policy snapshot, not today's defaults", () => {
  const i = inv({ vendor: "Sunridge Chemicals Ltd.", invoiceNumber: "SC-3390", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 10, unitPrice: 295, total: 2950 }], subtotal: 2950, tax: 236, total: 3186, issueDate: "2026-11-03" });
  const loose = { ...DEFAULT_RULES, amountTolerancePct: 0.15, quantityTolerance: 5 };
  const r0 = { ...asRun(i, run(i), "snap"), rules: loose };
  const res = applyCorrections(r0, { reviewer: "Priya", reason: "Date reads Nov 4 on the copy", source: "page 1 of the document", invoice: { issueDate: "2026-11-04" } }, [r0]);
  assert.ok(res.ok);
  if (res.ok) {
    assert.ok(!res.run.findings.some((f) => f.code === "CUMULATIVE_PO_EXCEEDED"), "10% over is inside the run's 15% snapshot");
    assert.equal(res.run.rules?.amountTolerancePct, 0.15, "snapshot kept");
  }
});

// ---------- AI service failure ----------

test("AI service failure: no fabricated fields, no decision, extract stage marked as system error", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "high demand" }), { status: 503 })) as typeof fetch;
  const stages: { id: string; status: string }[] = [];
  let invoiceSeen = false;
  try {
    await assert.rejects(
      runPipeline(
        { fileName: "x.pdf", fileHash: "h", mimeType: "application/pdf", pageImages: ["data:image/png;base64,AA=="], textLayer: "", hasTextLayer: false, pageCount: 1 },
        { vendors: VENDORS, purchaseOrders: PURCHASE_ORDERS, ledger: ERP_LEDGER, priorSubmissions: [], rules: DEFAULT_RULES, today: TODAY, model: "test" },
        { onStage: (s) => stages.push({ id: s.id, status: s.status }), onInvoice: () => (invoiceSeen = true) },
      ),
      /503/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(invoiceSeen, false);
  assert.equal(stages.filter((s) => s.id === "extract").at(-1)?.status, "error");
  assert.ok(!stages.some((s) => s.id === "decide"), "no decision is made");
});

test("PO suggestions list candidates with reasons and never confirm", () => {
  const v = checkVendor(RAO_MISREAD, VENDORS).vendor;
  const s = suggestPos({ ...RAO_MISREAD, lineItems: [{ ...RAO_MISREAD.lineItems[0], unitPrice: 1850, total: 1850 }, RAO_MISREAD.lineItems[1]] }, v, PURCHASE_ORDERS, ERP_LEDGER, DEFAULT_RULES);
  assert.equal(s[0].poId, "PO-2026-0225");
  assert.ok(s[0].reasons.some((x) => /equals/.test(x)));
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

// ---------- regression: current-state messaging and reviewer validation ----------

const VERIFY = { action: "verify_bank" as const, reviewer: "Priya", justification: "Called Bluepeak on the number in the vendor master", verificationConfirmed: true, verificationReference: "Call 5 Nov 10:15, A. Rao" };

test("status: after bank call-back, summary says verification recorded (attested), not 'call the vendor'", () => {
  const r0 = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-bc");
  assert.equal(r0.status, "payment_hold");
  assert.match(nextStep(r0, ["BANK_ACCOUNT_MISMATCH"]), /calling/i);
  const v = applyReviewAction(r0, VERIFY);
  assert.ok(v.ok);
  if (!v.ok) return;
  const s = caseSummary(v.run);
  assert.match(s.title, /Verification recorded — awaiting approval/);
  assert.doesNotMatch(s.next, /call/i);
  assert.equal(s.bankAttested?.by, "Priya");
  assert.match(v.run.audit.at(-1)!.action, /attested/i);
  assert.doesNotMatch(v.run.audit.at(-1)!.action, /^Verified/);
  assert.ok(v.run.findings.some((f) => f.code === "BANK_ACCOUNT_MISMATCH"), "original finding preserved");
});

test("status: approved with authorised PO exception never says 'within tolerance' or 'all checks passed'", () => {
  const r0 = asRun(BLUEPEAK, run(BLUEPEAK), "run-bp2");
  const v = applyReviewAction(r0, VERIFY);
  assert.ok(v.ok);
  if (!v.ok) return;
  const mid = caseSummary(v.run);
  assert.match(mid.title, /Bank verification recorded/);
  assert.match(mid.next, /amendment or authorisation/);
  assert.match(mid.next, /not changed/);
  const po = applyReviewAction(v.run, { action: "resolve_po", reviewer: "Priya", justification: "Price increase approved by PO owner", authorizedBy: "a.patel", reference: "PO-2026-0184-A1" });
  assert.ok(po.ok);
  if (!po.ok) return;
  assert.match(caseSummary(po.run).title, /awaiting approval/);
  const ok = applyReviewAction(po.run, { action: "approve", reviewer: "Priya", justification: "All controls resolved and recorded" });
  assert.ok(ok.ok);
  if (!ok.ok) return;
  const s = caseSummary(ok.run);
  assert.equal(s.title, "Approved with authorised PO exception");
  assert.doesNotMatch(`${s.title} ${s.line}`, /within PO tolerance|all checks passed|items? to resolve/i);
  assert.match(s.line, /PO-2026-0184-A1/);
  assert.match(s.line, /PO record unchanged/);
  assert.ok(ok.run.findings.some((f) => f.code === "PO_AMOUNT_EXCEEDED"), "original discrepancy retained");
  assert.equal(ok.run.audit.filter((e) => e.kind === "reviewer").length, 3, "audit history intact");
});

test("status: a clean approval still reads 'all checks passed'", () => {
  const r = asRun(HAPPY, run(HAPPY), "run-ok");
  assert.equal(r.status, "approved");
  assert.match(caseSummary(r).title, /all checks passed/i);
});

test("next step: fully billed PO never says '$0 still open' and does not imply the PO was updated", () => {
  const i = inv({ vendor: "Sunridge Chemicals Ltd.", invoiceNumber: "SC-3391", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 10, unitPrice: 295, total: 2950 }], subtotal: 2950, tax: 236, total: 3186 });
  const r = run(i, [...ERP_LEDGER], "h-x", []);
  const base = asRun(i, r, "run-full");
  const full = { ...base, poMatch: { ...base.poMatch, billing: { ...base.poMatch.billing!, previouslyBilled: base.poMatch.billing!.poTotal } }, findings: base.findings.map((f) => f) };
  const text = nextStep(full, ["CUMULATIVE_PO_EXCEEDED"]);
  assert.doesNotMatch(text, /\$0(\.00)? still open/);
  assert.match(text, /fully billed/);
  assert.match(text, /PO record is not changed/);
});

test("missing invoice number: recommends a revised invoice and rejects manual entry", () => {
  const i = inv({ ...HAPPY, invoiceNumber: null });
  const r0 = asRun(i, run(i), "run-nonum");
  assert.ok(r0.findings.some((f) => f.code === "MISSING_FIELD"));
  assert.match(nextStep(r0, ["MISSING_FIELD"]), /revised invoice/i);
  const res = applyCorrections(r0, { reviewer: "Priya", reason: "The number appears on the document", source: "page 1 header", invoice: { invoiceNumber: "INV-9999" } }, [r0]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /revised invoice/i);
});

test("validation: justifications must be substantive; bank verification needs reference and attestation", () => {
  const r0 = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-val");
  for (const j of ["ok", "fine", "looks fine", "approved", "called vendor", "      "]) assert.equal(applyReviewAction(r0, { ...VERIFY, justification: j }).ok, false, `rejects "${j}"`);
  assert.equal(applyReviewAction(r0, { ...VERIFY, verificationReference: "" }).ok, false, "reference required");
  assert.equal(applyReviewAction(r0, { ...VERIFY, verificationReference: "  " }).ok, false, "blank reference");
  assert.equal(applyReviewAction(r0, { ...VERIFY, verificationConfirmed: false }).ok, false, "attestation required");
  const ok = applyReviewAction(r0, VERIFY);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.match(ok.run.audit.at(-1)!.reference!, /Call 5 Nov 10:15, A\. Rao.*reviewer-attested/);
    assert.equal(ok.run.audit.at(-1)!.attested, true);
  }
});

test("validation: corrections need a substantive reason and a cited source", () => {
  const i = inv({ ...HAPPY, tax: 90 });
  const r0 = asRun(i, run(i), "run-src");
  const base = { reviewer: "Priya", invoice: { tax: 98.8 } };
  assert.equal(applyCorrections(r0, { ...base, reason: "fix", source: "page 1 total box" }, [r0]).ok, false, "weak reason");
  assert.equal(applyCorrections(r0, { ...base, reason: "Tax is 98.80 on the printed invoice", source: "" }, [r0]).ok, false, "no source");
  const ok = applyCorrections(r0, { ...base, reason: "Tax is 98.80 on the printed invoice", source: "page 1 totals box" }, [r0]);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.match(ok.run.audit.at(-1)!.note!, /source: page 1 totals box/);
    assert.equal(ok.run.originalInvoice?.tax, 90, "original extraction preserved");
  }
});

test("safety: approve stays locked while a blocking finding is open, even after other resolutions", () => {
  const r0 = asRun(BLUEPEAK, run(BLUEPEAK), "run-lock");
  const v = applyReviewAction(r0, VERIFY);
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(availableActions(v.run).find((a) => a.id === "approve")!.allowed, false);
  assert.equal(applyReviewAction(v.run, { action: "approve", reviewer: "Priya", justification: "Everything has been checked by me" }).ok, false);
});

// ---------- pre-deployment regression pass ----------

const RAO = inv({
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
const GOOD_REASON = { reviewer: "Priya", reason: "Vendor confirmed the PO by email", source: "vendor email dated 5 Nov" };

test("missing invoice number: Request clarification is the primary action, not a correction", () => {
  const i = inv({ ...HAPPY, invoiceNumber: null });
  const r = asRun(i, run(i), "run-nonum2");
  assert.equal(requiredAction(r, openCodes(r)), "clarify");
  const doc = deriveControls(r).find((c) => c.key === "document")!;
  assert.equal(doc.status, "unresolved");
  assert.equal(doc.action?.id, "request_info");
  assert.match(doc.action!.label, /revised invoice/i);
  assert.match(nextStep(r, openCodes(r)), /Request a revised invoice/);
  assert.ok(availableActions(r).find((a) => a.id === "request_info")!.allowed);
  assert.equal(availableActions(r).find((a) => a.id === "approve")!.allowed, false);
});

test("missing bank details: not shown as Passed/verified, policy unchanged (pays the account on file)", () => {
  const none = inv({ ...HAPPY, bankAccount: null });
  const r = asRun(none, run(none), "run-nobank");
  assert.equal(r.decision.resolution, "AUTO_APPROVE", "business policy preserved: no printed account is not a mismatch");
  const pay = deriveControls(r).find((c) => c.key === "payment")!;
  assert.equal(pay.status, "passed", "does not block");
  assert.equal(pay.caution?.label, "Not provided");
  assert.match(pay.caution!.text, /nothing here was verified/);
  assert.match(caseSummary(r).line, /not verified/);
  assert.doesNotMatch(caseSummary(r).line, /bank match/);
  // too few digits to compare
  const short = inv({ ...HAPPY, bankAccount: "••12" });
  assert.equal(deriveControls(asRun(short, run(short), "run-short")).find((c) => c.key === "payment")!.caution?.label, "Not verified");
  // matching: no caution; conflicting: payment hold
  const ok = deriveControls(asRun(HAPPY, run(HAPPY), "run-bank-ok")).find((c) => c.key === "payment")!;
  assert.equal(ok.caution, undefined);
  assert.equal(asRun(BANK_CHANGE, run(BANK_CHANGE), "run-bank-bad").status, "payment_hold");
});

test("PO selection: a reviewer-chosen PO stays unconfirmed and cannot silently clear the control", () => {
  const r0 = asRun(RAO, run(RAO), "run-po-sel");
  const res = applyCorrections(r0, { ...GOOD_REASON, invoice: { poReference: "PO-2026-0225" } }, [r0]);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.run.poMatch.method, "explicit");
  assert.ok(res.run.findings.some((f) => f.code === "PO_MATCH_UNCONFIRMED" && f.action !== "info"), "still needs owner confirmation");
  assert.ok(openCodes(res.run).includes("PO_MATCH_UNCONFIRMED"));
  assert.equal(availableActions(res.run).find((a) => a.id === "approve")!.allowed, false);
  assert.equal(res.run.audit.at(-1)!.kind, "reviewer");
  assert.match(res.run.audit.at(-1)!.action, /re-ran all checks/);
  // only the owner confirmation clears it, and that is recorded
  const c = applyReviewAction(res.run, { action: "confirm_po", reviewer: "Priya", justification: "Plant manager confirmed PO-2026-0225 by phone" });
  assert.ok(c.ok);
  if (c.ok) assert.ok(!openCodes(c.run).includes("PO_MATCH_UNCONFIRMED"));
});

test("PO selection: an incompatible PO (other vendor) is fully revalidated and blocks, not accepted", () => {
  const r0 = asRun(RAO, run(RAO), "run-po-bad");
  const res = applyCorrections(r0, { ...GOOD_REASON, invoice: { poReference: "PO-2026-0184" } }, [r0]);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.ok(res.run.findings.some((f) => f.code === "PO_VENDOR_MISMATCH"));
  assert.equal(res.run.status, "payment_hold");
  assert.equal(availableActions(res.run).find((a) => a.id === "approve")!.allowed, false);
});

test("duplicates are semantic: reformatted file and changed amount under the same invoice number are blocked", () => {
  const original = asRun(HAPPY, run(HAPPY), "run-dup-orig");
  const ledger = buildLedger(ERP_LEDGER, [original]);
  const revised = inv({ ...HAPPY, lineItems: [{ description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 }], subtotal: 1050, tax: 84, shipping: 0, total: 1134 });
  const r = run(revised, ledger, "different-file-hash", [{ runId: "run-dup-orig", fileHash: "h-new", createdAt: 1, status: "approved", invoiceNumber: "INV-1047" }]);
  assert.ok(r.blocking.includes("DUPLICATE_INVOICE"), "same vendor + same number, new file and new amount");
  assert.equal(r.decision.resolution, "REJECT");
  assert.match(r.findings.find((f) => f.code === "DUPLICATE_INVOICE")!.detail, /amount differs/i);
  assert.equal(asRun(revised, r, "run-dup-2").status, "rejected", "no second payable");
  // formatting differences in the number do not evade it
  const reformatted = inv({ ...HAPPY, invoiceNumber: "Invoice No. 01047" });
  assert.ok(run(reformatted, ledger, "another-hash").blocking.includes("DUPLICATE_INVOICE"));
});

test("duplicates: the same invoice number from an unrelated vendor is not a duplicate", () => {
  const original = asRun(HAPPY, run(HAPPY), "run-dup-orig2");
  const ledger = buildLedger(ERP_LEDGER, [original]);
  const other = inv({ ...BLUEPEAK, invoiceNumber: "INV-1047" });
  const r = run(other, ledger, "hash-bp");
  assert.ok(!r.codes.includes("DUPLICATE_INVOICE"));
  assert.ok(!r.codes.includes("POSSIBLE_DUPLICATE"));
});

test("cumulative PO boundary: exactly at the ceiling passes, one cent over is flagged", () => {
  const solvent = (total: number) => inv({ vendor: "Sunridge Chemicals Ltd.", invoiceNumber: "SC-4001", poReference: "PO-2026-0211", lineItems: [{ description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 1, unitPrice: total, total }], subtotal: total, tax: 0, shipping: 0, total });
  // PO 6,372.00 × 1.02 = 6,499.44 ceiling; 3,823.20 already billed
  const at = run(solvent(2676.24));
  assert.ok(!at.codes.includes("CUMULATIVE_PO_EXCEEDED"), "at the ceiling");
  const over = run(solvent(2676.25));
  assert.ok(over.blocking.includes("CUMULATIVE_PO_EXCEEDED"), "one cent over");
});

test("PO billing counts each eligible invoice once: approvals count, pending / duplicates / rejected do not", () => {
  const a = { ...asRun(inv({ ...HAPPY, invoiceNumber: "INV-2001" }), run(inv({ ...HAPPY, invoiceNumber: "INV-2001" })), "run-c1"), status: "approved" as const };
  const dupOfA = { ...asRun(inv({ ...HAPPY, invoiceNumber: "INV-2001" }), run(inv({ ...HAPPY, invoiceNumber: "INV-2001" }), buildLedger(ERP_LEDGER, [a]), "h2"), "run-c1-dup"), status: "rejected" as const };
  const pending = { ...asRun(inv({ ...HAPPY, invoiceNumber: "INV-2002" }), run(inv({ ...HAPPY, invoiceNumber: "INV-2002" })), "run-c2"), status: "needs_review" as const };
  const ledger = buildLedger(ERP_LEDGER, [a, dupOfA, pending]).filter((l) => l.poId === "PO-2026-0142");
  assert.equal(ledger.filter((l) => l.invoiceNumber === "INV-2001").length, 1, "approved counted once, rejected duplicate excluded");
  const next = inv({ ...HAPPY, invoiceNumber: "INV-2003" });
  const billing = run(next, buildLedger(ERP_LEDGER, [a, dupOfA, pending])).poMatch.billing!;
  assert.equal(billing.pendingInvoices.includes("INV-2002"), true);
  assert.equal(billing.priorInvoices.includes("INV-2002"), false, "pending is not confirmed spend");
  assert.equal(billing.priorInvoices.filter((n) => n === "INV-2001").length, 1);
});

test("stale state: approval is re-checked against the PO position when another invoice used it up first", () => {
  const line = (q: number) => ({ description: 'PCB assembly rev 3.2 - "Orion"', quantity: q, unitPrice: 87.5, total: q * 87.5 });
  const A = inv({ vendor: "Bluepeak Components Inc.", invoiceNumber: "BP-A", poReference: "PO-2026-0184", lineItems: [line(60)], subtotal: 5250, tax: 420, shipping: 120, total: 5790, bankAccount: "5550 1234 7777" });
  const B = inv({ vendor: "Bluepeak Components Inc.", invoiceNumber: "BP-B", poReference: "PO-2026-0184", lineItems: [line(45)], subtotal: 3937.5, tax: 315, shipping: 0, total: 4252.5 });
  const a0 = asRun(A, run(A), "run-A"); // bank change → on hold, pending (not counted yet)
  assert.equal(a0.status, "payment_hold");
  const b = { ...asRun(B, run(B, buildLedger(ERP_LEDGER, [a0]), "hb"), "run-B"), status: "approved" as const }; // B gets approved first
  const verified = applyReviewAction(a0, VERIFY);
  assert.ok(verified.ok);
  if (!verified.ok) return;
  assert.equal(verified.run.findings.some((f) => f.code === "CUMULATIVE_PO_EXCEEDED"), false, "A was fine when it was processed");
  const refreshed = refreshStale(verified.run, [verified.run, b]);
  assert.ok(refreshed, "stale position detected");
  assert.ok(refreshed!.findings.some((f) => f.code === "CUMULATIVE_PO_EXCEEDED" && f.action !== "info"));
  assert.equal(refreshed!.findings.length > verified.run.findings.length, true, "originals kept, new finding added");
  assert.equal(refreshed!.audit.length, verified.run.audit.length + 1, "audit appended, never rewritten");
  assert.equal(refreshed!.audit.at(-1)!.kind, "system");
  assert.equal(availableActions(refreshed!).find((x) => x.id === "approve")!.allowed, false, "approval is blocked until it is authorised");
  // a competing PENDING invoice alone must not block (whoever is approved first is legitimate)
  assert.equal(refreshStale(verified.run, [verified.run, { ...b, status: "needs_review" as const }]), null);
});

test("reviewer state transitions: awaiting vendor, hold, and closed states behave", () => {
  const r = asRun(BANK_CHANGE, run(BANK_CHANGE), "run-trans");
  const asked = applyReviewAction(r, { action: "request_info", reviewer: "Priya", justification: "Asked the vendor to confirm the new account" });
  assert.ok(asked.ok);
  if (!asked.ok) return;
  assert.equal(asked.run.status, "awaiting_info");
  assert.equal(applyReviewAction(asked.run, { action: "request_info", reviewer: "Priya", justification: "Asked the vendor again today" }).ok, false, "cannot request twice");
  assert.equal(applyReviewAction(asked.run, { action: "approve", reviewer: "Priya", justification: "Everything was checked by me" }).ok, false, "still blocked while waiting");
  const verified = applyReviewAction(asked.run, VERIFY);
  assert.ok(verified.ok, "a call-back can still be recorded while waiting");
  if (!verified.ok) return;
  assert.equal(caseSummary(verified.run).title.startsWith("Verification recorded"), true);
  const done = applyReviewAction(verified.run, { action: "approve", reviewer: "Priya", justification: "Call-back recorded and all controls resolved" });
  assert.ok(done.ok && done.run.status === "approved");
  if (done.ok) assert.equal(availableActions(done.run).length, 0, "closed");
});

test("audit: attested verification and PO authorisation keep identity, reference, justification and original findings", () => {
  const r0 = asRun(BLUEPEAK, run(BLUEPEAK), "run-audit");
  const originalCodes = r0.findings.map((f) => f.code);
  const v = applyReviewAction(r0, VERIFY);
  assert.ok(v.ok);
  if (!v.ok) return;
  const po = applyReviewAction(v.run, { action: "resolve_po", reviewer: "Sam", justification: "Owner approved the price change in writing", authorizedBy: "a.patel", reference: "AMD-77" });
  assert.ok(po.ok);
  if (!po.ok) return;
  const [, e1, e2] = po.run.audit;
  assert.equal(e1.actor, "Priya");
  assert.match(e1.reference!, /Call 5 Nov 10:15, A\. Rao/);
  assert.equal(e1.attested, true);
  assert.equal(e1.note, VERIFY.justification);
  assert.equal(e2.actor, "Sam");
  assert.match(e2.reference!, /a\.patel.*AMD-77/);
  assert.equal(e2.note, "Owner approved the price change in writing");
  assert.deepEqual(po.run.findings.map((f) => f.code), originalCodes, "original findings untouched");
  assert.match(e1.action, /attested/i);
  assert.doesNotMatch(JSON.stringify(po.run.audit), /Verified payment details by independent call-back/);
});

test("analytics: unique invoices, repeat uploads, STP, awaiting and exposure share one set of definitions", () => {
  const ok = asRun(HAPPY, run(HAPPY), "m-ok"); // auto-approved
  const repeat = { ...asRun(HAPPY, run(HAPPY, buildLedger(ERP_LEDGER, [ok]), "m-h2"), "m-repeat"), repeatSubmission: true }; // re-upload of the same invoice
  const open = asRun(BANK_CHANGE, run(BANK_CHANGE), "m-open"); // on hold, $3,272
  const m = computeMetrics([ok, repeat, open]);
  assert.equal(m.attempts, 3);
  assert.equal(m.cases, 2, "the repeat is not a new invoice");
  assert.equal(m.repeatAttempts, 1);
  assert.equal(m.eligible, 2, "repeat of an invoice already on file is not eligible");
  assert.equal(m.autoApproved, 1);
  assert.equal(m.stpRate, 0.5);
  assert.equal(m.awaiting, 1);
  assert.equal(m.holds, 1);
  assert.equal(m.valueRequiringIntervention, 3272);
  assert.deepEqual(m.byStatus, { approved: 1, needs_review: 0, payment_hold: 1, rejected: 0 });
});
