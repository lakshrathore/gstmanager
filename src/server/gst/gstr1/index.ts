import 'server-only';
import { Types } from 'mongoose';
import {
  blankRecordData, financialYear, MARKETPLACES, generateGstr1Json, SECTIONS, naturalKey, parseGstr1Tables, periodBounds, profileForPeriod,
  readWorkbook, recomputeRecordTax, validateGstr1Json, validateReturn,
  type AnyRecord, type MarketplaceId, type ReturnContext, type Section,
} from '@/engine';
import { canAccessCompany, type Auth } from '../../auth';
import { sha256 } from '../../crypto';
import { HttpError } from '../../http';
import { assertWithinLimit } from '../../license';
import {
  Company, GeneratedJson, GstReturn, Gstr1Error, Gstr1Record, oid,
  type CompanyDoc, type GstReturnDoc,
} from '../../models';
import { auditReturn } from '../gst-audit';
import { changeStatus, DATA_LOCKED, normalizeStatus, STATUS_LABELS, type ReturnStatus } from '../gst-status';

/**
 * GSTR-1 application processing: import → validate → edit → generate JSON.
 * Pure business logic on top of the framework-free engine; knows nothing about how the JSON reaches GSTN.
 */

/* ---------- tenant-scoped loaders ---------- */

export async function loadCompany(auth: Auth, companyId: string): Promise<CompanyDoc> {
  const id = oid(companyId);
  const c = id && (await Company.findOne({ _id: id, orgId: oid(auth.orgId) }).lean());
  if (!c || !canAccessCompany(auth, String(c._id))) throw new HttpError(404, 'Company not found');
  return c as CompanyDoc;
}

export async function loadReturn(auth: Auth, returnId: string) {
  const id = oid(returnId);
  const r = id && (await GstReturn.findOne({ _id: id, orgId: oid(auth.orgId) }).lean());
  if (!r || !canAccessCompany(auth, String(r.companyId))) throw new HttpError(404, 'Return not found');
  const status = normalizeStatus(r.status);
  if (status !== r.status) {
    await GstReturn.updateOne({ _id: r._id, status: r.status }, { $set: { status } }); // one-time legacy migration
    r.status = status;
  }
  const company = await loadCompany(auth, String(r.companyId));
  return { ret: r as GstReturnDoc, company };
}

export function contextFor(ret: GstReturnDoc, company: CompanyDoc): ReturnContext {
  return {
    supplierGstin: company.gstin, fp: ret.fp, quarterly: !!ret.quarterly,
    aatoAbove5Cr: !!company.aatoAbove5Cr, profile: profileForPeriod(ret.fp),
  };
}

export const toRecord = (d: { section: string; key: string; source: unknown; data: unknown }) =>
  ({ section: d.section, key: d.key, source: d.source ?? { sheet: '', rows: [] }, data: d.data }) as AnyRecord;

/* ---------- create ---------- */

export async function createReturn(auth: Auth, companyId: string, fp: string) {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp)) throw new HttpError(400, 'Return period must be MMYYYY');
  const company = await loadCompany(auth, companyId);
  const quarterly = company.filingFrequency === 'quarterly';
  if (quarterly && !['03', '06', '09', '12'].includes(fp.slice(0, 2))) throw new HttpError(400, 'Quarterly filers must pick the quarter-ending month');
  const existing = await GstReturn.findOne({ orgId: oid(auth.orgId), companyId: company._id, fp }).lean();
  if (existing) return existing;
  await assertWithinLimit(auth.orgId, 'returnsPerMonth');
  const ret = await GstReturn.create({
    orgId: oid(auth.orgId), companyId: company._id, gstin: company.gstin, fp, quarterly,
    fy: financialYear(periodBounds(fp).start), profileId: profileForPeriod(fp).id,
  });
  await auditReturn(auth, ret, 'return.create', { company: company.name });
  return ret.toObject();
}

/* ---------- import ---------- */

/** Records not created by the Excel template import: manual entries ("manual") and marketplace reports ("mp:…"). */
export const OTHER_SOURCES = /^(manual$|mp:)/;

export async function importExcel(auth: Auth, returnId: string, file: File) {
  const { ret, company } = await loadReturn(auth, returnId);
  assertEditable(ret.status, 're-import');
  if (!/\.xlsx$/i.test(file.name)) throw new HttpError(400, 'Upload the .xlsx GSTR-1 template (Excel 2007+)');
  if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'File too large (max 25 MB)');

  const tables = await readWorkbook(Buffer.from(await file.arrayBuffer()));
  const ctx = contextFor(ret, company);
  const parsed = parseGstr1Tables(tables, { supplierGstin: company.gstin, hsnSplit: ctx.profile.hsnSplit });
  if (!parsed.sheetsParsed.length) throw new HttpError(422, 'No GSTR-1 sheets recognised in this workbook', parsed.sheetsSkipped);

  const base = { orgId: ret.orgId, returnId: ret._id };
  // A workbook holding the same invoices/notes as a sales-report import (typically this return's own
  // Excel download, corrected and imported back) replaces that import – otherwise every document
  // would be in the return twice.
  const docKey = (section: string, d: { inum?: string; ntNum?: string }) => `${section}|${String(d.inum ?? d.ntNum ?? '').trim().toUpperCase()}`;
  const DOC_SECTIONS = ['b2b', 'b2cl', 'exp', 'cdnr', 'cdnur'];
  const incoming = new Set(parsed.records.filter((r) => DOC_SECTIONS.includes(r.section)).map((r) => docKey(r.section, r.data as { inum?: string; ntNum?: string })));
  const fromReports = incoming.size
    ? await Gstr1Record.find({ ...base, section: { $in: DOC_SECTIONS }, 'source.sheet': /^mp:/ }).select({ section: 1, data: 1, 'source.sheet': 1 }).lean()
    : [];
  const replaced = [...new Set(fromReports.filter((r) => incoming.has(docKey(r.section, r.data as { inum?: string; ntNum?: string }))).map((r) => (r.source as { sheet: string }).sheet))];
  // Replaces what came from the Excel template (and any sales-report import it repeats); manual entries stay.
  const keep: RegExp = replaced.length ? new RegExp(`^(manual$|mp:(?!(${replaced.map((x) => x.slice(3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$))`) : OTHER_SOURCES;
  await Promise.all([
    Gstr1Record.deleteMany({ ...base, 'source.sheet': { $not: keep } }),
    Gstr1Error.deleteMany({ ...base, $or: [{ origin: { $ne: 'import' } }, { sheet: { $not: keep } }] }),
    GeneratedJson.deleteMany(base),
  ]);
  if (replaced.length) {
    await GstReturn.updateOne({ _id: ret._id }, { $pull: { marketplaceImports: { marketplace: { $in: replaced.map((x) => x.slice(3)) } } } });
    parsed.issues.push({
      code: 'IMPORT_REPLACED_REPORT', severity: 'warning', section: 'b2b', recordKey: '', sheet: file.name, field: 'source',
      message: `This workbook repeats the invoices of the ${replaced.map((x) => MARKETPLACES[x.slice(3) as MarketplaceId]?.label ?? x.slice(3)).join(', ')} import – that import was replaced by the workbook`,
      suggestion: 'Nothing to do if the workbook is this return’s own Excel download. To use the sales report again, import it again.',
    });
  }
  for (let i = 0; i < parsed.records.length; i += 1000) {
    await Gstr1Record.insertMany(parsed.records.slice(i, i + 1000).map((r) => ({ ...base, section: r.section, key: r.key, source: r.source, data: r.data })), { ordered: false });
  }
  if (parsed.issues.length) await Gstr1Error.insertMany(parsed.issues.map((i) => ({ ...base, origin: 'import', ...i })));

  const importedAt = new Date();
  await changeStatus(auth, ret, 'imported', {
    note: `Imported ${file.name}`,
    set: {
      currentJsonId: null, jsonStale: false,
      importInfo: { fileName: file.name, importedAt, sheetsParsed: parsed.sheetsParsed, sheetsSkipped: parsed.sheetsSkipped, importIssueCount: parsed.issues.length },
    },
  });
  await auditReturn(auth, ret, 'return.import', {
    fileName: file.name, importedAt: importedAt.toISOString(), records: parsed.records.length,
    sheets: parsed.sheetsParsed.map((s) => s.sheet), skipped: parsed.sheetsSkipped.map((s) => s.sheet), importIssues: parsed.issues.length,
  });
  const validation = await revalidate(auth, returnId, { silent: true });
  return { sheetsParsed: parsed.sheetsParsed, sheetsSkipped: parsed.sheetsSkipped, importIssues: parsed.issues.length, summary: validation.summary };
}

/* ---------- validate ---------- */

export async function revalidate(auth: Auth, returnId: string, opts: { silent?: boolean } = {}) {
  const { ret, company } = await loadReturn(auth, returnId);
  const docs = await Gstr1Record.find({ returnId: ret._id, orgId: ret.orgId }).lean();
  const records = docs.map(toRecord);
  const { issues, summary } = validateReturn(records, contextFor(ret, company));

  const base = { orgId: ret.orgId, returnId: ret._id };
  await Gstr1Error.deleteMany({ ...base, origin: 'validation' });
  for (let i = 0; i < issues.length; i += 1000) {
    await Gstr1Error.insertMany(issues.slice(i, i + 1000).map((x) => ({ ...base, origin: 'validation', ...x })));
  }
  const errKeys = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.recordKey));
  const warnKeys = new Set(issues.filter((i) => i.severity === 'warning').map((i) => i.recordKey));
  const ops = docs
    .map((d) => ({ d, e: errKeys.has(d.key), w: warnKeys.has(d.key) }))
    .filter(({ d, e, w }) => d.hasErrors !== e || d.hasWarnings !== w)
    .map(({ d, e, w }) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { hasErrors: e, hasWarnings: w } } } }));
  if (ops.length) await Gstr1Record.bulkWrite(ops);

  const blocking = issues.some((i) => i.severity === 'error');
  await GstReturn.updateOne({ _id: ret._id }, { $set: { summary, lastValidatedAt: new Date() } });
  const target = validationTarget(ret, blocking, summary.total);
  if (target) await changeStatus(auth, ret, target, { note: `Validation: ${summary.errorCount} errors, ${summary.warningCount} warnings` });
  await auditReturn(auth, ret, opts.silent ? 'return.validate.auto' : 'return.validate', {
    total: summary.total, valid: summary.valid, errors: summary.errorCount, warnings: summary.warningCount, result: blocking ? 'validation_error' : 'valid',
  });
  return { summary, issues: issues.length };
}

/** Status after validation, or null to leave it alone (portal side / nothing changed since JSON). */
function validationTarget(ret: GstReturnDoc, blocking: boolean, total: number): ReturnStatus | null {
  const s = normalizeStatus(ret.status);
  if (DATA_LOCKED.has(s) || s === 'draft' || !total) return null;
  if (blocking) return 'validation_error';
  const jsonCurrent = !!ret.currentJsonId && !ret.jsonStale;
  if ((s === 'json_generated' || s === 'ready_for_upload' || s === 'error') && jsonCurrent) return null;
  return 'validated';
}

function assertEditable(status: string, what: string) {
  const s = normalizeStatus(status);
  if (DATA_LOCKED.has(s)) throw new HttpError(409, `The return is "${STATUS_LABELS[s]}" – ${what} is locked. ${s === 'uploading' ? 'Cancel the upload first.' : ''}`.trim());
}

/* ---------- edit ---------- */

const NUMERIC_FIELDS = new Set(['val', 'rt', 'txval', 'iamt', 'camt', 'samt', 'csamt', 'adAmt', 'qty', 'totnum', 'cancel', 'nilAmt', 'exptAmt', 'ngsupAmt', 'diffPercent']);
const UPPER_FIELDS = new Set(['ctin', 'etin', 'portCode', 'uqc', 'ntty', 'typ', 'expTyp', 'urType', 'invTyp', 'rchrg', 'splyTy']);
const toNum = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Keeps only the record's known fields and coerces types, so a crafted PATCH can't break validation or the JSON. */
function sanitize(original: Record<string, unknown>, incoming: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(original), ...['etin', 'receiverName', 'portCode', 'sbNum', 'sbDt', 'desc', 'diffPercent'].filter((k) => k in incoming)]);
  for (const k of keys) {
    if (k === 'items') continue;
    const v = k in incoming ? incoming[k] : original[k];
    const str = v == null ? (original[k] === undefined ? undefined : '') : String(v).trim();
    out[k] = NUMERIC_FIELDS.has(k) ? toNum(v) : UPPER_FIELDS.has(k) && str ? str.toUpperCase() : str;
  }
  if (Array.isArray(original.items)) {
    const items = Array.isArray(incoming.items) ? incoming.items : original.items;
    const itemKeys = Object.keys((original.items as Record<string, unknown>[])[0] ?? { rt: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    out.items = (items as Record<string, unknown>[]).slice(0, 50).map((it) => Object.fromEntries(itemKeys.map((k) => [k, toNum(it?.[k])])));
  }
  return out;
}

export async function updateRecord(auth: Auth, returnId: string, recordId: string, data: unknown, recomputeTax: boolean) {
  const { ret, company } = await loadReturn(auth, returnId);
  assertEditable(ret.status, 'editing');
  const doc = await Gstr1Record.findOne({ _id: oid(recordId), returnId: ret._id, orgId: ret.orgId }).lean();
  if (!doc) throw new HttpError(404, 'Record not found');
  if (!data || typeof data !== 'object') throw new HttpError(400, 'data must be an object');

  let rec = toRecord({ ...doc, data: sanitize(doc.data as Record<string, unknown>, data as Record<string, unknown>) });
  if (recomputeTax) rec = recomputeRecordTax(rec, company.gstin);
  const key = naturalKey(rec) ?? doc.key;
  await Gstr1Record.updateOne({ _id: doc._id }, { $set: { data: rec.data, key, edited: true } });
  if (key !== doc.key) await Gstr1Error.updateMany({ returnId: ret._id, orgId: ret.orgId, recordKey: doc.key }, { $set: { recordKey: key } });
  await GstReturn.updateOne({ _id: ret._id }, { $set: { jsonStale: !!ret.currentJsonId } });
  await auditReturn(auth, ret, 'record.update', { section: doc.section, key: doc.key, before: doc.data, after: rec.data }, 'Gstr1Record', String(doc._id));
  const v = await revalidate(auth, returnId, { silent: true });
  return { record: { ...doc, key, data: rec.data, edited: true }, summary: v.summary };
}

/** Adds a record typed in by the user (manual return entry, like the offline tool's forms). */
export async function createRecord(auth: Auth, returnId: string, section: string, data: unknown, recomputeTax: boolean) {
  const { ret, company } = await loadReturn(auth, returnId);
  assertEditable(ret.status, 'adding entries');
  if (!(SECTIONS as readonly string[]).includes(section)) throw new HttpError(400, 'Unknown section');
  if (!data || typeof data !== 'object') throw new HttpError(400, 'data must be an object');
  const blank = blankRecordData(section as Section, company.gstin.slice(0, 2)) as unknown as Record<string, unknown>;
  const id = new Types.ObjectId();
  let rec = toRecord({ section, key: '', source: { sheet: 'manual', rows: [] }, data: sanitize(blank, data as Record<string, unknown>) });
  if (recomputeTax) rec = recomputeRecordTax(rec, company.gstin);
  rec.key = naturalKey(rec) ?? `${section}|manual|${String(id)}`;
  await Gstr1Record.create({ _id: id, orgId: ret.orgId, returnId: ret._id, section, key: rec.key, source: rec.source, data: rec.data, edited: true });
  await GstReturn.updateOne({ _id: ret._id }, { $set: { jsonStale: !!ret.currentJsonId } });
  if (normalizeStatus(ret.status) === 'draft') await changeStatus(auth, ret, 'imported', { note: 'Manual entry started' });
  await auditReturn(auth, ret, 'record.create', { section, key: rec.key, data: rec.data }, 'Gstr1Record', String(id));
  const v = await revalidate(auth, returnId, { silent: true });
  return { record: { _id: String(id), section, key: rec.key, data: rec.data }, summary: v.summary };
}

export async function deleteRecord(auth: Auth, returnId: string, recordId: string) {
  const { ret } = await loadReturn(auth, returnId);
  assertEditable(ret.status, 'editing');
  const doc = await Gstr1Record.findOneAndDelete({ _id: oid(recordId), returnId: ret._id, orgId: ret.orgId }).lean();
  if (!doc) throw new HttpError(404, 'Record not found');
  await GstReturn.updateOne({ _id: ret._id }, { $set: { jsonStale: !!ret.currentJsonId } });
  await auditReturn(auth, ret, 'record.delete', { section: doc.section, key: doc.key, data: doc.data }, 'Gstr1Record', String(doc._id));
  return (await revalidate(auth, returnId, { silent: true })).summary;
}

/* ---------- JSON ---------- */

export async function generateJson(auth: Auth, returnId: string) {
  assertEditable((await loadReturn(auth, returnId)).ret.status, 'JSON generation');
  await revalidate(auth, returnId, { silent: true });
  const { ret, company } = await loadReturn(auth, returnId);
  const s = ret.summary as { errorCount?: number; total?: number } | undefined;
  if (!s?.total) throw new HttpError(422, 'Nothing to generate – import data first');
  if (s.errorCount) throw new HttpError(422, `Fix ${s.errorCount} validation error(s) before generating JSON`);

  const docs = await Gstr1Record.find({ returnId: ret._id, orgId: ret.orgId }).sort({ section: 1, _id: 1 }).lean();
  const ctx = contextFor(ret, company);
  const { json, log } = generateGstr1Json(docs.map(toRecord), ctx);
  const check = validateGstr1Json(json);
  if (!check.ok) {
    await auditReturn(auth, ret, 'json.schema_failed', { errors: check.errors.slice(0, 20) });
    throw new HttpError(422, 'Generated JSON failed schema validation', check.errors.slice(0, 50));
  }
  const payload = JSON.stringify(json);
  const hash = sha256(payload);
  const saved = await GeneratedJson.create({
    orgId: ret.orgId, returnId: ret._id, version: ctx.profile.jsonVersion, profileId: ctx.profile.id,
    payload, sha256: hash, sizeBytes: Buffer.byteLength(payload), log, createdBy: oid(auth.userId),
  });
  await changeStatus(auth, ret, 'json_generated', { note: `JSON ${ctx.profile.jsonVersion}, sha256 ${hash.slice(0, 12)}…`, set: { currentJsonId: saved._id, jsonStale: false } });
  await auditReturn(auth, ret, 'json.generate', {
    jsonId: String(saved._id), generatedAt: saved.createdAt.toISOString(), sha256: hash, version: ctx.profile.jsonVersion,
    profile: ctx.profile.id, sizeBytes: saved.sizeBytes, sections: log.sections,
  }, 'GeneratedJson', String(saved._id));
  return { id: String(saved._id), sha256: hash, sizeBytes: saved.sizeBytes, log, fileName: jsonFileName(company.gstin, ret.fp) };
}

export const jsonFileName = (gstin: string, fp: string) => `GSTR1_${gstin}_${fp}.json`;

