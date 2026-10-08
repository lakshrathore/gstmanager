import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { Auth } from '../auth';
import { HttpError } from '../http';
import { audit } from '../gst/gst-audit';
import { fyChoices } from '../gst/annual/common';
import { loadCompany } from '../gst/gstr1';
import { AssistantChat, DocRecord, oid } from '../models';
import { aiConfigured, aiNotSetUp, aiProvider, type AiProvider } from '../ai-provider';
import { aiStatus, assertAiAllowed, recordAiUsage, type Tokens } from '../ai-usage';
import { GroqError, groqChat, groqUsage, type GroqMessage } from '../groq';
import { resultText, runTool, toolLabel, TOOLS } from './tools';

/**
 * Ask-the-documents assistant: questions in Hindi, Hinglish or English about one client, answered by
 * Claude or Groq from tool results only (the client's stored records). The exact message history –
 * for Claude with thinking and tool blocks unchanged – is kept per conversation and replayed on the
 * next question.
 */

const MODEL = process.env.ASSISTANT_MODEL || process.env.DOC_AI_MODEL || 'claude-opus-5-5';
const GROQ_MODEL = process.env.GROQ_ASSISTANT_MODEL || 'openai/gpt-oss-120b';
const EFFORT = (process.env.ASSISTANT_EFFORT as 'low' | 'medium' | 'high' | undefined) || 'medium';
const MAX_STEPS = 8;
const MAX_HISTORY_CHARS = 800_000;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ maxRetries: 2 }));

function system(c: { name: string; gstin: string }) {
  return `You are the assistant of a chartered accountant's firm in India. You answer questions about one client's documents and data: ${c.name}, GSTIN ${c.gstin}.

Answer only from the results of your tools. Every amount, count, name, number or date you state must come from a tool result in this conversation. If the tools do not have it – nothing uploaded for that period, a document type missing – say so plainly and say what to upload. Never estimate, assume or fill in a figure.

Periods: Indian financial years run April to March ("FY 2026-27" = April 2026 to March 2027). A month named without a year is the most recent such month up to today. If a question could mean sales or purchases, or more than one period, take the likely one and say which you used.

Terms: "books" are the client's own registers and invoice documents; GSTR-1, GSTR-2A and GSTR-2B are GST portal data. ITC difference = ITC as per books − ITC as per GSTR-2B. Credit notes reduce totals.

Reply in the language and script the user wrote in (Hindi, Hinglish or English). Lead with the answer, then only the lines that support it. Amounts in Indian format with ₹ (₹1,23,456). Use a small markdown table for more than three items, at most 20 rows, then say how many more there are. End with one short line in italics naming what you looked at and the period, e.g. *(Purchase vs GSTR-2B, September 2026)*.

You can only read data. You cannot change, approve, upload or file anything – say where in the app to do it (Client documents → Review, Reports or Purchase vs GSTR-2B).`;
}

export interface Turn { role: 'user' | 'assistant'; text: string; tools?: { name: string; label: string; ok: boolean }[]; at: Date; error?: boolean }

async function chatFor(auth: Auth, id: string, withMessages = false) {
  const q = AssistantChat.findOne({ _id: oid(id), orgId: oid(auth.orgId), userId: oid(auth.userId) });
  const c = await (withMessages ? q.select('+messages') : q).lean();
  if (!c) throw new HttpError(404, 'Conversation not found');
  await loadCompany(auth, String(c.companyId)); // still allowed to see this client
  return c;
}

export async function listChats(auth: Auth, companyId: string) {
  const company = await loadCompany(auth, companyId);
  const chats = await AssistantChat.find({ orgId: oid(auth.orgId), userId: oid(auth.userId), companyId: company._id }).select({ title: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(50).lean();
  const st = await aiStatus(auth.orgId, aiConfigured());
  return { chats: chats.map((c) => ({ _id: String(c._id), title: c.title, updatedAt: c.updatedAt })), ai: st.allowed, aiReason: st.reason };
}

export async function getChat(auth: Auth, id: string) {
  const c = await chatFor(auth, id);
  return { _id: String(c._id), companyId: String(c.companyId), title: c.title, turns: c.turns, usage: c.usage };
}

export async function deleteChat(auth: Auth, id: string) {
  const c = await chatFor(auth, id);
  await AssistantChat.deleteOne({ _id: c._id });
  return { ok: true };
}

/** What the model should know that changes from question to question (sent with the question, never in the cached system prompt). */
async function context(auth: Auth, companyId: unknown) {
  const months = await DocRecord.distinct('fp', { orgId: oid(auth.orgId), companyId, review: { $ne: 'rejected' } });
  const list = (months as (string | null)[]).filter(Boolean).sort((a, b) => (a!.slice(2) + a!.slice(0, 2)).localeCompare(b!.slice(2) + b!.slice(0, 2))) as string[];
  const today = new Date();
  return `[Today ${today.toISOString().slice(0, 10)}; current FY ${fyChoices(today)[0]}; months with data for this client: ${list.length ? list.map((m) => `${m.slice(0, 2)}/${m.slice(2)}`).join(', ') : 'none yet'}]`;
}

type Exec = (name: string, args: Record<string, unknown>) => Promise<{ text: string; ok: boolean }>;
type Meter = (model: string, t: Tokens) => Promise<void>;
type Loop = { answer: string; messages: unknown[] };

/** Earlier answered questions as plain text – for a conversation held with the other AI service. */
function historyFromTurns(turns: Turn[], provider: AiProvider): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i + 1 < turns.length; i += 2) {
    const [q, a] = [turns[i], turns[i + 1]];
    if (q.role !== 'user' || a.role !== 'assistant' || a.error) continue;
    if (provider === 'groq') out.push({ role: 'user', content: q.text }, { role: 'assistant', content: a.text });
    else out.push({ role: 'user', content: [{ type: 'text', text: q.text }] }, { role: 'assistant', content: [{ type: 'text', text: a.text }] });
  }
  return out;
}

async function askClaude(sys: string, history: unknown[], question: string, exec: Exec, meter: Meter): Promise<Loop> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [...(history as Anthropic.Beta.BetaMessageParam[]), { role: 'user', content: [{ type: 'text', text: question }] }];
  for (let step = 0; ; step++) {
    const last = step >= MAX_STEPS;
    const res = await anthropic().beta.messages.create({
      model: MODEL, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: [{ type: 'text', text: sys }],
      tools: TOOLS,
      // At the step limit the model must answer with what it has.
      ...(last ? { tool_choice: { type: 'none' as const } } : {}),
      cache_control: { type: 'ephemeral' },
      output_config: { effort: EFFORT },
      messages,
    }, { timeout: 5 * 60_000 });
    await meter(res.model ?? MODEL, {
      inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    });
    // Appended exactly as returned – thinking blocks must be replayed unchanged.
    messages.push({ role: 'assistant', content: res.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

    if (res.stop_reason === 'refusal') return { answer: 'I can’t help with that request.', messages };
    if (res.stop_reason === 'tool_use') {
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      const results = await Promise.all(calls.map(async (call) => {
        const r = await exec(call.name, (call.input ?? {}) as Record<string, unknown>);
        return { type: 'tool_result' as const, tool_use_id: call.id, content: r.text, ...(r.ok ? {} : { is_error: true }) };
      }));
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (res.stop_reason === 'pause_turn') continue;
    let answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (res.stop_reason === 'max_tokens') answer += '\n\n_(The answer was cut off – ask for a narrower period or fewer rows.)_';
    return { answer, messages };
  }
}

const GROQ_TOOLS = TOOLS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

async function askGroq(sys: string, history: unknown[], question: string, exec: Exec, meter: Meter): Promise<Loop> {
  const messages: GroqMessage[] = [...(history as GroqMessage[]), { role: 'user', content: question }];
  for (let step = 0; ; step++) {
    const last = step >= MAX_STEPS;
    const res = await groqChat({
      model: GROQ_MODEL, max_completion_tokens: 16000,
      messages: [{ role: 'system', content: sys }, ...messages],
      tools: GROQ_TOOLS,
      // At the step limit the model must answer with what it has.
      tool_choice: last ? 'none' : 'auto',
      ...(GROQ_MODEL.includes('gpt-oss') ? { reasoning_effort: EFFORT } : {}),
    });
    await meter(res.model || GROQ_MODEL, groqUsage(res));
    const choice = res.choices[0];
    const calls = last ? [] : choice?.message.tool_calls ?? [];
    // Only what the next request needs – the model's reasoning text is not sent back.
    messages.push({ role: 'assistant', content: choice?.message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length) {
      for (const call of calls) {
        let args: Record<string, unknown> | null = null;
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported below */ }
        const r = args ? await exec(call.function.name, args) : { text: 'Error: the tool arguments were not valid JSON.', ok: false };
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.text });
      }
      continue;
    }
    let answer = (choice?.message.content ?? '').trim();
    if (choice?.finish_reason === 'length') answer += '\n\n_(The answer was cut off – ask for a narrower period or fewer rows.)_';
    return { answer, messages };
  }
}

function errorText(e: unknown) {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'The Claude API key is not valid (check ANTHROPIC_API_KEY).';
  if (e instanceof Anthropic.RateLimitError) return 'The Claude API is busy (rate limit) – ask again in a minute.';
  if (e instanceof Anthropic.APIError) return `The Claude API returned an error (${e.status ?? ''}): ${e.message}`;
  if (e instanceof GroqError) {
    if (e.status === 401 || e.status === 403) return 'The Groq API key is not valid (check GROQ_API_KEY).';
    if (e.status === 429) return 'The Groq API is busy (rate limit) – ask again in a minute.';
    return `The Groq API returned an error (${e.status || ''}): ${e.message}`;
  }
  return 'Something went wrong while answering.';
}

export async function ask(auth: Auth, input: { chatId?: string; companyId: string; message: string }) {
  if (!aiConfigured()) throw new HttpError(409, `The assistant needs AI. ${aiNotSetUp()}`);
  await assertAiAllowed(auth.orgId);
  const text = input.message.trim();
  if (!text) throw new HttpError(400, 'Type a question');
  const company = await loadCompany(auth, input.companyId);
  const chat = input.chatId
    ? await chatFor(auth, input.chatId, true)
    : (await AssistantChat.create({ orgId: oid(auth.orgId), userId: oid(auth.userId), companyId: company._id, title: text.slice(0, 80), messages: [], turns: [] })).toObject();
  if (String(chat.companyId) !== String(company._id)) throw new HttpError(409, 'This conversation is about another client – start a new one.');

  const provider = aiProvider();
  const stored = (chat as { messages?: unknown[] }).messages ?? [];
  const history = ((chat as { provider?: string }).provider ?? 'claude') === provider ? stored : historyFromTurns((chat.turns ?? []) as Turn[], provider);
  if (JSON.stringify(history).length > MAX_HISTORY_CHARS) throw new HttpError(409, 'This conversation is very long – start a new one.');
  const question = `${await context(auth, company._id)}\n\n${text}`;
  const used: { name: string; label: string; ok: boolean }[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  const exec: Exec = async (name, args) => {
    try {
      const out = await runTool(auth, String(company._id), name, args);
      used.push({ name, label: toolLabel(name, args), ok: true });
      return { text: resultText(out), ok: true };
    } catch (e) {
      used.push({ name, label: toolLabel(name, args), ok: false });
      return { text: `Error: ${(e as Error).message}`, ok: false };
    }
  };
  const meter: Meter = async (model, t) => {
    await recordAiUsage(oid(auth.orgId), 'assistant', model, t, String(chat._id), auth.email);
    usage.inputTokens += t.inputTokens + (t.cacheWriteTokens ?? 0);
    usage.cacheReadTokens += t.cacheReadTokens ?? 0;
    usage.outputTokens += t.outputTokens;
  };

  let answer = '';
  let messages: unknown[] = [];
  let failed = false;
  try {
    ({ answer, messages } = await (provider === 'groq' ? askGroq : askClaude)(system(company), history, question, exec, meter));
  } catch (e) {
    failed = true;
    answer = errorText(e);
    if (!(e instanceof Anthropic.APIError) && !(e instanceof GroqError) && !(e instanceof HttpError)) console.error('[assistant]', e);
  }

  const now = new Date();
  const turns: Turn[] = [{ role: 'user', text, at: now }, { role: 'assistant', text: answer || '(no answer)', tools: used, at: new Date(), ...(failed ? { error: true } : {}) }];
  await AssistantChat.updateOne({ _id: chat._id }, {
    // A failed turn leaves the model history as it was, so the conversation can continue.
    ...(failed ? {} : { $set: { messages, provider } }),
    $push: { turns: { $each: turns } },
    $inc: { 'usage.inputTokens': usage.inputTokens, 'usage.outputTokens': usage.outputTokens, 'usage.cacheReadTokens': usage.cacheReadTokens },
  });
  await audit(auth, 'assistant.ask', 'AssistantChat', String(chat._id), { companyId: String(company._id), provider, tools: used.map((u) => u.name), failed, ...usage });
  return { chatId: String(chat._id), turn: turns[1] };
}
