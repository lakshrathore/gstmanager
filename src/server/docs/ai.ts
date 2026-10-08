import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DOC_KINDS } from '@/engine/docs';

/**
 * Reads a document Claude can see – PDF (text or scanned), image, or plain text (Word, unknown
 * spreadsheets) – and returns what it is plus every invoice or bank transaction in it, as JSON that
 * matches a fixed schema. Unreadable values come back empty and are listed as uncertain; nothing is
 * guessed.
 */

export const DOC_AI_MODEL = process.env.DOC_AI_MODEL || 'claude-opus-5-5';
const EFFORT = (process.env.DOC_AI_EFFORT as 'low' | 'medium' | 'high' | undefined) || 'medium';

export const aiConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ maxRetries: 3 }));

const n = z.number().nullable();
const Item = z.object({
  description: z.string(), hsn: z.string(), quantity: n, unit: z.string(), unitPrice: n, discount: n,
  taxable: n, gstRate: n, cgst: n, sgst: n, igst: n, cess: n,
});
const Invoice = z.object({
  page: n,
  docType: z.enum(['INV', 'CN', 'DN']),
  supplierName: z.string(), supplierGstin: z.string(), customerName: z.string(), customerGstin: z.string(),
  invoiceNo: z.string(), invoiceDate: z.string(), placeOfSupply: z.string(), reverseCharge: z.boolean(),
  items: z.array(Item),
  taxable: n, discount: n, cgst: n, sgst: n, igst: n, cess: n, roundOff: n, total: n,
  uncertainFields: z.array(z.string()),
});
const Txn = z.object({
  page: n, date: z.string(), narration: z.string(), ref: z.string(), debit: n, credit: n, balance: n,
  uncertainFields: z.array(z.string()),
});
export const Extraction = z.object({
  documentType: z.enum(DOC_KINDS),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
  period: z.string(),
  gstinsFound: z.array(z.string()),
  invoices: z.array(Invoice),
  bankAccount: z.object({ bankName: z.string(), accountNumber: z.string(), holderName: z.string() }),
  bankTransactions: z.array(Txn),
  notes: z.string(),
});
export type ExtractionResult = z.infer<typeof Extraction>;

const SYSTEM = `You read business documents for an Indian chartered accountant's firm and return their contents as data for GST and accounting work.

Identify the document:
- documentType: tax_invoice, credit_note, debit_note, sales_register, purchase_register, gstr1, gstr2a, gstr2b, gstr3b, bank_statement, eway_bill, gst_certificate, accounting_report or other.
- confidence: how sure you are of the type. reason: one short sentence on what showed it.
- period: the month the document belongs to as MMYYYY (invoice date month, statement month, return period); "" if it spans several months or is not clear.
- gstinsFound: every GSTIN printed anywhere in the document.

Extract:
- invoices: only for tax_invoice, credit_note, debit_note, sales_register, purchase_register, gstr1, gstr2a and gstr2b. One entry per invoice or note – a PDF may hold several invoices, a register one per row. For other document types return an empty list.
- bankTransactions: only for bank_statement, one entry per transaction line, in statement order. Otherwise an empty list.

Rules:
- Copy values exactly as printed. Never invent, infer or calculate a value that is not printed – if a field is not on the document or cannot be read, use "" or null and add its name to uncertainFields. Also list any field you read but are not sure of (blurred, handwritten, cut off).
- Dates as YYYY-MM-DD. Amounts in rupees as plain numbers (no commas or symbols). Credit notes as positive amounts with docType CN.
- GSTINs are 15 characters (2-digit state code, PAN, entity, Z, check character); copy them character by character.
- placeOfSupply: the 2-digit state code if printed or the state name.
- invoice totals: taxable is the total taxable value; cgst, sgst, igst, cess the tax totals; total the invoice value as printed; roundOff if shown.
- page: the PDF page (1-based) where the invoice or transaction is; null for images and text.
- notes: anything the accountant should know (illegible pages, missing pages, totals that do not add up). Keep it short.`;

export type AiInput =
  | { type: 'pdf'; bytes: Buffer }
  | { type: 'image'; bytes: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }
  | { type: 'text'; text: string };

export class AiError extends Error {}

export async function extractWithAi(input: AiInput, context: { fileName: string; client?: { name: string; gstin: string } | null; otherClients: { name: string; gstin: string }[] }) {
  if (!aiConfigured()) throw new AiError('Reading PDFs, scans and images needs the Claude API: set ANTHROPIC_API_KEY in .env.local and restart.');
  const source: Anthropic.Beta.BetaContentBlockParam = input.type === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.bytes.toString('base64') } }
    : input.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.bytes.toString('base64') } }
      : { type: 'document', source: { type: 'text', media_type: 'text/plain', data: input.text } };
  const clients = context.client ? `This document was uploaded for the client ${context.client.name} (GSTIN ${context.client.gstin}).` : 'The client is not known yet.';
  const others = context.otherClients.length ? ` The firm's clients: ${context.otherClients.slice(0, 50).map((c) => `${c.name} ${c.gstin}`).join('; ')}.` : '';

  let res;
  try {
    res = await anthropic().beta.messages.parse({
      model: DOC_AI_MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: EFFORT, format: betaZodOutputFormat(Extraction) },
      messages: [{ role: 'user', content: [source, { type: 'text', text: `File name: ${context.fileName}. ${clients}${others}` }] }],
    }, { timeout: 15 * 60_000 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('The Claude API key is not valid (check ANTHROPIC_API_KEY).');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('Claude API rate limit reached – the document will be retried.');
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`Claude could not read this file: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new AiError(`Claude API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AiError('Claude declined to read this document.');
  if (res.stop_reason === 'max_tokens') throw new AiError('The document has too many lines to read in one go – split it into smaller files (for example one month per file).');
  if (!res.parsed_output) throw new AiError('Claude’s answer could not be read as data.');
  return {
    result: res.parsed_output, model: res.model,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0 },
  };
}
