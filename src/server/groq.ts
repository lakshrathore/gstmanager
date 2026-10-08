import 'server-only';

/**
 * Minimal client for Groq's OpenAI-compatible chat completions API (no SDK needed). Retries rate
 * limits and server errors a few times, honouring retry-after.
 */

const BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');

export class GroqError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface GroqToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type GroqContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
export type GroqMessage =
  | { role: 'system' | 'user'; content: GroqContent }
  | { role: 'assistant'; content: string | null; tool_calls?: GroqToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface GroqResponse {
  model: string;
  choices: { finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string; message: { content: string | null; tool_calls?: GroqToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function groqChat(body: Record<string, unknown>, { timeout = 5 * 60_000, retries = 3 } = {}): Promise<GroqResponse> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROQ_API_KEY ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (attempt < retries) { await wait(1000 * 2 ** attempt); continue; }
      throw new GroqError(0, `Could not reach the Groq API: ${(e as Error).message}`);
    }
    if (res.ok) return (await res.json()) as GroqResponse;
    const text = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await wait(Math.min(60_000, after > 0 ? after * 1000 : 1000 * 2 ** attempt));
      continue;
    }
    let message = text.slice(0, 500);
    try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
    throw new GroqError(res.status, message || res.statusText);
  }
}

/** Token counts in the shape the AI allowance records. */
export function groqUsage(r: GroqResponse) {
  const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: (r.usage?.prompt_tokens ?? 0) - cached, outputTokens: r.usage?.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** A zod-made JSON schema made acceptable to strict structured outputs: no $schema, every object closed. */
export function strictSchema(schema: unknown): Record<string, unknown> {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== 'object') return s;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== '$schema') o[k] = walk(v);
    if (o.type === 'object' && o.properties) { o.additionalProperties = false; o.required = Object.keys(o.properties as object); }
    return o;
  };
  return walk(schema) as Record<string, unknown>;
}
