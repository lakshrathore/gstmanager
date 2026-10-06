import 'server-only';
import ExcelJS from 'exceljs';
import {
  DEFAULT_OPTIONS, parseCsv, readPortalJson, readPortalTables, readPurchaseRegister, readWorkbook, reconcile, totalTax,
  type PurchaseDoc, type PurchaseSource, type ReconDecision as Decision, type ReconRow, type SheetTable,
} from '@/engine';
import type { Auth } from '../auth';
import { audit } from '../audit';
import { HttpError } from '../http';
import { loadCompany } from '../gst/gstr1';
import { oid, PurchaseDoc as PurchaseDocModel, PurchaseImport, ReconDecision } from '../models';

/**
 * Purchase reconciliation: books (purchase register) against GSTR-2A and, separately, GSTR-2B for one
 * company and return period. Data is uploaded per source; the reconciliation itself is computed on
 * request from the stored documents plus the user's decisions, so it is always up to date.
 */

export type Against = 'gstr2a' | 'gstr2b';
const MAX_FILE = 40 * 1024 * 1024;
const PERIOD_RE = /^(0[1-9]|1[0-2])\d{4}$/;

export function checkPeriod(fp: string) {
  if (!PERIOD_RE.test(fp)) throw new HttpError(400, 'Period must be MMYYYY');
}

const scope = (auth: Auth, companyId: string) => ({ orgId: oid(auth.orgId), companyId: oid(companyId) });

async function readFiles(files: File[], source: PurchaseSource, fp: string, gstin: string) {
  const docs: PurchaseDoc[] = [];
  const notes: { file: string; message: string }[] = [];
  for (const file of files) {
    const name = file.name;
    if (file.size > MAX_FILE) throw new HttpError(413, `${name} is too large (max 40 MB)`);
    if (/\.zip$/i.test(name)) throw new HttpError(400, `${name} is a ZIP file – extract it and upload the .json / .xlsx file inside`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (/\.json$/i.test(name)) {
      if (source === 'books') throw new HttpError(400, 'Upload the purchase register as Excel or CSV');
      let json: unknown;
      try { json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { throw new HttpError(400, `${name} is not valid JSON`); }
      const r = readPortalJson(json, source, name, fp);
      docs.push(...r.docs);
      notes.push(...r.notes.map((m) => ({ file: name, message: m })));
      continue;
    }
    let tables: SheetTable[];
    if (/\.(csv|txt)$/i.test(name)) tables = [parseCsv(bytes.toString('utf8'), name)];
    else if (/\.xlsx$/i.test(name)) tables = await readWorkbook(bytes);
    else if (/\.xls$/i.test(name)) throw new HttpError(400, `${name} is an old .xls file – save it as .xlsx first`);
    else throw new HttpError(400, `${name}: upload .xlsx, .csv or .json`);
    if (source === 'books') {
      const r = readPurchaseRegister(tables, name, fp, gstin);
      docs.push(...r.docs);
      notes.push(...r.skipped.map((s) => ({ file: name, message: `${s.sheet}: ${s.reason}` })), ...r.issues.slice(0, 50).map((i) => ({ file: name, message: `${i.sheet} row ${i.row}: ${i.message}` })));
    } else {
      const r = readPortalTables(tables, source, name, fp);
      docs.push(...r.docs);
      notes.push(...r.notes.map((m) => ({ file: name, message: m })));
    }
  }
  return { docs, notes };
}

/** Replaces the documents of one source for the company + period. */
export async function storeDocs(auth: Auth, companyId: string, fp: string, source: PurchaseSource, docs: PurchaseDoc[], meta: { via: 'file' | 'portal'; files: string[]; notes: unknown[] }) {
  const s = scope(auth, companyId);
  await PurchaseDocModel.deleteMany({ ...s, fp, source });
  const imp = await PurchaseImport.findOneAndUpdate(
    { ...s, fp, source },
    { $set: { via: meta.via, files: meta.files, docs: docs.length, taxable: round(docs.reduce((a, d) => a + sgn(d) * d.taxable, 0)), tax: round(docs.reduce((a, d) => a + sgn(d) * totalTax(d), 0)), notes: meta.notes.slice(0, 100), importedBy: auth.email } },
    { upsert: true, returnDocument: 'after' },
  );
  for (let i = 0; i < docs.length; i += 1000) {
    await PurchaseDocModel.insertMany(docs.slice(i, i + 1000).map((d) => ({ ...d, ...s, fp, importId: imp!._id })), { ordered: false });
  }
  await audit(auth, `recon.${source}_imported`, 'Company', companyId, { fp, docs: docs.length, via: meta.via, files: meta.files });
  return imp!.toObject();
}

const round = (n: number) => Math.round(n * 100) / 100;
const sgn = (d: PurchaseDoc) => (d.docType === 'CN' ? -1 : 1);

export async function importPurchaseFiles(auth: Auth, companyId: string, fp: string, source: PurchaseSource, files: File[]) {
  checkPeriod(fp);
  const company = await loadCompany(auth, companyId);
  if (!files.length) throw new HttpError(400, 'Choose a file');
  const { docs, notes } = await readFiles(files, source, fp, company.gstin);
  if (!docs.length) throw new HttpError(422, source === 'books' ? 'No purchase invoices found in this file' : 'No invoices or notes found in this file', notes.map((n) => ({ sheet: n.file, reason: n.message })));
  return { import: await storeDocs(auth, companyId, fp, source, docs, { via: 'file', files: files.map((f) => f.name), notes }), notes };
}

export async function removeSource(auth: Auth, companyId: string, fp: string, source: PurchaseSource) {
  checkPeriod(fp);
  await loadCompany(auth, companyId);
  const s = scope(auth, companyId);
  const r = await PurchaseDocModel.deleteMany({ ...s, fp, source });
  await PurchaseImport.deleteOne({ ...s, fp, source });
  await audit(auth, `recon.${source}_removed`, 'Company', companyId, { fp, docs: r.deletedCount });
  return { removed: r.deletedCount };
}

const lean = (d: Record<string, unknown>) => {
  const { _id, orgId, companyId, importId, createdAt, updatedAt, __v, fp, ...rest } = d;
  void _id; void orgId; void companyId; void importId; void createdAt; void updatedAt; void __v; void fp;
  return rest as unknown as PurchaseDoc;
};

export async function status(auth: Auth, companyId: string, fp: string) {
  checkPeriod(fp);
  await loadCompany(auth, companyId);
  const imports = await PurchaseImport.find({ ...scope(auth, companyId), fp }).lean();
  return { imports };
}

export async function runRecon(auth: Auth, companyId: string, fp: string, against: Against, tolerance?: number) {
  checkPeriod(fp);
  const company = await loadCompany(auth, companyId);
  const s = scope(auth, companyId);
  const [books, portal, other, decisions] = await Promise.all([
    PurchaseDocModel.find({ ...s, fp, source: 'books' }).lean(),
    PurchaseDocModel.find({ ...s, fp, source: against }).lean(),
    // Portal data of other periods: books-only invoices are looked up there (timing differences).
    PurchaseDocModel.find({ ...s, fp: { $ne: fp }, source: against }).select({ key: 1, source: 1, docType: 1, supplierGstin: 1, docNo: 1, period: 1 }).lean(),
    ReconDecision.find({ ...s, fp, against }).lean(),
  ]);
  const res = reconcile(
    books.map((d) => lean(d as unknown as Record<string, unknown>)),
    portal.map((d) => lean(d as unknown as Record<string, unknown>)),
    { ...DEFAULT_OPTIONS, amountTolerance: tolerance ?? DEFAULT_OPTIONS.amountTolerance, recipientGstin: company.gstin },
    decisions.map((d) => ({ action: d.action, booksKey: d.booksKey ?? undefined, portalKey: d.portalKey ?? undefined, reason: d.reason ?? undefined }) as Decision),
    { period: fp, otherPortal: other.map((d) => lean(d as unknown as Record<string, unknown>)) },
  );
  return { ...res, decisions: decisions.map((d) => ({ _id: String(d._id), action: d.action, booksKey: d.booksKey, portalKey: d.portalKey, reason: d.reason, byEmail: d.byEmail, at: d.createdAt })), counts: { books: books.length, portal: portal.length } };
}

export async function addDecision(auth: Auth, companyId: string, fp: string, against: Against, d: Decision) {
  checkPeriod(fp);
  await loadCompany(auth, companyId);
  if (d.action === 'ignore' && !d.booksKey === !d.portalKey) throw new HttpError(400, 'Ignore one document (books or portal)');
  if ((d.action === 'link' || d.action === 'accept') && (!d.booksKey || !d.portalKey)) throw new HttpError(400, 'Choose a books document and a portal document');
  const s = scope(auth, companyId);
  // A document can be in one decision of each kind at a time – replace older ones touching the same keys.
  const or: Record<string, string>[] = [];
  if (d.booksKey) or.push({ booksKey: d.booksKey });
  if (d.portalKey) or.push({ portalKey: d.portalKey });
  if (d.action !== 'accept') await ReconDecision.deleteMany({ ...s, fp, against, action: { $in: ['ignore', 'link'] }, $or: or });
  const doc = await ReconDecision.create({ ...s, fp, against, ...d, by: oid(auth.userId), byEmail: auth.email });
  await audit(auth, `recon.${d.action}`, 'Company', companyId, { fp, against, booksKey: d.booksKey, portalKey: d.portalKey, reason: d.reason });
  return { _id: String(doc._id) };
}

export async function removeDecision(auth: Auth, companyId: string, fp: string, against: Against, id: string) {
  await loadCompany(auth, companyId);
  const r = await ReconDecision.findOneAndDelete({ _id: oid(id), ...scope(auth, companyId), fp, against }).lean();
  if (!r) throw new HttpError(404, 'Decision not found');
  await audit(auth, 'recon.undo', 'Company', companyId, { fp, against, action: r.action, booksKey: r.booksKey, portalKey: r.portalKey });
  return { ok: true };
}

const STATUS_LABEL: Record<string, string> = {
  matched: 'Matched', mismatch: 'Mismatch', probable: 'Probable match', not_in_portal: 'Not in portal (books only)',
  not_in_books: 'Not in books (portal only)', ignored: 'Ignored',
};

/** Excel workbook of the reconciliation: a summary sheet and one row per document pair. */
export async function exportRecon(auth: Auth, companyId: string, fp: string, against: Against) {
  const company = await loadCompany(auth, companyId);
  const { rows, summary } = await runRecon(auth, companyId, fp, against);
  const wb = new ExcelJS.Workbook();
  const label = against === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B';
  const sum = wb.addWorksheet('Summary');
  sum.addRows([
    [`Purchase reconciliation – books vs ${label}`], [`${company.name} (${company.gstin}) – period ${fp.slice(0, 2)}/${fp.slice(2)}`], [],
    ['Status', 'Documents', 'Taxable value', 'Tax'],
    ...Object.entries(summary.byStatus).map(([k, v]) => [STATUS_LABEL[k], v.count, v.taxable, v.tax]),
    [], ['ITC as per books', summary.itc.books], [`ITC available as per ${label}`, summary.itc.portal], ['Difference (books − portal)', summary.itc.difference],
  ]);
  sum.getRow(1).font = { bold: true, size: 14 };
  sum.getRow(4).font = { bold: true };
  sum.columns.forEach((c) => { c.width = 28; });

  const ws = wb.addWorksheet('Details');
  const cols = ['Status', 'Supplier GSTIN', 'Supplier name', 'Type', 'Books doc no', 'Books date', 'Books taxable', 'Books IGST', 'Books CGST', 'Books SGST', 'Books cess',
    `${label} doc no`, `${label} date`, `${label} taxable`, `${label} IGST`, `${label} CGST`, `${label} SGST`, `${label} cess`, 'Differences', 'Notes', 'Ignored reason'];
  ws.addRow(cols).font = { bold: true };
  const fmtDiff = (r: ReconRow) => r.diffs.map((d) => `${d.field}: books ${d.books ?? '—'} / portal ${d.portal ?? '—'}`).join('; ');
  for (const r of rows) {
    const b = r.books, p = r.portal;
    ws.addRow([
      STATUS_LABEL[r.status], (b ?? p)!.supplierGstin, b?.supplierName ?? p?.supplierName ?? '', (b ?? p)!.docType,
      b?.docNo ?? '', b?.docDate ?? '', b?.taxable ?? '', b?.igst ?? '', b?.cgst ?? '', b?.sgst ?? '', b?.cess ?? '',
      p?.docNo ?? '', p?.docDate ?? '', p?.taxable ?? '', p?.igst ?? '', p?.cgst ?? '', p?.sgst ?? '', p?.cess ?? '',
      fmtDiff(r), r.notes.join('; '), r.ignoredReason ?? '',
    ]);
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ws.columns.forEach((c, i) => { c.width = i < 3 ? 22 : i >= 18 ? 45 : 14; });
  const buf = await wb.xlsx.writeBuffer();
  return { buf: Buffer.from(buf), name: `Recon_${label}_${company.gstin}_${fp}.xlsx` };
}

/** Purchase register template for books upload. */
export async function booksTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Purchase register');
  ws.addRow(['Supplier GSTIN', 'Supplier Name', 'Document Type', 'Invoice No', 'Invoice Date', 'Place of Supply', 'Reverse Charge', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess', 'Invoice Value']).font = { bold: true };
  ws.addRow(['27AAACR5055K1Z7', 'Sample Supplier Pvt Ltd', 'Invoice', 'INV/001/25-26', '05-06-2025', '29-Karnataka', 'N', 10000, 1800, 0, 0, 0, 11800]);
  ws.addRow(['27AAACR5055K1Z7', 'Sample Supplier Pvt Ltd', 'Credit Note', 'CN/004', '20-06-2025', '29-Karnataka', 'N', 1000, 180, 0, 0, 0, 1180]);
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
