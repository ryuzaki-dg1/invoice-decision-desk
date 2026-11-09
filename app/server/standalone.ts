// Production server: serves the Vite build (dist/) and the /api/* routes.
// Usage: node --experimental-strip-types server/standalone.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { handleApi } from "./api.ts";
import { accessConfigError, accessEnabled, challenge, isAuthorised } from "./access.ts";
import { getHealth } from "./proxy.ts";

// The platform supplies PORT (and optionally HOST). Without HOST, Node listens on all interfaces.
const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
const HOST = process.env.HOST?.trim() || undefined;
const DIST = join(import.meta.dirname, "..", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(DIST, pathname);
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
    if (pathname.startsWith("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(await readFile(filePath));
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // The app shell is gated too; only the minimal health probe is public.
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/api/health" && !isAuthorised(req)) return challenge(res);
    if (await handleApi(req, res)) return;
    if (await serveStatic(req, res)) return;
    // SPA fallback
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await readFile(join(DIST, "index.html")));
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  }
});

const configError = accessConfigError();
if (configError) {
  console.error(`Refusing to start: ${configError}`);
  process.exit(1);
}

const onListening = () => {
  const h = getHealth();
  console.log(`AP invoice decision server on ${HOST ?? "0.0.0.0/::"}:${PORT}`);
  console.log(`  Access: ${accessEnabled() ? "protected by DEMO_ACCESS_KEY" : "OPEN (no DEMO_ACCESS_KEY set)"}`);
  console.log(`  LLM: ${h.ok ? `${h.provider} / ${h.model}` : h.reason}`);
};
if (HOST) server.listen(PORT, HOST, onListening);
else server.listen(PORT, onListening);
