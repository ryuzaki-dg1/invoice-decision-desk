// End-to-end acceptance run on the real UI in Edge with the live model.
//  0) reset demo data; simulated AI outage (503) → no record, retry same document
//  1) six demo invoices through the real pipeline
//  2) repeat upload of the happy path (rejected, grouped, not double counted)
//  3) bank hold → verify payment details → approve
//  4) Sunridge PO overage → approve locked → authorised PO resolution → approve
//  5) handwritten Rao → PO suggestion correction → re-validation → confirm → approve
//  6) audit events persist across reload; metrics use unique invoices
// Usage: node scripts/e2e.mjs [baseUrl]   (CLEARS run history)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:5173";
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

// Demo cards are labelled by scenario name.
const CARD = { "INV-1047": "Routine invoice", "SC-3390": "Split PO billing", "scanned copy": "Duplicate resubmission", "handwritten bill": "Handwritten invoice", "INV-1052": "Bank account change", "BL-2291": "Unknown vendor" };
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
const waitDone = () => Promise.race([page.locator(".inv-head .badge-lg").waitFor({ timeout: 300000 }), page.locator(".sys-err").waitFor({ timeout: 300000 })]).catch(() => {});

const act = async (label, note, opts = {}) => {
  await page.locator(".act", { hasText: label }).first().click();
  await page.locator('.act-form input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.act-form input[aria-label="Justification"]').fill(note);
  if (opts.verify) await page.locator(".act-form .verify input").check();
  if (opts.auth) {
    await page.locator('.act-form input[aria-label="Authorised by"]').fill(opts.auth[0]);
    await page.locator('.act-form input[aria-label="Amendment reference"]').fill(opts.auth[1]);
  }
  if (opts.shot) await shot(opts.shot);
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  await page.waitForTimeout(1300);
};
const byNo = async (n) => (await runs()).find((r) => r.invoice.invoiceNumber === n && !r.repeatSubmission);

const resume = process.argv.includes("--resume"); // continue from step 4 with stored runs
if (!resume) {
// ---- 0) Reset + simulated AI outage ----
await fetch(`${base}/api/runs`, { method: "DELETE" });
check((await runs()).length === 0, "Reset demo data: no runs");
await page.goto(`${base}/`);
check((await page.locator(".kpi-value").first().innerText()) === "0", "Reset: Overview shows 0 unique invoices");
await page.route("**/api/chat", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand." } }) }));
await page.goto(`${base}/process`);
await page.locator(".demo", { hasText: CARD["INV-1047"] }).click();
await page.locator("img.drop-thumb").waitFor();
await page.locator(".btn-primary", { hasText: "Run process" }).click();
await page.locator(".sys-err").waitFor({ timeout: 30000 });
const sysTitle = await page.locator(".sys-title").innerText();
check(/temporarily unavailable/i.test(sysTitle), `Simulated 503 shown as "${sysTitle}", not a business decision`);
check((await runs()).length === 0, "Failed attempt saved no record and invented no fields");
await shot("process-ai-unavailable");
await page.unroute("**/api/chat");

async function runCase(ref, expected, label, retry = false) {
  const t0 = Date.now();
  if (!retry) {
    await page.goto(`${base}/process`);
    await page.locator(".demo", { hasText: CARD[ref] ?? ref }).click();
    await page.locator("img.drop-thumb").waitFor({ timeout: 30000 });
    await page.locator(".btn-primary", { hasText: "Run process" }).click();
  } else {
    await page.locator(".btn", { hasText: "Retry with the same document" }).click();
  }
  await waitDone();
  if (await page.locator(".sys-err").isVisible()) {
    console.log(`  provider error: ${(await page.locator(".sys-title").innerText())} → retrying same document`);
    await page.locator(".btn", { hasText: "Retry with the same document" }).click();
    await waitDone();
  }
  const got = (await page.locator(".inv-head .badge-lg").innerText().catch(() => "(none)")).trim();
  check(got.toLowerCase() === expected.toLowerCase(), `${label}: ${got} (expected ${expected}) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Retry after the outage, same document, no duplicate record.
await runCase("INV-1047", "Approved", "1. INV-1047 (retry after outage)", true);
check((await runs()).length === 1, "Retry created exactly one record");
for (const [i, [ref, expected]] of CASES.slice(1).entries()) {
  await runCase(ref, expected, `${i + 2}. ${ref}`);
}
await runCase("INV-1047", "Rejected", "7. Repeat upload of INV-1047");


// ---- 3) Bank hold ----
const bank = await byNo("INV-1052");
await page.goto(`${base}/queue?run=${bank.id}`);
await page.locator(".ws-card .inv-head").waitFor();
check(await page.locator(".act", { hasText: /^Approve/ }).isDisabled(), "Bank hold: Approve locked");
await page.locator(".btn", { hasText: "View original document" }).click();
check(await page.locator(".ws-left .doc img").isVisible(), "View document opens side by side inside the queue");
await shot("queue-doc-split");
await page.locator(".ws-back").click();
await act("Verify payment details", "Called Acme on (216) 555-0190, the number on file; controller confirmed the new account", { verify: true });
await act("Approve", "All controls resolved after call-back verification");
check((await runs()).find((r) => r.id === bank.id).status === "approved", "Bank hold → verified → approved");

} // end !resume
// ---- 4) Sunridge PO overage ----
const sun = await byNo("SC-3390");
await page.goto(`${base}/queue?run=${sun.id}`);
await page.locator(".ws-card .inv-head").waitFor();
check(await page.locator(".act", { hasText: /^Approve/ }).isDisabled(), "Sunridge: Approve locked while the PO overage is open");
await act("Resolve PO discrepancy", "Procurement increased the PO to cover the extra 2 drums", { auth: ["m.okafor", "PO-2026-0211-A1"], shot: "queue-po-form" });
let s2 = (await runs()).find((r) => r.id === sun.id);
check(s2.status === "needs_review" && s2.audit.at(-1).reference?.includes("PO-2026-0211-A1"), `PO resolution recorded with authoriser/reference; status ${s2.status} (explicit approval still required)`);
await act("Approve", "PO amended and authorised by m.okafor");
check((await runs()).find((r) => r.id === sun.id).status === "approved", "Sunridge approved after authorised PO resolution");

// ---- 5) Handwritten Rao ----
const rao = (await runs()).find((r) => /rao/i.test(r.invoice.vendor) && !r.repeatSubmission);
const l0 = rao.invoice.lineItems[0];
console.log(`     Rao (real model output): labour ${l0?.quantity} × ${l0?.unitPrice} = ${l0?.total}; AI-unsure: [${rao.invoice.lowConfidenceFields.join(", ")}]`);
await page.goto(`${base}/invoice/${rao.id}?from=queue`);
await page.locator(".inv-head").waitFor();
if (Math.abs((l0?.total ?? 0) - 1850) > 0.5) {
  await page.locator(".btn", { hasText: "Correct fields" }).click();
  await page.locator('input[aria-label="Line 1 unitPrice"]').fill("1850");
  await page.locator('input[aria-label="Line 1 total"]').fill("1850");
  await page.locator('.editor input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.editor input[aria-label="Reason for correction"]').fill("Labour reads 1850 on the photo; only value matching the subtotal");
  await page.locator(".btn", { hasText: "Save & re-run checks" }).click();
  await page.waitForTimeout(1500);
}
if (rao.poMatch.method !== "explicit") {
  await page.locator(".sugg-row .btn", { hasText: "Use this PO" }).first().click();
  await page.locator('.editor input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.editor input[aria-label="Reason for correction"]').fill("Plant manager confirmed the work was ordered on PO-2026-0225");
  await page.locator(".btn", { hasText: "Save & re-run checks" }).click();
  await page.waitForTimeout(1500);
}
check(await page.locator(".act", { hasText: /^Approve/ }).isDisabled(), "Rao: Approve locked until extracted information is confirmed");
await act("Confirm extracted information", "Checked every figure against the photo");
const r1 = (await runs()).find((r) => r.id === rao.id);
check(r1.status === "needs_review", `Confirming fields does not auto-approve (status ${r1.status})`);
await act("Approve", "Figures confirmed; PO assigned by plant manager");

// ---- 5b) A real uploaded invoice with TWO controls (bank + PO): checklist sequence ----
const bpFile = path.join(here, "tmp", "bluepeak-upload.png");
if (fs.existsSync(bpFile)) {
  const t0 = Date.now();
  await page.goto(`${base}/process`);
  await page.locator('input[type="file"]').setInputFiles(bpFile);
  await page.locator("img.drop-thumb").waitFor({ timeout: 30000 });
  await page.locator(".btn-primary", { hasText: "Run process" }).click();
  await waitDone();
  if (await page.locator(".sys-err").isVisible()) {
    await page.locator(".btn", { hasText: "Retry with the same document" }).click();
    await waitDone();
  }
  const got = (await page.locator(".inv-head .badge-lg").innerText().catch(() => "")).trim();
  check(/payment hold/i.test(got), `Uploaded Bluepeak invoice: ${got} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const bp = (await runs()).find((r) => r.invoice.invoiceNumber === "INV-4471");
  await page.goto(`${base}/queue?run=${bp.id}`);
  await page.locator(".ctl").waitFor();
  const foot0 = await page.locator(".ctl-foot").innerText();
  check(/2 unresolved controls/.test(foot0) && /locked/i.test(foot0), `Checklist: "${foot0.trim()}"`);
  await shot("bluepeak-checklist-before");
  await page.locator(".ctl .btn", { hasText: "Verify payment details" }).click();
  await page.locator('.act-form input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.act-form input[aria-label="Justification"]').fill("Called Bluepeak on (408) 555-0123 from the vendor master; finance confirmed the account");
  await page.locator(".act-form .verify input").check();
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  await page.waitForTimeout(1300);
  const pay = await page.locator(".ctl-payment, .ctl li").filter({ hasText: "Payment details" }).innerText();
  const foot1 = await page.locator(".ctl-foot").innerText();
  check(/Resolved/.test(pay) && /1 unresolved control/.test(foot1) && (await page.locator(".act", { hasText: /^Approve/ }).isDisabled()), `After bank verification: payment control resolved, "${foot1.trim()}", approve still locked`);
  await shot("bluepeak-checklist-after-bank");
  await page.locator(".ctl .btn", { hasText: "Resolve PO discrepancy" }).click();
  await page.locator('.act-form input[aria-label="Reviewer name"]').fill("Priya Shah");
  await page.locator('.act-form input[aria-label="Justification"]').fill("Surcharge BP-PRICE-2026-Q2 accepted by the PO owner");
  await page.locator('.act-form input[aria-label="Authorised by"]').fill("a.patel");
  await page.locator('.act-form input[aria-label="Amendment reference"]').fill("PO-2026-0184-A1");
  await page.locator(".act-form .btn", { hasText: "Confirm" }).click();
  await page.waitForTimeout(1300);
  const foot2 = await page.locator(".ctl-foot").innerText();
  check(/All controls satisfied/.test(foot2) && !(await page.locator(".act", { hasText: /^Approve/ }).isDisabled()), `After PO authorisation: "${foot2.trim()}", approve unlocked`);
}

// ---- 5c) Document-to-data verification ----
const acme = (await runs()).find((r) => r.invoice.invoiceNumber === "INV-1047" && !r.repeatSubmission);
await page.goto(`${base}/invoice/${acme.id}?from=history`);
await page.locator(".seg button", { hasText: "Detailed" }).click();
await page.locator(".fv", { hasText: "Total" }).first().click();
await page.waitForTimeout(600);
check((await page.locator(".hl-box").count()) >= 1, `Digital PDF: clicking Total highlights it on the page (${await page.locator(".hl-box").count()} box)`);
await shot("locate-digital");
const raoRun = (await runs()).find((r) => /rao/i.test(r.invoice.vendor));
await page.goto(`${base}/invoice/${raoRun.id}?from=history`);
await page.locator(".fv", { hasText: "Total" }).first().click();
check(await page.locator(".doc-hl-none").isVisible(), "Handwritten photo: no fabricated box; explains there is no text layer");
await page.locator(".seg button", { hasText: "Summary" }).click();

// ---- 5d) History: duplicate attempts are not mistaken for rejected invoices ----
await page.goto(`${base}/history`);
await page.waitForTimeout(700);
const dupCount = await page.locator(".badge.st-dup").count();
check(dupCount >= 2, `History marks ${dupCount} repeat attempts as "Duplicate blocked" with a link to the original`);

// ---- 6) Persistence + metrics ----
await page.goto(`${base}/invoice/${rao.id}?from=history`);
await page.locator(".audit").waitFor();
const auditText = await page.locator(".audit").innerText();
check(/Confirmed extracted information/.test(auditText) && /demo identity/.test(auditText), "Audit timeline persists after reload and labels the demo identity");
await shot("invoice-rao-audit", true);
const all = await runs();
await page.goto(`${base}/`);
await page.waitForTimeout(800);
const kpis = await page.locator(".kpi").allInnerTexts();
console.log(`     KPIs: ${kpis.map((k) => k.replace(/\s+/g, " ")).join(" | ")}`);
check(kpis[0].includes(`${all.length} processing attempts`), "Overview distinguishes unique invoices from processing attempts");
await shot("overview");
const more = page.locator(".feed-more").first();
if (await more.isVisible()) {
  await more.click();
  await shot("overview-attempts");
  check(await page.locator(".attempts li").count() >= 2, "Repeat submissions grouped under one invoice with expandable attempts");
}
for (const [name, url] of [["queue", "/queue"], ["history", "/history"], ["policy", "/policy"]]) {
  await page.goto(`${base}${url}`);
  await page.waitForTimeout(700);
  await shot(name);
}
console.log(`Stored runs: ${all.length} · ${all.map((r) => `${r.invoice.invoiceNumber}:${r.status}`).join(", ")}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exitCode = failures ? 1 : 0;
