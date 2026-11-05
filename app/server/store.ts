// File-backed run store. One JSON file is enough for a single-team demo and
// survives server restarts; swap for Postgres when there is more than one writer.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../src/types.ts";
import { applyReviewAction, type ReviewRequest } from "../src/lib/review.ts";
import { applyCorrections, type CorrectionRequest } from "../src/lib/revalidate.ts";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const FILE = join(DATA_DIR, "runs.json");
const DOCS_DIR = join(DATA_DIR, "docs");

let cache: RunRecord[] | null = null;

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
export async function addRun(input: Omit<RunRecord, "id"> & { previewImage?: string }): Promise<RunRecord> {
  const runs = await load();
  const { previewImage, ...rest } = input;
  const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let hasPreview = false;
  const m = previewImage?.match(/^data:image\/(jpeg|png|webp|gif);base64,(.+)$/);
  if (m) {
    await mkdir(DOCS_DIR, { recursive: true });
    await writeFile(join(DOCS_DIR, `${id}.${m[1]}`), Buffer.from(m[2], "base64"));
    hasPreview = true;
  }
  const run: RunRecord = { ...rest, id, hasPreview, resolvedCodes: rest.resolvedCodes ?? [] };
  await persist([run, ...runs]);
  return run;
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

export async function actOnRun(id: string, req: ReviewRequest): Promise<{ status: number; body: unknown }> {
  const runs = await load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return { status: 404, body: { error: "run not found" } };
  const result = applyReviewAction(runs[idx], req);
  if (!result.ok) return { status: 409, body: { error: result.error } };
  const next = [...runs];
  next[idx] = result.run;
  await persist(next);
  return { status: 200, body: result.run };
}

export async function correctRun(id: string, req: CorrectionRequest): Promise<{ status: number; body: unknown }> {
  const runs = await load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return { status: 404, body: { error: "run not found" } };
  const result = applyCorrections(runs[idx], req, runs);
  if (!result.ok) return { status: 409, body: { error: result.error } };
  const next = [...runs];
  next[idx] = result.run;
  await persist(next);
  return { status: 200, body: result.run };
}

export async function clearRuns(): Promise<void> {
  await persist([]);
  await rm(DOCS_DIR, { recursive: true, force: true });
}
