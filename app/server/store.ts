// File-backed run store. One JSON file is enough for a single-team demo and
// survives server restarts; swap for Postgres when there is more than one writer.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../src/types.ts";
import { applyReviewAction, type ReviewRequest } from "../src/lib/review.ts";
import { applyCorrections, evaluate, refreshStale, type CorrectionRequest } from "../src/lib/revalidate.ts";
import { initialStatus, templateExplanation } from "../src/lib/engine.ts";
import { DEFAULT_RULES } from "../src/lib/policy.ts";
import type { AuditEvent } from "../src/types.ts";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const FILE = join(DATA_DIR, "runs.json");
const DOCS_DIR = join(DATA_DIR, "docs");

let cache: RunRecord[] | null = null;

// Every write reads, decides and persists. Run them one at a time so two
// uploads (or a retry) can never both pass the duplicate / PO checks against
// the same stale snapshot, or overwrite each other's record.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<RunRecord[]> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as RunRecord[];
    // Drop records written by older versions of the app (no workflow status).
    cache = raw.filter((r) => r && r.status && Array.isArray(r.audit));
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(runs: RunRecord[]): Promise<void> {
  cache = runs;
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(runs, null, 1));
  await rename(tmp, FILE);
}

export async function listRuns(): Promise<RunRecord[]> {
  return load();
}

// The first page image is stored next to the run file so the invoice detail
// view can show the original document beside the evidence.
export function addRun(input: Omit<RunRecord, "id"> & { previewImage?: string }): Promise<RunRecord> {
  return serial(async () => {
    const runs = await load();
    const { previewImage, ...rest } = input;
    if (!rest || !rest.invoice || typeof rest.invoice !== "object" || !Array.isArray(rest.invoice.lineItems)) throw new Error("A run needs an extracted invoice.");
    const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let hasPreview = false;
    const m = previewImage?.match(/^data:image\/(jpeg|png|webp|gif);base64,(.+)$/);
    if (m) {
      await mkdir(DOCS_DIR, { recursive: true });
      await writeFile(join(DOCS_DIR, `${id}.${m[1]}`), Buffer.from(m[2], "base64"));
      hasPreview = true;
    }
    // The browser sends the outcome it computed. The server does not trust it:
    // it re-runs every deterministic check (vendor, bank, PO, cumulative
    // billing, duplicates) against the current store at the moment of saving,
    // so a stale tab, a retry or a crafted request cannot create an approved
    // or duplicate payable. Extraction and explanation text are kept as sent.
    const now = Date.now();
    // Thresholds are server-controlled. Anything the browser sends in `rules` is ignored.
    const rules = { ...DEFAULT_RULES };
    const ev = evaluate(rest.invoice, rules, { id, fileHash: rest.fileHash }, runs, now, { includeSameFile: true });
    const status = initialStatus(ev.decision.resolution);
    const explanation = status === rest.status && rest.explanation ? rest.explanation : templateExplanation(rest.invoice, ev.pm.poMatch, ev.findings, ev.decision);
    const system: AuditEvent = { at: now, actor: "System", kind: "system", action: `Automated decision: ${ev.decision.headline}`, toStatus: status, note: ev.decision.decidingCodes.join(", ") || "All checks passed" };
    const run: RunRecord = {
      ...rest,
      id,
      hasPreview,
      vendorId: ev.v.vendor?.id ?? null,
      vendorMatched: ev.v.vendor?.name ?? null,
      poMatch: ev.pm.poMatch,
      findings: ev.findings,
      decision: ev.decision,
      explanation,
      status,
      resolvedCodes: [],
      repeatSubmission: ev.dup.repeat,
      duplicateOf: ev.dup.duplicateOf,
      rules,
      audit: [system],
    };
    await persist([run, ...runs]);
    return run;
  });
}

export async function readPreview(id: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!/^run-[a-z0-9-]+$/.test(id)) return null;
  for (const ext of ["jpeg", "png", "webp", "gif"]) {
    try {
      return { data: await readFile(join(DOCS_DIR, `${id}.${ext}`)), mime: `image/${ext}` };
    } catch {
      // try next extension
    }
  }
  return null;
}

// Re-evaluation always uses the server's thresholds, never a snapshot a browser
// once supplied (older records may carry one).
const serverRules = (r: RunRecord): RunRecord => ({ ...r, rules: { ...DEFAULT_RULES } });

export function actOnRun(id: string, req: ReviewRequest): Promise<{ status: number; body: unknown }> {
  return serial(() => actOnRunNow(id, req));
}
async function actOnRunNow(id: string, req: ReviewRequest): Promise<{ status: number; body: unknown }> {
  const runs = await load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return { status: 404, body: { error: "run not found" } };
  if (req.action === "approve" && runs[idx].status !== "approved" && runs[idx].status !== "rejected") {
    // Re-check against today's PO position before approval is even attempted.
    const refreshed = refreshStale(serverRules(runs[idx]), runs);
    if (refreshed) {
      const next = [...runs];
      next[idx] = refreshed;
      await persist(next);
      const codes = refreshed.audit[refreshed.audit.length - 1].action;
      return { status: 409, body: { error: `${codes}. It was added to this case as an open finding. Reload the case and resolve it before approving.`, run: refreshed } };
    }
  }
  const result = applyReviewAction(runs[idx], req);
  if (!result.ok) return { status: 409, body: { error: result.error } };
  const next = [...runs];
  next[idx] = result.run;
  await persist(next);
  return { status: 200, body: result.run };
}

export function correctRun(id: string, req: CorrectionRequest): Promise<{ status: number; body: unknown }> {
  return serial(() => correctRunNow(id, req));
}
async function correctRunNow(id: string, req: CorrectionRequest): Promise<{ status: number; body: unknown }> {
  const runs = await load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return { status: 404, body: { error: "run not found" } };
  const result = applyCorrections(serverRules(runs[idx]), req, runs);
  if (!result.ok) return { status: 409, body: { error: result.error } };
  const next = [...runs];
  next[idx] = result.run;
  await persist(next);
  return { status: 200, body: result.run };
}

export function clearRuns(): Promise<void> {
  return serial(async () => {
    await persist([]);
    await rm(DOCS_DIR, { recursive: true, force: true });
  });
}
