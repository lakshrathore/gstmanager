import 'server-only';
import {
  financialYear, generateGstr1Json, parseGstr1Tables, parsePortalErrorReport, periodBounds, profileForPeriod,
  naturalKey, readWorkbook, recomputeRecordTax, validateGstr1Json, validateReturn,
  type AnyRecord, type ReturnContext, type ValidationIssue,
} from '@/engine';
import { audit } from '../audit';
import { canAccessCompany, type Auth } from '../auth';
import { sha256 } from '../crypto';
import { HttpError } from '../http';
import {
  Company, GeneratedJson, GstReturn, Gstr1Error, Gstr1Record, oid, UploadJob,
  type CompanyDoc, type GstReturnDoc,
} from '../models';

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
  const company = await loadCompany(auth, String(r.companyId));
  return { ret: r as GstReturnDoc, company };
}

export function contextFor(ret: GstReturnDoc, company: CompanyDoc): ReturnContext {
  return {
    supplierGstin: company.gstin, fp: ret.fp, quarterly: !!ret.quarterly,
    aatoAbove5Cr: !!company.aatoAbove5Cr, profile: profileForPeriod(ret.fp),
  };
}

const toRecord = (d: { section: string; key: string; source: unknown; data: unknown }) =>
  ({ section: d.section, key: d.key, source: d.source ?? { sheet: '', rows: [] }, data: d.data }) as AnyRecord;

/* ---------- create ---------- */

export async function createReturn(auth: Auth, companyId: string, fp: string) {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp)) throw new HttpError(400, 'Return period must be MMYYYY');
  const company = await loadCompany(auth, companyId);
  const quarterly = company.filingFrequency === 'quarterly';
  if (quarterly && !['03', '06', '09', '12'].includes(fp.slice(0, 2))) throw new HttpError(400, 'Quarterly filers must pick the quarter-ending month');
  const existing = await GstReturn.findOne({ orgId: oid(auth.orgId), companyId: company._id, fp }).lean();
  if (existing) return existing;
  const ret = await GstReturn.create({
    orgId: oid(auth.orgId), companyId: company._id, gstin: company.gstin, fp, quarterly,
    fy: financialYear(periodBounds(fp).start), profileId: profileForPeriod(fp).id,
  });
  await audit(auth, 'return.create', 'GstReturn', String(ret._id), { gstin: company.gstin, fp });
  return ret.toObject();
}

/* ---------- import ---------- */

export async function importExcel(auth: Auth, returnId: string, file: File) {
  const { ret, company } = await loadReturn(auth, returnId);
  if (['uploaded', 'processing', 'filed'].includes(ret.status)) throw new HttpError(409, `Return is ${ret.status}; re-import is blocked`);
  if (!/\.xlsx$/i.test(file.name)) throw new HttpError(400, 'Upload the .xlsx GSTR-1 template (Excel 2007+)');
  if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'File too large (max 25 MB)');

  const tables = await readWorkbook(Buffer.from(await file.arrayBuffer()));
  const ctx = contextFor(ret, company);
  const parsed = parseGstr1Tables(tables, { supplierGstin: company.gstin, hsnSplit: ctx.profile.hsnSplit });
  if (!parsed.sheetsParsed.length) throw new HttpError(422, 'No GSTR-1 sheets recognised in this workbook', parsed.sheetsSkipped);

  const base = { orgId: ret.orgId, returnId: ret._id };
  await Promise.all([Gstr1Record.deleteMany(base), Gstr1Error.deleteMany(base), GeneratedJson.deleteMany(base)]);
  for (let i = 0; i < parsed.records.length; i += 1000) {
    await Gstr1Record.insertMany(parsed.records.slice(i, i + 1000).map((r) => ({ ...base, section: r.section, key: r.key, source: r.source, data: r.data })), { ordered: false });
  }
  if (parsed.issues.length) await Gstr1Error.insertMany(parsed.issues.map((i) => ({ ...base, origin: 'import', ...i })));

  await GstReturn.updateOne({ _id: ret._id }, {
    $set: {
      status: 'imported', currentJsonId: null, jsonStale: false,
      importInfo: { fileName: file.name, importedAt: new Date(), sheetsParsed: parsed.sheetsParsed, sheetsSkipped: parsed.sheetsSkipped, importIssueCount: parsed.issues.length },
    },
  });
  await audit(auth, 'return.import', 'GstReturn', String(ret._id), {
    fileName: file.name, records: parsed.records.length, sheets: parsed.sheetsParsed.map((s) => s.sheet), skipped: parsed.sheetsSkipped.map((s) => s.sheet),
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
  const keepStatus = ['uploaded', 'processing', 'processed', 'processed_with_errors', 'filed'].includes(ret.status);
  await GstReturn.updateOne({ _id: ret._id }, {
    $set: {
      summary, lastValidatedAt: new Date(),
      ...(keepStatus ? {} : { status: blocking ? 'has_errors' : ret.status === 'json_generated' && !ret.jsonStale ? 'json_generated' : 'validated' }),
    },
  });
  if (!opts.silent) await audit(auth, 'return.validate', 'GstReturn', String(ret._id), { total: summary.total, errors: summary.errorCount, warnings: summary.warningCount });
  return { summary, issues: issues.length };
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
  if (['uploaded', 'processing', 'filed'].includes(ret.status)) throw new HttpError(409, 'Return is locked while an upload is in progress or after filing');
  const doc = await Gstr1Record.findOne({ _id: oid(recordId), returnId: ret._id, orgId: ret.orgId }).lean();
  if (!doc) throw new HttpError(404, 'Record not found');
  if (!data || typeof data !== 'object') throw new HttpError(400, 'data must be an object');

  let rec = toRecord({ ...doc, data: sanitize(doc.data as Record<string, unknown>, data as Record<string, unknown>) });
  if (recomputeTax) rec = recomputeRecordTax(rec, company.gstin);
  const key = naturalKey(rec) ?? doc.key;
  await Gstr1Record.updateOne({ _id: doc._id }, { $set: { data: rec.data, key, edited: true } });
  if (key !== doc.key) await Gstr1Error.updateMany({ returnId: ret._id, orgId: ret.orgId, recordKey: doc.key }, { $set: { recordKey: key } });
  await GstReturn.updateOne({ _id: ret._id }, { $set: { jsonStale: !!ret.currentJsonId } });
  await audit(auth, 'record.update', 'Gstr1Record', String(doc._id), { returnId, section: doc.section, key: doc.key, before: doc.data, after: rec.data });
  const v = await revalidate(auth, returnId, { silent: true });
  return { record: { ...doc, key, data: rec.data, edited: true }, summary: v.summary };
}

export async function deleteRecord(auth: Auth, returnId: string, recordId: string) {
  const { ret } = await loadReturn(auth, returnId);
  if (['uploaded', 'processing', 'filed'].includes(ret.status)) throw new HttpError(409, 'Return is locked');
  const doc = await Gstr1Record.findOneAndDelete({ _id: oid(recordId), returnId: ret._id, orgId: ret.orgId }).lean();
  if (!doc) throw new HttpError(404, 'Record not found');
  await GstReturn.updateOne({ _id: ret._id }, { $set: { jsonStale: !!ret.currentJsonId } });
  await audit(auth, 'record.delete', 'Gstr1Record', String(doc._id), { returnId, section: doc.section, key: doc.key, data: doc.data });
  return (await revalidate(auth, returnId, { silent: true })).summary;
}

/* ---------- JSON ---------- */

export async function generateJson(auth: Auth, returnId: string) {
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
    await audit(auth, 'json.schema_failed', 'GstReturn', String(ret._id), { errors: check.errors.slice(0, 20) });
    throw new HttpError(422, 'Generated JSON failed schema validation', check.errors.slice(0, 50));
  }
  const payload = JSON.stringify(json);
  const hash = sha256(payload);
  const saved = await GeneratedJson.create({
    orgId: ret.orgId, returnId: ret._id, version: ctx.profile.jsonVersion, profileId: ctx.profile.id,
    payload, sha256: hash, sizeBytes: Buffer.byteLength(payload), log, createdBy: oid(auth.userId),
  });
  const locked = ['uploaded', 'processing', 'processed', 'filed'].includes(ret.status);
  await GstReturn.updateOne({ _id: ret._id }, { $set: { currentJsonId: saved._id, jsonStale: false, ...(locked ? {} : { status: 'json_generated' }) } });
  await audit(auth, 'json.generate', 'GeneratedJson', String(saved._id), { returnId, sha256: hash, version: ctx.profile.jsonVersion, sizeBytes: saved.sizeBytes, sections: log.sections });
  return { id: String(saved._id), sha256: hash, sizeBytes: saved.sizeBytes, log, fileName: jsonFileName(company.gstin, ret.fp) };
}

export const jsonFileName = (gstin: string, fp: string) => `GSTR1_${gstin}_${fp}.json`;

/* ---------- portal error report ---------- */

export async function importPortalErrors(auth: Auth, returnId: string, report: unknown) {
  const { ret } = await loadReturn(auth, returnId);
  const errors = parsePortalErrorReport(report);
  const r = report as { gstin?: string; fp?: string };
  if (r?.gstin && r.gstin !== ret.gstin) throw new HttpError(400, `Error report is for ${r.gstin}, not ${ret.gstin}`);
  if (r?.fp && r.fp !== ret.fp) throw new HttpError(400, `Error report is for period ${r.fp}, not ${ret.fp}`);

  const docs = await Gstr1Record.find({ returnId: ret._id, orgId: ret.orgId }).select({ section: 1, key: 1, data: 1 }).lean();
  const findKey = (section: string, docNo?: string, ctin?: string) => {
    if (!docNo) return '';
    const up = docNo.toUpperCase();
    const d = docs.find((x) => {
      if (x.section !== section) return false;
      const dd = x.data as Record<string, string>;
      const no = (dd.inum ?? dd.ntNum ?? dd.hsn ?? '').toUpperCase();
      return no === up && (!ctin || !dd.ctin || dd.ctin === ctin);
    });
    return d?.key ?? '';
  };
  const rows: Partial<ValidationIssue & { origin: string }>[] = errors.map((e) => ({
    origin: 'portal', code: e.errorCode ?? 'PORTAL', severity: 'error', section: e.section as ValidationIssue['section'],
    recordKey: findKey(e.section, e.documentNo, e.ctin), documentNo: e.documentNo, field: e.path, message: e.message,
    suggestion: 'Correct the record and re-upload the regenerated JSON.',
  }));
  const base = { orgId: ret.orgId, returnId: ret._id };
  await Gstr1Error.deleteMany({ ...base, origin: 'portal' });
  if (rows.length) await Gstr1Error.insertMany(rows.map((x) => ({ ...base, ...x })));
  const keys = [...new Set(rows.map((x) => x.recordKey).filter(Boolean))];
  if (keys.length) await Gstr1Record.updateMany({ ...base, key: { $in: keys } }, { $set: { hasErrors: true } });

  const status = rows.length ? 'processed_with_errors' : 'processed';
  await GstReturn.updateOne({ _id: ret._id }, { $set: { status } });
  await UploadJob.findOneAndUpdate({ ...base }, { $set: { status, portalErrorCount: rows.length }, $push: { history: { at: new Date(), status, note: `Portal error report imported (${rows.length})` } } }, { sort: { createdAt: -1 } });
  await audit(auth, 'portal.errors_imported', 'GstReturn', String(ret._id), { count: rows.length, matched: keys.length });
  return { count: rows.length, matched: keys.length, status };
}
