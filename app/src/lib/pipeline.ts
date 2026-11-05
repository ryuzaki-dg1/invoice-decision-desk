// The invoice-to-decision process. Eight stages, each reported to the UI as it
// starts and finishes so the run view shows exactly what happened.
//
//   ingest → extract (LLM) → validate → vendor → po_match → duplicates
//          → decide (rules) → explain (LLM, cannot change the decision)

import type {
  Decision,
  Explanation,
  Finding,
  Invoice,
  LedgerInvoice,
  PurchaseOrder,
  RunRecord,
  StageId,
  StageState,
  Vendor,
} from "../types.ts";
import type { PreparedDocument } from "./document.ts";
import {
  checkDuplicates,
  checkVendor,
  decide,
  matchPurchaseOrder,
  money,
  templateExplanation,
  validateInvoice,
} from "./engine.ts";
import { chat, chatStream, extractJson, type MessageContent } from "./llm.ts";
import type { Rules } from "./rules.ts";

export const STAGES: { id: StageId; label: string; what: string }[] = [
  { id: "ingest", label: "Ingest document", what: "Render pages, detect text layer vs scan" },
  { id: "extract", label: "Extract fields", what: "Vision model reads vendor, numbers, lines, bank details" },
  { id: "validate", label: "Validate", what: "Required fields, arithmetic, read confidence" },
  { id: "vendor", label: "Vendor check", what: "Vendor master match and bank account verification" },
  { id: "po_match", label: "PO match", what: "Find PO (explicit or inferred), value, quantity, price" },
  { id: "duplicates", label: "Duplicate check", what: "Normalised invoice numbers and same-amount repeats" },
  { id: "decide", label: "Decide", what: "Strictest finding wins: reject > hold > review > approve" },
  { id: "explain", label: "Explain", what: "Plain-English summary and vendor message" },
];

export interface PipelineContext {
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  ledger: LedgerInvoice[];
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
  "shipping": number,               // 0 if none
  "total": number | null,           // amount due as printed
  "currency": string,               // ISO code, e.g. "USD"
  "bankAccount": string | null,     // remit-to account number as printed, digits only, else null
  "documentType": "digital" | "scanned" | "handwritten",
  "lowConfidenceFields": string[]   // field names you could not read with certainty, e.g. ["total","lineItems[1].quantity"]
}
Rules: copy numbers exactly as printed, never correct the vendor's arithmetic. Use null for anything not on the document rather than inventing it. Return only the JSON.`;

function makeStage(id: StageId): StageState {
  return { id, status: "pending", lines: [] };
}

export async function runPipeline(
  doc: PreparedDocument,
  ctx: PipelineContext,
  cb: PipelineCallbacks,
): Promise<Omit<RunRecord, "id" | "reviewStatus">> {
  const t0 = Date.now();
  const stages = new Map<StageId, StageState>(STAGES.map((s) => [s.id, makeStage(s.id)]));
  const update = (id: StageId, patch: Partial<StageState>) => {
    const next = { ...stages.get(id)!, ...patch };
    stages.set(id, next);
    cb.onStage(next);
  };
  const start = (id: StageId) => update(id, { status: "running", startedAt: Date.now() });
  const finish = (id: StageId, found: Finding[], summary: string, lines: string[]) => {
    const worst = found.some((f) => f.action === "reject" || f.action === "escalate") ? "fail" : found.some((f) => f.action === "review") ? "warn" : "done";
    update(id, { status: worst, summary, lines, endedAt: Date.now() });
  };

  // 1. Ingest
  start("ingest");
  const kind = doc.hasTextLayer ? "digital PDF with text layer" : doc.mimeType === "application/pdf" ? "scanned PDF (no text layer)" : "image";
  update("ingest", {
    status: "done",
    summary: `${doc.fileName} · ${kind}`,
    lines: [`${doc.pageCount} page${doc.pageCount > 1 ? "s" : ""}; ${doc.pageImages.length} rendered for the model`, doc.hasTextLayer ? `${doc.textLayer.length} characters of embedded text` : "No embedded text: model will read the page image"],
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
    invoice = {
      vendor: p.vendor ?? "",
      invoiceNumber: p.invoiceNumber ?? null,
      poReference: p.poReference ?? null,
      issueDate: p.issueDate ?? null,
      dueDate: p.dueDate ?? null,
      paymentTerms: p.paymentTerms ?? null,
      lineItems: (p.lineItems ?? []).map((l) => ({
        description: String(l.description ?? ""),
        quantity: Number(l.quantity ?? 0),
        unitPrice: Number(l.unitPrice ?? 0),
        total: Number(l.total ?? 0),
      })),
      subtotal: p.subtotal ?? null,
      tax: Number(p.tax ?? 0),
      shipping: Number(p.shipping ?? 0),
      total: p.total ?? null,
      currency: (p.currency || "USD").toUpperCase(),
      bankAccount: p.bankAccount ? String(p.bankAccount) : null,
      // A real text layer is authoritative; otherwise trust the model's read.
      documentType: doc.hasTextLayer ? "digital" : p.documentType === "handwritten" ? "handwritten" : "scanned",
      lowConfidenceFields: Array.isArray(p.lowConfidenceFields) ? p.lowConfidenceFields : [],
    };
  } catch (err) {
    update("extract", { status: "fail", summary: "Could not read the document", lines: [(err as Error).message], endedAt: Date.now() });
    throw err;
  }
  cb.onInvoice?.(invoice);
  update("extract", {
    status: "done",
    summary: `${invoice.vendor || "(no vendor)"} · ${invoice.invoiceNumber ?? "(no invoice #)"} · ${money(invoice.total, invoice.currency)}`,
    lines: [
      `PO reference: ${invoice.poReference ?? "none printed"}`,
      `${invoice.lineItems.length} line item(s); document read as ${invoice.documentType}`,
      invoice.lowConfidenceFields.length ? `Low-confidence fields: ${invoice.lowConfidenceFields.join(", ")}` : "All fields read with confidence",
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
  finish("validate", vf, vf.filter((f) => f.action !== "info").length ? vf.filter((f) => f.action !== "info").map((f) => f.title).join(" · ") : "Required fields present, arithmetic reconciles", vf.map((f) => `${f.title}: ${f.detail}`));

  // 4. Vendor
  start("vendor");
  const v = checkVendor(invoice, ctx.vendors);
  publish(v.findings);
  finish("vendor", v.findings, v.vendor ? `${v.vendor.name} (${v.vendor.id})` : "Unknown vendor", v.lines);

  // 5. PO match
  start("po_match");
  const pm = matchPurchaseOrder(invoice, v.vendor, ctx.purchaseOrders, ctx.ledger, ctx.rules, ctx.today);
  publish(pm.findings);
  const poSummary = pm.poMatch.po ? `${pm.poMatch.po.id} (${pm.poMatch.method})${pm.findings.some((f) => f.action !== "info") ? " · " + pm.findings.filter((f) => f.action !== "info").map((f) => f.title).join(" · ") : " · within tolerance"}` : "No PO matched";
  finish("po_match", pm.findings, poSummary, pm.lines);

  // 6. Duplicates
  start("duplicates");
  const dup = checkDuplicates(invoice, v.vendor, ctx.ledger, ctx.rules);
  publish(dup.findings);
  finish("duplicates", dup.findings, dup.findings.length ? dup.findings[0].title : "No duplicates", dup.lines);

  // 7. Decide (deterministic)
  start("decide");
  const { decision, extra } = decide(invoice, findings, ctx.rules);
  publish(extra);
  cb.onDecision?.(decision);
  update("decide", {
    status: decision.resolution === "AUTO_APPROVE" ? "done" : decision.resolution === "FLAG_FOR_REVIEW" ? "warn" : "fail",
    summary: decision.headline,
    lines: [
      `${findings.filter((f) => f.action === "reject").length} reject · ${findings.filter((f) => f.action === "escalate").length} hold · ${findings.filter((f) => f.action === "review").length} review · ${findings.filter((f) => f.action === "info").length} info`,
      decision.decidingCodes.length ? `Deciding rule(s): ${decision.decidingCodes.join(", ")}` : "No blocking findings",
      `Next: ${decision.nextAction}`,
    ],
    endedAt: Date.now(),
  });

  // 8. Explain (LLM writes prose; the decision is already fixed)
  start("explain");
  let explanation: Explanation;
  try {
    explanation = await explain(invoice, pm.poMatch.po, findings, decision, cb.onExplainToken);
    update("explain", { status: "done", summary: "Summary and vendor message drafted", lines: [explanation.vendorEmail ? "Vendor email drafted for review (not sent)" : "No vendor email needed"], endedAt: Date.now() });
  } catch (err) {
    explanation = templateExplanation(invoice, pm.poMatch, findings, decision);
    update("explain", { status: "done", summary: "Used template explanation (LLM unavailable)", lines: [(err as Error).message], endedAt: Date.now() });
  }

  return {
    createdAt: t0,
    durationMs: Date.now() - t0,
    fileName: doc.fileName,
    pageCount: doc.pageCount,
    invoice,
    vendorId: v.vendor?.id ?? null,
    vendorMatched: v.vendor?.name ?? null,
    poMatch: pm.poMatch,
    findings,
    decision,
    explanation,
    stages: STAGES.map((s) => stages.get(s.id)!),
    model: ctx.model,
  };
}

async function explain(
  invoice: Invoice,
  po: PurchaseOrder | null,
  findings: Finding[],
  decision: Decision,
  onToken?: (t: string) => void,
): Promise<Explanation> {
  const wantsEmail = decision.resolution === "FLAG_FOR_REVIEW" || decision.resolution === "REJECT";
  const system = `You write for an accounts-payable clerk who is not technical. The decision has ALREADY been made by the rules engine; never change or question it.
Write exactly two sections:
SUMMARY:
2-4 short sentences: what the invoice is, the decision, and the specific reason(s) with the actual numbers. No jargon, no rule codes.
VENDOR_EMAIL:
${wantsEmail ? "A short, polite email to the vendor (Subject line first) explaining what is needed to process the invoice. Only mention issues the vendor can fix or must know about. Sign as 'Accounts Payable'." : "Write exactly NONE (no vendor email: either approved, or a payment hold where we must not tip off a possible fraudster or must verify through known contacts)."}`;
  const user = `DECISION: ${decision.resolution} – ${decision.headline}
NEXT ACTION: ${decision.nextAction}
INVOICE: ${JSON.stringify(invoice)}
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
    summary: (sumMatch?.[1] ?? full).trim(),
    vendorEmail: wantsEmail && email && !/^none\b/i.test(email) ? email : null,
    generatedBy: "llm",
  };
}
