// End-to-end rehearsal: drives the real UI in Edge with the live model.
//  1) all six demo invoices through the real pipeline, checking each decision
//  2) a repeat upload of the happy-path invoice (must be rejected, no new payable)
//  3) bank-change hold resolved through the reviewer workflow
//  4) handwritten Rao bill: reacts to what the model ACTUALLY read; if the
//     overwritten digit was misread it corrects it and re-runs the checks
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
  ["Acme Industrial · INV-1047", "Approved"],
  ["Sunridge Chemicals · SC-3390", "Needs review"],
  ["Northstar Logistics · scanned copy", "Rejected"],
  ["Rao Electrical · handwritten bill", "Needs review"],
  ["Acme Industrial · INV-1052", "Payment hold"],
  ["Brightline Supply Co · BL-2291", "Payment hold"],
];

if (!uiOnly) await fetch(`${base}/api/runs`, { method: "DELETE" });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("  [page error]", e.message));
const shot = (name, fullPage = false) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage });
const runs = async () => (await fetch(`${base}/api/runs`)).json();
const byNo = async (n) => (await runs()).find((r) => r.invoice.invoiceNumber === n && !r.repeatSubmission);
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

async function runCase(title, expected, label) {
  const t0 = Date.now();
  await page.goto(`${base}/process`);
  await page.locator(".sample", { hasText: title }).click();
  await page.locator("img.dz-thumb").waitFor({ timeout: 30000 });
  await shot("process-intake");
  await page.locator(".btn-primary", { hasText: "Run process" }).click();
  await page.locator(".running .tl").waitFor({ timeout: 10000 }).catch(() => {});
  await Promise.race([page.locator(".inv-head .badge-lg").waitFor({ timeout: 300000 }), page.locator(".alert-err").waitFor({ timeout: 300000 })]).catch(() => {});
  if (await page.locator(".alert-err").isVisible()) console.log(`  ERROR: ${(await page.locator(".alert-err").innerText()).slice(0, 300)}`);
  const got = (await page.locator(".inv-head .badge-lg").innerText().catch(() => "(none)")).trim();
  check(got.toLowerCase() === expected.toLowerCase(), `${label}: ${got} (expected ${expected}) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`     ${(await page.locator(".dec-what").innerText().catch(() => "")).slice(0, 140)}`);
}

if (!uiOnly) {
  for (const [i, [title, expected]] of CASES.entries()) {
    await runCase(title, expected, `${i + 1}. ${title}`);
    await shot(`process-${String(i + 1).padStart(2, "0")}`);
  }
  await runCase(CASES[0][0], "Rejected", "Repeat upload of INV-1047");
}

// ---- Bank hold → verification → approval ----
const bank = await byNo("INV-1052");
if (bank) {
  await page.goto(`${base}/invoice/${bank.id}?from=queue`);
  await page.locator(".resolve").waitFor();
  await shot("invoice-bank-hold");
  check(await page.locator(".resolve .btn", { hasText: /^Approve/ }).isDisabled(), "Approve is locked on a bank hold");
  await page.locator(".resolve-fields input").first().fill("Priya Shah");
  await page.locator(".resolve-fields input").nth(1).fill("Called Acme on (216) 555-0190 (number on file); controller confirmed new account");
  await page.locator(".verify input").check();
  await page.locator(".resolve .btn", { hasText: "Record independent bank verification" }).click();
  await page.locator(".inv-head .badge-lg", { hasText: /needs review/i }).waitFor({ timeout: 10000 });
  await page.locator(".resolve-fields input").nth(1).fill("All controls resolved after call-back verification");
  await page.locator(".resolve .btn", { hasText: /^Approve/ }).click();
  await page.locator(".inv-head .badge-lg", { hasText: /approved/i }).waitFor({ timeout: 10000 });
  check(true, "Bank hold: verified → needs review → approved by reviewer");
}

// ---- Handwritten Rao: inspect what the model really read ----
const rao = (await runs()).find((r) => /rao/i.test(r.invoice.vendor) && !r.repeatSubmission);
if (rao) {
  const l0 = rao.invoice.lineItems[0];
  const codes = rao.findings.filter((f) => f.action !== "info").map((f) => f.code);
  console.log(`     Rao: model read labour line as ${l0?.quantity} × ${l0?.unitPrice} = ${l0?.total}; uncertain: [${rao.invoice.lowConfidenceFields.join(", ")}]; open: ${codes.join(", ")}`);
  await page.goto(`${base}/invoice/${rao.id}?from=queue`);
  await page.locator(".inv-head").waitFor();
  await shot("invoice-rao-before");
  const misread = Math.abs((l0?.total ?? 0) - 1850) > 0.5 || Math.abs((l0?.unitPrice ?? 0) - 1850) > 0.5;
  if (misread) {
    await page.locator(".btn", { hasText: "Correct fields" }).click();
    await page.locator('input[aria-label="Line 1 unitPrice"]').fill("1850");
    await page.locator('input[aria-label="Line 1 total"]').fill("1850");
    await page.locator('.editor input[aria-label="Reviewer name"]').fill("Priya Shah");
    await page.locator('.editor input[aria-label="Reason for correction"]').fill("Labour amount is 1850 on the photo (8 written over 3); only value that matches the subtotal");
    await shot("invoice-rao-editing");
    await page.locator(".btn", { hasText: "Save corrections & re-run checks" }).click();
    await page.waitForTimeout(1500);
    const after = (await runs()).find((r) => r.id === rao.id);
    check(!after.findings.some((f) => f.code === "ARITHMETIC_MISMATCH"), `Correction re-ran checks: arithmetic now reconciles; status ${after.status}; open ${after.findings.filter((f) => f.action !== "info" && !(after.resolvedCodes ?? []).includes(f.code)).map((f) => f.code).join(", ")}`);
    check(after.corrections?.[0]?.changes?.length >= 1 && after.originalInvoice, "Correction audit: original value kept, change + reviewer + reason recorded");
  } else {
    console.log("     Model read 1850 correctly; no correction needed. Showing confirmation path.");
  }
  await page.reload();
  await page.locator(".resolve").waitFor();
  check(await page.locator(".resolve .btn", { hasText: /^Approve/ }).isDisabled(), "Rao: Approve locked until figures and PO are confirmed");
  await shot("invoice-rao-after");
}

for (const [name, url] of [["overview", "/"], ["queue", "/queue"], ["history", "/history"], ["reference", "/reference"], ["policy", "/policy"]]) {
  await page.goto(`${base}${url}`);
  await page.waitForTimeout(700);
  await shot(name);
}
await page.goto(`${base}/policy`);
await page.locator(".setting input.input-num").first().fill("12");
await page.waitForTimeout(500);
await shot("policy-impact");

const all = await runs();
console.log(`Stored runs: ${all.length} · ${all.map((r) => `${r.invoice.invoiceNumber}:${r.status}`).join(", ")}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exitCode = failures ? 1 : 0;
