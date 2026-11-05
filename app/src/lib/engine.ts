// Deterministic AP decision engine.
//
// The LLM only reads the document. Every check below is plain code with an
// explicit threshold from Rules, so the same invoice always gets the same
// decision and every decision can point at the rule that produced it.

import type {
  BillingSummary,
  CheckAction,
  Decision,
  ExceptionCode,
  Explanation,
  Finding,
  Invoice,
  LedgerInvoice,
  LineItem,
  PoMatch,
  PurchaseOrder,
  Resolution,
  RunRecord,
  StageId,
  Vendor,
} from "../types.ts";
import type { Rules } from "./rules.ts";

// ---------- Normalisation helpers ----------

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|pvt|plc|gmbh)\b/g;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "INV-0923", "Invoice No. 923", "inv 923" all normalise to "923".
export function normalizeInvoiceNumber(s: string | null | undefined): string {
  if (!s) return "";
  let v = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let prev = "";
  while (prev !== v) {
    prev = v;
    v = v.replace(/^(INVOICE|INV|NO|NUMBER|NUM|BILL)/, "");
  }
  return v.replace(/^0+(?=.)/, "");
}

export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 1),
  );
}

export function tokenOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

export function money(amount: number | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const code = (currency || "USD").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

const last4 = (s: string) => digitsOnly(s).slice(-4);
const round2 = (n: number) => Math.round(n * 100) / 100;

function finding(
  stage: StageId,
  code: ExceptionCode,
  action: CheckAction,
  title: string,
  detail: string,
): Finding {
  return { stage, code, action, title, detail };
}

// ---------- Stage: validate ----------

export function validateInvoice(inv: Invoice, rules: Rules): Finding[] {
  const out: Finding[] = [];
  const tol = rules.arithmeticToleranceAbs;

  const missing: string[] = [];
  if (!inv.vendor) missing.push("vendor name");
  if (!inv.invoiceNumber) missing.push("invoice number");
  if (!inv.issueDate) missing.push("invoice date");
  if (inv.total === null || inv.total === undefined) missing.push("invoice total");
  if (missing.length) {
    out.push(
      finding(
        "validate",
        "MISSING_FIELD",
        "review",
        `Missing ${missing.join(", ")}`,
        `The invoice does not show: ${missing.join(", ")}. These are required to book and de-duplicate the invoice.`,
      ),
    );
  }

  const problems: string[] = [];
  for (const li of inv.lineItems) {
    const expected = round2(li.quantity * li.unitPrice);
    if (Math.abs(expected - li.total) > tol) {
      problems.push(`"${li.description}": ${li.quantity} × ${money(li.unitPrice, inv.currency)} = ${money(expected, inv.currency)}, but line shows ${money(li.total, inv.currency)}`);
    }
  }
  const lineSum = round2(inv.lineItems.reduce((s, li) => s + li.total, 0));
  if (inv.lineItems.length && inv.subtotal !== null && Math.abs(lineSum - inv.subtotal) > tol) {
    problems.push(`line items add up to ${money(lineSum, inv.currency)}, but subtotal shows ${money(inv.subtotal, inv.currency)}`);
  }
  const base = inv.subtotal ?? (inv.lineItems.length ? lineSum : null);
  if (base !== null && inv.total !== null) {
    const expectedTotal = round2(base + (inv.tax || 0) + (inv.shipping || 0));
    if (Math.abs(expectedTotal - inv.total) > tol) {
      problems.push(`subtotal + tax + shipping = ${money(expectedTotal, inv.currency)}, but total shows ${money(inv.total, inv.currency)}`);
    }
  }
  if (problems.length) {
    out.push(
      finding(
        "validate",
        "ARITHMETIC_MISMATCH",
        "review",
        "Invoice arithmetic does not reconcile",
        `${problems.join("; ")}. Either the vendor made an error or a figure was misread.`,
      ),
    );
  }

  if (inv.documentType === "handwritten" && rules.reviewHandwritten) {
    out.push(
      finding(
        "validate",
        "HANDWRITTEN_DOCUMENT",
        "review",
        "Handwritten invoice",
        "Policy: handwritten invoices are never auto-approved. A reviewer should confirm the figures against the original.",
      ),
    );
  } else if (inv.documentType !== "digital") {
    out.push(
      finding(
        "validate",
        "LOW_CONFIDENCE_READ",
        "info",
        `${inv.documentType === "scanned" ? "Scanned" : "Handwritten"} document`,
        "No text layer: fields were read visually from the page image.",
      ),
    );
  }

  const critical = ["total", "invoiceNumber", "bankAccount", "poReference", "lineItems", "subtotal", "tax"];
  const unsure = inv.lowConfidenceFields ?? [];
  const criticalUnsure = unsure.filter((f) => critical.some((c) => f.toLowerCase().startsWith(c.toLowerCase())));
  if (criticalUnsure.length) {
    out.push(
      finding(
        "validate",
        "LOW_CONFIDENCE_READ",
        "review",
        "Some figures could not be read with confidence",
        `Uncertain fields: ${criticalUnsure.join(", ")}. Confirm against the original before paying.`,
      ),
    );
  } else if (unsure.length) {
    out.push(
      finding("validate", "LOW_CONFIDENCE_READ", "info", "Minor fields read with low confidence", `Uncertain: ${unsure.join(", ")} (not used for the decision).`),
    );
  }
  return out;
}

// ---------- Stage: vendor ----------

export function resolveVendor(name: string, vendors: Vendor[]): { vendor: Vendor; how: "exact" | "alias" | "fuzzy" } | null {
  const n = normalizeName(name || "");
  if (!n) return null;
  for (const v of vendors) if (normalizeName(v.name) === n) return { vendor: v, how: "exact" };
  for (const v of vendors) if (v.aliases.some((a) => normalizeName(a) === n)) return { vendor: v, how: "alias" };
  let best: { vendor: Vendor; score: number } | null = null;
  for (const v of vendors) {
    for (const cand of [v.name, ...v.aliases]) {
      const score = tokenOverlap(n, normalizeName(cand));
      if (score >= 0.75 && (!best || score > best.score)) best = { vendor: v, score };
    }
  }
  return best ? { vendor: best.vendor, how: "fuzzy" } : null;
}

export function checkVendor(inv: Invoice, vendors: Vendor[]): { vendor: Vendor | null; findings: Finding[]; lines: string[] } {
  const findings: Finding[] = [];
  const lines: string[] = [];
  const hit = resolveVendor(inv.vendor, vendors);
  if (!hit) {
    findings.push(
      finding(
        "vendor",
        "VENDOR_NOT_IN_MASTER",
        "escalate",
        "Vendor is not in the approved vendor master",
        `"${inv.vendor}" does not match any approved vendor or known alias. No payment can be made until procurement onboards and verifies this vendor.`,
      ),
    );
    lines.push(`"${inv.vendor}" not found among ${vendors.length} approved vendors`);
    return { vendor: null, findings, lines };
  }
  const v = hit.vendor;
  lines.push(`Matched vendor master ${v.id} · ${v.name} (${hit.how} match)`);
  if (hit.how !== "exact") {
    findings.push(
      finding("vendor", "VENDOR_NAME_VARIANT", "info", "Vendor name variant", `Printed as "${inv.vendor}", matched to master record "${v.name}" (${hit.how}).`),
    );
  }
  if (v.status === "blocked") {
    findings.push(finding("vendor", "VENDOR_BLOCKED", "reject", "Vendor is blocked", `${v.name} is blocked in the vendor master.`));
  }
  if (inv.bankAccount) {
    if (digitsOnly(inv.bankAccount) !== digitsOnly(v.bankAccount)) {
      findings.push(
        finding(
          "vendor",
          "BANK_DETAILS_CHANGED",
          "escalate",
          "Remit-to bank account differs from vendor master",
          `Invoice asks for payment to account ending ${last4(inv.bankAccount)}; the vendor master has ${v.bankName} account ending ${last4(v.bankAccount)}. Changed bank details on an invoice are the most common payment-fraud pattern. Verify by phone using the contact on file, never the one on the invoice.`,
        ),
      );
      lines.push(`Bank account on invoice ends ${last4(inv.bankAccount)} ≠ master ${last4(v.bankAccount)}`);
    } else {
      lines.push(`Bank account matches master (ending ${last4(v.bankAccount)})`);
    }
  } else {
    lines.push("No bank details printed; will pay to account on file");
  }
  return { vendor: v, findings, lines };
}

// ---------- Stage: PO match ----------

function poKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sameInvoice(a: { vendorId: string | null; vendor: string; invoiceNumber: string | null }, b: { vendorId: string | null; vendor: string; invoiceNumber: string | null }): boolean {
  const na = normalizeInvoiceNumber(a.invoiceNumber);
  if (!na || na !== normalizeInvoiceNumber(b.invoiceNumber)) return false;
  if (a.vendorId && b.vendorId) return a.vendorId === b.vendorId;
  return normalizeName(a.vendor) === normalizeName(b.vendor);
}

function priorOnPo(po: PurchaseOrder, inv: Invoice, vendorId: string | null, ledger: LedgerInvoice[]): LedgerInvoice[] {
  return ledger.filter(
    (l) => l.poId === po.id && !sameInvoice(l, { vendorId, vendor: inv.vendor, invoiceNumber: inv.invoiceNumber }),
  );
}

function billingFor(po: PurchaseOrder, inv: Invoice, vendorId: string | null, ledger: LedgerInvoice[]): BillingSummary {
  const prior = priorOnPo(po, inv, vendorId, ledger);
  const previouslyBilled = round2(prior.reduce((s, l) => s + l.total, 0));
  const thisInvoice = inv.total ?? 0;
  const billedAfter = round2(previouslyBilled + thisInvoice);
  return {
    poTotal: po.total,
    previouslyBilled,
    thisInvoice,
    billedAfter,
    remainingAfter: round2(po.total - billedAfter),
    priorInvoices: prior.map((p) => p.invoiceNumber),
  };
}

function matchLine(desc: string, lines: LineItem[]): LineItem | null {
  let best: { li: LineItem; s: number } | null = null;
  for (const li of lines) {
    const s = tokenOverlap(desc, li.description);
    if (s >= 0.5 && (!best || s > best.s)) best = { li, s };
  }
  return best?.li ?? null;
}

function inferPo(inv: Invoice, vendor: Vendor | null, pos: PurchaseOrder[], ledger: LedgerInvoice[], rules: Rules): { po: PurchaseOrder; note: string } | null {
  if (!vendor || inv.total === null) return null;
  const candidates = pos.filter((p) => p.vendorId === vendor.id && p.status === "open");
  let best: { po: PurchaseOrder; score: number; note: string } | null = null;
  for (const po of candidates) {
    const b = billingFor(po, inv, vendor.id, ledger);
    const remaining = round2(po.total - b.previouslyBilled);
    if (remaining <= 0) continue;
    const amountFit = 1 - Math.min(1, Math.abs(remaining - inv.total) / remaining);
    const matchedLines = inv.lineItems.filter((li) => matchLine(li.description, po.lineItems)).length;
    const lineFit = inv.lineItems.length ? matchedLines / inv.lineItems.length : 0;
    const withinValue = inv.total <= remaining * (1 + rules.amountTolerancePct);
    const score = amountFit * 0.6 + lineFit * 0.4;
    if (withinValue && (amountFit >= 1 - rules.amountTolerancePct || lineFit >= 0.5) && (!best || score > best.score)) {
      best = {
        po,
        score,
        note: `vendor ${vendor.name}; invoice ${money(inv.total, inv.currency)} vs ${money(remaining, po.currency)} open on PO; ${matchedLines}/${inv.lineItems.length} line descriptions match`,
      };
    }
  }
  return best ? { po: best.po, note: best.note } : null;
}

export function matchPurchaseOrder(
  inv: Invoice,
  vendor: Vendor | null,
  pos: PurchaseOrder[],
  ledger: LedgerInvoice[],
  rules: Rules,
  today: string,
): { poMatch: PoMatch; findings: Finding[]; lines: string[] } {
  const findings: Finding[] = [];
  const lines: string[] = [];
  let po: PurchaseOrder | null = null;
  let method: PoMatch["method"] = "none";
  let inferenceNote: string | undefined;

  if (inv.poReference) {
    po = pos.find((p) => poKey(p.id) === poKey(inv.poReference!)) ?? null;
    if (po) {
      method = "explicit";
      lines.push(`PO reference ${inv.poReference} found: ${po.id} (${po.vendor}, ${money(po.total, po.currency)})`);
    } else {
      lines.push(`PO reference ${inv.poReference} not found in PO table`);
    }
  } else {
    lines.push("No PO reference printed on the invoice");
  }

  if (!po) {
    const inferred = inferPo(inv, vendor, pos, ledger, rules);
    if (inferred) {
      po = inferred.po;
      method = "inferred";
      inferenceNote = inferred.note;
      lines.push(`Inferred ${po.id} from ${inferred.note}`);
      findings.push(
        finding(
          "po_match",
          "PO_INFERRED",
          "review",
          `PO inferred: ${po.id}`,
          `${inv.poReference ? `Printed PO "${inv.poReference}" does not exist` : "No PO number on the invoice"}. Best match is ${po.id} (${inferred.note}). A person should confirm the match before payment.`,
        ),
      );
    } else if (inv.poReference) {
      findings.push(
        finding("po_match", "UNKNOWN_PO", "review", "PO number not recognised", `PO "${inv.poReference}" is not in the PO table and no open PO for this vendor fits the invoice.`),
      );
    } else {
      findings.push(
        finding(
          "po_match",
          "MISSING_PO_REFERENCE",
          "review",
          "No PO reference and no matching open PO",
          vendor ? `No open PO for ${vendor.name} can absorb ${money(inv.total, inv.currency)}. Ask the requester to raise or identify a PO.` : "Cannot infer a PO for an unknown vendor.",
        ),
      );
    }
  }

  if (!po) return { poMatch: { po: null, method: "none" }, findings, lines };

  if (vendor && po.vendorId !== vendor.id) {
    findings.push(
      finding("po_match", "PO_VENDOR_MISMATCH", "escalate", "PO belongs to a different vendor", `${po.id} was raised for ${po.vendor}, but the invoice is from ${vendor.name}.`),
    );
  }
  const asOf = inv.issueDate ?? today;
  if (po.status === "expired" || po.expirationDate < asOf) {
    findings.push(finding("po_match", "EXPIRED_PO", "review", "PO expired", `${po.id} expired on ${po.expirationDate}; invoice dated ${asOf}. Needs re-authorisation by ${po.approvedBy}.`));
  } else if (po.status === "closed") {
    findings.push(finding("po_match", "CLOSED_PO", "review", "PO is closed", `${po.id} is closed for invoicing.`));
  }
  if (inv.currency && po.currency && inv.currency.toUpperCase() !== po.currency.toUpperCase()) {
    findings.push(finding("po_match", "CURRENCY_MISMATCH", "review", "Currency differs from PO", `Invoice in ${inv.currency}, PO in ${po.currency}.`));
  }

  // Value: compare against what is still open on the PO, not the full PO.
  // This is what makes split invoicing work without false alarms.
  const billing = billingFor(po, inv, vendor?.id ?? null, ledger);
  const ceiling = po.total * (1 + rules.amountTolerancePct);
  const pct = (n: number) => `${((n / po.total) * 100).toFixed(1)}%`;
  lines.push(
    `PO value ${money(po.total, po.currency)} · previously billed ${money(billing.previouslyBilled, po.currency)}${billing.priorInvoices.length ? ` (${billing.priorInvoices.join(", ")})` : ""} · this invoice ${money(billing.thisInvoice, po.currency)} → ${pct(billing.billedAfter)} billed`,
  );
  if (billing.billedAfter > ceiling) {
    if (billing.previouslyBilled > 0) {
      findings.push(
        finding(
          "po_match",
          "CUMULATIVE_OVERBILLING",
          "review",
          "Split invoices exceed the PO",
          `${po.id} is for ${money(po.total, po.currency)}. Already billed ${money(billing.previouslyBilled, po.currency)} on ${billing.priorInvoices.join(", ")}; this invoice adds ${money(billing.thisInvoice, po.currency)}, bringing the total to ${money(billing.billedAfter, po.currency)} (${pct(billing.billedAfter)} of the PO, tolerance ${(rules.amountTolerancePct * 100).toFixed(0)}%). Over by ${money(billing.billedAfter - po.total, po.currency)}.`,
        ),
      );
    } else {
      findings.push(
        finding(
          "po_match",
          "AMOUNT_OVER_PO",
          "review",
          "Invoice exceeds PO value",
          `Invoice ${money(billing.thisInvoice, po.currency)} vs PO ${money(po.total, po.currency)} (${pct(billing.billedAfter)}; tolerance ${(rules.amountTolerancePct * 100).toFixed(0)}%).`,
        ),
      );
    }
  } else if (billing.previouslyBilled > 0 || billing.remainingAfter > po.total * rules.amountTolerancePct) {
    findings.push(
      finding(
        "po_match",
        "PARTIAL_BILLING",
        "info",
        "Partial billing against PO",
        `After this invoice ${pct(billing.billedAfter)} of ${po.id} is billed; ${money(Math.max(0, billing.remainingAfter), po.currency)} remains open.`,
      ),
    );
  } else if (Math.abs(billing.remainingAfter) >= 0.01) {
    findings.push(
      finding("po_match", "WITHIN_TOLERANCE", "info", "Small variance within tolerance", `Invoice differs from PO value by ${money(Math.abs(billing.remainingAfter), po.currency)} (within ${(rules.amountTolerancePct * 100).toFixed(0)}%).`),
    );
  }

  // Lines: quantity (cumulative across split invoices) and unit price.
  const prior = priorOnPo(po, inv, vendor?.id ?? null, ledger);
  for (const li of inv.lineItems) {
    const poLine = matchLine(li.description, po.lineItems);
    if (!poLine) {
      findings.push(finding("po_match", "LINE_NOT_ON_PO", "review", "Line not on PO", `"${li.description}" (${money(li.total, inv.currency)}) does not correspond to any line on ${po.id}.`));
      continue;
    }
    const priorQty = prior.reduce((s, p) => {
      const m = matchLine(poLine.description, p.lineItems);
      return s + (m ? m.quantity : 0);
    }, 0);
    if (priorQty + li.quantity > poLine.quantity + rules.quantityTolerance) {
      findings.push(
        finding(
          "po_match",
          "QUANTITY_OVER_PO",
          "review",
          "Quantity exceeds what was ordered",
          `"${poLine.description}": ordered ${poLine.quantity}, previously billed ${priorQty}, this invoice ${li.quantity} → ${priorQty + li.quantity} billed.`,
        ),
      );
    }
    const drift = poLine.unitPrice > 0 ? (li.unitPrice - poLine.unitPrice) / poLine.unitPrice : 0;
    if (drift > rules.priceTolerancePct) {
      findings.push(
        finding(
          "po_match",
          "PRICE_VARIANCE",
          "review",
          "Unit price above PO price",
          `"${poLine.description}": invoiced at ${money(li.unitPrice, inv.currency)} vs PO ${money(poLine.unitPrice, po.currency)} (+${(drift * 100).toFixed(1)}%).`,
        ),
      );
    }
  }

  return { poMatch: { po, method, inferenceNote, billing }, findings, lines };
}

// ---------- Stage: duplicates ----------

export function checkDuplicates(inv: Invoice, vendor: Vendor | null, ledger: LedgerInvoice[], rules: Rules): { findings: Finding[]; lines: string[] } {
  const findings: Finding[] = [];
  const vendorId = vendor?.id ?? null;
  const sameVendor = ledger.filter((l) => (vendorId && l.vendorId ? l.vendorId === vendorId : normalizeName(l.vendor) === normalizeName(inv.vendor)));
  const lines = [`Checked ${ledger.length} known invoices (${sameVendor.length} from this vendor)`];

  const exact = sameVendor.find((l) => sameInvoice(l, { vendorId, vendor: inv.vendor, invoiceNumber: inv.invoiceNumber }));
  if (exact) {
    const printedDiffers = (exact.invoiceNumber ?? "") !== (inv.invoiceNumber ?? "");
    findings.push(
      finding(
        "duplicates",
        "DUPLICATE_INVOICE",
        "reject",
        `Duplicate of ${exact.invoiceNumber}`,
        `This invoice matches ${exact.invoiceNumber} (${money(exact.total, inv.currency)}, dated ${exact.issueDate}, status ${exact.status.replace("_", " ")}).${printedDiffers ? ` Printed as "${inv.invoiceNumber}", which normalises to the same reference.` : ""} Paying it would pay the same bill twice.`,
      ),
    );
    lines.push(`Exact duplicate: "${inv.invoiceNumber}" ≡ "${exact.invoiceNumber}"`);
    return { findings, lines };
  }

  if (inv.total !== null) {
    const day = 86400000;
    const when = inv.issueDate ? Date.parse(inv.issueDate) : NaN;
    const near = sameVendor.find(
      (l) => Math.abs(l.total - inv.total!) < 0.01 && (Number.isNaN(when) || Math.abs(Date.parse(l.issueDate) - when) <= rules.duplicateWindowDays * day),
    );
    if (near) {
      findings.push(
        finding(
          "duplicates",
          "POSSIBLE_DUPLICATE",
          "review",
          `Possible duplicate of ${near.invoiceNumber}`,
          `Same vendor and same amount (${money(near.total, inv.currency)}) as ${near.invoiceNumber} dated ${near.issueDate}, within ${rules.duplicateWindowDays} days, but a different invoice number. Could be a re-issued invoice.`,
        ),
      );
      lines.push(`Same vendor + amount as ${near.invoiceNumber} within ${rules.duplicateWindowDays} days`);
      return { findings, lines };
    }
  }
  lines.push("No duplicates found");
  return { findings, lines };
}

// ---------- Stage: decide ----------

const RANK: Record<CheckAction, number> = { info: 0, review: 1, escalate: 2, reject: 3 };

export function decide(inv: Invoice, findings: Finding[], rules: Rules): { decision: Decision; extra: Finding[] } {
  const extra: Finding[] = [];
  if (inv.total !== null && inv.total > rules.autoApproveLimit) {
    extra.push(
      finding("decide", "OVER_APPROVAL_LIMIT", "review", "Above auto-approval limit", `Total ${money(inv.total, inv.currency)} exceeds the ${money(rules.autoApproveLimit, inv.currency)} auto-approval limit.`),
    );
  }
  const all = [...findings, ...extra];
  const top = all.reduce((m, f) => Math.max(m, RANK[f.action]), 0);
  const deciding = all.filter((f) => RANK[f.action] === top && top > 0);
  const codes = deciding.map((f) => f.code);
  const has = (c: ExceptionCode) => codes.includes(c);

  let resolution: Resolution;
  let headline: string;
  let nextAction: string;
  if (top === RANK.reject) {
    resolution = "REJECT";
    headline = has("DUPLICATE_INVOICE") ? "Rejected: duplicate of an invoice already on file" : "Rejected";
    nextAction = has("DUPLICATE_INVOICE")
      ? "Do not pay. Reply to the vendor that this invoice was already received and paid, quoting the original reference."
      : "Do not pay. Notify the vendor of the rejection reason.";
  } else if (top === RANK.escalate) {
    resolution = "ESCALATE";
    if (has("BANK_DETAILS_CHANGED")) {
      headline = "Payment hold: bank details changed";
      nextAction = "Hold payment. AP manager to verify the bank change by calling the vendor on the number in the vendor master. Do not use contact details from the invoice.";
    } else if (has("VENDOR_NOT_IN_MASTER")) {
      headline = "Payment hold: unknown vendor";
      nextAction = "Route to procurement. The vendor must be onboarded and verified (tax ID, bank letter) before any payment.";
    } else {
      headline = "Escalated to AP manager";
      nextAction = deciding.map((f) => f.title).join("; ");
    }
  } else if (top === RANK.review) {
    resolution = "FLAG_FOR_REVIEW";
    headline = `Needs review: ${deciding.length} item${deciding.length > 1 ? "s" : ""} to confirm`;
    nextAction = deciding.map((f) => f.title).join(" · ");
  } else {
    resolution = "AUTO_APPROVE";
    headline = "Approved for payment";
    nextAction = `Schedule payment${inv.dueDate ? ` for ${inv.dueDate}` : ""}${inv.paymentTerms ? ` (${inv.paymentTerms})` : ""} to the account on file.`;
  }
  return { decision: { resolution, headline, decidingCodes: codes, nextAction }, extra };
}

// ---------- Fallback explanation (used if the LLM is unavailable) ----------

export function templateExplanation(inv: Invoice, poMatch: PoMatch, findings: Finding[], decision: Decision): Explanation {
  const issues = findings.filter((f) => f.action !== "info");
  const po = poMatch.po ? `${poMatch.po.id}${poMatch.method === "inferred" ? " (inferred)" : ""}` : "no PO";
  const summary =
    decision.resolution === "AUTO_APPROVE"
      ? `Invoice ${inv.invoiceNumber ?? "(no number)"} from ${inv.vendor} for ${money(inv.total, inv.currency)} matches ${po}; all checks passed. ${decision.nextAction}`
      : `Invoice ${inv.invoiceNumber ?? "(no number)"} from ${inv.vendor} for ${money(inv.total, inv.currency)} against ${po}. ${decision.headline}. ${issues.map((f) => `${f.title}: ${f.detail}`).join(" ")}`;
  const vendorEmail =
    decision.resolution === "AUTO_APPROVE" || decision.resolution === "ESCALATE"
      ? null
      : `Subject: Invoice ${inv.invoiceNumber ?? ""} – action needed\n\nHello ${inv.vendor} team,\n\nWe could not process invoice ${inv.invoiceNumber ?? ""} (${money(inv.total, inv.currency)}) yet:\n${issues.map((f) => `- ${f.title}`).join("\n")}\n\nPlease review and reply with a corrected invoice or clarification.\n\nThanks,\nAccounts Payable`;
  return { summary, vendorEmail, generatedBy: "template" };
}

// ---------- Ledger ----------

export function buildLedger(erp: LedgerInvoice[], runs: RunRecord[]): LedgerInvoice[] {
  const fromRuns: LedgerInvoice[] = runs
    .filter((r) => r.reviewStatus !== "rejected" && r.invoice.invoiceNumber)
    .map((r) => ({
      vendorId: r.vendorId,
      vendor: r.invoice.vendor,
      invoiceNumber: r.invoice.invoiceNumber!,
      poId: r.poMatch.po?.id ?? null,
      total: r.invoice.total ?? 0,
      issueDate: r.invoice.issueDate ?? new Date(r.createdAt).toISOString().slice(0, 10),
      lineItems: r.invoice.lineItems,
      status: r.reviewStatus === "pending" ? "pending_review" : "approved",
      source: "run",
      runId: r.id,
    }));
  return [...erp, ...fromRuns];
}

export function resolutionLabel(r: Resolution): string {
  switch (r) {
    case "AUTO_APPROVE":
      return "Approved";
    case "FLAG_FOR_REVIEW":
      return "Needs review";
    case "ESCALATE":
      return "Payment hold";
    case "REJECT":
      return "Rejected";
  }
}
