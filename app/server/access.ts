// Server-enforced demo access. The key lives only in the server environment
// (DEMO_ACCESS_KEY) and is checked with HTTP Basic auth, so the browser shows
// its own sign-in prompt and the secret is never part of the frontend bundle.
// Any username works; the password is the key.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const digest = (s: string) => createHash("sha256").update(s).digest();

export const isProduction = (): boolean => process.env.NODE_ENV === "production";
const accessKey = (): string => (process.env.DEMO_ACCESS_KEY ?? "").trim();

// Returns a message when the deployment is unsafe to start, otherwise null.
export function accessConfigError(): string | null {
  const key = accessKey();
  if (key) return key.length < 12 ? "DEMO_ACCESS_KEY must be at least 12 characters." : null;
  if (isProduction() && process.env.ALLOW_OPEN_ACCESS !== "true") {
    return "DEMO_ACCESS_KEY is not set. In production every route (invoice history, reviewer actions, model calls) would be public. Set DEMO_ACCESS_KEY, or set ALLOW_OPEN_ACCESS=true to knowingly run without a key.";
  }
  return null;
}

export function accessEnabled(): boolean {
  return accessKey() !== "";
}

export function isAuthorised(req: IncomingMessage): boolean {
  const key = accessKey();
  if (!key) return true; // local development, or explicitly open
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(digest(password), digest(key));
}

export function challenge(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="Invoice Decision Desk", charset="UTF-8"');
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Access key required" }));
}

// "Reset demo data" deletes every case and audit trail. Allowed locally; in
// production only when ENABLE_RESET=true is set deliberately.
export function resetEnabled(): boolean {
  return !isProduction() || process.env.ENABLE_RESET === "true";
}
