// Generates the digital demo invoice PDFs (and wraps the scanned image into an
// image-only PDF) in public/samples. Run: npm run make-samples
// Layouts deliberately differ per vendor, like real AP inboxes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "public", "samples");
fs.mkdirSync(out, { recursive: true });

const BILL_TO = ["Ironworks Manufacturing", "Accounts Payable", "200 Lakeside Blvd", "Chicago, IL 60601"];
const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function write(file, build) {
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  doc.pipe(fs.createWriteStream(path.join(out, file)));
  build(doc);
  doc.end();
  console.log("wrote", file);
}

function lineTable(doc, y, lines, { color = "#222", currency = "$" } = {}) {
  const cols = [50, 330, 390, 470];
  doc.rect(50, y, 512, 22).fill(color);
  doc.fill("#fff").font("Helvetica-Bold").fontSize(9.5);
  ["Description", "Qty", "Unit price", "Amount"].forEach((h, i) => doc.text(h, cols[i] + 6, y + 7, { width: i ? 80 : 270, align: i ? "right" : "left" }));
  y += 22;
  doc.fill("#222").font("Helvetica").fontSize(10);
  for (const l of lines) {
    doc.text(l.d, cols[0] + 6, y + 7, { width: 270 });
    doc.text(String(l.q), cols[1] + 6, y + 7, { width: 80, align: "right" });
    doc.text(currency + fmt(l.u), cols[2] + 6, y + 7, { width: 80, align: "right" });
    doc.text(currency + fmt(l.q * l.u), cols[3] + 6, y + 7, { width: 80, align: "right" });
    y += 26;
    doc.moveTo(50, y).lineTo(562, y).strokeColor("#ddd").stroke();
  }
  return y;
}

function totals(doc, y, rows) {
  for (const [k, v, bold] of rows) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10);
    doc.text(k, 360, y + 8, { width: 110, align: "right" });
    doc.text(v, 470, y + 8, { width: 86, align: "right" });
    y += bold ? 22 : 18;
  }
  return y;
}

// ---- Layout A: classic header block (Acme) ----
function acme(file, { number, date, due, po, lines, tax, shipping, total, bankBlock }) {
  write(file, (doc) => {
    doc.font("Helvetica-Bold").fontSize(20).fill("#1f3b73").text("ACME INDUSTRIAL SUPPLY CO.", 50, 50);
    doc.font("Helvetica").fontSize(9.5).fill("#444").text("1440 Forge Road · Cleveland, OH 44101 · (216) 555-0190 · Tax ID 34-1299201", 50, 76);
    doc.font("Helvetica-Bold").fontSize(26).fill("#1f3b73").text("INVOICE", 400, 50, { width: 162, align: "right" });
    doc.fill("#222").font("Helvetica").fontSize(10);
    const meta = [["Invoice #", number], ["Invoice date", date], ["Due date", due], ["Terms", "Net 30"], ["Customer PO", po]];
    meta.forEach(([k, v], i) => {
      doc.font("Helvetica-Bold").text(k, 360, 110 + i * 15, { width: 90 });
      doc.font("Helvetica").text(v, 450, 110 + i * 15, { width: 112, align: "right" });
    });
    doc.font("Helvetica-Bold").text("Bill to", 50, 110);
    doc.font("Helvetica").text(BILL_TO.join("\n"), 50, 125);
    let y = lineTable(doc, 210, lines, { color: "#1f3b73" });
    const sub = lines.reduce((s, l) => s + l.q * l.u, 0);
    y = totals(doc, y, [["Subtotal", "$" + fmt(sub)], ["Sales tax (8%)", "$" + fmt(tax)], ["Freight", "$" + fmt(shipping)], ["Total due (USD)", "$" + fmt(total), true]]);
    bankBlock(doc, y + 30);
    doc.font("Helvetica").fontSize(8.5).fill("#888").text("Thank you for your business. Questions: ar@acmeindustrial.example", 50, 720, { align: "center", width: 512 });
  });
}

const acmeBankOk = (doc, y) => {
  doc.font("Helvetica-Bold").fontSize(10).fill("#222").text("Remittance", 50, y);
  doc.font("Helvetica").text("First Midwest Bank · Account 4410 2287 4821 · Routing 071000013", 50, y + 15);
};

acme("01-acme-happy-path.pdf", {
  number: "INV-1047",
  date: "2026-11-02",
  due: "2026-12-02",
  po: "PO-2026-0142",
  lines: [
    { d: "Hex bolt M8x40 (box of 100)", q: 25, u: 42 },
    { d: "Lock washer M8 (box of 500)", q: 10, u: 18.5 },
  ],
  tax: 99.65,
  shipping: 45,
  total: 1379.65,
  bankBlock: acmeBankOk,
});

acme("05-acme-bank-change.pdf", {
  number: "INV-1052",
  date: "2026-11-04",
  due: "2026-12-04",
  po: "PO-2026-0198",
  lines: [{ d: "Stainless steel sheet 4x8 (16ga)", q: 20, u: 145 }],
  tax: 232,
  shipping: 140,
  total: 3272,
  bankBlock: (doc, y) => {
    doc.rect(50, y, 512, 62).fill("#fff4d6");
    doc.fill("#7a4b00").font("Helvetica-Bold").fontSize(10).text("IMPORTANT: OUR BANKING DETAILS HAVE CHANGED", 62, y + 10);
    doc.font("Helvetica").fill("#222").text("Please update your records and remit this and all future payments to:", 62, y + 25);
    doc.font("Helvetica-Bold").text("Horizon Trust Bank · Account 8830 1177 9934 · Routing 026009593", 62, y + 40);
  },
});

// ---- Layout B: modern left-rail (Sunridge) ----
write("02-sunridge-split-overbilling.pdf", (doc) => {
  doc.rect(0, 0, 160, 792).fill("#0f5c4d");
  doc.fill("#fff").font("Helvetica-Bold").fontSize(16).text("SUNRIDGE\nCHEMICALS", 24, 50);
  doc.font("Helvetica").fontSize(8.5).text("Sunridge Chemicals Ltd.\n77 Refinery Row\nBaton Rouge, LA 70805\n\nBank: PNC Bank\nAcct 6604 1233 9085", 24, 100);
  doc.fill("#0f5c4d").font("Helvetica-Bold").fontSize(22).text("Tax Invoice", 190, 50);
  doc.fill("#222").font("Helvetica").fontSize(10);
  doc.text(`Invoice number: SC-3390\nIssued: November 3, 2026\nPayment terms: Net 30\nYour order: PO-2026-0211`, 190, 85);
  doc.text(`Billed to:\n${BILL_TO.join("\n")}`, 400, 85);
  doc.font("Helvetica-Oblique").fill("#0f5c4d").text("Partial shipment 2 — balance of order", 190, 165);
  let y = 190;
  doc.fill("#222").font("Helvetica-Bold").fontSize(9.5);
  doc.text("Item", 190, y).text("Qty", 380, y, { width: 40, align: "right" }).text("Rate", 430, y, { width: 55, align: "right" }).text("Line total", 495, y, { width: 70, align: "right" });
  y += 18;
  doc.font("Helvetica").fontSize(10);
  doc.text("Industrial solvent XR-4 (drum, 55gal)", 190, y).text("10", 380, y, { width: 40, align: "right" }).text("295.00", 430, y, { width: 55, align: "right" }).text("2,950.00", 495, y, { width: 70, align: "right" });
  y += 30;
  doc.moveTo(190, y).lineTo(565, y).strokeColor("#ccc").stroke();
  doc.text("Net amount", 380, y + 10, { width: 105, align: "right" }).text("2,950.00", 495, y + 10, { width: 70, align: "right" });
  doc.text("Sales tax 8%", 380, y + 26, { width: 105, align: "right" }).text("236.00", 495, y + 26, { width: 70, align: "right" });
  doc.font("Helvetica-Bold").fontSize(12).text("Amount due USD", 360, y + 46, { width: 125, align: "right" }).text("3,186.00", 495, y + 46, { width: 70, align: "right" });
});

// ---- Layout C: minimal (unknown vendor) ----
write("06-unknown-vendor.pdf", (doc) => {
  doc.font("Helvetica-Bold").fontSize(18).text("Brightline Supply Co", 50, 50);
  doc.font("Helvetica").fontSize(9).fill("#666").text("billing@brightline-supply.example", 50, 72);
  doc.fill("#222").fontSize(10).text("INVOICE BL-2291 · 1 November 2026 · Due on receipt", 50, 110);
  doc.text(`To: ${BILL_TO.join(", ")}`, 50, 128);
  let y = lineTable(doc, 170, [{ d: "Facility consulting services - October", q: 1, u: 4800 }], { color: "#555" });
  totals(doc, y, [["Total", "$4,800.00", true]]);
  doc.font("Helvetica").fontSize(10).text("Wire to: Metro Community Bank · Account 5521 9087 3364", 50, y + 70);
});

// ---- 03: scanned (image-only) PDF ----
const scan = path.join(here, "tmp", "03-scan.png");
if (fs.existsSync(scan)) {
  write("03-northstar-duplicate-scan.pdf", (doc) => doc.image(scan, 0, 0, { width: 612, height: 792 }));
} else {
  console.warn("skip 03: run scripts/make-images.ps1 first");
}
