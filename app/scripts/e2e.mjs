// End-to-end rehearsal on the real UI in Edge with the live model.
//  1) six demo invoices through the real pipeline, checking each decision
//  2) repeat upload of the happy path (must be rejected; no new payable)
//  3) bank hold → record verification → approve (guided actions)
//  4) handwritten Rao: PO suggestion → correction → re-validation → confirm → approve
//  5) screenshots of every screen to scripts/tmp/e2e/
// Usage: node scripts/e2e.mjs [baseUrl] [--ui-only]   (CLEARS run history unless --ui-only)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:5173";
const uiOnly = process.argv.includes("--ui-only");
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "tmp", "e2e");
fs.mkdirSync(shots, { recursive: true });

const CASES = [
  ["INV-1047", "Approved"],
  ["SC-3390", "Needs review"],
  ["scanned copy", "Rejected"],
  ["handwritten bill", "Needs review"],
  ["INV-1052", "Payment hold"],
  ["BL-2291", "Payment hold"],
];

if (!uiOnly) await fetch(`${base}/api/runs`, { method: "DELETE" });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("  [page error]", e.message));
const shot = (name, fullPage = false) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage });
const runs = async () => (await fetch(`${base}/api/runs`)).json();
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

async function runCase(ref, expected, label, attempt = 1) {
  const t0 = Date.now();
  await page.goto(`${base}/process`);
  await page.locator(".demo", { hasText: ref }).click();
  await page.locator("img.drop-thumb").waitFor({ timeout: 30000 });
  if (ref === "INV-1047" && attempt === 1) await shot("process-a-selected");
  await page.locator(".btn-primary", { hasText: "Run process" }).click();
  await page.locator(".proc").waitFor({ timeout: 10000 }).catch(() => {});
  if (ref === "SC-3390") {
    await page.waitForTimeout(2500);
    await shot("process-b-running");
  }
  await Promise.race([page.locator(".inv-head .badge-lg").waitFor({ timeout: 300000 }), page.locator(".alert-err").waitFor({ timeout: 300000 })]).catch(() => {});
  if (await page.locator(".alert-err").isVisible()) {
    console.log(`  provider/system error: ${(await page.locator(".alert-err").innerText()).slice(0, 160).replace(/\s+/g, " ")}`);
    if (attempt < 2) return runCase(ref, expected, label, attempt + 1);
  }
  const got = (await page.locator(".inv-head .badge-lg").innerText().catch(() => "(none)")).trim();
  check(got.toLowerCase() === expected.toLowerCase(), `${label}: ${got} (expected ${expected}) · ${((Date.now() - t0) / 1000).toFixed(1)}s${attempt > 1 ? " · after 1 retry" : ""}`);
  console.log(`     ${(await page.locator(".decision-title").innerText().catch(() => "")).slice(0, 120)}`);
}

if (!uiOnly) {
  await page.goto(`${base}/process`);
  await shot("process-a-intake");
  for (const [i, [ref, expected]] of CASES.entries()) {
    await runCase(ref, expected, `${i + 1}. ${ref}`);
    await shot(`process-c-${String(i + 1).padStart(2, "0")}`);
  }
  await runCase("INV-1047", "Rejected", "Repeat upload of INV-1047");
}

const confirmAction = async (label, note, verify = false) => {
  await page.locator(".act", { hasText: label }).click();
  await page.locator('.act-form input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.act-form input[aria-label="Justification"]').fill(note);
  if (verify) await page.locator(".act-form .verify input").check();
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  await page.waitForTimeout(1200);
};

// ---- Bank hold via the Review Queue workspace ----
const bank = (await runs()).find((r) => r.invoice.invoiceNumber === "INV-1052" && !r.repeatSubmission);
if (bank) {
  await page.goto(`${base}/queue?run=${bank.id}`);
  await page.locator(".ws-card .inv-head").waitFor();
  await shot("queue-bank");
  check(await page.locator(".act", { hasText: /^Approve/ }).isDisabled(), "Approve is locked on a bank hold");
  // Validation messages when submitting without input
  await page.locator(".act", { hasText: "Record independent bank verification" }).click();
  await page.locator('.act-form input[aria-label="Justification"]').fill("");
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  check(await page.locator(".form-errors").isVisible(), "Missing justification / verification shows validation messages");
  await shot("queue-bank-form");
  await page.locator('.act-form input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.act-form input[aria-label="Justification"]').fill("Called Acme on (216) 555-0190 (number on file); controller confirmed the new account");
  await page.locator(".act-form .verify input").check();
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  await page.locator(".ws-card .badge-lg", { hasText: /needs review/i }).waitFor({ timeout: 10000 });
  await confirmAction("Approve", "All controls resolved after call-back verification");
  const b2 = (await runs()).find((r) => r.id === bank.id);
  check(b2.status === "approved", `Bank hold: verified → needs review → ${b2.status}`);
}

// ---- Handwritten Rao: suggestion → correction → re-validation → confirm → approve ----
const rao = (await runs()).find((r) => /rao/i.test(r.invoice.vendor) && !r.repeatSubmission);
if (rao) {
  const l0 = rao.invoice.lineItems[0];
  console.log(`     Rao (real model output): labour ${l0?.quantity} × ${l0?.unitPrice} = ${l0?.total}; AI-unsure: [${rao.invoice.lowConfidenceFields.join(", ")}]`);
  await page.goto(`${base}/invoice/${rao.id}?from=queue`);
  await page.locator(".inv-head").waitFor();
  await shot("invoice-rao-summary");
  if (Math.abs((l0?.total ?? 0) - 1850) > 0.5) {
    await page.locator(".btn", { hasText: "Correct fields" }).click();
    await page.locator('input[aria-label="Line 1 unitPrice"]').fill("1850");
    await page.locator('input[aria-label="Line 1 total"]').fill("1850");
    await page.locator('.editor input[aria-label="Reviewer name"]').fill("Priya Shah");
    await page.locator('.editor input[aria-label="Reason for correction"]').fill("Labour reads 1850 on the photo (8 over 3); the only value matching the subtotal");
    await page.locator(".btn", { hasText: "Save & re-run checks" }).click();
    await page.waitForTimeout(1500);
  }
  if (rao.poMatch.method !== "explicit") {
    await page.locator(".sugg-row .btn", { hasText: "Use this PO" }).first().click();
    await page.locator('.editor input[aria-label="Reviewer name"]').fill("Priya Shah");
    await page.locator('.editor input[aria-label="Reason for correction"]').fill("Plant manager confirmed the work was ordered on PO-2026-0225");
    await shot("invoice-rao-editing");
    await page.locator(".btn", { hasText: "Save & re-run checks" }).click();
    await page.waitForTimeout(1500);
  }
  let r = (await runs()).find((x) => x.id === rao.id);
  const open = (x) => x.findings.filter((f) => f.action !== "info" && !(x.resolvedCodes ?? []).includes(f.code)).map((f) => f.code);
  check(r.corrections?.length >= 1 && r.originalInvoice, `Correction recorded (${r.corrections?.map((c) => c.changes.map((ch) => `${ch.field} ${ch.from}→${ch.to}`).join("; ")).join(" | ")}); all checks re-ran; open: ${open(r).join(", ")}`);
  check(await page.locator(".act", { hasText: /^Approve/ }).isDisabled(), "Approve still locked until figures are confirmed");
  await confirmAction("Confirm figures match the document", "Checked every figure against the photo; labour reads 1850");
  await confirmAction("Approve", "Figures confirmed; PO assigned by plant manager");
  r = (await runs()).find((x) => x.id === rao.id);
  check(r.status === "approved", `Rao final status: ${r.status} · audit: ${r.audit.map((a) => a.action.split(":")[0]).join(" → ")}`);
  await page.locator(".seg button", { hasText: "Detailed" }).click();
  await shot("invoice-rao-detailed", true);
  await page.locator(".seg button", { hasText: "Summary" }).click();
}

for (const [name, url] of [["overview", "/"], ["queue", "/queue"], ["history", "/history"], ["reference", "/reference"], ["policy", "/policy"]]) {
  await page.goto(`${base}${url}`);
  await page.waitForTimeout(700);
  await shot(name);
}
const sunridge = (await runs()).find((r) => r.invoice.invoiceNumber === "SC-3390");
if (sunridge) {
  await page.goto(`${base}/invoice/${sunridge.id}?from=history`);
  await page.locator(".inv-head").waitFor();
  await shot("invoice-sunridge-summary");
}

const all = await runs();
console.log(`Stored runs: ${all.length} · ${all.map((r) => `${r.invoice.invoiceNumber}:${r.status}`).join(", ")}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exitCode = failures ? 1 : 0;
