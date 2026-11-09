import type { Resolution } from "../types";

// Demo inputs served from /samples. They go through exactly the same path as
// an uploaded file (fetched as a File, rendered, sent to the model).
export interface Sample {
  file: string;
  short: string; // scenario name for the card
  complication: string; // one line: what makes it interesting
  title: string;
  scenario: string;
  expect: Resolution;
  kind: "Digital PDF" | "Scanned PDF" | "Handwritten photo";
}

export const SAMPLES: Sample[] = [
  {
    file: "01-acme-happy-path.pdf",
    short: "Routine invoice",
    complication: "Freight $0.85 over the PO, inside tolerance",
    title: "Acme Industrial · INV-1047",
    scenario: "Happy path. Totals reconcile; freight is $0.85 above the PO (0.06%), inside the 2% tolerance.",
    expect: "AUTO_APPROVE",
    kind: "Digital PDF",
  },
  {
    file: "02-sunridge-split-overbilling.pdf",
    short: "Split PO billing",
    complication: "Second partial invoice pushes the PO over",
    title: "Sunridge Chemicals · SC-3390",
    scenario: "Split PO. Second partial invoice: 12 drums already paid + 10 billed now on a PO for 20.",
    expect: "FLAG_FOR_REVIEW",
    kind: "Digital PDF",
  },
  {
    file: "03-northstar-duplicate-scan.pdf",
    short: "Duplicate resubmission",
    complication: "Scanned copy of an invoice already paid",
    title: "Northstar Logistics · scanned copy",
    scenario: "Scanned resubmission of INV-7712 (already paid), invoice number written as \"7712\".",
    expect: "REJECT",
    kind: "Scanned PDF",
  },
  {
    file: "04-rao-handwritten-no-po.jpg",
    short: "Handwritten invoice",
    complication: "No PO number; one digit written over",
    title: "Rao Electrical · handwritten bill",
    scenario: "Handwritten, no PO number, and the labour amount has a digit written over (3 or 8?). Reviewer corrects or confirms; every check re-runs.",
    expect: "FLAG_FOR_REVIEW",
    kind: "Handwritten photo",
  },
  {
    file: "05-acme-bank-change.pdf",
    short: "Bank account change",
    complication: "Exact PO match, new remit-to account",
    title: "Acme Industrial · INV-1052",
    scenario: "Perfect PO match, but asks to pay a new bank account. A security risk that needs independent verification before release.",
    expect: "ESCALATE",
    kind: "Digital PDF",
  },
  {
    file: "06-unknown-vendor.pdf",
    short: "Unknown vendor",
    complication: "Payee not in the vendor master, no PO",
    title: "Brightline Supply Co · BL-2291",
    scenario: "Vendor not in the vendor master and no PO.",
    expect: "ESCALATE",
    kind: "Digital PDF",
  },
];
