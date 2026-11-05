// Browser-side client for LLM calls. The API key never reaches the browser:
// we post to /api/chat and /api/chat-stream, and the server picks the
// provider (Gemini / OpenAI / OpenRouter) and model from its environment.

export type MessageContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
}

export interface HealthResult {
  ok: boolean;
  reason?: string;
  provider?: string;
  model?: string;
}

export async function checkHealth(): Promise<HealthResult> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    return (await res.json()) as HealthResult;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function chat(opts: ChatOptions): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: opts.messages, temperature: opts.temperature ?? 0 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Yields content deltas from the SSE stream relayed by the server.
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string, void, void> {
  const res = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: opts.messages, temperature: opts.temperature ?? 0.2 }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`LLM stream ${res.status}: ${res.body ? (await res.text()).slice(0, 300) : "(no body)"}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // keep-alive or partial frame
      }
    }
  }
}

// Pull the first JSON object out of a model reply that may include fences or prose.
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return text;
}
