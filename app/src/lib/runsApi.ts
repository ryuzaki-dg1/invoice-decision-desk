// Client for the server-side run store (/api/runs). Runs are persisted on the
// server so every browser sees the same history and review state.

import type { RunRecord } from "../types.ts";
import type { ReviewRequest } from "./review.ts";
import type { CorrectionRequest } from "./revalidate.ts";

export async function fetchRuns(): Promise<RunRecord[]> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`Could not load runs (${res.status})`);
  return (await res.json()) as RunRecord[];
}

// Retries once: the decision has already been computed, so a network blip
// must not lose it.
export async function saveRun(run: Omit<RunRecord, "id">, previewImage?: string): Promise<RunRecord> {
  const body = JSON.stringify({ ...run, previewImage });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) throw new Error(`Could not save run (${res.status})`);
      return (await res.json()) as RunRecord;
    } catch (err) {
      if (attempt >= 3) throw new Error(`Decision computed but not saved: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

export async function submitReview(id: string, req: ReviewRequest): Promise<RunRecord> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Action failed (${res.status})`);
  return body as RunRecord;
}

export async function submitCorrection(id: string, req: CorrectionRequest): Promise<RunRecord> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}/corrections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Correction failed (${res.status})`);
  return body as RunRecord;
}

export async function resetRuns(): Promise<void> {
  const res = await fetch("/api/runs", { method: "DELETE" });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not reset (${res.status})`);
}
