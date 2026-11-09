// All /api/* routes, shared by the Vite dev middleware and the production server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { forwardChat, forwardChatStream, getHealth } from "./proxy.ts";
import { challenge, isAuthorised, resetEnabled } from "./access.ts";
import { actOnRun, addRun, clearRuns, correctRun, listRuns, readPreview } from "./store.ts";

const MAX_BODY = 25 * 1024 * 1024; // page images are the largest legitimate payload

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// Returns false if the URL is not an API route.
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  if (!url.startsWith("/api/")) return false;
  try {
    if (url === "/api/health" && req.method === "GET") {
      // Unauthenticated callers (platform health checks) learn only that the server is up.
      sendJson(res, 200, isAuthorised(req) ? getHealth() : { status: "ok" });
      return true;
    }
    if (!isAuthorised(req)) {
      challenge(res);
      return true;
    }
    if (url === "/api/chat" && req.method === "POST") {
      const result = await forwardChat(await readJson(req));
      res.statusCode = result.status;
      res.setHeader("Content-Type", result.contentType);
      res.end(result.body);
    } else if (url === "/api/chat-stream" && req.method === "POST") {
      const upstream = await forwardChatStream(await readJson(req));
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      if (!upstream.body) {
        res.end();
      } else {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      }
    } else if (url === "/api/runs" && req.method === "GET") {
      sendJson(res, 200, await listRuns());
    } else if (url === "/api/runs" && req.method === "POST") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendJson(res, 201, await addRun((await readJson(req)) as any));
    } else if (url === "/api/runs" && req.method === "DELETE") {
      if (!resetEnabled()) sendJson(res, 403, { error: "Reset is disabled on this deployment (set ENABLE_RESET=true to allow it)." });
      else {
        await clearRuns();
        sendJson(res, 200, { ok: true });
      }
    } else if (/^\/api\/runs\/[^/]+\/preview$/.test(url) && req.method === "GET") {
      const doc = await readPreview(decodeURIComponent(url.split("/")[3]));
      if (!doc) sendJson(res, 404, { error: "no preview" });
      else {
        res.statusCode = 200;
        res.setHeader("Content-Type", doc.mime);
        res.setHeader("Cache-Control", "private, max-age=3600");
        res.end(doc.data);
      }
    } else if (/^\/api\/runs\/[^/]+\/corrections$/.test(url) && req.method === "POST") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await correctRun(decodeURIComponent(url.split("/")[3]), (await readJson(req)) as any);
      sendJson(res, result.status, result.body);
    } else if (/^\/api\/runs\/[^/]+\/actions$/.test(url) && req.method === "POST") {
      const id = decodeURIComponent(url.split("/")[3]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await actOnRun(id, (await readJson(req)) as any);
      sendJson(res, result.status, result.body);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
    else res.end();
  }
  return true;
}
