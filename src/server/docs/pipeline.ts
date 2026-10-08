import 'server-only';
import JSZip from 'jszip';
import { Types } from 'mongoose';
import { readWorkbook } from '@/engine';
import {
  balanceBreaks, bankDupKey, bankMode, checkBank, checkInvoice, dupKey, nearDupKey, parseCsv, readStructuredJson, readStructuredTables,
  type DocKind, type Extracted, type Flag, type InvoiceData, type StructuredRead,
} from '@/engine/docs';
import { stateCode } from '@/engine/marketplace/states';
import { fyOf } from '../gst/annual/common';
import { ClientDoc, Company, DocRecord, type ClientDocDoc } from '../models';
import { AiError, aiConfigured, DOC_AI_MODEL, extractWithAi, type ExtractionResult } from './ai';
import { getFile } from './storage';
import { assertAiAllowed, recordAiUsage } from '../ai-usage';

/**
 * Background processing of uploaded documents: read (rules first, AI for the rest) → identify the
 * client, side and period → check → find duplicates → store records. Runs inside the server process,
 * a few documents at a time; anything left half-done by a restart is picked up again on the next kick.
 */

const CONCURRENCY = Math.max(1, Number(process.env.DOC_AI_CONCURRENCY) || 3);
const STALE_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;
const q = globalThis as unknown as { __docQueue?: { running: number } };
const queue = (q.__docQueue ??= { running: 0 });

/** Starts workers for queued documents (call after uploads and whenever the workspace is viewed). */
export async function kick() {
  await ClientDoc.updateMany({ status: 'processing', startedAt: { $lt: new Date(Date.now() - STALE_MS) } }, { $set: { status: 'queued' } });
  while (queue.running < CONCURRENCY) {
    const doc = await ClientDoc.findOneAndUpdate(
      { status: 'queued' },
      { $set: { status: 'processing', startedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    ).lean();
    if (!doc) return;
    queue.running++;
    runOne(doc as ClientDocDoc)
      .catch((e) => console.error('[docs] processing failed', String(doc._id), e))
      .finally(() => { queue.running--; void kick(); });
  }
}

async function runOne(doc: ClientDocDoc) {
  try {
    await processDoc(doc);
  } catch (e) {
    const retry = e instanceof AiError && /rate limit/i.test(e.message) && (doc.attempts ?? 1) < MAX_ATTEMPTS;
    await ClientDoc.updateOne({ _id: doc._id }, { $set: { status: retry ? 'queued' : 'failed', error: (e as Error).message.slice(0, 500) } });
  }
}

/* ---------- reading ---------- */

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';
const IMAGE: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** Plain text of a .docx (paragraphs and table cells). */
async function docxText(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new AiError('This Word file has no document text.');
  return xml.replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

const tablesAsText = (tables: { name: string; rows: unknown[][] }[]) =>
  tables.map((t) => `Sheet: ${t.name}\n${t.rows.slice(0, 1500).map((r) => (r ?? []).map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c ?? '')).join('\t')).join('\n')}`).join('\n\n');

interface Read {
  kind: DocKind; reason: string; method: 'rules' | 'ai'; confidence: number; period: string; ownerGstin?: string;
  gstins: string[]; records: Extracted[]; notes: string[]; ai?: { model: string; inputTokens: number; outputTokens: number; costInr: number };
}

const CONF = { high: 0.95, medium: 0.75, low: 0.5 } as const;
const KIND_SOURCE: Partial<Record<DocKind, Extracted & { kind: 'invoice' } extends { source: infer S } ? S : never>> = {
  sales_register: 'register', purchase_register: 'register', gstr1: 'gstr1', gstr2a: 'gstr2a', gstr2b: 'gstr2b',
};

function fromAi(r: ExtractionResult): Extracted[] {
  const out: Extracted[] = [];
  const num = (v: number | null) => (v == null || !Number.isFinite(v) ? 0 : Math.abs(v));
  const source = KIND_SOURCE[r.documentType] ?? 'document';
  for (const i of r.invoices) {
    const data: InvoiceData = {
      docType: i.docType,
      supplierName: i.supplierName || undefined, supplierGstin: i.supplierGstin.replace(/\s/g, '').toUpperCase() || undefined,
      customerName: i.customerName || undefined, customerGstin: i.customerGstin.replace(/\s/g, '').toUpperCase() || undefined,
      invoiceNo: i.invoiceNo.trim(), invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(i.invoiceDate) ? i.invoiceDate : '',
      pos: i.placeOfSupply ? stateCode(i.placeOfSupply) || undefined : undefined, rcm: i.reverseCharge || undefined,
      taxable: num(i.taxable), cgst: num(i.cgst), sgst: num(i.sgst), igst: num(i.igst), cess: num(i.cess),
      discount: i.discount != null ? Math.abs(i.discount) : undefined, total: i.total != null ? Math.abs(i.total) : null,
      items: i.items.length ? i.items.map((x) => ({
        description: x.description || undefined, hsn: x.hsn || undefined, quantity: x.quantity, unit: x.unit || undefined, unitPrice: x.unitPrice,
        discount: x.discount, taxable: x.taxable, gstRate: x.gstRate, cgst: x.cgst, sgst: x.sgst, igst: x.igst, cess: x.cess,
      })) : undefined,
    };
    // Items without a total taxable value: add them up (shown as uncertain so the CA confirms).
    const uncertain = [...i.uncertainFields];
    if (i.taxable == null && data.items?.length) { data.taxable = Math.round(data.items.reduce((a, x) => a + (x.taxable ?? 0), 0) * 100) / 100; uncertain.push('taxable'); }
    out.push({ kind: 'invoice', source, direction: null, data, loc: i.page ? { page: i.page } : undefined, uncertain });
  }
  const acct = r.bankAccount.accountNumber ? r.bankAccount.accountNumber.replace(/\s/g, '').slice(-4) : undefined;
  for (const t of r.bankTransactions) {
    out.push({
      kind: 'bank',
      data: { date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '', narration: t.narration, ref: t.ref || undefined, debit: num(t.debit), credit: num(t.credit), balance: t.balance, mode: bankMode(t.narration), account: acct ? `${r.bankAccount.bankName} …${acct}`.trim() : undefined },
      loc: t.page ? { page: t.page } : undefined, uncertain: t.uncertainFields,
    });
  }
  return out;
}

async function readDoc(doc: ClientDocDoc, bytes: Buffer, client: { name: string; gstin: string } | null, others: { name: string; gstin: string }[]): Promise<Read> {
  const e = ext(doc.fileName);
  const gstin = client?.gstin ?? '';
  const fromRules = (s: StructuredRead): Read => ({
    kind: s.kind, reason: s.reason, method: 'rules', confidence: 1, period: s.period ?? '', ownerGstin: s.ownerGstin,
    gstins: s.ownerGstin ? [s.ownerGstin] : [], records: s.records, notes: s.notes,
  });
  const ai = async (input: Parameters<typeof extractWithAi>[0], note?: string): Promise<Read> => {
    // The plan must include Document AI and this month's allowance must not be used up.
    try { await assertAiAllowed(String(doc.orgId)); } catch (e) { throw new AiError((e as Error).message); }
    const r = await extractWithAi(input, { fileName: doc.fileName, client, otherClients: others });
    const costInr = await recordAiUsage(doc.orgId, 'extract', r.model ?? DOC_AI_MODEL, r.usage, String(doc._id), doc.uploadedBy ?? undefined);
    return {
      kind: r.result.documentType, reason: r.result.reason, method: 'ai', confidence: CONF[r.result.confidence], period: /^\d{6}$/.test(r.result.period) ? r.result.period : '',
      gstins: [...new Set(r.result.gstinsFound.map((g) => g.replace(/\s/g, '').toUpperCase()))], records: fromAi(r.result),
      notes: [...(note ? [note] : []), ...(r.result.notes ? [r.result.notes] : [])],
      ai: { model: r.model ?? DOC_AI_MODEL, inputTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens, outputTokens: r.usage.outputTokens, costInr },
    };
  };

  if (e === 'json') {
    let json: unknown;
    try { json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { throw new AiError('The file is not valid JSON.'); }
    const s = readStructuredJson(json, doc.fileName, gstin);
    if (s) return fromRules(s);
    return { kind: 'other', reason: 'JSON file of an unknown layout', method: 'rules', confidence: 0.3, period: '', gstins: [], records: [], notes: ['Not a GSTN JSON this app reads (GSTR-1, GSTR-2A, GSTR-2B, GSTR-3B).'] };
  }
  if (e === 'xlsx' || e === 'csv' || e === 'txt' || e === 'tsv') {
    const tables = e === 'xlsx' ? await readWorkbook(bytes, 50_000) : [parseCsv(bytes.toString('utf8'), doc.fileName)];
    const s = readStructuredTables(tables, doc.fileName, gstin);
    if (s) {
      if (doc.kindOverride && doc.kindOverride !== s.kind && ['sales_register', 'purchase_register'].includes(doc.kindOverride)) {
        const { readRegister } = await import('@/engine/docs');
        const dir = doc.kindOverride === 'sales_register' ? 'sales' : 'purchase';
        return { ...fromRules(s), kind: doc.kindOverride as DocKind, reason: 'Type set by you', records: readRegister(tables, dir, gstin).records };
      }
      return fromRules(s);
    }
    if (!aiConfigured()) return { kind: 'other', reason: 'Spreadsheet layout not recognised', method: 'rules', confidence: 0.3, period: '', gstins: [], records: [], notes: ['The columns were not recognised as a register, GSTN file or bank statement. Set ANTHROPIC_API_KEY to let AI read it.'] };
    return ai({ type: 'text', text: tablesAsText(tables) }, 'Spreadsheet layout not recognised by the rules – read by AI.');
  }
  if (e === 'xls') throw new AiError('Old Excel format (.xls): open it in Excel and save as .xlsx, then upload again.');
  if (e === 'pdf') return ai({ type: 'pdf', bytes });
  if (IMAGE[e]) return ai({ type: 'image', bytes, mediaType: IMAGE[e] });
  if (e === 'docx') return ai({ type: 'text', text: await docxText(bytes) });
  if (e === 'doc') throw new AiError('Old Word format (.doc): save it as .docx or PDF and upload again.');
  throw new AiError(`Files of type .${e} are not supported. Upload PDF, images (JPG, PNG), Excel (.xlsx), CSV, JSON or Word (.docx).`);
}

/* ---------- client, side, period ---------- */

function identifyClient(read: Read, companies: { _id: Types.ObjectId; name: string; gstin: string }[]) {
  const counts = new Map<string, number>();
  const bump = (g?: string) => { if (g) counts.set(g, (counts.get(g) ?? 0) + 1); };
  bump(read.ownerGstin);
  for (const r of read.records) if (r.kind === 'invoice') { bump(r.data.supplierGstin); bump(r.data.customerGstin); }
  for (const g of read.gstins) bump(g);
  const hits = companies.map((c) => ({ c, n: counts.get(c.gstin) ?? 0 })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  return hits;
}

function directionOf(r: Extracted & { kind: 'invoice' }, kind: DocKind, clientGstin: string): 'sales' | 'purchase' | null {
  if (r.direction) return r.direction;
  if (clientGstin && r.data.supplierGstin === clientGstin) return 'sales';
  if (clientGstin && r.data.customerGstin === clientGstin) return 'purchase';
  if (kind === 'sales_register' || kind === 'gstr1') return 'sales';
  if (kind === 'purchase_register' || kind === 'gstr2a' || kind === 'gstr2b') return 'purchase';
  return null;
}

const monthOf = (iso: string) => (/^\d{4}-\d{2}/.test(iso) ? `${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');

/* ---------- process ---------- */

export async function processDoc(docIn: ClientDocDoc) {
  const doc = (await ClientDoc.findById(docIn._id).select('+extraction').lean()) as (ClientDocDoc & { extraction?: Read }) | null;
  if (!doc) return;
  const companies = (await Company.find({ orgId: doc.orgId }).select({ name: 1, gstin: 1 }).lean()) as { _id: Types.ObjectId; name: string; gstin: string }[];
  let company = doc.companyId ? companies.find((c) => String(c._id) === String(doc.companyId)) ?? null : null;

  // What was read before is reused (a client assignment or type change must not pay for AI again).
  // A type set by the CA re-reads structured files by rules (free); AI-read files keep what was read.
  let read = doc.extraction && !(doc.kindOverride && doc.extraction.method === 'rules') ? doc.extraction : null;
  if (!read) {
    const bytes = await getFile(doc.fileId);
    read = await readDoc(doc, bytes, company ? { name: company.name, gstin: company.gstin } : null, companies.map((c) => ({ name: c.name, gstin: c.gstin })));
    await ClientDoc.updateOne({ _id: doc._id }, { $set: { extraction: read } });
  }
  if (doc.kindOverride && read.method === 'ai' && doc.kindOverride !== read.kind) {
    const kind = doc.kindOverride as DocKind;
    read = { ...read, kind, reason: 'Type set by you', records: read.records.map((r: Extracted) => (r.kind === 'invoice' ? { ...r, source: KIND_SOURCE[kind] ?? 'document', direction: null } : r)) };
  }

  const docNotes = [...read.notes];
  const hits = identifyClient(read, companies);
  if (!company) {
    if (hits.length === 1 || (hits.length > 1 && hits[0].n > hits[1].n)) company = hits[0].c;
    else {
      await ClientDoc.updateOne({ _id: doc._id }, {
        $set: {
          status: 'needs_review', kind: read.kind, kindReason: read.reason, method: read.method, confidence: read.confidence, gstins: read.gstins, ai: read.ai,
          notes: docNotes, processedAt: new Date(),
          error: hits.length > 1 ? `Mentions several clients (${hits.map((h) => h.c.name).join(', ')}) – pick the client.` : 'Client not identified (none of your clients’ GSTINs is in it) – pick the client.',
          counts: { records: read.records.length, review: 0, errors: 0 },
        },
      });
      return;
    }
  } else if (hits.length && !hits.some((h) => String(h.c._id) === String(company!._id))) {
    docNotes.push(`This document names ${hits.map((h) => `${h.c.name} (${h.c.gstin})`).join(', ')} but was uploaded for ${company.name}.`);
  }
  const clientGstin = company.gstin;

  // Records: side, client GSTIN filled in, period, checks.
  type Row = { rec: Extracted; flags: Flag[]; fp: string; direction: 'sales' | 'purchase' | null };
  const rows: Row[] = read.records.map((rec: Extracted) => {
    if (rec.kind === 'bank') {
      return { rec, flags: checkBank(rec.data, rec.uncertain), fp: monthOf(rec.data.date) || read!.period, direction: null };
    }
    const direction = directionOf(rec, read!.kind, clientGstin);
    const d = rec.data;
    if (direction === 'purchase' && !d.customerGstin) d.customerGstin = clientGstin;
    if (direction === 'sales' && !d.supplierGstin) d.supplierGstin = clientGstin;
    const flags = checkInvoice(d, { clientGstin, direction, uncertain: rec.uncertain });
    if (!direction) flags.push({ code: 'direction_unknown', severity: 'error', field: 'supplierGstin', message: `Neither the supplier nor the customer GSTIN is ${company!.name}’s (${clientGstin}) – is this a sale or a purchase of this client?` });
    // Portal data belongs to its return period; books to the month of the invoice date.
    const fp = (rec.source !== 'document' && rec.source !== 'register' && d.returnPeriod) || monthOf(d.invoiceDate) || read!.period;
    return { rec, flags, fp, direction };
  });

  // Bank statements: running balance.
  const bank = rows.map((r, i) => ({ id: String(i), data: r.rec.kind === 'bank' ? r.rec.data : null })).filter((x): x is { id: string; data: NonNullable<typeof x.data> } => !!x.data);
  for (const [i, f] of balanceBreaks(bank)) rows[Number(i)].flags.push(f);

  // Duplicates: against records already stored for the client, and inside this document.
  const keyOf = (r: Row) => (r.rec.kind === 'invoice' ? dupKey(r.rec.source, r.direction, r.rec.data) : `bank|${bankDupKey(r.rec.data)}`);
  const nearOf = (r: Row) => (r.rec.kind === 'invoice' ? nearDupKey(r.rec.source, r.direction, r.rec.data) : null);
  const keys = rows.map(keyOf);
  const nears = rows.map(nearOf);
  const existing = await DocRecord.find({
    orgId: doc.orgId, companyId: company._id, docId: { $ne: doc._id }, review: { $ne: 'rejected' },
    $or: [{ dupKey: { $in: keys.filter(Boolean) } }, { nearKey: { $in: nears.filter(Boolean) } }],
  }).select({ dupKey: 1, nearKey: 1, docId: 1, docNo: 1 }).lean();
  const fileNames = new Map((await ClientDoc.find({ _id: { $in: existing.map((x) => x.docId) } }).select({ fileName: 1 }).lean()).map((d) => [String(d._id), d.fileName]));
  const seenHere = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = keys[i];
    if (!k) return;
    const prior = existing.find((x) => x.dupKey === k);
    const what = r.rec.kind === 'bank' ? 'transaction (same date, amount and reference)' : `invoice (same ${r.direction === 'sales' ? 'customer' : 'supplier'}, type and number)`;
    if (prior) r.flags.push({ code: r.rec.kind === 'bank' ? 'duplicate_txn' : 'duplicate', severity: 'error', message: `Same ${what} already in ${fileNames.get(String(prior.docId)) ?? 'another file'}.`, relatedId: String(prior._id) });
    else if (seenHere.has(k) && r.rec.kind === 'invoice') r.flags.push({ code: 'duplicate', severity: 'error', message: `Same ${what} appears twice in this file (row/page ${(rows[seenHere.get(k)!].rec.loc?.row ?? rows[seenHere.get(k)!].rec.loc?.page) ?? '?'}).` });
    else if (seenHere.has(k)) r.flags.push({ code: 'duplicate_txn', severity: 'warning', message: 'An identical transaction appears earlier in this statement – check it is not repeated.' });
    seenHere.set(k, i);
    const near = nears[i] && existing.find((x) => x.nearKey === nears[i] && x.dupKey !== k);
    if (near && !prior) r.flags.push({ code: 'possible_duplicate', severity: 'warning', message: `Same party, date and amount as ${near.docNo || 'a record'} in ${fileNames.get(String(near.docId)) ?? 'another file'} – the same bill entered twice?`, relatedId: String(near._id) });
  });

  // Store (replacing an earlier run of this document).
  const lowConfidence = read.method === 'ai' && read.confidence < 0.7;
  const docs = rows.map((r, i) => {
    const d = r.rec.data;
    const isInv = r.rec.kind === 'invoice';
    const inv = d as InvoiceData;
    const party = isInv ? (r.direction === 'sales' ? inv.customerName ?? inv.customerGstin : inv.supplierName ?? inv.supplierGstin) ?? '' : '';
    const needsReview = r.flags.some((f) => f.severity === 'error') || (r.rec.uncertain?.length ?? 0) > 0 || lowConfidence;
    return {
      orgId: doc.orgId, companyId: company!._id, docId: doc._id, kind: r.rec.kind, source: isInv ? (r.rec as { source: string }).source : undefined,
      direction: r.direction, fp: r.fp || undefined, fy: r.fp ? fyOf(r.fp) : undefined, data: d, loc: r.rec.loc, uncertain: r.rec.uncertain ?? [],
      flags: r.flags, review: needsReview ? 'review' : 'ok',
      dupKey: keys[i] ?? undefined, nearKey: nears[i] ?? undefined, party, docNo: isInv ? inv.invoiceNo : (d as { ref?: string }).ref,
      amount: isInv ? inv.total ?? inv.taxable + inv.igst + inv.cgst + inv.sgst + inv.cess : Math.max((d as { debit: number }).debit, (d as { credit: number }).credit),
      text: searchText(r.rec),
    };
  });
  await DocRecord.deleteMany({ docId: doc._id });
  for (let i = 0; i < docs.length; i += 1000) await DocRecord.insertMany(docs.slice(i, i + 1000), { ordered: false });

  const fps = rows.map((r) => r.fp).filter(Boolean);
  const fp = mostCommon(fps) || read.period || undefined;
  const review = docs.filter((d) => d.review === 'review').length;
  const errors = docs.filter((d) => d.flags.some((f) => f.severity === 'error')).length;
  // A guessed sales/purchase side or a document naming another client needs the CA's eye too.
  const needs = review > 0 || lowConfidence || (read.kind === 'other' && !read.records.length) || docNotes.some((n) => /but was uploaded for|Could not tell whether/.test(n));
  await ClientDoc.updateOne({ _id: doc._id }, {
    $set: {
      status: needs ? 'needs_review' : 'processed', companyId: company._id, kind: read.kind, kindReason: read.reason, method: read.method, confidence: read.confidence,
      fp, fy: fp ? fyOf(fp) : undefined, gstins: read.gstins, notes: docNotes, ai: read.ai, error: lowConfidence ? 'Not sure what this document is – check the type.' : undefined,
      counts: { records: docs.length, review, errors }, processedAt: new Date(),
    },
  });
}

function mostCommon(xs: string[]) {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export function searchText(r: Extracted) {
  const d = r.data as unknown as Record<string, unknown>;
  const parts = Object.values(d).filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
  if (r.kind === 'invoice') for (const i of r.data.items ?? []) parts.push(i.description ?? '', i.hsn ?? '');
  return parts.join(' ').toLowerCase().slice(0, 2000);
}
