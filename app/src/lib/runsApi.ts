// Client for the server-side run store (/api/runs). Runs are persisted on the
// server so the dashboard shows the same history in every browser.

import type { RunRecord } from "../types.ts";

export async function fetchRuns(): Promise<RunRecord[]> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`Could not load runs (${res.status})`);
  return (await res.json()) as RunRecord[];
}

export async function saveRun(run: Omit<RunRecord, "id">): Promise<RunRecord> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(run),
  });
  if (!res.ok) throw new Error(`Could not save run (${res.status})`);
  return (await res.json()) as RunRecord;
}

export async function reviewRun(id: string, reviewStatus: "approved" | "rejected", reviewNote: string): Promise<RunRecord> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewStatus, reviewNote }),
  });
  if (!res.ok) throw new Error(`Could not update run (${res.status})`);
  return (await res.json()) as RunRecord;
}

export async function resetRuns(): Promise<void> {
  const res = await fetch("/api/runs", { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not reset (${res.status})`);
}
