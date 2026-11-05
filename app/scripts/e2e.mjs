// End-to-end demo rehearsal: drives the real UI in Edge with the live model.
// 1) runs all six demo invoices and checks each decision,
// 2) re-uploads the happy-path invoice and expects a rejected repeat submission,
// 3) resolves the bank-change hold through the reviewer workflow,
// 4) screenshots every screen to scripts/tmp/e2e/.
// Usage: node scripts/e2e.mjs [baseUrl]   (app must be running; CLEARS run history)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:5173";
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "tmp", "e2e");
fs.mkdirSync(shots, { recursive: true });
const shot = (page, name, full = true) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: full });

const CASES = [
  ["Acme Industrial · INV-1047", "Approved"],
  ["Sunridge Chemicals · SC-3390", "Needs review"],
  ["Northstar Logistics · scanned copy", "Rejected"],
  ["Rao Electrical · handwritten bill", "Needs review"],
  ["Acme Industrial · INV-1052", "Payment hold"],
  ["Brightline Supply Co · BL-2291", "Payment hold"],
];

const uiOnly = process.argv.includes("--ui-only");
if (!uiOnly) await fetch(`${base}/api/runs`, { method: "DELETE" });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
page.on("pageerror", (e) => console.log("  [page error]", e.message));
let failures = 0;

async function runCase(title, expected, label) {
  const t0 = Date.now();
  await page.goto(`${base}/process`);
  const sample = page.locator(".sample", { hasText: title });
  if (!(await sample.isVisible())) await page.locator(".link-btn", { hasText: "Demo scenarios" }).click();
  await sample.click();
  await page.locator("img.doc-thumb").waitFor({ timeout: 30000 });
  await page.locator(".btn-primary", { hasText: "Run process" }).click();
  const done = page.locator("a.btn-sm[href^='/invoice/']");
  await Promise.race([done.waitFor({ timeout: 240000 }), page.locator(".alert-err").waitFor({ timeout: 240000 })]).catch(() => {});
  if (await page.locator(".alert-err").isVisible()) console.log(`  ERROR: ${(await page.locator(".alert-err").innerText()).slice(0, 300)}`);
  const got = (await page.locator(".dhead .badge-lg").innerText().catch(() => "(none)")).trim();
  const ok = got.toLowerCase() === expected.toLowerCase();
  if (!ok) failures++;
  const head = await page.locator(".dhead-reason").innerText().catch(() => "");
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${got} (expected ${expected}) · ${((Date.now() - t0) / 1000).toFixed(1)}s\n     ${head.slice(0, 160)}`);
  return done.getAttribute("href").catch(() => null);
}

const links = {};
if (uiOnly) {
  // Reuse stored runs (saves LLM quota): find the latest run per invoice number.
  const stored = await (await fetch(`${base}/api/runs`)).json();
  const byNo = (n) => stored.find((r) => r.invoice.invoiceNumber === n && !r.repeatSubmission);
  links[2] = byNo("SC-3390") && `/invoice/${byNo("SC-3390").id}`;
  links[5] = byNo("INV-1052") && `/invoice/${byNo("INV-1052").id}`;
} else {
  for (const [i, [title, expected]] of CASES.entries()) {
    links[i + 1] = await runCase(title, expected, `${i + 1}. ${title}`);
    await shot(page, `process-${String(i + 1).padStart(2, "0")}`);
  }
  // Re-upload of the approved happy-path invoice must not create a second payable.
  await runCase(CASES[0][0], "Rejected", "Repeat upload of INV-1047");
  await page.locator(".tab", { hasText: "Validation evidence" }).click();
  await shot(page, "process-repeat");
}

// Reviewer workflow on the bank-change hold.
await page.goto(`${base}${links[5]}`);
await page.locator(".review").waitFor();
await shot(page, "invoice-bank-hold");
const approveDisabled = await page.locator(".review .btn", { hasText: /^Approve/ }).isDisabled();
console.log(`${approveDisabled ? "PASS" : "FAIL"} Approve is blocked on a bank hold`);
if (!approveDisabled) failures++;
await page.locator(".review input.input").first().fill("Priya Shah");
await page.locator(".review input.input").nth(1).fill("Called Acme on (216) 555-0190 (number on file); controller confirmed new account");
await page.locator(".check input").check();
await page.locator(".review .btn", { hasText: "Record independent bank verification" }).click();
await page.locator(".dhead .badge-lg", { hasText: /needs review/i }).waitFor({ timeout: 10000 });
await page.locator(".review input.input").nth(1).fill("All controls resolved after call-back verification");
await page.locator(".review .btn", { hasText: /^Approve/ }).click();
await page.locator(".dhead .badge-lg", { hasText: /approved/i }).waitFor({ timeout: 10000 });
console.log("PASS Bank hold: verified → needs review → approved by reviewer");
await page.locator(".tab", { hasText: "Audit trail" }).click();
await shot(page, "invoice-bank-resolved");

await page.goto(`${base}${links[2]}`);
await page.locator(".poc").waitFor();
await shot(page, "invoice-split-po");

for (const [name, url] of [["overview", "/"], ["queue", "/queue"], ["history", "/history"], ["reference", "/reference"], ["policy", "/policy"]]) {
  await page.goto(`${base}${url}`);
  await page.waitForTimeout(600);
  await shot(page, name);
}

const runs = await (await fetch(`${base}/api/runs`)).json();
console.log(`Stored runs: ${runs.length} · statuses: ${runs.map((r) => r.status).join(", ")}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exitCode = failures ? 1 : 0;
