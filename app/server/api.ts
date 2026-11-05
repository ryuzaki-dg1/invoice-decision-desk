// All /api/* routes, shared by the Vite dev middleware and the production server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { forwardChat, forwardChatStream, getHealth } from "./proxy.ts";
import { actOnRun, addRun, clearRuns, correctRun, listRuns, readPreview } from "./store.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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
      sendJson(res, 200, getHealth());
    } else if (url === "/api/chat" && req.method === "POST") {
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
      await clearRuns();
      sendJson(res, 200, { ok: true });
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
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    else res.end();
  }
  return true;
}
