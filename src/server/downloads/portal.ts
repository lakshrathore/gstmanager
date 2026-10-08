import 'server-only';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Types } from 'mongoose';
import { readPortalJson, recordsFromGstr1Json, type PurchaseDoc } from '@/engine';
import type { Auth } from '../auth';
import { HttpError } from '../http';
import { oid, PortalFetch, type CompanyDoc } from '../models';
import { audit } from '../gst/gst-audit';
import { getGstClient, GstnError, GstnSessionError } from '../gst/gst-client';
import { fetchGstr1, fetchGstr9, fetchInwardReturn, fetchLedger, gstr3bApi, sandboxConfigured, trackReturnsPublic } from '../gst/gst-client/sandbox';
import { gstnHttpError, loginInfo } from '../gst/gst-login';
import { loadCompany } from '../gst/gstr1';
import { renderAnnual, XLSX } from '../gst/annual';
import { fyInfo } from '../gst/annual/common';
import { fromGstr9Json } from '../gst/annual/gstr9';
import { gstr3bWorkbook } from '../gst/gstr3b/excel';
import { normalizeForm } from '../gst/gstr3b/protocol';
import { upload as uploadClientDocs } from '../docs';
import { deleteFile, getFile, putFile } from '../docs/storage';
import { gstr1Workbook } from './gstr1Excel';

/**
 * Download centre, "from the GST portal": returns, ledgers and the filing list as GSTN holds them,
 * fetched through the GST API integration (Sandbox) one period per request, kept (GSTN's JSON in
 * GridFS) so they can be downloaded again as JSON or Excel – or all as a ZIP – without another API
 * call. Everything except the filing list needs the company's GST login (OTP).
 */

export const PORTAL_TYPES = ['gstr1', 'gstr3b', 'gstr2a', 'gstr2b', 'gstr9', 'cash_ledger', 'itc_ledger', 'filed'] as const;
export type PortalType = (typeof PORTAL_TYPES)[number];

const INFO: Record<PortalType, { name: string; yearly: boolean; login: boolean; toDocs: boolean }> = {
  gstr1: { name: 'GSTR-1', yearly: false, login: true, toDocs: true },
  gstr3b: { name: 'GSTR-3B', yearly: false, login: true, toDocs: true },
  gstr2a: { name: 'GSTR-2A', yearly: false, login: true, toDocs: true },
  gstr2b: { name: 'GSTR-2B', yearly: false, login: true, toDocs: true },
  gstr9: { name: 'GSTR-9', yearly: true, login: true, toDocs: false },
  cash_ledger: { name: 'Cash ledger', yearly: true, login: true, toDocs: false },
  itc_ledger: { name: 'Credit (ITC) ledger', yearly: true, login: true, toDocs: false },
  filed: { name: 'Filed returns list', yearly: true, login: false, toDocs: false },
};
const FILE_TAG: Record<PortalType, string> = {
  gstr1: 'GSTR1', gstr3b: 'GSTR3B', gstr2a: 'GSTR2A', gstr2b: 'GSTR2B', gstr9: 'GSTR9', cash_ledger: 'CashLedger', itc_ledger: 'ITCLedger', filed: 'FiledReturns',
};

const MONTH = /^(0[1-9]|1[0-2])\d{4}$/;
const monthKey = (fp: string) => Number(fp.slice(2)) * 12 + Number(fp.slice(0, 2));
const nowFp = () => { const d = new Date(Date.now() + 5.5 * 3_600_000); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`; };

function checkPeriod(type: PortalType, period: string) {
  if (INFO[type].yearly) {
    const fy = fyInfo(period);
    if (!fy) throw new HttpError(400, 'Financial year must look like 2025-26');
    if (monthKey(fy.months[0]) > monthKey(nowFp())) throw new HttpError(400, `FY ${period} has not started yet.`);
  } else {
    if (!MONTH.test(period)) throw new HttpError(400, 'Period must be MMYYYY');
    if (monthKey(period) > monthKey(nowFp())) throw new HttpError(400, `${period.slice(0, 2)}/${period.slice(2)} is in the future.`);
  }
}

/** Whether downloading from the portal works on this installation, and why not. */
function availability(): { available: boolean; reason: string | null } {
  if (getGstClient().id !== 'sandbox') return { available: false, reason: 'Downloading from the GST portal needs the GST API integration (GST_INTEGRATION=sandbox with Sandbox API keys).' };
  if (!sandboxConfigured()) return { available: false, reason: 'The Sandbox GST API keys are not set (SANDBOX_API_KEY, SANDBOX_API_SECRET).' };
  return { available: true, reason: null };
}

const ctxOf = (auth: Auth, c: CompanyDoc) => ({ orgId: auth.orgId, companyId: String(c._id), gstin: c.gstin });

export interface PortalItem {
  id: string; type: PortalType; typeName: string; period: string; count: number; notes: string[];
  fetchedAt: Date; fetchedBy: string | null; inDocuments: boolean; excel: boolean;
}
type FetchDoc = { _id: Types.ObjectId; type: string; period: string; count?: number | null; notes?: string[]; updatedAt?: Date; fetchedBy?: string | null; clientDocId?: unknown };
const itemOf = (d: FetchDoc): PortalItem => ({
  id: String(d._id), type: d.type as PortalType, typeName: INFO[d.type as PortalType]?.name ?? d.type, period: d.period, count: d.count ?? 0,
  notes: d.notes ?? [], fetchedAt: d.updatedAt ?? new Date(), fetchedBy: d.fetchedBy ?? null, inDocuments: !!d.clientDocId, excel: true,
});

/** The company's GST login, what has been downloaded already, and whether this installation can do it. */
export async function portalStatus(auth: Auth, companyId: string) {
  const company = await loadCompany(auth, companyId);
  const avail = availability();
  const client = getGstClient();
  const session = avail.available && client.session ? await client.session(ctxOf(auth, company)) : { state: 'none', message: avail.reason ?? 'Not logged in to GST.' };
  const docs = await PortalFetch.find({ orgId: oid(auth.orgId), companyId: company._id }).sort({ period: -1 }).lean();
  return { ...avail, session, login: loginInfo(), items: docs.map((d) => itemOf(d as FetchDoc)) };
}

/* ---------- fetch one ---------- */

const rowsIn = (v: unknown): number => {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).reduce<number>((a, x) => a + (Array.isArray(x) ? x.length : x && typeof x === 'object' ? rowsIn(x) : 0), 0);
  return 0;
};

async function fromGstn(auth: Auth, company: CompanyDoc, type: PortalType, period: string): Promise<{ json: unknown; count: number; notes: string[] }> {
  const ctx = ctxOf(auth, company);
  switch (type) {
    case 'gstr1': {
      const { json, notes } = await fetchGstr1(ctx, period);
      return { json, count: recordsFromGstr1Json(json as never).length, notes };
    }
    case 'gstr3b': {
      const { inner } = await gstr3bApi.details(ctx, period);
      const json = inner ?? {};
      return { json, count: Object.keys(json as object).length ? 1 : 0, notes: [] };
    }
    case 'gstr2a': case 'gstr2b': {
      const json = await fetchInwardReturn(ctx, type, period);
      return { json, count: readPortalJson(json, type, type, period).docs.length, notes: [] };
    }
    case 'gstr9': {
      const json = await fetchGstr9(ctx, period);
      return { json, count: fromGstr9Json(json).read, notes: [] };
    }
    case 'cash_ledger': case 'itc_ledger': {
      const start = Number(period.slice(0, 4));
      const today = new Date(Date.now() + 5.5 * 3_600_000);
      const end = new Date(Date.UTC(start + 1, 2, 31));
      const to = end < today ? end : today;
      const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      const json = await fetchLedger(ctx, type === 'cash_ledger' ? 'cash' : 'itc', `01/04/${start}`, dmy(to));
      return { json, count: rowsIn(json), notes: [] };
    }
    case 'filed': {
      const json = await trackReturnsPublic(company.gstin, period);
      return { json, count: rowsIn(json), notes: [] };
    }
  }
}

export async function fetchFromPortal(auth: Auth, input: { companyId: string; type: PortalType; period: string; toDocuments?: boolean; force?: boolean }) {
  const { type, period } = input;
  if (!PORTAL_TYPES.includes(type)) throw new HttpError(400, 'Unknown return type');
  checkPeriod(type, period);
  const avail = availability();
  if (!avail.available) throw new HttpError(409, avail.reason!);
  const company = await loadCompany(auth, input.companyId);
  const key = { orgId: oid(auth.orgId), companyId: company._id, type, period };
  const existing = await PortalFetch.findOne(key).lean();
  if (existing && !input.force) return { item: itemOf(existing as FetchDoc), skipped: true };

  let got;
  try {
    got = await fromGstn(auth, company, type, period);
  } catch (e) {
    if (e instanceof GstnSessionError) throw new HttpError(409, 'Not logged in to GST for this client – log in with the OTP above, then download again.', { session: 'expired' });
    if (e instanceof GstnError) gstnHttpError(e);
    throw e;
  }
  const bytes = Buffer.from(JSON.stringify(got.json ?? {}, null, 1));
  const fileName = `${FILE_TAG[type]}_${company.gstin}_${period}.json`;
  const fileId = await putFile(bytes, fileName, 'application/json', { orgId: auth.orgId, portal: true });

  // Also into Client documents (read there by rules: sales/purchase records, checks, reconciliation).
  let clientDocId = existing?.clientDocId ?? null;
  const notes = [...got.notes];
  if (input.toDocuments && INFO[type].toDocs && got.count) {
    const r = await uploadClientDocs(auth, String(company._id), [new File([new Uint8Array(bytes)], fileName, { type: 'application/json' })], { kind: type as 'gstr1' });
    const f = r.files[0];
    if (f?.id) clientDocId = new Types.ObjectId(f.id);
    if (f?.status === 'duplicate') notes.push('Already in Client documents (same data).');
  }

  if (existing?.fileId) await deleteFile(existing.fileId as Types.ObjectId).catch(() => undefined);
  const doc = await PortalFetch.findOneAndUpdate(key, {
    $set: { gstin: company.gstin, fileId, sizeBytes: bytes.length, count: got.count, notes, fetchedBy: auth.email, clientDocId },
  }, { upsert: true, new: true }).lean();
  await audit(auth, 'portal.download', 'Company', String(company._id), { type, period, count: got.count, toDocuments: !!clientDocId });
  return { item: itemOf(doc as FetchDoc), skipped: false };
}

/* ---------- files ---------- */

const title = (company: CompanyDoc, type: PortalType, period: string) =>
  `${INFO[type].name} from the GST portal – ${company.name} (${company.gstin}) – ${period.includes('-') ? `FY ${period}` : `${period.slice(0, 2)}/${period.slice(2)}`}`;

async function loadFetch(auth: Auth, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, 'Download not found');
  const d = await PortalFetch.findOne({ _id: oid(id), orgId: oid(auth.orgId) }).lean();
  if (!d?.fileId) throw new HttpError(404, 'Download not found');
  const company = await loadCompany(auth, String(d.companyId));
  return { d, company };
}

export async function renderPortalFile(auth: Auth, id: string, format: 'json' | 'xlsx') {
  const { d, company } = await loadFetch(auth, id);
  const type = d.type as PortalType;
  const bytes = await getFile(d.fileId as Types.ObjectId);
  const base = `${FILE_TAG[type]}_${company.gstin}_${d.period}`;
  if (format === 'json') return { fileName: `${base}.json`, contentType: 'application/json', bytes };
  const json = JSON.parse(bytes.toString('utf8')) as unknown;
  const t = title(company, type, d.period);
  let out: Buffer;
  switch (type) {
    case 'gstr1': out = await gstr1Workbook(recordsFromGstr1Json(json as never), t); break;
    case 'gstr3b': out = await gstr3bWorkbook(normalizeForm(json), t); break;
    case 'gstr2a': case 'gstr2b': out = await inwardWorkbook(readPortalJson(json, type, type, d.period).docs, t); break;
    case 'gstr9': out = (await renderAnnual('gstr9', company, d.period, fromGstr9Json(json).form, 'xlsx')).bytes; break;
    default: out = await genericWorkbook(json, t);
  }
  return { fileName: `${base}.xlsx`, contentType: XLSX, bytes: out };
}

export async function downloadPortalFile(auth: Auth, id: string, format: 'json' | 'xlsx') {
  const f = await renderPortalFile(auth, id, format);
  await audit(auth, 'portal.download_file', 'PortalFetch', id, { format, fileName: f.fileName });
  return f;
}

/** Everything downloaded for a client (optionally only some types/periods) as one ZIP. */
export async function portalZip(auth: Auth, companyId: string, ids: string[], formats: ('json' | 'xlsx')[]) {
  const company = await loadCompany(auth, companyId);
  const q: Record<string, unknown> = { orgId: oid(auth.orgId), companyId: company._id };
  if (ids.length) q._id = { $in: ids.filter((x) => Types.ObjectId.isValid(x)).map((x) => oid(x)) };
  const docs = await PortalFetch.find(q).sort({ type: 1, period: 1 }).lean();
  if (!docs.length) throw new HttpError(404, 'Nothing downloaded from the portal for this client yet.');
  const zip = new JSZip();
  const skipped: string[] = [];
  for (const d of docs) {
    for (const f of formats) {
      try {
        const file = await renderPortalFile(auth, String(d._id), f);
        zip.file(`${INFO[d.type as PortalType]?.name ?? d.type}/${file.fileName}`, file.bytes);
      } catch (e) {
        skipped.push(`${d.type} ${d.period} (${f}): ${(e as Error).message}`);
      }
    }
  }
  if (skipped.length) zip.file('NOT-INCLUDED.txt', skipped.join('\r\n'));
  await audit(auth, 'portal.download_zip', 'Company', String(company._id), { files: docs.length, formats });
  return { fileName: `GST-portal_${company.gstin}.zip`, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
}

export async function deletePortalFetch(auth: Auth, id: string) {
  const { d } = await loadFetch(auth, id);
  await PortalFetch.deleteOne({ _id: d._id });
  await deleteFile(d.fileId as Types.ObjectId).catch(() => undefined);
  return { ok: true };
}

/* ---------- Excel ---------- */

function sheetHead(ws: ExcelJS.Worksheet, t: string, headers: string[]) {
  ws.addRow([t]).font = { bold: true, size: 12 };
  ws.addRow([]);
  const h = ws.addRow(headers);
  h.font = { bold: true };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0EC' } }; });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

/** GSTR-2A / GSTR-2B as one row per supplier document. */
async function inwardWorkbook(docs: PurchaseDoc[], t: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Documents');
  sheetHead(ws, t, ['Supplier GSTIN', 'Supplier name', 'Type', 'Number', 'Date', 'Place of supply', 'Reverse charge', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Invoice value', 'ITC available', 'Reason', 'Supplier filed on']);
  for (const x of docs) {
    ws.addRow([
      x.supplierGstin, x.supplierName ?? '', x.docType, x.docNo, x.docDate, x.pos ?? '', x.rcm ? 'Y' : 'N', x.taxable, x.igst, x.cgst, x.sgst, x.cess,
      x.invoiceValue ?? '', x.itcAvailable == null ? '' : x.itcAvailable ? 'Yes' : 'No', x.itcReason ?? '', x.supplierFilingDate ?? '',
    ]);
  }
  const total = ws.addRow(['Total', '', '', `${docs.length} documents`, '', '', '', ...(['taxable', 'igst', 'cgst', 'sgst', 'cess'] as const).map((k) => Math.round(docs.reduce((a, x) => a + x[k], 0) * 100) / 100)]);
  total.font = { bold: true };
  for (const c of [8, 9, 10, 11, 12, 13]) ws.getColumn(c).numFmt = '#,##0.00';
  ws.columns.forEach((c, i) => { c.width = [17, 28, 6, 18, 12, 8, 8][i] ?? 14; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Any GSTN JSON (ledgers, filing list): each list of records becomes a sheet, nested fields as columns. */
async function genericWorkbook(json: unknown, t: string) {
  const wb = new ExcelJS.Workbook();
  const lists: { path: string; rows: Record<string, unknown>[] }[] = [];
  const scalars: [string, unknown][] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (v.some((x) => x && typeof x === 'object' && !Array.isArray(x))) lists.push({ path: path || 'data', rows: v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] });
      return;
    }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); return; }
    if (path) scalars.push([path, v]);
  };
  walk(json, '');
  const flat = (o: Record<string, unknown>, pre = ''): Record<string, unknown> => Object.entries(o).reduce<Record<string, unknown>>((a, [k, v]) => {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(a, flat(v as Record<string, unknown>, key));
    else a[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    return a;
  }, {});
  const used = new Set<string>();
  for (const l of lists) {
    const rows = l.rows.map((r) => flat(r));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    let name = l.path.split('.').slice(-2).join(' ').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'data';
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 25)} ${i}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    sheetHead(ws, t, cols);
    for (const r of rows) ws.addRow(cols.map((c) => r[c] ?? ''));
    ws.columns.forEach((c) => { c.width = 16; });
  }
  const info = wb.addWorksheet(lists.length ? 'Details' : 'Data');
  sheetHead(info, t, ['Field', 'Value']);
  for (const [k, v] of scalars) info.addRow([k, v as string]);
  if (!scalars.length && !lists.length) info.addRow(['(GSTN returned no data)']);
  info.columns.forEach((c, i) => { c.width = i ? 40 : 30; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

