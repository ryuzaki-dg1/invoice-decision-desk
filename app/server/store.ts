// File-backed run store. One JSON file is enough for a single-team demo and
// survives server restarts; swap for Postgres when there is more than one writer.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../src/types.ts";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const FILE = join(DATA_DIR, "runs.json");

let cache: RunRecord[] | null = null;

async function load(): Promise<RunRecord[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf8")) as RunRecord[];
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

export async function addRun(input: Omit<RunRecord, "id">): Promise<RunRecord> {
  const runs = await load();
  const run: RunRecord = { ...input, id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` };
  await persist([run, ...runs]);
  return run;
}

export async function reviewRun(id: string, reviewStatus: "approved" | "rejected", reviewNote: string): Promise<RunRecord | null> {
  const runs = await load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const updated: RunRecord = { ...runs[idx], reviewStatus, reviewNote, reviewedAt: Date.now() };
  const next = [...runs];
  next[idx] = updated;
  await persist(next);
  return updated;
}

export async function clearRuns(): Promise<void> {
  await persist([]);
}
