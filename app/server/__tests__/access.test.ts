// Deployment safety: server-controlled thresholds, demo access key, reset gating,
// persistence under DATA_DIR and port/host binding, exercised against the real server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Invoice } from "../../src/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const KEY = "demo-access-key-123456";
const auth = { Authorization: `Basic ${Buffer.from(`demo:${KEY}`).toString("base64")}` };

function invoice(p: Partial<Invoice> = {}): Invoice {
  return { vendor: "Acme Industrial Supply Co.", invoiceNumber: "INV-7001", poReference: "PO-2026-0142", issueDate: "2026-11-02", dueDate: "2026-12-02", paymentTerms: "Net 30", lineItems: [{ description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 }, { description: "Lock washer M8 (box of 500)", quantity: 10, unitPrice: 18.5, total: 185 }], subtotal: 1235, tax: 98.8, shipping: 45.85, otherCharges: 0, discount: 0, total: 1379.65, currency: "USD", bankAccount: "4410 2287 4821", documentType: "digital", lowConfidenceFields: [], ...p };
}

function start(env: Record<string, string>, port: number) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "server/standalone.ts"], { cwd: ROOT, env: { ...process.env, GEMINI_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => out.includes("AP invoice decision server") && (clearInterval(t), resolve()), 50);
    child.on("exit", (code) => (clearInterval(t), reject(new Error(`exited ${code}: ${out}`))));
  });
  return { child, ready, output: () => out };
}

test("production refuses to start without an access key", async () => {
  const s = start({ NODE_ENV: "production", DEMO_ACCESS_KEY: "" }, 39101);
  await assert.rejects(s.ready, /DEMO_ACCESS_KEY is not set/);
});

test("access key, server thresholds, reset gating and persistence on the real server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zamp-deploy-"));
  const port = 39102;
  const env = { NODE_ENV: "production", DEMO_ACCESS_KEY: KEY, DATA_DIR: dir };
  let s = start(env, port); // PORT from the environment
  await s.ready;
  const base = `http://127.0.0.1:${port}`;
  try {
    // Every route except the bare health probe needs the key.
    for (const [m, p] of [["GET", "/api/runs"], ["POST", "/api/runs"], ["DELETE", "/api/runs"], ["POST", "/api/chat"], ["POST", "/api/chat-stream"], ["POST", "/api/runs/x/actions"], ["POST", "/api/runs/x/corrections"], ["GET", "/api/runs/x/preview"], ["GET", "/"]] as const) {
      const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    const wrong = await fetch(`${base}/api/runs`, { headers: { Authorization: `Basic ${Buffer.from("x:wrong-key").toString("base64")}` } });
    assert.equal(wrong.status, 401);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { status: "ok" }, "unauthenticated health reveals nothing else");
    assert.equal((await fetch(`${base}/api/health`, { headers: auth })).status, 200);

    // Thresholds sent by the browser are ignored: 20% tolerance would hide a PO overrun.
    const inv = invoice({ lineItems: [{ description: "Hex bolt M8x40 (box of 100)", quantity: 25, unitPrice: 42, total: 1050 }], subtotal: 1050, tax: 0, shipping: 0, total: 1050 });
    const body = { createdAt: Date.now(), durationMs: 1, fileName: "a.pdf", fileHash: "h1", pageCount: 1, extractionMethod: "t", invoice: inv, rules: { autoApproveLimit: 1, amountTolerancePct: 5, arithmeticToleranceAbs: 9999 }, findings: [], decision: {}, explanation: { summary: "", vendorEmail: null, generatedBy: "template" }, stages: [], model: "t", status: "approved", audit: [] };
    const created = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const run = (await created.json()) as { rules: { autoApproveLimit: number; amountTolerancePct: number }; id: string };
    assert.equal(run.rules.autoApproveLimit, 25000);
    assert.equal(run.rules.amountTolerancePct, 0.02);

    // Reset is off in production unless ENABLE_RESET=true.
    const del = await fetch(`${base}/api/runs`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 403);
    assert.equal(((await (await fetch(`${base}/api/runs`, { headers: auth })).json()) as unknown[]).length, 1);

    // Oversized and malformed bodies are rejected, not crashed on.
    assert.equal((await fetch(`${base}/api/runs`, { method: "POST", headers: auth, body: "{nope" })).status, 400);

    // Data lands in DATA_DIR and survives a restart (same directory = mounted volume).
    assert.ok(existsSync(join(dir, "runs.json")));
    s.child.kill();
    await new Promise((r) => s.child.on("exit", r));
    s = start(env, port);
    await s.ready;
    const after = (await (await fetch(`${base}/api/runs`, { headers: auth })).json()) as { id: string }[];
    assert.equal(after.length, 1);
    assert.equal(after[0].id, run.id);
    assert.equal(JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"))[0].id, run.id);
  } finally {
    s.child.kill();
  }
});

test("reset works when explicitly enabled, and the server binds the supplied PORT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zamp-deploy-"));
  const s = start({ NODE_ENV: "production", DEMO_ACCESS_KEY: KEY, ENABLE_RESET: "true", DATA_DIR: dir }, 39103);
  await s.ready;
  try {
    assert.match(s.output(), /:39103/);
    const del = await fetch("http://127.0.0.1:39103/api/runs", { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
  } finally {
    s.child.kill();
  }
});
