// Deterministic AP decision engine.
//
// The LLM only reads the document. Every check below is plain code with an
// explicit threshold from Rules, so the same invoice always gets the same
// decision and every decision can point at the rule that produced it.
//
// Decision precedence (strictest finding wins):
//   reject   — confirmed duplicate, blocked vendor              → Rejected
//   escalate — bank account mismatch, unknown vendor, PO of other vendor → Payment hold
//   review   — missing info, arithmetic, unconfirmed PO, over PO, low confidence → Needs review
//   info     — recorded, never blocks                           → Approved if nothing else

import type {
  BillingSummary,
  CaseStatus,
  CheckAction,
  Decision,
  DuplicateRef,
  Evidence,
  ExceptionCode,
  Explanation,
  Finding,
  Invoice,
  LedgerInvoice,
  LineCheck,
  LineItem,
  PoMatch,
  PurchaseOrder,
  Resolution,
  RunRecord,
  StageId,
  Vendor,
} from "../types.ts";
import type { Rules } from "./policy.ts";

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

// Conservative: ignore case, spaces, punctuation, a leading "INV"/"Invoice No"
// label and leading zeros. "INV-0923", "Invoice No. 923" and "inv 923" match;
// "SC-3390" and "3390" do not (different alphabetic prefix).
export function normalizeInvoiceNumber(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(INVOICE|INV)(NO|NUMBER)?(?=\d)/, "")
    .replace(/^0+(?=.)/, "");
}

export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

export function maskAccount(s: string | null | undefined): string {
  const d = digitsOnly(s);
  return d ? `•••• ${d.slice(-4)}` : "—";
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

const round2 = (n: number) => Math.round(n * 100) / 100;

// The ONE percentage format used everywhere (engine text, evidence, UI):
// fraction in, signed 2-decimal percent out. 486 / 9570 → "+5.08%".
export function fmtPct(fraction: number, signed = true): string {
  const v = (fraction * 100).toFixed(2);
  return signed && fraction >= 0 ? `+${v}%` : `${v}%`;
}
const pct = (n: number) => fmtPct(n);
const signedMoney = (n: number, c: string) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n), c)}`;

function finding(stage: StageId, code: ExceptionCode, action: CheckAction, title: string, detail: string, evidence?: Evidence[]): Finding {
  return { stage, code, action, title, detail, evidence };
}

// A PO a reviewer selected (it was not printed on the invoice) is a lead, not
// proof the spend was authorised. It stays unconfirmed until the PO owner
// confirms it, so choosing a PO never silently clears the PO control.
export function assignedPoFinding(po: PurchaseOrder): Finding {
  return finding(
    "po_match",
    "PO_MATCH_UNCONFIRMED",
    "review",
    `PO ${po.id} was selected by a reviewer`,
    `${po.id} is not the PO printed on the invoice; a reviewer selected it. A selection is not proof the spend was authorised: confirm with the PO owner (${po.approvedBy}) before approving.`,
    [
      { label: "PO printed on invoice", value: "not this PO", tone: "bad" },
      { label: "PO selected by reviewer", value: `${po.id} · ${money(po.total, po.currency)}` },
      { label: "PO owner", value: po.approvedBy },
    ],
  );
}

// ---------- Stage: validate ----------

export function expectedTotal(inv: Invoice): number | null {
  const lineSum = round2(inv.lineItems.reduce((s, li) => s + li.total, 0));
  const base = inv.subtotal ?? (inv.lineItems.length ? lineSum : null);
  if (base === null) return null;
  return round2(base + (inv.tax || 0) + (inv.shipping || 0) + (inv.otherCharges || 0) - (inv.discount || 0));
}

export function validateInvoice(inv: Invoice, rules: Rules): Finding[] {
  const out: Finding[] = [];
  const tol = rules.arithmeticToleranceAbs;
  const c = inv.currency;

  const missing: string[] = [];
  if (!inv.vendor) missing.push("vendor name");
  if (!inv.invoiceNumber) missing.push("invoice number");
  if (!inv.issueDate) missing.push("invoice date");
  if (inv.total === null || inv.total === undefined) missing.push("invoice total");
  if (missing.length) {
    out.push(
      finding("validate", "MISSING_FIELD", "review", `Missing ${missing.join(", ")}`, `The invoice does not show: ${missing.join(", ")}. These are required to book the invoice and check it for duplicates.`),
    );
  }

  // Internal arithmetic: each check is independent of the PO, so a PO
  // tolerance can never hide an invoice that does not add up.
  const problems: string[] = [];
  const evidence: Evidence[] = [];
  for (const li of inv.lineItems) {
    const exp = round2(li.quantity * li.unitPrice);
    if (Math.abs(exp - li.total) > tol) {
      problems.push(`"${li.description}": ${li.quantity} × ${money(li.unitPrice, c)} = ${money(exp, c)}, line shows ${money(li.total, c)}`);
    }
  }
  const lineSum = round2(inv.lineItems.reduce((s, li) => s + li.total, 0));
  if (inv.lineItems.length && inv.subtotal !== null && Math.abs(lineSum - inv.subtotal) > tol) {
    problems.push(`line items sum to ${money(lineSum, c)}, subtotal shows ${money(inv.subtotal, c)}`);
  }
  const exp = expectedTotal(inv);
  if (exp !== null && inv.total !== null) {
    evidence.push(
      { label: "Subtotal", value: money(inv.subtotal ?? lineSum, c) },
      { label: "Tax", value: money(inv.tax, c) },
      ...(inv.shipping ? [{ label: "Freight / shipping", value: money(inv.shipping, c) }] : []),
      ...(inv.otherCharges ? [{ label: "Other charges", value: money(inv.otherCharges, c) }] : []),
      ...(inv.discount ? [{ label: "Discount", value: `−${money(inv.discount, c)}` }] : []),
      { label: "Expected total", value: money(exp, c) },
      { label: "Invoice total", value: money(inv.total, c) },
    );
    const diff = round2(inv.total - exp);
    if (Math.abs(diff) > tol) {
      problems.push(`expected total ${money(exp, c)} but invoice shows ${money(inv.total, c)} (difference ${signedMoney(diff, c)})`);
      evidence.push({ label: "Difference", value: signedMoney(diff, c), tone: "bad" });
    } else {
      evidence.push({ label: "Difference", value: `${signedMoney(diff, c)} (within ${money(tol, c)} rounding)`, tone: "good" });
    }
  }
  if (problems.length) {
    out.push(
      finding(
        "validate",
        "ARITHMETIC_MISMATCH",
        "review",
        "Invoice does not add up",
        `${problems.join("; ")}. Either the vendor made an error or a figure was misread. PO tolerance does not apply to internal arithmetic.`,
        evidence,
      ),
    );
  }

  if (inv.documentType === "handwritten" && rules.reviewHandwritten) {
    out.push(
      finding("validate", "HANDWRITTEN_DOCUMENT", "review", "Handwritten invoice", "Policy: handwritten invoices are never auto-approved. A reviewer confirms the figures against the original."),
    );
  } else if (inv.documentType !== "digital") {
    out.push(finding("validate", "SCANNED_DOCUMENT", "info", "Scanned document", "No text layer; fields were read visually from the page image."));
  }

  const critical = ["total", "invoiceNumber", "bankAccount", "poReference", "lineItems", "subtotal", "tax", "shipping", "discount"];
  const unsure = inv.lowConfidenceFields ?? [];
  const criticalUnsure = unsure.filter((f) => critical.some((k) => f.toLowerCase().startsWith(k.toLowerCase())));
  if (criticalUnsure.length) {
    out.push(
      finding(
        "validate",
        "LOW_EXTRACTION_CONFIDENCE",
        "review",
        "Some figures could not be read with certainty",
        `The model flagged these fields as uncertain: ${criticalUnsure.join(", ")}. Confirm them against the original document. (Model self-report, not a calibrated score.)`,
      ),
    );
  } else if (unsure.length) {
    out.push(finding("validate", "LOW_EXTRACTION_CONFIDENCE", "info", "Minor fields uncertain", `Model flagged: ${unsure.join(", ")} (not used for the decision).`));
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
        "UNKNOWN_VENDOR",
        "escalate",
        "Vendor is not in the approved vendor master",
        `"${inv.vendor}" does not match any approved vendor or known alias. Nothing can be paid until procurement onboards and verifies this vendor (legal entity, tax ID, bank letter).`,
        [
          { label: "Name on invoice", value: inv.vendor || "—", tone: "bad" },
          { label: "Vendor master", value: `No match among ${vendors.length} approved vendors` },
          { label: "Bank account on invoice", value: maskAccount(inv.bankAccount) },
        ],
      ),
    );
    lines.push(`"${inv.vendor}" not found among ${vendors.length} approved vendors`);
    return { vendor: null, findings, lines };
  }
  const v = hit.vendor;
  lines.push(`Matched ${v.id} · ${v.name} (${hit.how} match)`);
  if (hit.how !== "exact") {
    findings.push(finding("vendor", "VENDOR_NAME_VARIANT", "info", "Vendor name variant", `Printed as "${inv.vendor}", matched to vendor master record "${v.name}" (${hit.how} match).`));
  }
  if (v.status === "blocked") {
    findings.push(finding("vendor", "VENDOR_BLOCKED", "reject", "Vendor is blocked", `${v.name} is blocked in the vendor master.`));
  }
  // Invoices often print only the last digits ("Acct ending 4821"). A partial
  // number matches if it is the tail of the account on file; it is only a
  // mismatch when the printed digits disagree with the account on file.
  const invDigits = digitsOnly(inv.bankAccount);
  const masterDigits = digitsOnly(v.bankAccount);
  const partial = invDigits.length >= 4 && invDigits.length < masterDigits.length;
  const bankMatches = partial ? masterDigits.endsWith(invDigits) : invDigits === masterDigits;
  if (inv.bankAccount && invDigits.length < 4) {
    lines.push("Bank details too short to compare; payment would go to the account on file");
  } else if (inv.bankAccount) {
    if (!bankMatches) {
      findings.push(
        finding(
          "vendor",
          "BANK_ACCOUNT_MISMATCH",
          "escalate",
          "Bank account differs from approved vendor records",
          `The invoice asks for payment to an account that is not on file for ${v.name}. Changed bank details are a common route for payment fraud, so the change must be verified independently by calling the vendor on the number already in the vendor master, never a number from the invoice or email.`,
          [
            { label: "Approved account (vendor master)", value: `${maskAccount(v.bankAccount)} · ${v.bankName}`, tone: "good" },
            { label: "Account on invoice", value: maskAccount(inv.bankAccount), tone: "bad" },
            { label: "Trusted contact on file", value: v.phone },
          ],
        ),
      );
      lines.push(`Invoice account ${maskAccount(inv.bankAccount)} ≠ approved ${maskAccount(v.bankAccount)}`);
    } else {
      lines.push(`Bank account matches vendor master (${maskAccount(v.bankAccount)})${partial ? ` · only the last ${invDigits.length} digits are printed` : ""}`);
    }
  } else {
    lines.push("No bank details printed; payment would go to the account on file");
  }
  return { vendor: v, findings, lines };
}

// ---------- Stage: PO match ----------

function poKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type InvoiceKey = { vendorId: string | null; vendor: string; invoiceNumber: string | null };

function sameInvoice(a: InvoiceKey, b: InvoiceKey): boolean {
  const na = normalizeInvoiceNumber(a.invoiceNumber);
  if (!na || na !== normalizeInvoiceNumber(b.invoiceNumber)) return false;
  if (a.vendorId && b.vendorId) return a.vendorId === b.vendorId;
  return normalizeName(a.vendor) === normalizeName(b.vendor);
}

// Confirmed billing = paid (ERP payment record) or approved here. Invoices
// still in review or on hold are NOT committed spend; they are tracked
// separately as pending.
export const isConfirmed = (l: LedgerInvoice) => l.status === "paid" || l.status === "approved";

function onPo(po: PurchaseOrder, inv: Invoice, vendorId: string | null, ledger: LedgerInvoice[]): LedgerInvoice[] {
  // A duplicate of this invoice is not "previous billing" — counting it would double-count.
  return ledger.filter((l) => l.poId === po.id && !sameInvoice(l, { vendorId, vendor: inv.vendor, invoiceNumber: inv.invoiceNumber }));
}
function priorOnPo(po: PurchaseOrder, inv: Invoice, vendorId: string | null, ledger: LedgerInvoice[]): LedgerInvoice[] {
  return onPo(po, inv, vendorId, ledger).filter(isConfirmed);
}

function billingFor(po: PurchaseOrder, inv: Invoice, vendorId: string | null, ledger: LedgerInvoice[], rules: Rules): BillingSummary {
  const all = onPo(po, inv, vendorId, ledger);
  const prior = all.filter(isConfirmed);
  const pending = all.filter((l) => !isConfirmed(l));
  const previouslyBilled = round2(prior.reduce((s, l) => s + l.total, 0));
  const thisInvoice = inv.total ?? 0;
  const billedAfter = round2(previouslyBilled + thisInvoice);
  return {
    poTotal: po.total,
    tolerancePct: rules.amountTolerancePct,
    previouslyBilled,
    thisInvoice,
    billedAfter,
    remainingAfter: round2(po.total - billedAfter),
    priorInvoices: prior.map((p) => p.invoiceNumber),
    pendingOnPo: round2(pending.reduce((s, l) => s + l.total, 0)),
    pendingInvoices: pending.map((p) => p.invoiceNumber),
    ledger: [...prior, ...pending].map((l) => ({ invoiceNumber: l.invoiceNumber, issueDate: l.issueDate, total: l.total, status: l.status, source: l.source, confirmed: isConfirmed(l) })),
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

export interface PoSuggestion {
  poId: string;
  poTotal: number;
  openValue: number;
  amountFitPct: number; // 100 = invoice equals open value
  linesMatched: number;
  linesTotal: number;
  reasons: string[];
  withinValue: boolean;
}

// All open POs for the vendor, ranked, each with the reasons it was suggested.
// Used to help a reviewer pick a PO; never confirms one by itself.
export function suggestPos(inv: Invoice, vendor: Vendor | null, pos: PurchaseOrder[], ledger: LedgerInvoice[], rules: Rules): PoSuggestion[] {
  if (!vendor) return [];
  const out: PoSuggestion[] = [];
  for (const po of pos.filter((p) => p.vendorId === vendor.id && p.status === "open")) {
    const b = billingFor(po, inv, vendor.id, ledger, rules);
    const open = round2(po.total - b.previouslyBilled);
    const total = inv.total ?? 0;
    const fit = open > 0 && total > 0 ? 1 - Math.min(1, Math.abs(open - total) / open) : 0;
    const matched = inv.lineItems.filter((li) => matchLine(li.description, po.lineItems)).length;
    const reasons = [`Same vendor (${vendor.name})`];
    if (total > 0) reasons.push(Math.abs(open - total) < 0.01 ? `Amount equals the ${money(open, po.currency)} open on the PO` : `Invoice ${money(total, inv.currency)} vs ${money(open, po.currency)} open (${Math.round(fit * 100)}% fit)`);
    reasons.push(`${matched} of ${inv.lineItems.length} line descriptions match`);
    out.push({ poId: po.id, poTotal: po.total, openValue: open, amountFitPct: Math.round(fit * 100), linesMatched: matched, linesTotal: inv.lineItems.length, reasons, withinValue: total <= open * (1 + rules.amountTolerancePct) });
  }
  return out.sort((a, b) => b.amountFitPct * 0.6 + (b.linesMatched / Math.max(1, b.linesTotal)) * 40 - (a.amountFitPct * 0.6 + (a.linesMatched / Math.max(1, a.linesTotal)) * 40));
}

function inferPo(inv: Invoice, vendor: Vendor | null, pos: PurchaseOrder[], ledger: LedgerInvoice[], rules: Rules): { po: PurchaseOrder; note: string } | null {
  if (!vendor || inv.total === null) return null;
  const candidates = pos.filter((p) => p.vendorId === vendor.id && p.status === "open");
  let best: { po: PurchaseOrder; score: number; note: string } | null = null;
  for (const po of candidates) {
    const b = billingFor(po, inv, vendor.id, ledger, rules);
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
        note: `same vendor; invoice ${money(inv.total, inv.currency)} vs ${money(remaining, po.currency)} open on the PO; ${matchedLines} of ${inv.lineItems.length} line descriptions match`,
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
  const c = inv.currency;
  let po: PurchaseOrder | null = null;
  let method: PoMatch["method"] = "none";
  let inferenceNote: string | undefined;

  if (inv.poReference) {
    po = pos.find((p) => poKey(p.id) === poKey(inv.poReference!)) ?? null;
    if (po) {
      method = "explicit";
      lines.push(`PO ${inv.poReference} found: ${po.id} · ${po.vendor} · ${money(po.total, po.currency)}`);
    } else {
      lines.push(`PO ${inv.poReference} is not in the PO table`);
    }
  } else {
    lines.push("No PO number printed on the invoice");
  }

  if (!po) {
    const inferred = inferPo(inv, vendor, pos, ledger, rules);
    if (inferred) {
      po = inferred.po;
      method = "inferred";
      inferenceNote = inferred.note;
      lines.push(`Suggested ${po.id}: ${inferred.note}`);
      findings.push(
        finding(
          "po_match",
          "PO_MATCH_UNCONFIRMED",
          "review",
          `Suggested PO ${po.id} needs confirmation`,
          `${inv.poReference ? `Printed PO "${inv.poReference}" does not exist` : "No PO number on the invoice"}. The closest open PO is ${po.id} (${inferred.note}). This is a suggestion, not a confirmed match: confirm with the requester (${po.approvedBy}) before approving.`,
          [
            { label: "PO on invoice", value: inv.poReference ?? "none", tone: "bad" },
            { label: "Suggested PO", value: `${po.id} · ${money(po.total, po.currency)}` },
            { label: "PO owner", value: po.approvedBy },
          ],
        ),
      );
    } else if (inv.poReference) {
      findings.push(finding("po_match", "UNKNOWN_PO", "review", "PO number not recognised", `PO "${inv.poReference}" is not in the PO table and no open PO for this vendor fits the invoice.`));
    } else {
      findings.push(
        finding(
          "po_match",
          "MISSING_PO_REFERENCE",
          "review",
          "No PO reference and no matching open PO",
          vendor ? `No open PO for ${vendor.name} can absorb ${money(inv.total, c)}. Ask the requester to identify or raise a PO.` : "A PO cannot be suggested for a vendor that is not in the vendor master.",
        ),
      );
    }
  }

  if (!po) return { poMatch: { po: null, method: "none" }, findings, lines };

  if (vendor && po.vendorId !== vendor.id) {
    findings.push(finding("po_match", "PO_VENDOR_MISMATCH", "escalate", "PO belongs to a different vendor", `${po.id} was raised for ${po.vendor}, but the invoice is from ${vendor.name}.`));
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

  // Value: cumulative billing (previous invoices on this PO + this one) vs the
  // PO value plus the allowed tolerance. Split invoicing passes as long as the
  // running total stays inside the PO.
  const billing = billingFor(po, inv, vendor?.id ?? null, ledger, rules);
  const ceiling = round2(po.total * (1 + rules.amountTolerancePct));
  const variance = round2(billing.billedAfter - po.total);
  const variancePct = po.total ? variance / po.total : 0;
  const tolText = fmtPct(rules.amountTolerancePct, false);
  const valueEvidence: Evidence[] = [
    { label: "PO value", value: money(po.total, po.currency) },
    ...(billing.previouslyBilled > 0 ? [{ label: `Previously billed (${billing.priorInvoices.join(", ")})`, value: money(billing.previouslyBilled, po.currency) }] : []),
    { label: "This invoice", value: money(billing.thisInvoice, c) },
    { label: "Cumulative billed", value: money(billing.billedAfter, po.currency) },
    { label: "Variance vs PO", value: `${signedMoney(variance, po.currency)} (${pct(variancePct)})`, tone: billing.billedAfter > ceiling ? "bad" : "neutral" },
    { label: "Allowed tolerance", value: `${tolText} (up to ${money(ceiling, po.currency)})` },
  ];
  lines.push(
    `PO ${money(po.total, po.currency)} · previously billed ${money(billing.previouslyBilled, po.currency)} · this invoice ${money(billing.thisInvoice, c)} · cumulative ${money(billing.billedAfter, po.currency)} (${pct(variancePct)} vs PO, tolerance ${tolText})`,
  );
  if (billing.billedAfter > ceiling) {
    if (billing.previouslyBilled > 0) {
      findings.push(
        finding(
          "po_match",
          "CUMULATIVE_PO_EXCEEDED",
          "review",
          "Cumulative billing exceeds the PO",
          `${po.id} is for ${money(po.total, po.currency)}. ${money(billing.previouslyBilled, po.currency)} was already billed on ${billing.priorInvoices.join(", ")}; this invoice adds ${money(billing.thisInvoice, c)}, so ${money(billing.billedAfter, po.currency)} would be billed in total, ${money(variance, po.currency)} (${pct(variancePct)}) over the PO. Tolerance is ${tolText}.`,
          valueEvidence,
        ),
      );
    } else {
      findings.push(
        finding(
          "po_match",
          "PO_AMOUNT_EXCEEDED",
          "review",
          "Invoice exceeds the PO value",
          `Invoice ${money(billing.thisInvoice, c)} vs PO ${money(po.total, po.currency)}: ${signedMoney(variance, po.currency)} (${pct(variancePct)}), above the ${tolText} tolerance.`,
          valueEvidence,
        ),
      );
    }
  } else if (billing.pendingOnPo > 0 && billing.billedAfter + billing.pendingOnPo > ceiling) {
    findings.push(
      finding(
        "po_match",
        "PENDING_PO_CONFLICT",
        "review",
        "Competes with pending invoices on the PO",
        `This invoice fits within ${po.id} on confirmed billing, but ${money(billing.pendingOnPo, po.currency)} more is pending review or on hold (${billing.pendingInvoices.join(", ")}). If both were approved the PO would be exceeded. Decide which one the PO covers.`,
        [...valueEvidence, { label: `Pending, not committed (${billing.pendingInvoices.join(", ")})`, value: money(billing.pendingOnPo, po.currency), tone: "bad" }],
      ),
    );
  } else if (billing.previouslyBilled > 0 || billing.remainingAfter > po.total * rules.amountTolerancePct) {
    findings.push(
      finding("po_match", "PARTIAL_BILLING", "info", "Partial billing against PO", `After this invoice ${money(billing.billedAfter, po.currency)} of ${po.id} is billed; ${money(Math.max(0, billing.remainingAfter), po.currency)} remains open.`, valueEvidence),
    );
  } else if (Math.abs(variance) >= 0.01) {
    findings.push(
      finding("po_match", "WITHIN_TOLERANCE", "info", "Small variance within tolerance", `Invoice is ${signedMoney(variance, po.currency)} (${pct(variancePct)}) vs the PO, inside the ${tolText} tolerance.`, valueEvidence),
    );
  }

  // Lines: quantity (cumulative across split invoices) and unit price.
  const prior = priorOnPo(po, inv, vendor?.id ?? null, ledger);
  const lineChecks: LineCheck[] = [];
  for (const li of inv.lineItems) {
    const poLine = matchLine(li.description, po.lineItems);
    if (!poLine) {
      lineChecks.push({ description: li.description, poDescription: null, poQty: null, priorQty: 0, invoiceQty: li.quantity, poUnitPrice: null, invoiceUnitPrice: li.unitPrice, status: "not_on_po" });
      findings.push(finding("po_match", "LINE_NOT_ON_PO", "review", "Line not on PO", `"${li.description}" (${money(li.total, c)}) does not correspond to any line on ${po.id}.`));
      continue;
    }
    const priorQty = prior.reduce((s, p) => s + (matchLine(poLine.description, p.lineItems)?.quantity ?? 0), 0);
    const drift = poLine.unitPrice > 0 ? (li.unitPrice - poLine.unitPrice) / poLine.unitPrice : 0;
    const qtyOver = priorQty + li.quantity > poLine.quantity + rules.quantityTolerance;
    const priceOver = drift > rules.priceTolerancePct;
    lineChecks.push({
      description: li.description,
      poDescription: poLine.description,
      poQty: poLine.quantity,
      priorQty,
      invoiceQty: li.quantity,
      poUnitPrice: poLine.unitPrice,
      invoiceUnitPrice: li.unitPrice,
      status: qtyOver ? "qty_over" : priceOver ? "price_over" : "ok",
    });
    if (qtyOver) {
      findings.push(
        finding(
          "po_match",
          "QUANTITY_EXCEEDS_PO",
          "review",
          "Quantity exceeds what was ordered",
          `"${poLine.description}": ordered ${poLine.quantity}, previously billed ${priorQty}, this invoice ${li.quantity}, so ${priorQty + li.quantity} would be billed.`,
          [
            { label: "Ordered (PO)", value: String(poLine.quantity) },
            { label: "Previously billed", value: String(priorQty) },
            { label: "This invoice", value: String(li.quantity) },
            { label: "Cumulative", value: String(priorQty + li.quantity), tone: "bad" },
          ],
        ),
      );
    }
    if (priceOver) {
      findings.push(
        finding("po_match", "PRICE_VARIANCE", "review", "Unit price above PO price", `"${poLine.description}": invoiced at ${money(li.unitPrice, c)} vs PO ${money(poLine.unitPrice, po.currency)} (${pct(drift)}).`),
      );
    }
  }

  return { poMatch: { po, method, inferenceNote, billing, lines: lineChecks }, findings, lines };
}

// ---------- Stage: duplicates ----------

export interface PriorSubmission {
  runId: string;
  fileHash: string;
  createdAt: number;
  status: CaseStatus;
  invoiceNumber: string | null;
}

export function describeLedgerStatus(s: LedgerInvoice["status"]): string {
  return s === "paid" ? "paid (payment record in ERP)" : s === "approved" ? "approved for payment, not yet paid" : "already submitted and under review";
}

export function checkDuplicates(
  inv: Invoice,
  vendor: Vendor | null,
  ledger: LedgerInvoice[],
  rules: Rules,
  fileHash: string,
  prior: PriorSubmission[],
): { findings: Finding[]; lines: string[]; duplicateOf?: DuplicateRef; repeat: boolean } {
  const findings: Finding[] = [];
  const vendorId = vendor?.id ?? null;
  const sameVendor = ledger.filter((l) => (vendorId && l.vendorId ? l.vendorId === vendorId : normalizeName(l.vendor) === normalizeName(inv.vendor)));
  const lines = [`Checked ${ledger.length} known invoices (${sameVendor.length} from this vendor) and ${prior.length} earlier uploads`];

  const sameFile = prior.find((p) => p.fileHash && p.fileHash === fileHash);
  if (sameFile) {
    lines.push(`Identical file already uploaded on ${new Date(sameFile.createdAt).toLocaleString()} (run ${sameFile.runId})`);
    findings.push(
      finding(
        "duplicates",
        "REPEAT_SUBMISSION",
        "info",
        "This exact file was uploaded before",
        `Byte-identical document first processed in run ${sameFile.runId}. This upload is recorded as a repeat submission and does not create a new payable.`,
      ),
    );
  }

  const exact = sameVendor.find((l) => sameInvoice(l, { vendorId, vendor: inv.vendor, invoiceNumber: inv.invoiceNumber }));
  if (exact) {
    const printedDiffers = exact.invoiceNumber !== (inv.invoiceNumber ?? "");
    const ref: DuplicateRef = { invoiceNumber: exact.invoiceNumber, source: exact.source, status: exact.status, runId: exact.runId, issueDate: exact.issueDate, total: exact.total };
    findings.push(
      finding(
        "duplicates",
        "DUPLICATE_INVOICE",
        "reject",
        `Duplicate of ${exact.invoiceNumber}`,
        `Same vendor and same invoice number as ${exact.invoiceNumber} (${money(exact.total, inv.currency)}, dated ${exact.issueDate}), which is ${describeLedgerStatus(exact.status)}.${printedDiffers ? ` Printed here as "${inv.invoiceNumber}", which normalises to the same number.` : ""} ${Math.abs(exact.total - (inv.total ?? exact.total)) >= 0.01 ? ` The amount differs (${money(inv.total, inv.currency)} here vs ${money(exact.total, inv.currency)} on file): a changed amount under the same invoice number is a revised or conflicting invoice and is not paid as a second payable. Ask the vendor to confirm which one is valid.` : ""} Processing it again would create a second payable for the same bill.`,
        [
          { label: "This submission", value: `${inv.invoiceNumber ?? "—"} · ${money(inv.total, inv.currency)}` },
          { label: "Original on file", value: `${exact.invoiceNumber} · ${money(exact.total, inv.currency)} · ${exact.issueDate}` },
          { label: "Original status", value: describeLedgerStatus(exact.status) },
          { label: "Source", value: exact.source === "erp" ? "ERP history (demo data)" : `Earlier run ${exact.runId}` },
        ],
      ),
    );
    lines.push(`Exact duplicate: "${inv.invoiceNumber}" ≡ "${exact.invoiceNumber}" (${describeLedgerStatus(exact.status)})`);
    return { findings, lines, duplicateOf: ref, repeat: true };
  }

  if (inv.total !== null) {
    const day = 86400000;
    const when = inv.issueDate ? Date.parse(inv.issueDate) : NaN;
    const near = sameVendor.find((l) => Math.abs(l.total - inv.total!) < 0.01 && (Number.isNaN(when) || Math.abs(Date.parse(l.issueDate) - when) <= rules.duplicateWindowDays * day));
    if (near) {
      findings.push(
        finding(
          "duplicates",
          "POSSIBLE_DUPLICATE",
          "review",
          `Possible duplicate of ${near.invoiceNumber}`,
          `Same vendor and same amount (${money(near.total, inv.currency)}) as ${near.invoiceNumber} dated ${near.issueDate}, within ${rules.duplicateWindowDays} days, but a different invoice number. Could be a re-issued invoice; confirm with the vendor.`,
        ),
      );
      lines.push(`Same vendor + amount as ${near.invoiceNumber} within ${rules.duplicateWindowDays} days`);
      return { findings, lines, repeat: !!sameFile };
    }
  }
  lines.push("No duplicate invoice found");
  return { findings, lines, repeat: !!sameFile };
}

// ---------- Stage: decide ----------

const RANK: Record<CheckAction, number> = { info: 0, review: 1, escalate: 2, reject: 3 };

// A concrete instruction per review finding, using the run's own numbers.
function reviewAction(code: ExceptionCode, inv: Invoice, vendor: Vendor | null, pm?: PoMatch): string | null {
  const po = pm?.po;
  const b = pm?.billing;
  const who = vendor?.name ?? inv.vendor;
  switch (code) {
    case "CUMULATIVE_PO_EXCEEDED": {
      if (!po || !b) return null;
      const left = b.poTotal - b.previouslyBilled;
      return left > 0.005
        ? `Ask ${who} for a corrected invoice for the ${money(left, po.currency)} still open on ${po.id}, or have ${po.approvedBy} authorise a PO amendment.`
        : `${po.id} is already fully billed. Ask ${po.approvedBy} to authorise a PO amendment for the extra amount, or request a corrected invoice from ${who}.`;
    }
    case "PO_AMOUNT_EXCEEDED":
      return po && b ? `Confirm the extra ${money(b.billedAfter - b.poTotal, po.currency)} with ${po.approvedBy} or request a corrected invoice.` : null;
    case "QUANTITY_EXCEEDS_PO":
      return "Confirm with receiving how many units were actually delivered.";
    case "PENDING_PO_CONFLICT":
      return po ? `Decide with ${po.approvedBy} which pending invoice ${po.id} covers before approving.` : null;
    case "PO_MATCH_UNCONFIRMED":
      return po ? `Confirm ${po.id} with its owner ${po.approvedBy}, then record the confirmation.` : null;
    case "HANDWRITTEN_DOCUMENT":
    case "LOW_EXTRACTION_CONFIDENCE":
      return "Check the extracted figures against the original document.";
    case "ARITHMETIC_MISMATCH":
      return `Ask ${who} for a corrected invoice; do not pay the printed total until it reconciles.`;
    case "MISSING_FIELD":
      return inv.invoiceNumber ? `Request a complete invoice from ${who}.` : `Invoice number is missing. Request a revised invoice from ${who}; do not enter a number manually.`;
    case "EXPIRED_PO":
      return po ? `Ask ${po.approvedBy} to re-authorise ${po.id}.` : null;
    case "POSSIBLE_DUPLICATE":
      return `Confirm with ${who} whether this re-issues an invoice already on file.`;
    case "PRICE_VARIANCE":
      return "Confirm the price change with procurement or request a corrected invoice.";
    case "MISSING_PO_REFERENCE":
    case "UNKNOWN_PO":
      return "Ask the requester to identify the PO, or raise one before approval.";
    case "LINE_NOT_ON_PO":
      return "Confirm the extra line with the requester or request a corrected invoice.";
    case "OVER_APPROVAL_LIMIT":
      return "A second approver is required by policy.";
    default:
      return null;
  }
}

export function decide(
  inv: Invoice,
  findings: Finding[],
  rules: Rules,
  vendor: Vendor | null,
  duplicateOf?: DuplicateRef,
  poMatch?: PoMatch,
): { decision: Decision; extra: Finding[] } {
  const extra: Finding[] = [];
  if (inv.total !== null && inv.total > rules.autoApproveLimit) {
    extra.push(finding("decide", "OVER_APPROVAL_LIMIT", "review", "Above auto-approval limit", `Total ${money(inv.total, inv.currency)} exceeds the ${money(rules.autoApproveLimit, inv.currency)} auto-approval limit.`));
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
    if (has("DUPLICATE_INVOICE") && duplicateOf) {
      headline = `Rejected: duplicate of ${duplicateOf.invoiceNumber}`;
      nextAction = `Do not process. Tell the vendor this invoice is already on file as ${duplicateOf.invoiceNumber} (${describeLedgerStatus(duplicateOf.status)}). No new payable was created.`;
    } else {
      headline = "Rejected";
      nextAction = "Do not process. Notify the vendor of the rejection reason.";
    }
  } else if (top === RANK.escalate) {
    resolution = "ESCALATE";
    if (has("BANK_ACCOUNT_MISMATCH")) {
      headline = "Payment hold: bank account differs from vendor records";
      nextAction = `Keep on hold. Call ${vendor?.name ?? "the vendor"} on the number in the vendor master${vendor ? `, ${vendor.phone},` : ""} to confirm the bank change. Do not use contact details from the invoice or email. Release only after independent verification.`;
    } else if (has("UNKNOWN_VENDOR")) {
      headline = "Payment hold: vendor not in vendor master";
      nextAction = "Send to procurement for vendor onboarding and verification (legal entity, tax ID, bank confirmation). The invoice cannot be approved until the vendor exists in the vendor master.";
    } else {
      headline = "Payment hold";
      nextAction = deciding.map((f) => f.title).join("; ");
    }
  } else if (top === RANK.review) {
    resolution = "FLAG_FOR_REVIEW";
    headline = deciding.length === 1 ? `Needs review: ${deciding[0].title.toLowerCase()}` : `Needs review: ${deciding.length} items to resolve`;
    const steps = [...new Set(deciding.map((f) => reviewAction(f.code, inv, vendor, poMatch) ?? f.title))];
    nextAction = steps.length === 1 ? steps[0] : steps.map((s, i) => `${i + 1}. ${s}`).join(" ");
  } else {
    resolution = "AUTO_APPROVE";
    headline = "Approved: all checks passed";
    nextAction = `Eligible for payment${inv.dueDate ? ` by ${inv.dueDate}` : ""}${inv.paymentTerms ? ` (${inv.paymentTerms})` : ""} to the account on file. Passed to the payment run; not yet paid.`;
  }
  return { decision: { resolution, headline, decidingCodes: codes, nextAction }, extra };
}

export function initialStatus(r: Resolution): CaseStatus {
  return r === "AUTO_APPROVE" ? "approved" : r === "REJECT" ? "rejected" : r === "ESCALATE" ? "payment_hold" : "needs_review";
}

// ---------- Fallback explanation (used if the LLM is unavailable) ----------

export function templateExplanation(inv: Invoice, poMatch: PoMatch, findings: Finding[], decision: Decision): Explanation {
  const issues = findings.filter((f) => f.action !== "info");
  const po = poMatch.po ? `${poMatch.po.id}${poMatch.method === "inferred" ? " (suggested, unconfirmed)" : ""}` : "no PO";
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
    .filter((r) => r.status !== "rejected" && r.invoice.invoiceNumber)
    .map((r) => ({
      vendorId: r.vendorId,
      vendor: r.invoice.vendor,
      invoiceNumber: r.invoice.invoiceNumber!,
      poId: r.poMatch.po?.id ?? null,
      total: r.invoice.total ?? 0,
      issueDate: r.invoice.issueDate ?? new Date(r.createdAt).toISOString().slice(0, 10),
      lineItems: r.invoice.lineItems,
      status: r.status === "approved" ? "approved" : "in_review",
      source: "run",
      runId: r.id,
    }));
  return [...erp, ...fromRuns];
}

export function resolutionLabel(r: Resolution): string {
  return { AUTO_APPROVE: "Approved", FLAG_FOR_REVIEW: "Needs review", ESCALATE: "Payment hold", REJECT: "Rejected" }[r];
}

export function statusLabel(s: CaseStatus): string {
  return { approved: "Approved", needs_review: "Needs review", payment_hold: "Payment hold", awaiting_info: "Awaiting vendor", rejected: "Rejected" }[s];
}

export function isOpen(s: CaseStatus): boolean {
  return s === "needs_review" || s === "payment_hold" || s === "awaiting_info";
}
