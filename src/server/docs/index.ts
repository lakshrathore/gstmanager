import 'server-only';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  analyse, checkBank, checkInvoice, DOC_KINDS, dupKey, nearDupKey, type BankTxn, type DocKind, type Flag, type InvoiceData, type Rec,
} from '@/engine/docs';
import { can, canAccessCompany, type Auth } from '../auth';
import { HttpError } from '../http';
import { audit } from '../gst/gst-audit';
import { fyInfo, fyOf } from '../gst/annual/common';
import { loadCompany } from '../gst/gstr1';
import { ClientDoc, Company, DocRecord, oid, type DocRecordDoc } from '../models';
import { aiConfigured, DOC_AI_MODEL } from './ai';
import { aiStatus } from '../ai-usage';
import { recentBatches } from './firm';
import { kick, searchText } from './pipeline';
import { deleteFile, getFile, putFile } from './storage';

/**
 * Client documents: upload → (background) understand, extract, check → review → analyse. Every
 * record keeps a link to the file and page/row it came from.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPES = /\.(pdf|jpe?g|png|webp|gif|xlsx|xls|csv|tsv|txt|json|docx|doc)$/i;
const CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain',
  json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? '';

/** Documents not yet assigned to a client are visible only to users who see every client. */
const seesAll = (auth: Auth) => auth.companyIds.length === 0;

async function docFor(auth: Auth, id: string) {
  const d = oid(id) && (await ClientDoc.findOne({ _id: oid(id), orgId: oid(auth.orgId) }).lean());
  if (!d || (d.companyId ? !canAccessCompany(auth, String(d.companyId)) : !seesAll(auth))) throw new HttpError(404, 'Document not found');
  return d;
}

/* ---------- upload ---------- */

/** `kind` is set when the type is known for sure (a return downloaded from the GST portal). */
export async function upload(auth: Auth, target: string, files: File[], opts: { kind?: DocKind } = {}) {
  const company = target === 'auto' ? null : await loadCompany(auth, target);
  if (!company && !seesAll(auth)) throw new HttpError(403, 'Pick the client to upload for.');
  const batchId = new Types.ObjectId().toString();
  const out: { fileName: string; id?: string; status: string; message?: string }[] = [];
  for (const f of files) {
    if (!TYPES.test(f.name)) { out.push({ fileName: f.name, status: 'rejected', message: 'File type not supported' }); continue; }
    if (f.size > MAX_FILE_BYTES) { out.push({ fileName: f.name, status: 'rejected', message: 'Larger than 25 MB' }); continue; }
    if (!f.size) { out.push({ fileName: f.name, status: 'rejected', message: 'Empty file' }); continue; }
    const bytes = Buffer.from(await f.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const same = await ClientDoc.findOne({ orgId: oid(auth.orgId), sha256, status: { $ne: 'duplicate' }, ...(company ? { companyId: { $in: [company._id, null] } } : {}) }).select({ fileName: 1, companyId: 1 }).lean();
    const fileId = await putFile(bytes, f.name, CONTENT_TYPE[extOf(f.name)] ?? 'application/octet-stream', { orgId: auth.orgId });
    const doc = await ClientDoc.create({
      orgId: oid(auth.orgId), companyId: company?._id ?? same?.companyId ?? null, fileId, fileName: f.name.slice(0, 250), contentType: CONTENT_TYPE[extOf(f.name)],
      sizeBytes: f.size, sha256, batchId, uploadedBy: auth.email, ...(opts.kind ? { kindOverride: opts.kind } : {}),
      ...(same ? { status: 'duplicate', duplicateOf: same._id, error: `Same file as ${same.fileName} (already uploaded) – not processed again.` } : {}),
    });
    out.push({ fileName: f.name, id: String(doc._id), status: doc.status });
  }
  await audit(auth, 'docs.upload', 'Company', company ? String(company._id) : 'auto', { batchId, files: out.length, accepted: out.filter((x) => x.id).length });
  void kick();
  return { batchId, files: out, ai: aiConfigured() };
}

/* ---------- workspace ---------- */

const recOf = (r: DocRecordDoc): Rec => ({
  id: String(r._id), docId: String(r.docId), kind: r.kind as Rec['kind'], source: (r.source ?? undefined) as Rec['source'], direction: (r.direction ?? null) as Rec['direction'],
  fp: r.fp ?? '', data: r.data as Rec['data'], flags: (r.flags ?? []) as Flag[], review: r.review as Rec['review'],
});

function prevFp(fp: string) {
  const m = Number(fp.slice(0, 2)), y = Number(fp.slice(2));
  return m === 1 ? `12${y - 1}` : `${String(m - 1).padStart(2, '0')}${y}`;
}

/**
 * One client's year: months with document and record counts, the documents (of a month, or the
 * whole year), and the analysis – summary, reconciliation, exceptions, findings – of that period.
 */
export async function workspace(auth: Auth, companyId: string, fy: string, fp?: string) {
  const info = fyInfo(fy);
  if (!info) throw new HttpError(400, 'Financial year must look like 2026-27');
  if (fp && !info.months.includes(fp)) throw new HttpError(400, 'Month is not in this financial year');
  const company = await loadCompany(auth, companyId);
  void kick();
  const base = { orgId: oid(auth.orgId), companyId: company._id };

  const [docs, recCounts, pending, unassigned] = await Promise.all([
    ClientDoc.find({ ...base, $or: [{ fy }, { fy: null }, { fy: { $exists: false } }] }).sort({ createdAt: -1 }).limit(2000).lean(),
    DocRecord.aggregate<{ _id: { fp: string; review: string }; n: number }>([{ $match: { ...base, fy } }, { $group: { _id: { fp: '$fp', review: '$review' }, n: { $sum: 1 } } }]),
    ClientDoc.countDocuments({ orgId: oid(auth.orgId), status: { $in: ['queued', 'processing'] } }),
    seesAll(auth) ? ClientDoc.find({ orgId: oid(auth.orgId), companyId: null, status: { $ne: 'duplicate' } }).sort({ createdAt: -1 }).limit(200).lean() : Promise.resolve([]),
  ]);
  const months = info.months.map((m) => {
    const rc = recCounts.filter((x) => x._id.fp === m);
    return {
      fp: m, docs: docs.filter((d) => d.fp === m).length,
      records: rc.reduce((a, x) => a + (x._id.review === 'rejected' ? 0 : x.n), 0), review: rc.find((x) => x._id.review === 'review')?.n ?? 0,
    };
  });

  const period = fp ? { fp } : { fy };
  const recs = (await DocRecord.find({ ...base, ...period }).lean()).map((r) => recOf(r as DocRecordDoc));
  const previous = fp ? (await DocRecord.find({ ...base, fp: prevFp(fp) }).lean()).map((r) => recOf(r as DocRecordDoc)) : undefined;
  // Bank lines of a month pay invoices of other months: match against the year's books.
  const books = fp && recs.some((r) => r.kind === 'bank')
    ? (await DocRecord.find({ ...base, fy, kind: 'invoice', source: { $in: ['document', 'register'] } }).lean()).map((r) => recOf(r as DocRecordDoc))
    : undefined;
  const analysis = analyse(recs, { clientGstin: company.gstin, period: fp ?? info.fp, previous, books, monthly: !!fp });

  const shown = docs.filter((d) => !fp || d.fp === fp || !d.fp);
  return {
    company: { _id: String(company._id), name: company.name, gstin: company.gstin },
    fy, fp: fp ?? null, months,
    noPeriod: docs.filter((d) => !d.fp && d.status !== 'queued' && d.status !== 'processing').length,
    docs: shown.map(docView),
    unassigned: unassigned.map(docView),
    pending,
    batches: await recentBatches(auth),
    ai: { ...(await aiStatus(auth.orgId, aiConfigured())), model: DOC_AI_MODEL },
    analysis: { ...analysis, recon: analysis.recon ? { summary: analysis.recon.summary, rows: analysis.recon.rows } : null },
    canEdit: can(auth, 'return:edit'),
  };
}

function docView(d: Record<string, unknown> & { _id: unknown }) {
  return {
    _id: String(d._id), fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, status: d.status, kind: d.kind ?? null, kindReason: d.kindReason ?? null,
    method: d.method ?? null, confidence: d.confidence ?? null, fp: d.fp ?? null, fy: d.fy ?? null, gstins: d.gstins ?? [], notes: d.notes ?? [], error: d.error ?? null,
    counts: d.counts ?? null, companyId: d.companyId ? String(d.companyId) : null, createdAt: d.createdAt, uploadedBy: d.uploadedBy, ai: d.ai ?? null, batchId: d.batchId ?? null,
  };
}

/* ---------- records ---------- */

export interface RecordQuery {
  companyId: string; fy?: string; fp?: string; kind?: 'invoice' | 'bank'; direction?: 'sales' | 'purchase'; source?: string;
  review?: string; flag?: string; minAmount?: number; maxAmount?: number; q?: string; docId?: string; ids?: string[]; mode?: string;
  page?: number; limit?: number;
}

export function recordFilter(auth: Auth, company: { _id: Types.ObjectId }, q: RecordQuery) {
  const f: Record<string, unknown> = { orgId: oid(auth.orgId), companyId: company._id };
  if (q.fp) f.fp = q.fp; else if (q.fy) f.fy = q.fy;
  if (q.kind) f.kind = q.kind;
  if (q.direction) f.direction = q.direction;
  if (q.source) f.source = q.source === 'books' ? { $in: ['document', 'register'] } : q.source;
  if (q.review) f.review = q.review === 'open' ? { $in: ['review'] } : q.review;
  else f.review = { $ne: 'rejected' };
  if (q.flag) f['flags.code'] = q.flag === 'any' ? { $exists: true } : { $in: q.flag.split(',') };
  if (q.minAmount != null || q.maxAmount != null) f.amount = { ...(q.minAmount != null ? { $gte: q.minAmount } : {}), ...(q.maxAmount != null ? { $lte: q.maxAmount } : {}) };
  if (q.docId) f.docId = oid(q.docId);
  if (q.ids?.length) f._id = { $in: q.ids.map(oid).filter(Boolean) };
  if (q.mode) f['data.mode'] = q.mode;
  if (q.q?.trim()) {
    const words = q.q.trim().toLowerCase().split(/\s+/).slice(0, 6).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    f.$and = words.map((w) => ({ text: { $regex: w } }));
  }
  return f;
}

export async function listRecords(auth: Auth, q: RecordQuery) {
  const company = await loadCompany(auth, q.companyId);
  const filter = recordFilter(auth, company, q);
  const limit = Math.min(500, q.limit ?? 100);
  const page = Math.max(0, q.page ?? 0);
  const [rows, total] = await Promise.all([
    DocRecord.find(filter).sort({ fp: 1, 'data.invoiceDate': 1, 'data.date': 1, _id: 1 }).skip(page * limit).limit(limit).lean(),
    DocRecord.countDocuments(filter),
  ]);
  const files = new Map((await ClientDoc.find({ _id: { $in: [...new Set(rows.map((r) => String(r.docId)))].map(oid) } }).select({ fileName: 1, contentType: 1 }).lean()).map((d) => [String(d._id), d]));
  return {
    total, page, limit,
    records: rows.map((r) => ({ ...recordView(r as DocRecordDoc), fileName: files.get(String(r.docId))?.fileName ?? '' })),
  };
}

function recordView(r: DocRecordDoc) {
  return {
    _id: String(r._id), docId: String(r.docId), kind: r.kind, source: r.source ?? null, direction: r.direction ?? null, fp: r.fp ?? null,
    data: r.data, original: r.original ?? null, loc: r.loc ?? null, uncertain: r.uncertain ?? [], flags: r.flags ?? [], review: r.review,
    reviewedBy: r.reviewedBy ?? null, reviewedAt: r.reviewedAt ?? null,
  };
}

async function recordFor(auth: Auth, id: string) {
  const r = oid(id) && (await DocRecord.findOne({ _id: oid(id), orgId: oid(auth.orgId) }).lean());
  if (!r || !canAccessCompany(auth, String(r.companyId))) throw new HttpError(404, 'Record not found');
  return r as DocRecordDoc;
}

export async function getRecord(auth: Auth, id: string) {
  const r = await recordFor(auth, id);
  const doc = await ClientDoc.findById(r.docId).lean();
  const related = (r.flags ?? []).map((f) => f.relatedId).filter(Boolean) as string[];
  const rel = related.length ? await DocRecord.find({ _id: { $in: related.map(oid) }, orgId: oid(auth.orgId) }).lean() : [];
  return { record: recordView(r), doc: doc ? docView(doc) : null, related: rel.map((x) => recordView(x as DocRecordDoc)) };
}

/** Re-runs the checks after the CA edits a record (duplicate flags are recomputed against the client's other records). */
async function recheck(r: DocRecordDoc, data: InvoiceData | BankTxn) {
  const company = await Company.findById(r.companyId).select({ gstin: 1 }).lean();
  const flags: Flag[] = r.kind === 'invoice'
    ? checkInvoice(data as InvoiceData, { clientGstin: company?.gstin ?? '', direction: (r.direction ?? null) as 'sales' | 'purchase' | null })
    : checkBank(data as BankTxn);
  let key: string | null = null;
  let near: string | null = null;
  if (r.kind === 'invoice') {
    key = dupKey((r.source ?? 'document') as Rec['source'] & string, (r.direction ?? null) as 'sales' | 'purchase' | null, data as InvoiceData);
    near = nearDupKey((r.source ?? 'document') as Rec['source'] & string, (r.direction ?? null) as 'sales' | 'purchase' | null, data as InvoiceData);
    const other = key && (await DocRecord.findOne({ orgId: r.orgId, companyId: r.companyId, _id: { $ne: r._id }, dupKey: key, review: { $ne: 'rejected' } }).select({ _id: 1 }).lean());
    if (other) flags.push({ code: 'duplicate', severity: 'error', message: 'Same invoice (party, type and number) as another record.', relatedId: String(other._id) });
  }
  if (!flags.some((f) => f.code === 'direction_unknown') && r.kind === 'invoice' && !r.direction) {
    flags.push({ code: 'direction_unknown', severity: 'error', field: 'supplierGstin', message: 'Is this a sale or a purchase of this client?' });
  }
  return { flags, dupKey: key ?? undefined, nearKey: near ?? undefined };
}

export async function updateRecord(auth: Auth, id: string, input: { action: 'save' | 'approve' | 'reject' | 'reopen'; data?: unknown; direction?: 'sales' | 'purchase' }) {
  const r = await recordFor(auth, id);
  const set: Record<string, unknown> = {};
  if (input.direction && r.kind === 'invoice') { set.direction = input.direction; r.direction = input.direction; }
  if (input.data && typeof input.data === 'object') {
    const data = { ...(r.data as object), ...(input.data as object) } as InvoiceData | BankTxn;
    if (r.kind === 'invoice') {
      const d = data as InvoiceData;
      for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'cess'] as const) d[k] = Math.round((Number(d[k]) || 0) * 100) / 100;
      if (!['INV', 'CN', 'DN'].includes(d.docType)) throw new HttpError(422, 'Document type must be INV, CN or DN');
      if (d.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.invoiceDate)) throw new HttpError(422, 'Invoice date must be YYYY-MM-DD');
      for (const g of ['supplierGstin', 'customerGstin'] as const) if (d[g]) d[g] = String(d[g]).toUpperCase().replace(/\s/g, '');
    }
    const checked = await recheck(r, data);
    const fp = r.kind === 'invoice'
      ? (r.source === 'document' || r.source === 'register' ? monthOf((data as InvoiceData).invoiceDate) : r.fp) || r.fp
      : monthOf((data as BankTxn).date) || r.fp;
    Object.assign(set, {
      data, ...checked, original: r.original ?? r.data, uncertain: [], fp, fy: fp ? fyOf(fp) : r.fy,
      amount: r.kind === 'invoice' ? ((data as InvoiceData).total ?? (data as InvoiceData).taxable) : Math.max((data as BankTxn).debit, (data as BankTxn).credit),
      text: searchText(r.kind === 'invoice' ? { kind: 'invoice', source: 'document', direction: null, data: data as InvoiceData } : { kind: 'bank', data: data as BankTxn }),
    });
  } else if (input.direction) {
    Object.assign(set, await recheck(r, r.data as InvoiceData));
  }
  if (input.action === 'approve') Object.assign(set, { review: 'approved', reviewedBy: auth.email, reviewedAt: new Date() });
  if (input.action === 'reject') Object.assign(set, { review: 'rejected', reviewedBy: auth.email, reviewedAt: new Date() });
  if (input.action === 'reopen') Object.assign(set, { review: 'review' });
  if (input.action === 'save' && r.review === 'ok' && (set.flags as Flag[] | undefined)?.some((f) => f.severity === 'error')) set.review = 'review';
  await DocRecord.updateOne({ _id: r._id }, { $set: set });
  await refreshDocCounts(r.docId);
  await audit(auth, `docs.record.${input.action}`, 'DocRecord', String(r._id), { docId: String(r.docId), edited: !!input.data });
  return { ok: true, ...(await getRecord(auth, id)) };
}

const monthOf = (iso: string) => (/^\d{4}-\d{2}/.test(iso ?? '') ? `${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');

async function refreshDocCounts(docId: unknown) {
  const recs = await DocRecord.find({ docId }).select({ review: 1, flags: 1 }).lean();
  const review = recs.filter((r) => r.review === 'review').length;
  const doc = await ClientDoc.findById(docId).select({ status: 1 }).lean();
  await ClientDoc.updateOne({ _id: docId }, {
    $set: {
      counts: { records: recs.filter((r) => r.review !== 'rejected').length, review, errors: recs.filter((r) => r.review !== 'rejected' && r.flags?.some((f: { severity?: string | null }) => f.severity === 'error')).length },
      ...(doc && ['processed', 'needs_review'].includes(doc.status ?? '') ? { status: review ? 'needs_review' : 'processed' } : {}),
    },
  });
}

/** Approves every record of a document (or a list) that has no errors left – the "looks right" button. */
export async function approveClean(auth: Auth, ids: string[]) {
  const recs = await DocRecord.find({ _id: { $in: ids.map(oid) }, orgId: oid(auth.orgId), review: 'review' }).lean();
  const ok = recs.filter((r) => canAccessCompany(auth, String(r.companyId)) && !r.flags?.some((f: { severity?: string | null }) => f.severity === 'error'));
  await DocRecord.updateMany({ _id: { $in: ok.map((r) => r._id) } }, { $set: { review: 'approved', reviewedBy: auth.email, reviewedAt: new Date() } });
  for (const d of new Set(ok.map((r) => String(r.docId)))) await refreshDocCounts(oid(d));
  await audit(auth, 'docs.record.approve_bulk', 'DocRecord', 'bulk', { count: ok.length });
  return { ok: true, approved: ok.length, skipped: recs.length - ok.length };
}

/* ---------- document actions ---------- */

export async function docAction(auth: Auth, id: string, a: { action: 'assign'; companyId: string } | { action: 'set_kind'; kind: string } | { action: 'reprocess' } | { action: 'delete' }) {
  const d = await docFor(auth, id);
  switch (a.action) {
    case 'assign': {
      const c = await loadCompany(auth, a.companyId);
      await ClientDoc.updateOne({ _id: d._id }, { $set: { companyId: c._id, status: 'queued', error: null } });
      break;
    }
    case 'set_kind':
      if (!(DOC_KINDS as readonly string[]).includes(a.kind)) throw new HttpError(400, 'Unknown document type');
      await ClientDoc.updateOne({ _id: d._id }, { $set: { kindOverride: a.kind as DocKind, status: 'queued', error: null } });
      break;
    case 'reprocess':
      // Read again from the file (AI is paid for again for PDFs and images).
      await ClientDoc.updateOne({ _id: d._id }, { $set: { status: 'queued', error: null, attempts: 0 }, $unset: { extraction: 1 } });
      break;
    case 'delete':
      await DocRecord.deleteMany({ docId: d._id });
      await ClientDoc.deleteOne({ _id: d._id });
      if (!(await ClientDoc.exists({ fileId: d.fileId }))) await deleteFile(d.fileId);
      break;
  }
  await audit(auth, `docs.${a.action}`, 'ClientDoc', String(d._id), { fileName: d.fileName, ...('companyId' in a ? { companyId: a.companyId } : {}), ...('kind' in a ? { kind: a.kind } : {}) });
  void kick();
  return { ok: true };
}

export async function fileOf(auth: Auth, id: string) {
  const d = await docFor(auth, id);
  return { fileName: d.fileName, contentType: d.contentType || 'application/octet-stream', bytes: await getFile(d.fileId) };
}

export async function docDetail(auth: Auth, id: string) {
  const d = await docFor(auth, id);
  return { doc: docView(d) };
}

export { aiConfigured };
