import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { Auth } from '../auth';
import { HttpError } from '../http';
import { audit } from '../gst/gst-audit';
import { fyChoices } from '../gst/annual/common';
import { loadCompany } from '../gst/gstr1';
import { AssistantChat, DocRecord, oid } from '../models';
import { aiConfigured } from '../docs/ai';
import { aiStatus, assertAiAllowed, recordAiUsage } from '../ai-usage';
import { resultText, runTool, toolLabel, TOOLS } from './tools';

/**
 * Ask-the-documents assistant: questions in Hindi, Hinglish or English about one client, answered by
 * Claude from tool results only (the client's stored records). The exact message history – thinking
 * and tool blocks unchanged – is kept per conversation and replayed on the next question.
 */

const MODEL = process.env.ASSISTANT_MODEL || process.env.DOC_AI_MODEL || 'claude-opus-5-5';
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

export async function ask(auth: Auth, input: { chatId?: string; companyId: string; message: string }) {
  if (!aiConfigured()) throw new HttpError(409, 'The assistant needs the Claude API: set ANTHROPIC_API_KEY in .env.local and restart.');
  await assertAiAllowed(auth.orgId);
  const text = input.message.trim();
  if (!text) throw new HttpError(400, 'Type a question');
  const company = await loadCompany(auth, input.companyId);
  const chat = input.chatId
    ? await chatFor(auth, input.chatId, true)
    : (await AssistantChat.create({ orgId: oid(auth.orgId), userId: oid(auth.userId), companyId: company._id, title: text.slice(0, 80), messages: [], turns: [] })).toObject();
  if (String(chat.companyId) !== String(company._id)) throw new HttpError(409, 'This conversation is about another client – start a new one.');

  const history = ((chat as { messages?: Anthropic.Beta.BetaMessageParam[] }).messages ?? []) as Anthropic.Beta.BetaMessageParam[];
  if (JSON.stringify(history).length > MAX_HISTORY_CHARS) throw new HttpError(409, 'This conversation is very long – start a new one.');
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: [{ type: 'text', text: `${await context(auth, company._id)}\n\n${text}` }] }];
  const used: { name: string; label: string; ok: boolean }[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let answer = '';
  let failed = false;

  try {
    for (let step = 0; ; step++) {
      const last = step >= MAX_STEPS;
      const res = await anthropic().beta.messages.create({
        model: MODEL, max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        system: [{ type: 'text', text: system(company) }],
        tools: TOOLS,
        // At the step limit the model must answer with what it has.
        ...(last ? { tool_choice: { type: 'none' as const } } : {}),
        cache_control: { type: 'ephemeral' },
        output_config: { effort: EFFORT },
        messages,
      }, { timeout: 5 * 60_000 });
      await recordAiUsage(oid(auth.orgId), 'assistant', res.model ?? MODEL, {
        inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      }, String(chat._id), auth.email);
      usage.inputTokens += res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0);
      usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
      usage.outputTokens += res.usage.output_tokens;
      // Appended exactly as returned – thinking blocks must be replayed unchanged.
      messages.push({ role: 'assistant', content: res.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

      if (res.stop_reason === 'refusal') { answer = 'I can’t help with that request.'; break; }
      if (res.stop_reason === 'tool_use') {
        const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        const results = await Promise.all(calls.map(async (call) => {
          const args = (call.input ?? {}) as Record<string, unknown>;
          try {
            const out = await runTool(auth, String(company._id), call.name, args);
            used.push({ name: call.name, label: toolLabel(call.name, args), ok: true });
            return { type: 'tool_result' as const, tool_use_id: call.id, content: resultText(out) };
          } catch (e) {
            used.push({ name: call.name, label: toolLabel(call.name, args), ok: false });
            return { type: 'tool_result' as const, tool_use_id: call.id, content: `Error: ${(e as Error).message}`, is_error: true };
          }
        }));
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (res.stop_reason === 'pause_turn') continue;
      answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (res.stop_reason === 'max_tokens') answer += '\n\n_(The answer was cut off – ask for a narrower period or fewer rows.)_';
      break;
    }
  } catch (e) {
    failed = true;
    answer = e instanceof Anthropic.AuthenticationError ? 'The Claude API key is not valid (check ANTHROPIC_API_KEY).'
      : e instanceof Anthropic.RateLimitError ? 'The Claude API is busy (rate limit) – ask again in a minute.'
        : e instanceof Anthropic.APIError ? `The Claude API returned an error (${e.status ?? ''}): ${e.message}`
          : e instanceof HttpError ? e.message : 'Something went wrong while answering.';
    if (!(e instanceof Anthropic.APIError) && !(e instanceof HttpError)) console.error('[assistant]', e);
  }

  const now = new Date();
  const turns: Turn[] = [{ role: 'user', text, at: now }, { role: 'assistant', text: answer || '(no answer)', tools: used, at: new Date(), ...(failed ? { error: true } : {}) }];
  await AssistantChat.updateOne({ _id: chat._id }, {
    // A failed turn leaves the model history as it was, so the conversation can continue.
    ...(failed ? {} : { $set: { messages } }),
    $push: { turns: { $each: turns } },
    $inc: { 'usage.inputTokens': usage.inputTokens, 'usage.outputTokens': usage.outputTokens, 'usage.cacheReadTokens': usage.cacheReadTokens },
  });
  await audit(auth, 'assistant.ask', 'AssistantChat', String(chat._id), { companyId: String(company._id), tools: used.map((u) => u.name), failed, ...usage });
  return { chatId: String(chat._id), turn: turns[1] };
}
