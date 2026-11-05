// Server-side LLM proxy. Keys live only in the server environment; the
// browser posts to /api/chat and /api/chat-stream.
//
// Provider is chosen from whichever key is set (first match wins):
//   GEMINI_API_KEY     → Google Gemini (free tier available), OpenAI-compatible endpoint
//   OPENAI_API_KEY     → OpenAI
//   OPENROUTER_API_KEY → OpenRouter (any model)
// LLM_MODEL overrides the default model for the chosen provider.

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ProxyAgent, fetch as undiciFetch } from "undici";

interface Provider {
  name: "gemini" | "openai" | "openrouter";
  url: string;
  key: string;
  model: string;
  // Tried in order when the primary model is overloaded or retired.
  fallbacks: string[];
}

// LLM_MODEL may be a comma-separated list: primary first, then fallbacks.
function models(defaults: string[]): { model: string; fallbacks: string[] } {
  const list = (process.env.LLM_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const all = list.length ? list : defaults;
  return { model: all[0], fallbacks: all.slice(1) };
}

const KEY_VARS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

// Local dev convenience: pick up keys from app/.env, re-checked until one is
// found so adding the file doesn't need a server restart.
function loadDotEnv(): void {
  if (KEY_VARS.some((k) => process.env[k]?.trim())) return;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(".env", "utf8")) as Record<string, string>;
  } catch {
    return; // no .env file; rely on real environment variables
  }
  // Unlike process.loadEnvFile, overwrite empty values left by an earlier read.
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]?.trim()) process.env[k] = v.trim();
  }
}

export function resolveProvider(): Provider | null {
  loadDotEnv();
  const env = process.env;
  const gemini = env.GEMINI_API_KEY?.trim();
  const openai = env.OPENAI_API_KEY?.trim();
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  if (gemini) {
    return {
      name: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: gemini,
      ...models(["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"]),
    };
  }
  if (openai) {
    return { name: "openai", url: "https://api.openai.com/v1/chat/completions", key: openai, ...models(["gpt-4.1-mini"]) };
  }
  if (openrouter) {
    return { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: openrouter, ...models(["google/gemini-3.5-flash"]) };
  }
  return null;
}

function buildFetch(): typeof fetch {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    const agent = new ProxyAgent(proxyUrl);
    return ((input: string | URL, init?: RequestInit) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undiciFetch(input, { ...(init as any), dispatcher: agent })) as unknown as typeof fetch;
  }
  return fetch;
}

const NO_KEY = "No LLM key configured. Set GEMINI_API_KEY (free at aistudio.google.com/apikey), OPENAI_API_KEY or OPENROUTER_API_KEY and restart.";

function upstreamBody(p: Provider, model: string, body: unknown, stream: boolean): Record<string, unknown> {
  const b = body as { messages?: unknown; temperature?: number };
  const out: Record<string, unknown> = { model, messages: b.messages, stream };
  if (typeof b.temperature === "number") out.temperature = b.temperature;
  // Gemini "thinks" by default; keep it light so extraction stays fast.
  if (p.name === "gemini") out.reasoning_effort = process.env.LLM_REASONING_EFFORT || "low";
  return out;
}

// Overloaded (429/5xx) or retired (404) models are worth retrying elsewhere;
// auth and bad-request errors are not.
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callUpstream(body: unknown, stream: boolean): Promise<Response> {
  const p = resolveProvider();
  if (!p) return new Response(JSON.stringify({ error: NO_KEY }), { status: 500, headers: { "Content-Type": "application/json" } });
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` };
  if (p.name === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost";
    headers["X-Title"] = "AP Invoice Decision";
  }
  const doFetch = buildFetch();
  // Primary model gets one quick retry, then each fallback gets one attempt.
  const attempts = [p.model, p.model, ...p.fallbacks];
  let last: Response | null = null;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await sleep(i === 1 ? 800 : 300);
    try {
      const res = await doFetch(p.url, { method: "POST", headers, body: JSON.stringify(upstreamBody(p, attempts[i], body, stream)) });
      if (res.ok || !RETRYABLE.has(res.status)) {
        if (i > 0) console.warn(`[llm] served by ${attempts[i]} after ${i} retr${i > 1 ? "ies" : "y"}`);
        return res;
      }
      console.warn(`[llm] ${attempts[i]} → ${res.status}, trying next`);
      last = res;
    } catch (err) {
      console.warn(`[llm] ${attempts[i]} network error: ${(err as Error).message}`);
    }
  }
  return last ?? new Response(JSON.stringify({ error: "All LLM attempts failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
}

export interface ProxyResult {
  status: number;
  body: string;
  contentType: string;
}

export async function forwardChat(body: unknown): Promise<ProxyResult> {
  const res = await callUpstream(body, false);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: await res.text() };
}

export function forwardChatStream(body: unknown): Promise<Response> {
  return callUpstream(body, true);
}

export function getHealth(): { ok: boolean; reason?: string; provider?: string; model?: string } {
  const p = resolveProvider();
  if (!p) return { ok: false, reason: NO_KEY };
  return { ok: true, provider: p.name, model: p.model };
}
