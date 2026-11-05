// End-to-end demo rehearsal: drives the real UI in Edge, runs every demo
// invoice through the full pipeline (real LLM), checks each decision and
// saves screenshots to scripts/tmp/e2e/.
// Usage: node scripts/e2e.mjs [baseUrl]   (app must be running; clears run history)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173";
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

await fetch(`${base}/api/runs`, { method: "DELETE" });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on("pageerror", (e) => console.log("  [page error]", e.message));
await page.goto(base);

let failures = 0;
for (const [i, [title, expected]] of CASES.entries()) {
  const t0 = Date.now();
  await page.locator(".sample", { hasText: title }).click();
  await page.locator(".doc-thumb").waitFor({ timeout: 30000 });
  await page.locator(".btn-primary", { hasText: "Run" }).click();
  await Promise.race([
    page.locator("a.link", { hasText: "Saved" }).waitFor({ timeout: 180000 }),
    page.locator(".error").waitFor({ timeout: 180000 }).then(async () => {
      throw new Error(await page.locator(".error").innerText());
    }),
  ]).catch((e) => console.log(`  ERROR: ${e.message.slice(0, 400)}`));
  const got = (await page.locator(".decision .badge").first().innerText().catch(() => "(none)")).replace(/^\W+/, "").trim();
  const headline = await page.locator(".decision .decision-headline").first().innerText().catch(() => "");
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${i + 1}. ${title}: ${got} (expected ${expected}) · ${headline} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const findings = await page.locator(".decision .finding-title").allInnerTexts().catch(() => []);
  console.log(`     findings: ${findings.join(" | ")}`);
  await page.screenshot({ path: path.join(shots, `${String(i + 1).padStart(2, "0")}.png`), fullPage: true });
}

await page.goto(`${base}/dashboard`);
await page.locator(".runs tbody tr").first().waitFor();
await page.screenshot({ path: path.join(shots, "dashboard.png"), fullPage: true });
await page.locator(".runs tbody tr").nth(1).click();
await page.locator(".drawer").waitFor();
await page.screenshot({ path: path.join(shots, "drawer.png") });
await browser.close();
console.log(failures ? `${failures} case(s) failed` : "All cases passed");
process.exit(failures ? 1 : 0);
