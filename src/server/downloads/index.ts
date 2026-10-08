import 'server-only';
import JSZip from 'jszip';
import { canAccessCompany, type Auth } from '../auth';
import { HttpError } from '../http';
import { AnnualReturn, Company, GeneratedJson, GstReturn, Gstr1Record, Gstr3b, oid, type CompanyDoc } from '../models';
import { audit } from '../gst/gst-audit';
import { checkFy, KIND, renderAnnual, validateFor, XLSX, type AnnualKind } from '../gst/annual';
import { fyInfo, fyOf, isBlank } from '../gst/annual/common';
import { jsonFileName, toRecord } from '../gst/gstr1';
import { gstr3bWorkbook } from '../gst/gstr3b/excel';
import { normalizeForm, saveBody } from '../gst/gstr3b/protocol';
import { normalizeStatus, STATUS_LABELS } from '../gst/gst-status/statuses';
import { gstr1Workbook } from './gstr1Excel';

/**
 * Download center: every prepared return (GSTR-1, GSTR-3B, GSTR-9, GSTR-9C) matching the chosen
 * companies, periods and filing status, one file at a time or all together as a ZIP.
 */

export const RETURN_TYPES = ['gstr1', 'gstr3b', 'gstr9', 'gstr9c'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];
export type Format = 'json' | 'xlsx';
const TYPE_NAME: Record<ReturnType, string> = { gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', gstr9: 'GSTR-9', gstr9c: 'GSTR-9C' };
const STATUS_3B: Record<string, string> = { draft: 'Draft', saving: 'Saving to GSTN', saved: 'Saved on GSTN', offset: 'Liability offset', filed: 'Filed' };

export interface Criteria {
  types: ReturnType[];
  /** Empty = every company the user can see. */
  companyIds: string[];
  /** MMYYYY, inclusive. Annual returns are included when their financial year overlaps the range. */
  from: string;
  to: string;
  status: 'all' | 'filed' | 'unfiled';
}

/** Whether a format can be downloaded, and why not. */
interface Avail { ok: boolean; note?: string }
export interface Item {
  type: ReturnType; typeName: string;
  companyId: string; companyName: string; gstin: string;
  /** MMYYYY for monthly returns, "2024-25" for annual ones. */
  period: string;
  status: string; statusLabel: string; filed: boolean;
  updatedAt: Date | null;
  formats: Record<Format, Avail>;
}

const key = (fp: string) => Number(fp.slice(2)) * 12 + Number(fp.slice(0, 2));

export function checkCriteria(c: Criteria) {
  for (const fp of [c.from, c.to]) if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp)) throw new HttpError(400, 'Periods must be MMYYYY');
  if (key(c.from) > key(c.to)) throw new HttpError(400, '“From” must not be after “to”.');
  if (key(c.to) - key(c.from) > 120) throw new HttpError(400, 'Pick at most 10 years at a time.');
  if (!c.types.length) throw new HttpError(400, 'Pick at least one return type.');
}

function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  for (let k = key(from); k <= key(to); k++) {
    const y = Math.floor((k - 1) / 12);
    const m = k - y * 12;
    out.push(`${String(m).padStart(2, '0')}${y}`);
  }
  return out;
}

async function companiesFor(auth: Auth, ids: string[]) {
  const all = await Company.find({ orgId: oid(auth.orgId) }).lean();
  return (all as CompanyDoc[]).filter((c) => canAccessCompany(auth, String(c._id)) && (!ids.length || ids.includes(String(c._id))));
}

export async function listReturns(auth: Auth, c: Criteria): Promise<Item[]> {
  checkCriteria(c);
  const companies = await companiesFor(auth, c.companyIds);
  if (!companies.length) return [];
  const byId = new Map(companies.map((x) => [String(x._id), x]));
  const base = { orgId: oid(auth.orgId), companyId: { $in: companies.map((x) => x._id) } };
  const months = monthsBetween(c.from, c.to);
  const fys = [...new Set(months.map(fyOf))];
  const items: Item[] = [];
  const add = (type: ReturnType, companyId: unknown, period: string, status: string, statusLabel: string, updatedAt: Date | null | undefined, formats: Record<Format, Avail>) => {
    const co = byId.get(String(companyId))!;
    items.push({ type, typeName: TYPE_NAME[type], companyId: String(co._id), companyName: co.name, gstin: co.gstin, period, status, statusLabel, filed: status === 'filed', updatedAt: updatedAt ?? null, formats });
  };

  if (c.types.includes('gstr1')) {
    const rets = await GstReturn.find({ ...base, fp: { $in: months } }).lean();
    const counts = rets.length
      ? await Gstr1Record.aggregate<{ _id: unknown; n: number }>([{ $match: { orgId: oid(auth.orgId), returnId: { $in: rets.map((r) => r._id) } } }, { $group: { _id: '$returnId', n: { $sum: 1 } } }])
      : [];
    const n = new Map(counts.map((x) => [String(x._id), x.n]));
    for (const r of rets) {
      const st = normalizeStatus(r.status);
      add('gstr1', r.companyId, r.fp, st, STATUS_LABELS[st], r.updatedAt, {
        json: r.currentJsonId ? { ok: true, note: r.jsonStale ? 'Data changed after the JSON was generated' : undefined } : { ok: false, note: 'JSON not generated yet' },
        xlsx: n.get(String(r._id)) ? { ok: true } : { ok: false, note: 'No records imported' },
      });
    }
  }
  if (c.types.includes('gstr3b')) {
    const docs = await Gstr3b.find({ ...base, fp: { $in: months } }).select({ companyId: 1, fp: 1, status: 1, form: 1, portalForm: 1, updatedAt: 1 }).lean();
    for (const d of docs) {
      const has = !!(d.form || d.portalForm);
      const st = d.status ?? 'draft';
      add('gstr3b', d.companyId, d.fp, st, STATUS_3B[st] ?? st, d.updatedAt, { json: has ? { ok: true } : { ok: false, note: 'Not prepared yet' }, xlsx: has ? { ok: true } : { ok: false, note: 'Not prepared yet' } });
    }
  }
  const kinds = (['gstr9', 'gstr9c'] as const).filter((k) => c.types.includes(k));
  if (kinds.length) {
    const docs = await AnnualReturn.find({ ...base, kind: { $in: kinds }, fy: { $in: fys } }).lean();
    for (const d of docs) {
      const kind = d.kind as AnnualKind;
      const form = KIND[kind].normalize(d.form ?? {});
      const blank = isBlank(form);
      let json: Avail = blank ? { ok: false, note: 'Not prepared yet' } : { ok: true };
      if (!blank && kind === 'gstr9') {
        const errors = (await validateFor(kind, byId.get(String(d.companyId))!, d.fy, form)).filter((i) => i.severity === 'error').length;
        if (errors) json = { ok: false, note: `${errors} validation error(s)` };
      }
      add(kind, d.companyId, d.fy, d.status ?? 'draft', d.status === 'filed' ? 'Filed' : 'Draft', d.updatedAt, { json, xlsx: blank ? { ok: false, note: 'Not prepared yet' } : { ok: true } });
    }
  }

  const keep = items.filter((x) => c.status === 'all' || (c.status === 'filed') === x.filed);
  const order = (x: Item) => (/^\d{4}-/.test(x.period) ? key(fyInfo(x.period)!.fp) : key(x.period));
  return keep.sort((a, b) => a.companyName.localeCompare(b.companyName) || order(b) - order(a) || RETURN_TYPES.indexOf(a.type) - RETURN_TYPES.indexOf(b.type));
}

/* ---------- one file ---------- */

export interface RenderedFile { fileName: string; contentType: string; bytes: Buffer }

export async function renderReturn(auth: Auth, type: ReturnType, companyId: string, period: string, format: Format): Promise<RenderedFile> {
  if (!RETURN_TYPES.includes(type)) throw new HttpError(400, 'Unknown return type');
  const [company] = await companiesFor(auth, [companyId]);
  if (!company) throw new HttpError(404, 'Company not found');
  const q = { orgId: oid(auth.orgId), companyId: company._id };
  const title = (name: string, p: string) => `${name} – ${company.name} (${company.gstin}) – ${p.length === 6 ? `${p.slice(0, 2)}/${p.slice(2)}` : `FY ${p}`}`;

  if (type === 'gstr9' || type === 'gstr9c') {
    checkFy(period);
    const d = await AnnualReturn.findOne({ ...q, kind: type, fy: period }).lean();
    if (!d?.form) throw new HttpError(404, `${TYPE_NAME[type]} for ${period} is not prepared`);
    return renderAnnual(type, company, period, d.form, format);
  }
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(period)) throw new HttpError(400, 'Period must be MMYYYY');

  if (type === 'gstr1') {
    const ret = await GstReturn.findOne({ ...q, fp: period }).lean();
    if (!ret) throw new HttpError(404, `GSTR-1 for ${period} not found`);
    if (format === 'json') {
      const j = ret.currentJsonId && (await GeneratedJson.findOne({ _id: ret.currentJsonId, orgId: ret.orgId }).lean());
      if (!j) throw new HttpError(404, 'GSTR-1 JSON not generated yet – generate it in the return first');
      return { fileName: jsonFileName(company.gstin, period), contentType: 'application/json', bytes: Buffer.from(j.payload) };
    }
    const recs = await Gstr1Record.find({ orgId: ret.orgId, returnId: ret._id }).sort({ section: 1, _id: 1 }).lean();
    return { fileName: `GSTR1_${company.gstin}_${period}.xlsx`, contentType: XLSX, bytes: await gstr1Workbook(recs.map(toRecord), title('GSTR-1', period)) };
  }

  const d = await Gstr3b.findOne({ ...q, fp: period }).lean();
  // A filed return: what GSTN holds is what was filed.
  const form = d && (d.status === 'filed' && d.portalForm ? d.portalForm : d.form ?? d.portalForm);
  if (!form) throw new HttpError(404, `GSTR-3B for ${period} is not prepared`);
  if (format === 'json') {
    return { fileName: `GSTR3B_${company.gstin}_${period}.json`, contentType: 'application/json', bytes: Buffer.from(JSON.stringify(saveBody(normalizeForm(form), company.gstin, period), null, 2)) };
  }
  return { fileName: `GSTR3B_${company.gstin}_${period}.xlsx`, contentType: XLSX, bytes: await gstr3bWorkbook(normalizeForm(form), title('GSTR-3B', period)) };
}

export async function downloadOne(auth: Auth, type: ReturnType, companyId: string, period: string, format: Format) {
  const f = await renderReturn(auth, type, companyId, period, format);
  await audit(auth, 'download.file', 'Company', companyId, { type, period, format, fileName: f.fileName });
  return f;
}

/* ---------- ZIP ---------- */

const MAX_ZIP_ITEMS = 300;

/** Every matching return in the chosen format(s), in GSTIN/return folders, with a list of what was left out. */
export async function downloadZip(auth: Auth, c: Criteria, formats: Format[]) {
  const items = await listReturns(auth, c);
  if (!items.length) throw new HttpError(404, 'No returns match these filters.');
  if (items.length > MAX_ZIP_ITEMS) throw new HttpError(413, `${items.length} returns match – narrow the filters to at most ${MAX_ZIP_ITEMS}.`);
  const zip = new JSZip();
  const skipped: string[] = [];
  let files = 0;
  for (const it of items) {
    for (const format of formats) {
      const label = `${it.gstin} ${it.typeName} ${it.period} (${format.toUpperCase()})`;
      if (!it.formats[format].ok) { skipped.push(`${label}: ${it.formats[format].note ?? 'not available'}`); continue; }
      try {
        const f = await renderReturn(auth, it.type, it.companyId, it.period, format);
        zip.file(`${it.gstin}/${it.typeName}/${f.fileName}`, f.bytes);
        files++;
      } catch (e) {
        skipped.push(`${label}: ${e instanceof HttpError ? e.message : 'could not be created'}`);
      }
    }
  }
  if (!files) throw new HttpError(404, `None of the ${items.length} matching return(s) has a ${formats.join(' or ').toUpperCase()} file yet.${skipped.length ? ` ${skipped[0]}` : ''}`);
  const readme = [
    `GST returns – downloaded ${new Date().toLocaleString('en-IN')} by ${auth.email}`,
    `Returns: ${c.types.map((t) => TYPE_NAME[t]).join(', ')} · Periods ${c.from} – ${c.to} · Status: ${c.status} · Formats: ${formats.join(', ')}`,
    `${files} file(s).`,
    ...(skipped.length ? ['', 'Not included:', ...skipped.map((s) => `- ${s}`)] : []),
    '',
    'GSTR-1 and GSTR-9 JSON are GSTN upload formats. GSTR-3B JSON is GSTN’s save format (for records; the portal has no GSTR-3B JSON upload).',
    'GSTR-9C JSON is this app’s backup format – GSTN accepts only JSON made by its GSTR-9C offline tool.',
  ].join('\r\n');
  zip.file('README.txt', readme);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await audit(auth, 'download.zip', 'Organization', auth.orgId, { types: c.types, from: c.from, to: c.to, status: c.status, formats, files, skipped: skipped.length });
  return { fileName: `GST-returns_${c.from}-${c.to}.zip`, bytes };
}
