import 'server-only';
import { can, type Auth } from '../../auth';
import { sha256 } from '../../crypto';
import { HttpError } from '../../http';
import { GSTR3B_STATUSES, Gstr3b, oid, PortalEvidence, type Gstr3bDoc } from '../../models';
import { audit } from '../gst-audit';
import { getGstClient, GstnError, GstnSessionError, type ClientContext } from '../gst-client';
import { gstr3bApi } from '../gst-client/sandbox';
import { errorLines, findFiling, maskPan, PAN_RE, parseGstnDate, STATUS_CD_LABEL } from '../gst-client/sandbox-protocol';
import { gstnHttpError, loginInfo } from '../gst-login';
import { sessionState } from '../gst-session';
import { loadCompany } from '../gstr1';
import { readWorkbook } from '@/engine';
import { STATE_CODES } from '@/engine/masters';
import { gstr3bWorkbook } from './excel';
import {
  fromAutoLiability, isNilForm, parseGstr3bExcel, isOffset, itcAvailable, itcNet, liabilityRows, nilFileBody, normalizeForm, offsetBody, parseLedger, planOffset,
  saveBody, type AutoLiability, type Gstr3bForm, type ItcUse, type LedgerBalance,
} from './protocol';

/**
 * GSTR-3B through the GST API integration: get (GSTN's saved values, auto-calculated liability,
 * ledger balance) → prepare → save → status → offset liability → review GSTN's payment table → EVC
 * OTP → file → ARN. Each step moves only on GSTN's own response, which is kept as evidence; OTPs and
 * PANs go straight to GSTN and are never stored or logged.
 */

export type Gstr3bStatus = (typeof GSTR3B_STATUSES)[number];

/** Statuses in which the prepared tables can still change (GSTN locks the return once liability is offset). */
const EDITABLE: Gstr3bStatus[] = ['draft', 'saved'];

function checkFp(fp: string) {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp)) throw new HttpError(400, 'Return period must be MMYYYY');
  const now = new Date();
  if (Number(fp.slice(2)) * 12 + Number(fp.slice(0, 2)) > now.getFullYear() * 12 + now.getMonth() + 1) throw new HttpError(400, 'GSTR-3B cannot be prepared for a future period');
}

async function load(auth: Auth, companyId: string, fp: string, create = false) {
  checkFp(fp);
  const company = await loadCompany(auth, companyId);
  const q = { orgId: oid(auth.orgId), companyId: company._id, fp };
  const doc = create
    ? await Gstr3b.findOneAndUpdate(q, { $setOnInsert: { gstin: company.gstin, status: 'draft' } }, { upsert: true, returnDocument: 'after' }).lean()
    : await Gstr3b.findOne(q).lean();
  const ctx: ClientContext = { orgId: auth.orgId, companyId: String(company._id), gstin: company.gstin };
  return { company, doc: doc as Gstr3bDoc | null, ctx };
}

async function loadDoc(auth: Auth, companyId: string, fp: string) {
  const r = await load(auth, companyId, fp, true);
  return { ...r, doc: r.doc! };
}

function requireApi() {
  if (getGstClient().id !== 'sandbox') throw new HttpError(409, 'GSTR-3B filing needs the GST API integration (GST_INTEGRATION=sandbox).');
}

const status = (doc: Gstr3bDoc) => (doc.status ?? 'draft') as Gstr3bStatus;

function assertStatus(doc: Gstr3bDoc, allowed: Gstr3bStatus[], what: string) {
  if (!allowed.includes(status(doc))) throw new HttpError(409, `Cannot ${what} while GSTR-3B is "${status(doc)}".`);
}

/** Only path that changes status: conditional on the status the caller read. */
async function move(auth: Auth, doc: Gstr3bDoc, to: Gstr3bStatus, note: string, set: Record<string, unknown> = {}) {
  const r = await Gstr3b.updateOne(
    { _id: doc._id, status: doc.status },
    { $set: { status: to, ...set }, $push: { history: { at: new Date(), from: doc.status, to, note, byEmail: auth.email } } },
  );
  if (!r.modifiedCount) throw new HttpError(409, 'GSTR-3B was changed by someone else in the meantime. Reload and try again.');
  doc.status = to;
}

const log = (auth: Auth, doc: Gstr3bDoc, action: string, meta: Record<string, unknown> = {}) =>
  audit(auth, `gstr3b.${action}`, 'Gstr3b', String(doc._id), { gstin: doc.gstin, fp: doc.fp, ...meta });

/** Keeps a GSTN request/response as evidence (pretty JSON). Never contains tokens, OTPs or PANs. */
async function evidence(auth: Auth, doc: Gstr3bDoc, kind: 'upload_reference' | 'processing_result' | 'error_report' | 'summary' | 'offset' | 'acknowledgement', name: string, content: unknown, reference?: string) {
  const bytes = Buffer.from(JSON.stringify(content ?? null, null, 2));
  const ev = await PortalEvidence.create({
    orgId: doc.orgId, returnId: doc._id, kind, reference: reference?.slice(0, 64),
    fileName: `GSTR3B-${doc.gstin}-${doc.fp}-${name}.json`, contentType: 'application/json', sizeBytes: bytes.length, sha256: sha256(bytes), content: bytes,
    recordedBy: oid(auth.userId), recordedByEmail: auth.email,
  });
  return ev._id;
}

async function evidenceJson(doc: Gstr3bDoc, id: unknown, kind: string): Promise<unknown> {
  const ev = await PortalEvidence.findOne({ _id: id, returnId: doc._id, orgId: doc.orgId, kind }).select('+content').lean();
  if (!ev?.content) return null;
  const c = ev.content as unknown as Buffer | { buffer: ArrayBuffer | Buffer };
  return JSON.parse((Buffer.isBuffer(c) ? c : Buffer.from(c.buffer as ArrayBuffer)).toString('utf8'));
}

/** A GSTN call whose business error becomes a note instead of failing the whole step. A lost session always fails. */
async function soft<T>(notes: string[], label: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GstnSessionError || !(e instanceof GstnError)) throw e;
    notes.push(`${label}: ${e.code && !/^\d+$/.test(e.code) ? `GSTN ${e.code}: ` : ''}${e.message}`);
    return null;
  }
}

/** GSTN's return details: stored on the document and as evidence (the file step uses exactly this copy). */
async function storeDetails(auth: Auth, doc: Gstr3bDoc, inner: unknown, raw: unknown) {
  const id = await evidence(auth, doc, 'summary', 'details', raw);
  const set = { portalDetails: inner ?? {}, portalForm: normalizeForm(inner), portalFetchedAt: new Date(), 'portal.detailsEvidenceId': id };
  await Gstr3b.updateOne({ _id: doc._id }, { $set: set });
  Object.assign(doc, { portalDetails: set.portalDetails, portalForm: set.portalForm, portalFetchedAt: set.portalFetchedAt });
  doc.portal = { ...doc.portal, detailsEvidenceId: id } as Gstr3bDoc['portal'];
  return id;
}

async function storeLedger(doc: Gstr3bDoc, inner: unknown) {
  const ledger = parseLedger(inner);
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { ledger, ledgerFetchedAt: new Date() } });
  doc.ledger = ledger;
  return ledger;
}

/* ---------- overview ---------- */

export async function overview(auth: Auth, companyId: string, fp: string) {
  const { company, doc, ctx } = await load(auth, companyId, fp);
  const client = getGstClient();
  const portalForm = doc?.portalForm ? normalizeForm(doc.portalForm) : null;
  // Once filed, the return is what GSTN holds – which may differ from a draft prepared here.
  const filedForm = doc && status(doc) === 'filed' && portalForm && !isNilForm(portalForm) ? portalForm : null;
  const form = filedForm ?? (doc?.form ? normalizeForm(doc.form) : null);
  const tx = (doc?.portalDetails as { tx_pmt?: Record<string, unknown> } | undefined)?.tx_pmt;
  return {
    company: { _id: String(company._id), name: company.name, gstin: company.gstin },
    fp,
    status: (doc ? status(doc) : 'draft') as Gstr3bStatus,
    api: client.id === 'sandbox',
    canEdit: can(auth, 'return:edit'),
    canOperate: can(auth, 'portal:operate'),
    canFile: can(auth, 'return:file'),
    session: await sessionState(ctx),
    login: loginInfo(),
    form,
    formSource: doc?.formSource ?? null,
    formUpdatedAt: doc?.formUpdatedAt ?? null,
    formUpdatedBy: doc?.formUpdatedBy ?? null,
    auto: (doc?.autoLiability as AutoLiability | undefined) ?? null,
    autoFetchedAt: doc?.autoFetchedAt ?? null,
    portalForm,
    portalFetchedAt: doc?.portalFetchedAt ?? null,
    ledger: (doc?.ledger as LedgerBalance | undefined) ?? null,
    ledgerFetchedAt: doc?.ledgerFetchedAt ?? null,
    notes: doc?.fetchNotes ?? [],
    liability: liabilityRows(doc?.portalDetails),
    /** 4(C) as saved on GSTN – may be added to the ledger's ITC for the set-off. */
    currentItc: portalForm ? itcNet(portalForm) : null,
    payment: tx ? { pdcash: tx.pdcash ?? [], pditc: tx.pditc ?? null, offset: isOffset(doc?.portalDetails) } : null,
    nilEligible: !!doc && nilEligible(doc),
    portal: doc?.portal ?? {},
    history: doc?.history ?? [],
  };
}

/** Nil GSTR-3B: nothing prepared here and nothing saved on GSTN (checked by a fetch). */
function nilEligible(doc: Gstr3bDoc) {
  return EDITABLE.includes(status(doc)) && !!doc.portalFetchedAt && isNilForm(normalizeForm(doc.form ?? {})) && isNilForm(normalizeForm(doc.portalForm ?? {}));
}

/* ---------- get from GSTN ---------- */

/**
 * Pulls everything GSTN has for the period: the saved return (and its payment table), the
 * auto-calculated liability and ITC, the ledger balance and whether it is already filed. Tables that
 * were never prepared here start from GSTN's saved values, else from the auto-calculation.
 */
export async function fetchFromPortal(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  const notes: string[] = [];
  try {
    const details = await soft(notes, 'Saved GSTR-3B', gstr3bApi.details(ctx, fp));
    if (details) await storeDetails(auth, doc, details.inner, details.raw);
    const auto = await soft(notes, 'Auto-calculated liability', gstr3bApi.autoLiability(ctx, fp));
    const ledger = await soft(notes, 'Ledger balance', gstr3bApi.ledgerBalance(ctx, fp));
    if (ledger) await storeLedger(doc, ledger.inner);
    const track = await soft(notes, 'Filing status', gstr3bApi.track(ctx, fp));

    const set: Record<string, unknown> = { fetchNotes: notes };
    if (auto) {
      const a = fromAutoLiability(auto.inner);
      set.autoLiability = a;
      set.autoFetchedAt = new Date();
      doc.autoLiability = a;
    }
    if (!doc.form && EDITABLE.includes(status(doc))) {
      const portalForm = details ? normalizeForm(details.inner) : null;
      const pick = portalForm && !isNilForm(portalForm) ? { form: portalForm, src: 'portal' } : auto ? { form: (set.autoLiability as AutoLiability).form, src: 'auto' } : null;
      if (pick) Object.assign(set, { form: pick.form, formSource: pick.src, formUpdatedAt: new Date(), formUpdatedBy: 'GSTN' });
    }
    await Gstr3b.updateOne({ _id: doc._id }, { $set: set });

    const filed = track ? findFiling(track.filings, fp, 'GSTR3B') : undefined;
    if (filed && status(doc) !== 'filed') {
      await move(auth, doc, 'filed', `GSTN lists GSTR-3B as filed, ARN ${filed.arn}`, {
        'portal.arn': filed.arn, 'portal.filedOn': parseGstnDate(filed.dof) ?? new Date(), 'portal.filedVia': 'sandbox',
      });
    } else if (details && isOffset(details.inner) && ['draft', 'saving', 'saved'].includes(status(doc))) {
      await move(auth, doc, 'offset', 'GSTN shows the liability already set off', { 'portal.offsetAt': new Date() });
      notes.push('GSTN shows the tax liability for this period already set off. Review the payment table and file.');
    }
  } catch (e) {
    await Gstr3b.updateOne({ _id: doc._id }, { $set: { fetchNotes: notes } });
    gstnHttpError(e);
  }
  await log(auth, doc, 'fetch', { notes: notes.length });
  return { ok: true, notes };
}

/* ---------- prepare ---------- */

export async function saveDraft(auth: Auth, companyId: string, fp: string, input: unknown) {
  const { doc } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, EDITABLE, 'edit the return');
  const form = normalizeForm(input);
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { form, formSource: 'manual', formUpdatedAt: new Date(), formUpdatedBy: auth.email } });
  if (status(doc) === 'saved') await move(auth, doc, 'draft', 'Edited after saving to GSTN – save to GSTN again');
  await log(auth, doc, 'edit');
  return { ok: true };
}

/** Replaces the prepared tables with GSTN's auto-calculated values or the values saved on GSTN. */
export async function useValues(auth: Auth, companyId: string, fp: string, source: 'auto' | 'portal') {
  const { doc } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, EDITABLE, 'edit the return');
  const form = source === 'auto' ? (doc.autoLiability as AutoLiability | undefined)?.form : doc.portalForm;
  if (!form) throw new HttpError(409, 'Fetch from the GST portal first.');
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { form: normalizeForm(form), formSource: source, formUpdatedAt: new Date(), formUpdatedBy: auth.email } });
  if (status(doc) === 'saved' && source === 'auto') await move(auth, doc, 'draft', 'Replaced with auto-calculated values – save to GSTN again');
  await log(auth, doc, 'use_values', { source });
  return { ok: true };
}

/* ---------- Excel ---------- */

/** The prepared tables as the GSTR-3B Excel template (blank when nothing is prepared yet). */
export async function excelTemplate(auth: Auth, companyId: string, fp: string) {
  const { company, doc } = await load(auth, companyId, fp);
  const title = `GSTR-3B – ${company.name} (${company.gstin}) – ${fp.slice(0, 2)}/${fp.slice(2)}`;
  return { fileName: `GSTR3B_${company.gstin}_${fp}.xlsx`, bytes: await gstr3bWorkbook(doc?.form ? normalizeForm(doc.form) : null, title) };
}

/** Replaces the prepared tables with an uploaded GSTR-3B Excel (template layout). */
export async function importExcel(auth: Auth, companyId: string, fp: string, file: File) {
  if (!/\.xlsx$/i.test(file.name)) throw new HttpError(400, 'Upload the GSTR-3B Excel template (.xlsx)');
  if (file.size > 5 * 1024 * 1024) throw new HttpError(413, 'File too large (max 5 MB)');
  const { doc } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, EDITABLE, 'import into the return');
  let sheets;
  try {
    sheets = await readWorkbook(Buffer.from(await file.arrayBuffer()), 2000);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const res = parseGstr3bExcel(sheets, STATE_CODES);
  if (!res.read.tables && !res.read.interState && !res.read.inward) throw new HttpError(422, res.issues.join(' '));
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { form: res.form, formSource: 'excel', formUpdatedAt: new Date(), formUpdatedBy: auth.email } });
  if (status(doc) === 'saved') await move(auth, doc, 'draft', `Imported ${file.name} – save to GSTN again`);
  await log(auth, doc, 'import_excel', { fileName: file.name, ...res.read, issues: res.issues.length });
  return { ok: true, read: res.read, issues: res.issues };
}

/* ---------- save ---------- */

export async function saveToGstn(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, EDITABLE, 'save to GSTN');
  if (!doc.form) throw new HttpError(409, 'Prepare the return first (fetch from the GST portal or fill the tables).');
  const body = saveBody(doc.form as Gstr3bForm, doc.gstin, fp);
  const res = await gstr3bApi.save(ctx, fp, body).catch(gstnHttpError);
  const evId = await evidence(auth, doc, 'upload_reference', 'save', { request: body, response: res.raw }, res.reference);
  if (res.reference) {
    await move(auth, doc, 'saving', `Saved to GSTN, reference ${res.reference}`, { 'portal.saveReference': res.reference, 'portal.saveErrors': [] });
  } else {
    await move(auth, doc, 'saved', 'GSTN accepted the save', { 'portal.savedAt': new Date(), 'portal.saveErrors': [] });
  }
  await log(auth, doc, 'save', { reference: res.reference, transactionId: res.transactionId, evidenceId: String(evId) });
  return { ok: true, reference: res.reference ?? null, state: status(doc) };
}

export async function checkSave(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, ['saving'], 'check the save status');
  const ref = doc.portal?.saveReference;
  if (!ref) throw new HttpError(409, 'No GSTN reference recorded for the save.');
  const st = await gstr3bApi.status(ctx, fp, ref).catch(gstnHttpError);
  const label = STATUS_CD_LABEL[st.code] ?? st.code;
  if (st.state === 'processing') return { state: st.state, label };

  if (st.state === 'error') {
    const messages = errorLines(st.errorReport, 10);
    await evidence(auth, doc, 'error_report', 'save-errors', st.raw, ref);
    await move(auth, doc, 'draft', `GSTN: ${label}`, { 'portal.saveErrors': messages.length ? messages : [`GSTN: ${label}`] });
    await log(auth, doc, 'save_error', { reference: ref, code: st.code });
    return { state: st.state, label, messages };
  }

  await evidence(auth, doc, 'processing_result', 'save-status', st.raw, ref);
  await move(auth, doc, 'saved', `GSTN: ${label}`, { 'portal.savedAt': new Date() });
  await log(auth, doc, 'saved', { reference: ref });
  // Tax payable and ledger balance are what the set-off needs next.
  const notes: string[] = [];
  const details = await soft(notes, 'Saved GSTR-3B', gstr3bApi.details(ctx, fp)).catch(() => null);
  if (details) await storeDetails(auth, doc, details.inner, details.raw);
  const ledger = await soft(notes, 'Ledger balance', gstr3bApi.ledgerBalance(ctx, fp)).catch(() => null);
  if (ledger) await storeLedger(doc, ledger.inner);
  return { state: st.state, label, notes };
}

/** Fresh tax payable (from the saved return) and ledger balance before the set-off. */
export async function refreshPayment(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  try {
    const details = await gstr3bApi.details(ctx, fp);
    await storeDetails(auth, doc, details.inner, details.raw);
    const ledger = await gstr3bApi.ledgerBalance(ctx, fp);
    await storeLedger(doc, ledger.inner);
    if (isOffset(details.inner) && ['saving', 'saved'].includes(status(doc))) {
      await move(auth, doc, 'offset', 'GSTN shows the liability already set off', { 'portal.offsetAt': new Date() });
    }
  } catch (e) {
    gstnHttpError(e);
  }
  return { ok: true };
}

/* ---------- offset liability ---------- */

export async function offsetLiability(auth: Auth, companyId: string, fp: string, input: { itcUse: ItcUse; includeCurrentItc: boolean; confirmed: boolean }) {
  requireApi();
  if (!can(auth, 'return:file')) throw new HttpError(403, 'Only an owner or admin can set off the liability (it debits the cash and credit ledgers).');
  if (!input.confirmed) throw new HttpError(422, 'Confirm the set-off first.');
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  assertStatus(doc, ['saved'], 'offset the liability');

  // Always against GSTN's current figures, never a stale copy.
  const details = await gstr3bApi.details(ctx, fp).catch(gstnHttpError);
  await storeDetails(auth, doc, details.inner, details.raw);
  const ledger = await storeLedger(doc, (await gstr3bApi.ledgerBalance(ctx, fp).catch(gstnHttpError)).inner);
  if (isOffset(details.inner)) {
    await move(auth, doc, 'offset', 'GSTN shows the liability already set off', { 'portal.offsetAt': new Date() });
    return { ok: true, already: true };
  }
  const rows = liabilityRows(details.inner);
  if (!rows.length) throw new HttpError(409, 'GSTN has not posted the tax payable for this return yet. Refresh in a minute.');
  const itc = itcAvailable(ledger, input.includeCurrentItc ? itcNet(normalizeForm(details.inner)) : undefined);
  const plan = planOffset(rows, ledger, itc, input.itcUse);
  if (plan.errors.length) throw new HttpError(422, plan.errors.join(' '));
  const short = Object.entries(plan.shortfall).filter(([, v]) => v > 0);
  if (short.length) {
    throw new HttpError(422, `The cash ledger is short by ${short.map(([k, v]) => `${k.toUpperCase()} ₹${v}`).join(', ')}. Create and pay a challan (PMT-06) on the GST portal for this amount, then refresh the ledger.`, { shortfall: plan.shortfall });
  }

  const body = offsetBody(rows, plan);
  const res = await gstr3bApi.offset(ctx, fp, body).catch(gstnHttpError);
  const evId = await evidence(auth, doc, 'offset', 'offset', { request: body, response: res.raw });
  await log(auth, doc, 'offset', { itcUsed: plan.itcUse, cashPaid: plan.cashNeeded, transactionId: res.transactionId, evidenceId: String(evId) });
  await move(auth, doc, 'offset', 'Liability set off', { 'portal.offsetAt': new Date(), 'portal.offsetEvidenceId': evId });

  // The file step needs GSTN's details after the set-off.
  const notes: string[] = [];
  const after = await soft(notes, 'Updated GSTR-3B', gstr3bApi.details(ctx, fp)).catch(() => null);
  if (after) await storeDetails(auth, doc, after.inner, after.raw);
  const led = await soft(notes, 'Ledger balance', gstr3bApi.ledgerBalance(ctx, fp)).catch(() => null);
  if (led) await storeLedger(doc, led.inner);
  return { ok: true, message: String((res.inner as { Message?: string } | undefined)?.Message ?? 'Liability set off.'), notes };
}

/** Re-reads GSTN's return after the set-off; filing binds to exactly this copy. */
export async function fetchDetails(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  const details = await gstr3bApi.details(ctx, fp).catch(gstnHttpError);
  const id = await storeDetails(auth, doc, details.inner, details.raw);
  return { ok: true, evidenceId: String(id), offset: isOffset(details.inner) };
}

/* ---------- file ---------- */

function assertCanFile(auth: Auth) {
  if (!can(auth, 'return:file')) throw new HttpError(403, 'Only an owner or admin can file the return.');
}

function cleanPan(pan: string) {
  const p = pan.trim().toUpperCase();
  if (!PAN_RE.test(p)) throw new HttpError(422, 'Enter the authorised signatory’s PAN (10 characters, e.g. ABCDE1234F)');
  return p;
}

function fileable(doc: Gstr3bDoc, nil: boolean) {
  if (doc.portal?.fileSubmittedAt) throw new HttpError(409, 'Filing was already submitted to GSTN. Fetch the ARN.');
  if (nil) {
    if (!nilEligible(doc)) throw new HttpError(409, 'A Nil GSTR-3B needs every table to be zero here and on GSTN. Fetch from the GST portal first.');
  } else assertStatus(doc, ['offset'], 'file');
}

export async function requestEvcOtp(auth: Auth, companyId: string, fp: string, pan: string, nil: boolean) {
  requireApi();
  assertCanFile(auth);
  const p = cleanPan(pan);
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  fileable(doc, nil);
  const res = await gstr3bApi.requestEvcOtp(ctx, p).catch(gstnHttpError);
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { 'portal.evcRequestedAt': new Date() } });
  await log(auth, doc, 'evc_otp_requested', { pan: maskPan(p), nil, transactionId: res.transactionId });
  return { ok: true };
}

export async function fileWithEvc(auth: Auth, companyId: string, fp: string, input: { pan: string; otp: string; detailsEvidenceId?: string; verified: boolean; nil: boolean }) {
  requireApi();
  assertCanFile(auth);
  if (!input.verified) throw new HttpError(422, 'Confirm that you have reviewed the return before filing.');
  const pan = cleanPan(input.pan);
  const otp = input.otp.trim();
  if (!/^\d{4,8}$/.test(otp)) throw new HttpError(422, 'Enter the EVC OTP exactly as received');
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  fileable(doc, input.nil);
  if (!doc.portal?.evcRequestedAt) throw new HttpError(409, 'Request the EVC OTP first.');

  let body: unknown;
  if (input.nil) body = nilFileBody(doc.gstin, fp);
  else {
    const id = doc.portal?.detailsEvidenceId;
    if (!id || String(id) !== input.detailsEvidenceId) throw new HttpError(409, 'GSTN’s return details changed since you reviewed them. Review the latest details and confirm again.');
    // Evidence holds GSTN's response ({ status_cd, data }); the file body is its data.
    body = ((await evidenceJson(doc, id, 'summary')) as { data?: unknown } | null)?.data;
    if (!body || (!isOffset(body) && liabilityRows(body).some((r) => r.igst.tx + r.cgst.tx + r.sgst.tx + r.cess.tx > 0))) {
      throw new HttpError(409, 'The reviewed details do not show the set-off yet. Fetch GSTN’s details again.');
    }
  }

  const res = await gstr3bApi.file(ctx, fp, pan, otp, body).catch(gstnHttpError);
  const evId = await evidence(auth, doc, 'acknowledgement', 'file', res.raw, res.ackNum);
  await Gstr3b.updateOne({ _id: doc._id }, { $set: { 'portal.fileSubmittedAt': new Date(), 'portal.ackNum': res.ackNum, 'portal.nil': input.nil } });
  doc.portal = { ...doc.portal, fileSubmittedAt: new Date(), ackNum: res.ackNum } as Gstr3bDoc['portal'];
  await log(auth, doc, 'file', { pan: maskPan(pan), nil: input.nil, ackNum: res.ackNum, transactionId: res.transactionId, evidenceId: String(evId) });

  try {
    return { ...(await fetchArn(auth, companyId, fp)), ackNum: res.ackNum ?? null };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'GSTN did not list the ARN yet.';
    return { ok: true, found: false, ackNum: res.ackNum ?? null, message: `${msg} Fetch the ARN in a few minutes.` };
  }
}

export async function fetchArn(auth: Auth, companyId: string, fp: string) {
  requireApi();
  const { doc, ctx } = await loadDoc(auth, companyId, fp);
  if (status(doc) === 'filed') return { ok: true, found: true, arn: doc.portal?.arn };
  const t = await gstr3bApi.track(ctx, fp).catch(gstnHttpError);
  const f = findFiling(t.filings, fp, 'GSTR3B');
  if (!f?.arn) return { ok: true, found: false, message: 'GSTN does not list GSTR-3B for this period as filed yet.' };
  await evidence(auth, doc, 'acknowledgement', 'arn', t.raw, f.arn);
  await move(auth, doc, 'filed', `Filed, ARN ${f.arn}`, { 'portal.arn': f.arn, 'portal.filedOn': parseGstnDate(f.dof) ?? new Date(), 'portal.filedVia': 'sandbox' });
  await log(auth, doc, 'filed', { arn: f.arn });
  return { ok: true, found: true, arn: f.arn };
}
