import 'server-only';
import { readWorkbook, type AnyRecord } from '@/engine';
import { can, type Auth } from '../../auth';
import { HttpError } from '../../http';
import { ANNUAL_KINDS, AnnualReturn, Gstr1Record, Gstr3b, GstReturn, oid, type AnnualReturnDoc, type CompanyDoc } from '../../models';
import { audit } from '../gst-audit';
import { loadCompany, toRecord } from '../gstr1';
import { fyInfo, isBlank, parseAnnualExcel, type AnnualForm, type Issue, type TableDef } from './common';
import { annualWorkbook } from './excel';
import { fromGstr9Json, gstr9FromSources, gstr9Json, GSTR9_TABLES, normalizeGstr9, validateGstr9, type Gstr3bSource } from './gstr9';
import { fromGstr9cJson, gstr9cFromGstr9, gstr9cJson, gstr9Figures, GSTR9C_TABLES, normalizeGstr9c, validateGstr9c, type Gstr9Figures } from './gstr9c';

/**
 * GSTR-9 and GSTR-9C, prepared offline: create for a company + financial year → enter, import (Excel
 * or JSON) or auto-fill → validate → download (JSON for the GST portal / offline tool, Excel) → record
 * the ARN once filed on the portal.
 */

export type AnnualKind = (typeof ANNUAL_KINDS)[number];

export const KIND: Record<AnnualKind, { name: string; tables: TableDef[]; normalize: (f: unknown) => AnnualForm }> = {
  gstr9: { name: 'GSTR-9', tables: GSTR9_TABLES, normalize: normalizeGstr9 },
  gstr9c: { name: 'GSTR-9C', tables: GSTR9C_TABLES, normalize: normalizeGstr9c },
};

export function checkKind(kind: string): AnnualKind {
  if (!(ANNUAL_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Return must be gstr9 or gstr9c');
  return kind as AnnualKind;
}

export function checkFy(fy: string) {
  const info = fyInfo(fy);
  if (!info) throw new HttpError(400, 'Financial year must look like 2024-25');
  const now = new Date();
  const current = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  if (info.start < 2017 || info.start > current) throw new HttpError(400, 'Pick a financial year from 2017-18 to the current year');
  return info;
}

async function load(auth: Auth, kindIn: string, companyId: string, fy: string, create = false) {
  const kind = checkKind(kindIn);
  checkFy(fy);
  const company = await loadCompany(auth, companyId);
  const q = { orgId: oid(auth.orgId), companyId: company._id, kind, fy };
  const doc = create
    ? await AnnualReturn.findOneAndUpdate(q, { $setOnInsert: { gstin: company.gstin, status: 'draft' } }, { upsert: true, returnDocument: 'after' }).lean()
    : await AnnualReturn.findOne(q).lean();
  return { kind, company, doc: doc as AnnualReturnDoc | null };
}

async function loadDoc(auth: Auth, kind: string, companyId: string, fy: string) {
  const r = await load(auth, kind, companyId, fy, true);
  return { ...r, doc: r.doc! };
}

const log = (auth: Auth, doc: AnnualReturnDoc, action: string, meta: Record<string, unknown> = {}) =>
  audit(auth, `${doc.kind}.${action}`, 'AnnualReturn', String(doc._id), { gstin: doc.gstin, fy: doc.fy, ...meta });

function assertDraft(doc: AnnualReturnDoc, what: string) {
  if (doc.status === 'filed') throw new HttpError(409, `${KIND[doc.kind as AnnualKind].name} for ${doc.fy} is marked as filed. Reopen it to ${what}.`);
}

/** GSTR-9 of the same company and year, as the figures GSTR-9C reconciles against. */
async function gstr9Of(orgId: unknown, companyId: unknown, fy: string) {
  const g = await AnnualReturn.findOne({ orgId, companyId, kind: 'gstr9', fy }).lean();
  if (!g?.form) return null;
  const form = normalizeGstr9(g.form);
  return isBlank(form) ? null : { form, figures: gstr9Figures(form), status: g.status };
}

/** Validation issues for a form, with what the checks need from elsewhere. */
export async function validateFor(kind: AnnualKind, company: CompanyDoc, fy: string, form: AnnualForm, gstr9?: Gstr9Figures | null): Promise<Issue[]> {
  if (kind === 'gstr9') return validateGstr9(form, { fy, aatoAbove5Cr: !!company.aatoAbove5Cr });
  const g = gstr9 !== undefined ? gstr9 : (await gstr9Of(company.orgId, company._id, fy))?.figures ?? null;
  return validateGstr9c(form, { fy, gstr9: g });
}

/* ---------- overview ---------- */

export async function overview(auth: Auth, kindIn: string, companyId: string, fy: string) {
  const { kind, company, doc } = await load(auth, kindIn, companyId, fy);
  const form = doc?.form ? KIND[kind].normalize(doc.form) : null;
  const g9 = kind === 'gstr9c' ? await gstr9Of(company.orgId, company._id, fy) : null;
  return {
    kind, fy,
    company: { _id: String(company._id), name: company.name, gstin: company.gstin, aatoAbove5Cr: !!company.aatoAbove5Cr },
    status: (doc?.status ?? 'draft') as 'draft' | 'filed',
    form,
    formSource: doc?.formSource ?? null,
    formUpdatedAt: doc?.formUpdatedAt ?? null,
    formUpdatedBy: doc?.formUpdatedBy ?? null,
    notes: doc?.notes ?? [],
    filed: doc?.filed?.arn ? doc.filed : null,
    history: doc?.history ?? [],
    canEdit: can(auth, 'return:edit'),
    canFile: can(auth, 'return:file'),
    /** GSTR-9C: the year's GSTR-9 figures it is checked against (null when there is no GSTR-9 here). */
    gstr9: g9 ? { ...g9.figures, status: g9.status } : null,
    sources: kind === 'gstr9' ? await sourceMonths(auth, company, fy) : null,
  };
}

/** Which months of the year have GSTR-1 / GSTR-3B data in the app (for auto-fill). */
async function sourceMonths(auth: Auth, company: CompanyDoc, fy: string) {
  const months = fyInfo(fy)!.months;
  const [r1, r3] = await Promise.all([
    GstReturn.find({ orgId: oid(auth.orgId), companyId: company._id, fy }).select({ fp: 1 }).lean(),
    Gstr3b.find({ orgId: oid(auth.orgId), companyId: company._id, fp: { $in: months }, form: { $ne: null } }).select({ fp: 1 }).lean(),
  ]);
  return { gstr1: r1.map((x) => x.fp).sort(), gstr3b: r3.map((x) => x.fp).sort() };
}

/* ---------- prepare ---------- */

async function setForm(auth: Auth, doc: AnnualReturnDoc, form: AnnualForm, source: 'auto' | 'manual' | 'excel' | 'json', notes?: string[]) {
  const set: Record<string, unknown> = { form, formSource: source, formUpdatedAt: new Date(), formUpdatedBy: auth.email };
  if (notes) set.notes = notes;
  await AnnualReturn.updateOne({ _id: doc._id, status: 'draft' }, { $set: set });
}

export async function saveDraft(auth: Auth, kind: string, companyId: string, fy: string, input: unknown) {
  const { doc, company } = await loadDoc(auth, kind, companyId, fy);
  assertDraft(doc, 'edit it');
  const form = KIND[doc.kind as AnnualKind].normalize(input);
  await setForm(auth, doc, form, 'manual');
  await log(auth, doc, 'edit');
  const issues = await validateFor(doc.kind as AnnualKind, company, fy, form);
  return { ok: true, errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length };
}

/**
 * GSTR-9 from the year's GSTR-1 records and GSTR-3B returns in the app; GSTR-9C's "as per annual
 * return" figures from the year's GSTR-9. Replaces the prepared GSTR-9; for GSTR-9C only those figures.
 */
export async function autofill(auth: Auth, kind: string, companyId: string, fy: string) {
  const { doc, company } = await loadDoc(auth, kind, companyId, fy);
  assertDraft(doc, 'fill it again');
  if (doc.kind === 'gstr9') {
    const months = fyInfo(fy)!.months;
    const rets = await GstReturn.find({ orgId: oid(auth.orgId), companyId: company._id, fy }).select({ fp: 1, quarterly: 1 }).lean();
    const recs = rets.length ? await Gstr1Record.find({ orgId: oid(auth.orgId), returnId: { $in: rets.map((r) => r._id) } }).lean() : [];
    const byRet = new Map<string, AnyRecord[]>();
    for (const d of recs) byRet.set(String(d.returnId), [...(byRet.get(String(d.returnId)) ?? []), toRecord(d)]);
    const gstr1 = rets.filter((r) => byRet.has(String(r._id))).map((r) => ({ fp: r.fp, quarterly: !!r.quarterly, records: byRet.get(String(r._id))! }));
    const g3 = await Gstr3b.find({ orgId: oid(auth.orgId), companyId: company._id, fp: { $in: months }, form: { $ne: null } }).lean();
    const gstr3b: Gstr3bSource[] = g3.map((d) => {
      const tx = (d.portalDetails as { tx_pmt?: { pdcash?: Record<string, number>[]; pditc?: Record<string, number> } } | undefined)?.tx_pmt;
      const paid = d.status === 'offset' || d.status === 'filed';
      // A filed return: what GSTN holds is what was filed.
      return { fp: d.fp, form: d.status === 'filed' && d.portalForm ? d.portalForm : d.form, payment: paid && tx ? { pdcash: tx.pdcash, pditc: tx.pditc } : null };
    });
    if (!gstr1.length && !gstr3b.length) throw new HttpError(409, `There is no GSTR-1 or GSTR-3B data for ${fy} in the app to fill GSTR-9 from. Import an Excel or JSON file, or enter the tables.`);
    const res = gstr9FromSources(fy, gstr1, gstr3b);
    await setForm(auth, doc, res.form, 'auto', res.notes);
    await log(auth, doc, 'autofill', { gstr1Months: gstr1.length, gstr3bMonths: gstr3b.length });
    return { ok: true, notes: res.notes };
  }
  const g9 = await gstr9Of(company.orgId, company._id, fy);
  if (!g9) throw new HttpError(409, `Prepare GSTR-9 for ${fy} first – GSTR-9C takes its “as per annual return” figures from it.`);
  const res = gstr9cFromGstr9(normalizeGstr9c(doc.form ?? {}), g9.figures, g9.form);
  await setForm(auth, doc, res.form, 'auto', res.notes);
  await log(auth, doc, 'autofill', { from: 'gstr9' });
  return { ok: true, notes: res.notes };
}

/* ---------- import ---------- */

/** Replaces the prepared form with an uploaded Excel (template layout) or JSON file. */
export async function importFile(auth: Auth, kindIn: string, companyId: string, fy: string, file: File) {
  const kind = checkKind(kindIn);
  const name = KIND[kind].name;
  const isJson = /\.json$/i.test(file.name);
  if (!isJson && !/\.xlsx$/i.test(file.name)) throw new HttpError(400, `Upload the ${name} Excel template (.xlsx) or a ${name} JSON file`);
  if (file.size > 10 * 1024 * 1024) throw new HttpError(413, 'File too large (max 10 MB)');
  const { doc, company } = await loadDoc(auth, kind, companyId, fy);
  assertDraft(doc, 'import into it');
  const bytes = Buffer.from(await file.arrayBuffer());
  const issues: string[] = [];
  let form: AnnualForm;
  let read: Record<string, number>;

  if (isJson) {
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw new HttpError(422, 'The file is not valid JSON.');
    }
    let gstin: string | undefined;
    if (kind === 'gstr9') {
      const res = fromGstr9Json(json);
      if (!res.read) throw new HttpError(422, 'No GSTR-9 tables (table4 … table18) found in this JSON.');
      form = res.form; gstin = res.gstin; read = { tables: res.read };
      if (res.fp && res.fp !== fyInfo(fy)!.fp) issues.push(`The JSON is for return period ${res.fp}; GSTR-9 for ${fy} uses ${fyInfo(fy)!.fp}.`);
    } else {
      const res = fromGstr9cJson(json);
      if (!res) throw new HttpError(422, 'This is not a GSTR-9C JSON exported from this app. GSTN’s offline tool JSON cannot be read back – import the Excel instead.');
      form = res.form; gstin = res.gstin; read = { tables: Object.keys(res.form.v).length };
      if (res.fy && res.fy !== fy) issues.push(`The JSON is for ${res.fy}, imported into ${fy}.`);
    }
    if (gstin && gstin.toUpperCase() !== company.gstin) throw new HttpError(422, `The JSON is for GSTIN ${gstin}, not ${company.gstin}.`);
  } else {
    let sheets;
    try {
      sheets = await readWorkbook(bytes, 5000);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    const res = parseAnnualExcel(KIND[kind].tables, sheets, name);
    if (!res.read.rows && !res.read.listRows && !res.read.text) throw new HttpError(422, res.issues.join(' '));
    form = res.form; read = res.read; issues.push(...res.issues);
  }
  await setForm(auth, doc, form, isJson ? 'json' : 'excel', issues.length ? [`Import of ${file.name}:`, ...issues.slice(0, 50)] : []);
  await log(auth, doc, 'import', { fileName: file.name, ...read, issues: issues.length });
  return { ok: true, read, issues };
}

/* ---------- download ---------- */

export const annualFileName = (kind: AnnualKind, gstin: string, fy: string, ext: 'json' | 'xlsx') => `${KIND[kind].name.replace('-', '')}_${gstin}_${fy}.${ext}`;

/**
 * The prepared return as a file. GSTR-9 JSON is GSTN's upload format and is refused while the form
 * has errors; GSTR-9C JSON is this app's backup format; Excel is always available.
 */
export async function renderAnnual(kind: AnnualKind, company: CompanyDoc, fy: string, formIn: unknown, format: 'json' | 'xlsx') {
  const form = KIND[kind].normalize(formIn ?? {});
  const name = KIND[kind].name;
  if (format === 'xlsx') {
    const title = `${name} – ${company.name} (${company.gstin}) – FY ${fy}`;
    return { fileName: annualFileName(kind, company.gstin, fy, 'xlsx'), contentType: XLSX, bytes: await annualWorkbook(KIND[kind].tables, form, title) };
  }
  if (kind === 'gstr9') {
    const errors = (await validateFor(kind, company, fy, form)).filter((i) => i.severity === 'error');
    if (errors.length) throw new HttpError(422, `GSTR-9 has ${errors.length} error(s) – fix them before downloading the JSON for the portal. First: ${errors[0].message}`);
    return { fileName: annualFileName(kind, company.gstin, fy, 'json'), contentType: 'application/json', bytes: Buffer.from(JSON.stringify(gstr9Json(form, company.gstin, fy))) };
  }
  return { fileName: annualFileName(kind, company.gstin, fy, 'json'), contentType: 'application/json', bytes: Buffer.from(JSON.stringify(gstr9cJson(form, company.gstin, fy), null, 2)) };
}

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function download(auth: Auth, kindIn: string, companyId: string, fy: string, format: 'json' | 'xlsx') {
  const { kind, company, doc } = await load(auth, kindIn, companyId, fy);
  const file = await renderAnnual(kind, company, fy, doc?.form, format);
  if (doc) await log(auth, doc, 'download', { format });
  return file;
}

/* ---------- filed on the portal ---------- */

export async function markFiled(auth: Auth, kind: string, companyId: string, fy: string, input: { arn: string; filedOn: string }) {
  if (!can(auth, 'return:file')) throw new HttpError(403, 'Only an owner or admin can mark the return as filed.');
  const arn = input.arn.trim().toUpperCase();
  if (!/^[A-Z0-9]{10,20}$/.test(arn)) throw new HttpError(422, 'Enter the ARN exactly as shown on the GST portal (letters and digits, e.g. AA0703250123456).');
  const filedOn = new Date(input.filedOn);
  if (Number.isNaN(filedOn.getTime()) || filedOn > new Date()) throw new HttpError(422, 'Enter the filing date (not in the future).');
  const { doc } = await loadDoc(auth, kind, companyId, fy);
  assertDraft(doc, 'mark it filed again');
  if (!doc.form || isBlank(KIND[doc.kind as AnnualKind].normalize(doc.form))) throw new HttpError(409, 'Prepare the return before marking it filed.');
  const r = await AnnualReturn.updateOne(
    { _id: doc._id, status: 'draft' },
    {
      $set: { status: 'filed', filed: { arn, filedOn, recordedAt: new Date(), recordedBy: auth.email } },
      $push: { history: { at: new Date(), from: 'draft', to: 'filed', note: `ARN ${arn}`, byEmail: auth.email } },
    },
  );
  if (!r.modifiedCount) throw new HttpError(409, 'The return was changed by someone else in the meantime. Reload and try again.');
  await log(auth, doc, 'mark_filed', { arn });
  return { ok: true };
}

export async function reopen(auth: Auth, kind: string, companyId: string, fy: string, reason: string) {
  if (!can(auth, 'return:file')) throw new HttpError(403, 'Only an owner or admin can reopen a filed return.');
  const { doc } = await loadDoc(auth, kind, companyId, fy);
  if (doc.status !== 'filed') throw new HttpError(409, 'The return is not marked as filed.');
  await AnnualReturn.updateOne(
    { _id: doc._id, status: 'filed' },
    { $set: { status: 'draft' }, $unset: { filed: 1 }, $push: { history: { at: new Date(), from: 'filed', to: 'draft', note: reason.slice(0, 200), byEmail: auth.email } } },
  );
  await log(auth, doc, 'reopen', { reason: reason.slice(0, 200), arn: doc.filed?.arn });
  return { ok: true };
}
