import 'server-only';
import { z } from 'zod';
import { GroqError, groqChat, groqUsage, strictSchema, type GroqContent } from '../groq';
import type { AiInput, ExtractionResult } from './ai';

/**
 * Document reading on Groq. Groq takes no PDFs, so a PDF with a text layer is sent as its text,
 * and a scanned PDF as page images, 3 pages per request (Groq's image limit), with the answers
 * joined. Photos go to the vision model as they are (shrunk if too big). Answers use strict
 * structured outputs against the same schema as Claude's and are checked again here.
 */

export const GROQ_TEXT_MODEL = process.env.GROQ_DOC_MODEL || 'openai/gpt-oss-120b';
export const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const EFFORT = (process.env.DOC_AI_EFFORT as 'low' | 'medium' | 'high' | undefined) || 'medium';
const PAGES_PER_CALL = 3;
const MAX_SCANNED_PAGES = 30;
const MAX_TEXT_CHARS = 250_000;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_IMAGE_SIDE = 2000;

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
type Context = { fileName: string; client?: { name: string; gstin: string } | null; otherClients: { name: string; gstin: string }[] };

export async function extractWithGroq(
  input: AiInput, context: Context, ctx: { system: string; schema: z.ZodType<ExtractionResult>; fail: (m: string) => Error },
): Promise<{ result: ExtractionResult; model: string; usage: Usage }> {
  const clients = context.client ? `This document was uploaded for the client ${context.client.name} (GSTIN ${context.client.gstin}).` : 'The client is not known yet.';
  const others = context.otherClients.length ? ` The firm's clients: ${context.otherClients.slice(0, 50).map((c) => `${c.name} ${c.gstin}`).join('; ')}.` : '';
  const about = `File name: ${context.fileName}. ${clients}${others}`;
  const schema = strictSchema(z.toJSONSchema(ctx.schema));

  const call = async (model: string, content: GroqContent, maxTokens: number) => {
    let res;
    try {
      res = await groqChat({
        model,
        messages: [{ role: 'system', content: ctx.system }, { role: 'user', content }],
        response_format: { type: 'json_schema', json_schema: { name: 'document', strict: true, schema } },
        max_completion_tokens: maxTokens,
        ...(model.includes('gpt-oss') ? { reasoning_effort: EFFORT } : {}),
      }, { timeout: 10 * 60_000 });
    } catch (e) {
      if (!(e instanceof GroqError)) throw e;
      if (e.status === 401 || e.status === 403) throw ctx.fail('The Groq API key is not valid (check GROQ_API_KEY).');
      if (e.status === 429) throw ctx.fail('Groq API rate limit reached – the document will be retried.');
      if (e.status === 400 || e.status === 413) throw ctx.fail(`Groq could not read this file: ${e.message}`);
      throw ctx.fail(`Groq API error ${e.status || ''}: ${e.message}`);
    }
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') throw ctx.fail('The document has too many lines to read in one go – split it into smaller files (for example one month per file).');
    let json: unknown;
    try { json = JSON.parse(choice?.message.content ?? ''); } catch { throw ctx.fail('Groq’s answer could not be read as data.'); }
    const parsed = ctx.schema.safeParse(json);
    if (!parsed.success) throw ctx.fail('Groq’s answer did not have the expected fields.');
    return { result: parsed.data, model: res.model || model, usage: groqUsage(res) };
  };

  if (input.type === 'text') return call(GROQ_TEXT_MODEL, textPrompt(input.text, about, ctx.fail), 32_000);
  if (input.type === 'image') {
    const url = await imageUrl(input.bytes, input.mediaType, ctx.fail);
    return call(GROQ_VISION_MODEL, [{ type: 'image_url', image_url: { url } }, { type: 'text', text: about }], 16_000);
  }

  // PDF: its text layer if it has one, else the pages as images.
  const { extractText, getDocumentProxy, renderPageAsImage } = await import('unpdf');
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(input.bytes)); } catch { throw ctx.fail('This PDF could not be opened (damaged or password-protected).'); }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const chars = text.reduce((a, t) => a + t.replace(/\s/g, '').length, 0);
  if (chars >= 60 * totalPages) {
    const joined = text.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n');
    return call(GROQ_TEXT_MODEL, textPrompt(joined, `${about} This is the text layer of a PDF; the --- Page n --- lines mark its pages.`, ctx.fail), 32_000);
  }
  if (totalPages > MAX_SCANNED_PAGES) throw ctx.fail(`This scanned PDF has ${totalPages} pages – split it into files of up to ${MAX_SCANNED_PAGES} pages and upload again.`);
  const parts: Awaited<ReturnType<typeof call>>[] = [];
  for (let first = 1; first <= totalPages; first += PAGES_PER_CALL) {
    const last = Math.min(totalPages, first + PAGES_PER_CALL - 1);
    const images: GroqContent = [];
    for (let p = first; p <= last; p++) {
      const png = Buffer.from(await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), width: 1600 }));
      images.push({ type: 'image_url', image_url: { url: await imageUrl(png, 'image/png', ctx.fail) } });
    }
    const where = totalPages > 1 ? ` ${last > first ? `These images are pages ${first}–${last}` : `This image is page ${first}`} of a scanned PDF of ${totalPages} pages, in order; give each invoice or transaction its page number from this range. An invoice may continue from or onto pages not shown – read what is shown.` : ' This image is the only page of a scanned PDF (page 1).';
    parts.push(await call(GROQ_VISION_MODEL, [...images, { type: 'text', text: about + where }], 16_000));
  }
  return { result: merge(parts.map((p) => p.result)), model: parts[0].model, usage: sumUsage(parts.map((p) => p.usage)) };
}

function textPrompt(text: string, about: string, fail: (m: string) => Error): GroqContent {
  if (text.length > MAX_TEXT_CHARS) throw fail('The document has too much text to read in one go – split it into smaller files (for example one month per file).');
  return `${about}\n\nDocument text:\n<document>\n${text}\n</document>`;
}

/** Image as a data URL, re-encoded as a smaller JPEG when it is over Groq's base64 image limit. */
async function imageUrl(bytes: Buffer, mediaType: string, fail: (m: string) => Error) {
  if (bytes.length <= MAX_IMAGE_BYTES) return `data:${mediaType};base64,${bytes.toString('base64')}`;
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(bytes);
  for (const side of [MAX_IMAGE_SIDE, 1600, 1200]) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const canvas = createCanvas(Math.round(img.width * k), Math.round(img.height * k));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpg = await canvas.encode('jpeg', 85);
    if (jpg.length <= MAX_IMAGE_BYTES) return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  }
  throw fail('The image is too large – upload a smaller photo or scan.');
}

const RANK = { high: 2, medium: 1, low: 0 } as const;

/** Joins the answers for page groups of one scanned PDF. */
export function merge(parts: ExtractionResult[]): ExtractionResult {
  if (parts.length === 1) return parts[0];
  const kinds = parts.map((p) => p.documentType).filter((k) => k !== 'other');
  const documentType = kinds.length ? kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0] : 'other';
  const periods = [...new Set(parts.map((p) => p.period).filter(Boolean))];
  return {
    documentType,
    confidence: parts.reduce((m, p) => (RANK[p.confidence] < RANK[m] ? p.confidence : m), 'high' as ExtractionResult['confidence']),
    reason: parts.find((p) => p.documentType === documentType)?.reason ?? parts[0].reason,
    period: periods.length === 1 ? periods[0] : '',
    gstinsFound: [...new Set(parts.flatMap((p) => p.gstinsFound))],
    invoices: parts.flatMap((p) => p.invoices),
    bankAccount: parts.find((p) => p.bankAccount.accountNumber || p.bankAccount.bankName)?.bankAccount ?? parts[0].bankAccount,
    bankTransactions: parts.flatMap((p) => p.bankTransactions),
    notes: [...new Set(parts.map((p) => p.notes).filter(Boolean))].join(' '),
  };
}

const sumUsage = (us: Usage[]): Usage => us.reduce((a, u) => ({
  inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens,
  cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + u.cacheWriteTokens,
}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
