// The invoice-to-decision process. Eight stages, each reported to the UI as it
// actually starts and finishes; timings are measured, not simulated.
//
//   ingest → extract (LLM) → validate → vendor → po_match → duplicates
//          → decide (rules) → explain (LLM, cannot change the decision)

import type { Decision, Explanation, Finding, Invoice, LedgerInvoice, PurchaseOrder, RunRecord, StageId, StageState, Vendor } from "../types.ts";
import type { PreparedDocument } from "./document.ts";
import { checkDuplicates, checkVendor, decide, describeLedgerStatus, initialStatus, matchPurchaseOrder, money, templateExplanation, validateInvoice, type PriorSubmission } from "./engine.ts";
import { chat, chatStream, extractJson, type MessageContent } from "./llm.ts";
import type { Rules } from "./policy.ts";

export const STAGES: { id: StageId; label: string; what: string }[] = [
  { id: "ingest", label: "Ingest document", what: "Render pages and detect digital text vs scan" },
  { id: "extract", label: "Extract fields", what: "Vision model reads vendor, amounts, lines and bank details" },
  { id: "validate", label: "Validate arithmetic", what: "Required fields, totals reconcile, read certainty" },
  { id: "vendor", label: "Verify vendor", what: "Vendor master match and bank account check" },
  { id: "po_match", label: "Match purchase order", what: "PO value, cumulative billing, quantities and prices" },
  { id: "duplicates", label: "Detect duplicates", what: "Invoice history and repeat uploads" },
  { id: "decide", label: "Apply decision rules", what: "Strictest finding wins: reject › hold › review › approve" },
  { id: "explain", label: "Generate explanation", what: "Plain-English summary and vendor message draft" },
];

export interface PipelineContext {
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  ledger: LedgerInvoice[];
  priorSubmissions: PriorSubmission[];
  rules: Rules;
  today: string;
  model: string;
}

export interface PipelineCallbacks {
  onStage: (s: StageState) => void;
  onInvoice?: (inv: Invoice) => void;
  onFindings?: (f: Finding[]) => void;
  onDecision?: (d: Decision) => void;
  onExplainToken?: (t: string) => void;
}

const EXTRACT_PROMPT = `You are an accounts-payable document reader. Read the invoice and return ONLY a JSON object with exactly these fields:
{
  "vendor": string,                 // supplier name as printed (the party being paid, not the bill-to)
  "invoiceNumber": string | null,   // exactly as printed, null if absent
  "poReference": string | null,     // customer purchase order number if printed, else null. Do not guess.
  "issueDate": string | null,       // yyyy-mm-dd
  "dueDate": string | null,         // yyyy-mm-dd; if absent but terms given, compute from issueDate
  "paymentTerms": string | null,
  "lineItems": [{"description": string, "quantity": number, "unitPrice": number, "total": number}],
  "subtotal": number | null,
  "tax": number,                    // 0 if none
  "shipping": number,               // freight / shipping / delivery charge, 0 if none
  "otherCharges": number,           // any other added fee or surcharge not in the lines, 0 if none
  "discount": number,               // discount as a POSITIVE number, 0 if none
  "total": number | null,           // amount due as printed
  "currency": string,               // ISO code, e.g. "USD"
  "bankAccount": string | null,     // remit-to account number as printed, digits only, else null
  "documentType": "digital" | "scanned" | "handwritten",
  "lowConfidenceFields": string[]   // field names you could not read with certainty, e.g. ["total","lineItems[1].quantity"]
}
Rules: copy numbers exactly as printed and never correct the vendor's arithmetic. Use null for anything not on the document rather than inventing it. Return only the JSON.`;

export async function runPipeline(doc: PreparedDocument, ctx: PipelineContext, cb: PipelineCallbacks): Promise<Omit<RunRecord, "id">> {
  const t0 = Date.now();
  const stages = new Map<StageId, StageState>(STAGES.map((s) => [s.id, { id: s.id, status: "pending", lines: [] }]));
  const update = (id: StageId, patch: Partial<StageState>) => {
    const next = { ...stages.get(id)!, ...patch };
    stages.set(id, next);
    cb.onStage(next);
  };
  const start = (id: StageId) => update(id, { status: "running", startedAt: Date.now() });
  const finish = (id: StageId, found: Finding[], summary: string, lines: string[]) => {
    const status = found.some((f) => f.action === "reject" || f.action === "escalate") ? "blocked" : found.some((f) => f.action === "review") ? "warn" : "done";
    update(id, { status, summary, lines, endedAt: Date.now() });
  };
  const blockingTitles = (f: Finding[]) => f.filter((x) => x.action !== "info").map((x) => x.title).join(" · ");

  // 1. Ingest
  start("ingest");
  const kind = doc.hasTextLayer ? "Digital PDF (text layer found)" : doc.mimeType === "application/pdf" ? "Scanned PDF (no text layer)" : "Image / photo";
  const extractionMethod = doc.hasTextLayer ? "Vision model + PDF text layer" : "Vision model (page image only)";
  update("ingest", {
    status: "done",
    summary: kind,
    lines: [`${doc.fileName}`, `${doc.pageCount} page${doc.pageCount > 1 ? "s" : ""}; ${doc.pageImages.length} sent to the model`, `File fingerprint ${doc.fileHash.slice(0, 12)}…`],
    endedAt: Date.now(),
  });

  // 2. Extract
  start("extract");
  const content: MessageContent = [
    ...doc.pageImages.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    {
      type: "text" as const,
      text: doc.hasTextLayer
        ? `Embedded text layer of the PDF (use it to confirm numbers you see in the image):\n\n${doc.textLayer.slice(0, 12000)}`
        : "This document has no text layer. Read it from the image.",
    },
  ];
  let invoice: Invoice;
  try {
    const raw = await chat({ messages: [{ role: "system", content: EXTRACT_PROMPT }, { role: "user", content }], temperature: 0 });
    const p = JSON.parse(extractJson(raw)) as Partial<Invoice>;
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    invoice = {
      vendor: p.vendor ?? "",
      invoiceNumber: p.invoiceNumber ?? null,
      poReference: p.poReference ?? null,
      issueDate: p.issueDate ?? null,
      dueDate: p.dueDate ?? null,
      paymentTerms: p.paymentTerms ?? null,
      lineItems: (p.lineItems ?? []).map((l) => ({ description: String(l.description ?? ""), quantity: Number(l.quantity ?? 0), unitPrice: Number(l.unitPrice ?? 0), total: Number(l.total ?? 0) })),
      subtotal: num(p.subtotal),
      tax: Number(p.tax ?? 0),
      shipping: Number(p.shipping ?? 0),
      otherCharges: Number(p.otherCharges ?? 0),
      discount: Math.abs(Number(p.discount ?? 0)),
      total: num(p.total),
      currency: (p.currency || "USD").toUpperCase(),
      bankAccount: p.bankAccount ? String(p.bankAccount) : null,
      // A real text layer is authoritative; otherwise use the model's read.
      documentType: doc.hasTextLayer ? "digital" : p.documentType === "handwritten" ? "handwritten" : "scanned",
      lowConfidenceFields: Array.isArray(p.lowConfidenceFields) ? p.lowConfidenceFields : [],
    };
  } catch (err) {
    update("extract", { status: "error", summary: "Could not read the document (system error, not a business rule)", lines: [(err as Error).message], endedAt: Date.now() });
    throw err;
  }
  cb.onInvoice?.(invoice);
  update("extract", {
    status: "done",
    summary: `${invoice.vendor || "(no vendor)"} · ${invoice.invoiceNumber ?? "(no invoice #)"} · ${money(invoice.total, invoice.currency)}`,
    lines: [
      extractionMethod,
      `PO reference: ${invoice.poReference ?? "none printed"}`,
      `${invoice.lineItems.length} line item(s); read as ${invoice.documentType}`,
      invoice.lowConfidenceFields.length ? `Model flagged as uncertain: ${invoice.lowConfidenceFields.join(", ")}` : "Model flagged no uncertain fields",
    ],
    endedAt: Date.now(),
  });

  const findings: Finding[] = [];
  const publish = (f: Finding[]) => {
    findings.push(...f);
    cb.onFindings?.([...findings]);
  };

  // 3. Validate
  start("validate");
  const vf = validateInvoice(invoice, ctx.rules);
  publish(vf);
  finish("validate", vf, blockingTitles(vf) || "All required fields present; totals reconcile", vf.map((f) => `${f.title}: ${f.detail}`));

  // 4. Vendor
  start("vendor");
  const v = checkVendor(invoice, ctx.vendors);
  publish(v.findings);
  finish("vendor", v.findings, blockingTitles(v.findings) || `${v.vendor?.name} verified`, v.lines);

  // 5. PO match
  start("po_match");
  const pm = matchPurchaseOrder(invoice, v.vendor, ctx.purchaseOrders, ctx.ledger, ctx.rules, ctx.today);
  publish(pm.findings);
  const poLabel = pm.poMatch.po ? `${pm.poMatch.po.id}${pm.poMatch.method === "inferred" ? " (suggested)" : ""}` : "No PO";
  finish("po_match", pm.findings, `${poLabel} · ${blockingTitles(pm.findings) || "within PO value and tolerance"}`, pm.lines);

  // 6. Duplicates
  start("duplicates");
  const dup = checkDuplicates(invoice, v.vendor, ctx.ledger, ctx.rules, doc.fileHash, ctx.priorSubmissions);
  publish(dup.findings);
  finish("duplicates", dup.findings, blockingTitles(dup.findings) || (dup.repeat ? "Repeat upload of an earlier file" : "No duplicates found"), dup.lines);

  // 7. Decide (deterministic)
  start("decide");
  const { decision, extra } = decide(invoice, findings, ctx.rules, v.vendor, dup.duplicateOf, pm.poMatch);
  publish(extra);
  cb.onDecision?.(decision);
  const count = (a: string) => findings.filter((f) => f.action === a).length;
  update("decide", {
    status: decision.resolution === "AUTO_APPROVE" ? "done" : decision.resolution === "FLAG_FOR_REVIEW" ? "warn" : "blocked",
    summary: decision.headline,
    lines: [
      `${count("reject")} reject · ${count("escalate")} hold · ${count("review")} review · ${count("info")} info`,
      decision.decidingCodes.length ? `Deciding rule(s): ${decision.decidingCodes.join(", ")}` : "No blocking findings",
    ],
    endedAt: Date.now(),
  });

  // 8. Explain (LLM writes prose; the decision is already fixed)
  start("explain");
  let explanation: Explanation;
  try {
    explanation = await explain(invoice, pm.poMatch.po, findings, decision, dup.duplicateOf ? describeLedgerStatus(dup.duplicateOf.status) : null, cb.onExplainToken);
    update("explain", { status: "done", summary: explanation.vendorEmail ? "Summary and vendor email drafted (not sent)" : "Summary written; no vendor email for this outcome", lines: [], endedAt: Date.now() });
  } catch (err) {
    explanation = templateExplanation(invoice, pm.poMatch, findings, decision);
    update("explain", { status: "done", summary: "Template explanation used (AI service unavailable)", lines: [(err as Error).message], endedAt: Date.now() });
  }

  const status = initialStatus(decision.resolution);
  return {
    createdAt: t0,
    durationMs: Date.now() - t0,
    fileName: doc.fileName,
    fileHash: doc.fileHash,
    pageCount: doc.pageCount,
    extractionMethod,
    invoice,
    vendorId: v.vendor?.id ?? null,
    vendorMatched: v.vendor?.name ?? null,
    poMatch: pm.poMatch,
    findings,
    decision,
    explanation,
    stages: STAGES.map((s) => stages.get(s.id)!),
    model: ctx.model,
    status,
    resolvedCodes: [],
    hasPreview: false,
    textBoxes: doc.hasTextLayer ? doc.textBoxes : undefined,
    repeatSubmission: dup.repeat,
    rules: { ...ctx.rules },
    duplicateOf: dup.duplicateOf,
    audit: [{ at: Date.now(), actor: "System", kind: "system", action: `Automated decision: ${decision.headline}`, toStatus: status, note: decision.decidingCodes.join(", ") || "All checks passed" }],
  };
}

async function explain(
  invoice: Invoice,
  po: PurchaseOrder | null,
  findings: Finding[],
  decision: Decision,
  duplicateStatus: string | null,
  onToken?: (t: string) => void,
): Promise<Explanation> {
  const wantsEmail = decision.resolution === "FLAG_FOR_REVIEW" || decision.resolution === "REJECT";
  const system = `You write for an accounts-payable executive. The decision has ALREADY been made by deterministic rules; never change, soften or question it.
Accuracy rules: only state facts present in the FINDINGS. Quote amounts and percentages exactly as written there; never calculate or round your own. Never describe the approved account's digits as the invoice's account. "Approved" means eligible for payment, NOT paid; only say "paid" if a finding says there is a payment record. Never claim a verification happened. Never invent amounts.
Write exactly two sections:
SUMMARY:
2-4 short sentences: what the invoice is, the decision, and the specific reason(s) with the actual numbers. Plain English, no rule codes.
VENDOR_EMAIL:
${wantsEmail ? "A short, polite email to the vendor (Subject line first) explaining what is needed. Only mention issues the vendor can fix or must know. Sign as 'Accounts Payable'." : "Write exactly NONE (approved needs no email; for a payment hold we must not alert a possible fraudster and verification goes through trusted contacts on file)."}`;
  const user = `DECISION: ${decision.resolution} – ${decision.headline}
NEXT ACTION: ${decision.nextAction}
${duplicateStatus ? `ORIGINAL INVOICE STATUS: ${duplicateStatus}\n` : ""}INVOICE: ${JSON.stringify(invoice)}
PO: ${po ? JSON.stringify({ id: po.id, vendor: po.vendor, total: po.total, lines: po.lineItems }) : "none"}
FINDINGS: ${JSON.stringify(findings.map((f) => ({ action: f.action, title: f.title, detail: f.detail })))}`;

  let full = "";
  for await (const chunk of chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2 })) {
    full += chunk;
    onToken?.(chunk);
  }
  if (!full.trim()) throw new Error("Empty explanation from model");
  const sumMatch = full.match(/SUMMARY:\s*([\s\S]*?)(?:VENDOR_EMAIL:|$)/i);
  const emailMatch = full.match(/VENDOR_EMAIL:\s*([\s\S]*)$/i);
  const email = emailMatch?.[1].trim() ?? "";
  return {
    summary: (sumMatch?.[1] ?? full).replace(/\*\*/g, "").trim(),
    vendorEmail: wantsEmail && email && !/^none\b/i.test(email) ? email.replace(/\*\*/g, "") : null,
    generatedBy: "llm",
  };
}
