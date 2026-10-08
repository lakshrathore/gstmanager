import 'server-only';
import { recordsFromGstr1Json } from '@/engine';
import type { Auth } from '../auth';
import { HttpError } from '../http';
import { GeneratedJson, Gstr1Error, Gstr1Record, Gstr3b, GstReturn, oid, type CompanyDoc, type GstReturnDoc } from '../models';
import { type FiledReturn, filingsFrom, findGstr1Filing, parseGstnDate } from '../gst/gst-client/sandbox-protocol';
import { sandboxClient, trackReturnsPublic } from '../gst/gst-client/sandbox';
import { DATA_LOCKED, normalizeStatus, STATUS_LABELS, changeStatus } from '../gst/gst-status';
import { recordFiledFromGstn } from '../gst/gst-upload';
import { createReturn, revalidate } from '../gst/gstr1';
import { fetchFromPortal as fetch3b, useValues as take3bValues } from '../gst/gstr3b';
import { isNilForm, normalizeForm } from '../gst/gstr3b/protocol';
import { fillGstr9FromPortal } from '../gst/annual';

/**
 * A return downloaded from the GST portal, shown in the app's own form for that period:
 *   - a blank form is filled with GSTN's data;
 *   - a return GSTN lists as filed gets exactly the filed data and is locked as filed (GSTN's ARN and
 *     Track Returns response kept as the acknowledgement);
 *   - a form that already has the user's own (unfiled) data is kept, unless they ask to replace it.
 */

export type FormState = 'filled' | 'filed' | 'kept' | 'locked' | 'skipped';
export interface FormResult { state: FormState; note: string; link?: string }

const ctxOf = (company: CompanyDoc) => ({ orgId: String(company.orgId), companyId: String(company._id), gstin: company.gstin });

/* ---------- GSTR-1 ---------- */

/** GSTN's filing list for the period (one call); a failure only means the filing status is unknown. */
async function gstr1Filing(company: CompanyDoc, fp: string): Promise<{ filing?: FiledReturn; raw?: unknown }> {
  try {
    const t = await sandboxClient.trackReturn!({ ...ctxOf(company), fp });
    return { filing: findGstr1Filing(t.filings, fp), raw: t.raw };
  } catch (e) {
    if ((e as { name?: string }).name === 'GstnSessionError') throw e;
    return {};
  }
}

export async function gstr1Form(auth: Auth, company: CompanyDoc, fp: string, json: unknown, opts: { replace?: boolean; checkFiled?: boolean } = {}): Promise<FormResult> {
  const quarterly = company.filingFrequency === 'quarterly';
  if (quarterly && !['03', '06', '09', '12'].includes(fp.slice(0, 2))) {
    return { state: 'skipped', note: 'Quarterly filer: the GSTR-1 form is for the quarter-ending month (IFF months are not prepared here).' };
  }
  let ret = (await GstReturn.findOne({ orgId: oid(auth.orgId), companyId: company._id, fp }).lean()) as GstReturnDoc | null;
  if (!ret) {
    try { ret = (await createReturn(auth, String(company._id), fp)) as GstReturnDoc; } catch (e) {
      return { state: 'skipped', note: e instanceof HttpError ? e.message : 'The GSTR-1 form could not be created.' };
    }
  }
  const link = `/returns/${ret._id}`;
  const status = normalizeStatus(ret.status);
  if (status === 'filed') return { state: 'locked', note: 'Already filed here – not changed.', link };

  const { filing, raw } = opts.checkFiled === false ? {} : await gstr1Filing(company, fp);
  const base = { orgId: ret.orgId, returnId: ret._id };
  if (DATA_LOCKED.has(status)) {
    if (filing?.arn) {
      const arn = await recordFiledFromGstn(auth, ret, filing, raw);
      return { state: 'filed', note: `Filed on GSTN (ARN ${arn}) – locked as filed; the data uploaded from here was kept.`, link };
    }
    return { state: 'kept', note: `The return is “${STATUS_LABELS[status]}” here – data not replaced.`, link };
  }

  // Records that came from an earlier portal download are simply refreshed; the user's own are protected.
  const own = await Gstr1Record.countDocuments({ ...base, 'source.sheet': { $ne: 'GST portal' } });
  if (own && !filing?.arn && !opts.replace) {
    return { state: 'kept', note: `The GSTR-1 form already has ${own} record(s) you imported or entered – not replaced. Use “Load into form” to replace them.`, link };
  }
  const records = recordsFromGstr1Json(json as never);
  if (!records.length && !filing?.arn) return { state: 'skipped', note: 'GSTN has no GSTR-1 data for this period.', link };

  // The filed (or downloaded) data replaces everything in the form.
  await Promise.all([Gstr1Record.deleteMany(base), Gstr1Error.deleteMany(base), GeneratedJson.deleteMany(base)]);
  for (let i = 0; i < records.length; i += 1000) {
    await Gstr1Record.insertMany(records.slice(i, i + 1000).map((r) => ({ ...base, section: r.section, key: r.key, source: { sheet: 'GST portal', rows: [] }, data: r.data })), { ordered: false });
  }
  if (records.length) {
    await changeStatus(auth, ret, 'imported', {
      note: 'Loaded from the GST portal',
      set: { currentJsonId: null, jsonStale: false, importInfo: { fileName: 'GST portal (downloaded)', importedAt: new Date(), sheetsParsed: [], sheetsSkipped: [], importIssueCount: 0 } },
    });
    await revalidate(auth, String(ret._id), { silent: true });
  }
  if (filing?.arn) {
    const fresh = (await GstReturn.findById(ret._id).lean()) as GstReturnDoc;
    const arn = await recordFiledFromGstn(auth, fresh, filing, raw);
    return { state: 'filed', note: `Filed on GSTN (ARN ${arn}) – the form shows the filed ${records.length} record(s) and is locked.`, link };
  }
  return { state: 'filled', note: `${records.length} record(s) loaded into the GSTR-1 form.`, link };
}

/* ---------- GSTR-3B ---------- */

/**
 * GSTR-3B through its own "get from GSTN" step: saved details, auto-calculated liability, ledger
 * balance and filing status. A blank form takes GSTN's values; a filed return is locked as filed.
 * Returns GSTN's details JSON for the download centre.
 */
export async function gstr3bForm(auth: Auth, company: CompanyDoc, fp: string, opts: { replace?: boolean } = {}): Promise<{ json: unknown; result: FormResult; notes: string[] }> {
  const before = await Gstr3b.findOne({ orgId: oid(auth.orgId), companyId: company._id, fp }).select({ form: 1, status: 1, formSource: 1, formUpdatedBy: 1 }).lean();
  // Tables that came from GSTN earlier are refreshed with GSTN's latest saved values; the user's own are kept.
  const fromGstn = !!before?.form && before.formUpdatedBy === 'GSTN';
  const r = await fetch3b(auth, String(company._id), fp);
  const doc = await Gstr3b.findOne({ orgId: oid(auth.orgId), companyId: company._id, fp }).lean();
  const link = `/gstr3b?companyId=${company._id}&fp=${fp}`;
  const json = doc?.portalDetails ?? {};
  let result: FormResult;
  if (doc?.status === 'filed') {
    result = before?.status === 'filed'
      ? { state: 'locked', note: 'Already filed here.', link }
      : { state: 'filed', note: `Filed on GSTN (ARN ${doc.portal?.arn ?? ''}) – the form shows the filed return and is locked.`, link };
  } else if (!before?.form && doc?.form) {
    result = { state: 'filled', note: `Tables filled with GSTN’s ${doc.formSource === 'auto' ? 'auto-calculated' : 'saved'} values.`, link };
  } else if (before?.form && doc?.portalForm && !isNilForm(normalizeForm(doc.portalForm)) && (opts.replace || fromGstn) && ['draft', 'saved'].includes(doc.status ?? 'draft')) {
    await take3bValues(auth, String(company._id), fp, 'portal');
    result = { state: 'filled', note: fromGstn && !opts.replace ? 'Tables refreshed with the values saved on GSTN.' : 'Tables replaced with the values saved on GSTN.', link };
  } else if (before?.form) {
    result = { state: 'kept', note: 'The GSTR-3B form already has your values – not replaced. Use “Load into form” to take GSTN’s saved values.', link };
  } else {
    result = { state: 'skipped', note: 'GSTN has no GSTR-3B values for this period yet.', link };
  }
  return { json, result, notes: r.notes };
}

/* ---------- GSTR-9 ---------- */

/** GSTR-9 filing of a financial year from GSTN's public filing list (one call). */
export async function gstr9Filing(company: CompanyDoc, fy: string): Promise<{ arn: string; filedOn: Date | null } | undefined> {
  try {
    const list = filingsFrom(await trackReturnsPublic(company.gstin, fy));
    const f = list.find((x) => (x.rtntype ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === 'GSTR9' && /filed/i.test(x.status ?? '') && !!x.arn);
    return f?.arn ? { arn: f.arn, filedOn: parseGstnDate(f.dof) } : undefined;
  } catch {
    return undefined;
  }
}

export async function gstr9Form(auth: Auth, company: CompanyDoc, fy: string, json: unknown, opts: { replace?: boolean } = {}): Promise<FormResult> {
  const filing = await gstr9Filing(company, fy);
  return fillGstr9FromPortal(auth, String(company._id), fy, json, { filing, replace: opts.replace });
}
