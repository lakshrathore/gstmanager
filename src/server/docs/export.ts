import 'server-only';
import ExcelJS from 'exceljs';
import { analyse, NOTE_LABEL, type BankTxn, type InvoiceData, type Rec } from '@/engine/docs';
import { STATE_CODES } from '@/engine/masters';
import type { Auth } from '../auth';
import { HttpError } from '../http';
import { audit } from '../gst/gst-audit';
import { fyInfo } from '../gst/annual/common';
import { loadCompany } from '../gst/gstr1';
import { ClientDoc, DocRecord, oid, type DocRecordDoc } from '../models';
import { recordFilter, type RecordQuery } from '.';

/**
 * Excel of a client's period: summary and exceptions, sales, purchases, GSTR-2B, reconciliation,
 * supplier- and customer-wise totals, bank transactions, duplicates and errors – or just the records
 * matching the filters on screen.
 */

const MONEY = '#,##0.00';
const SOURCE: Record<string, string> = { document: 'Invoice document', register: 'Register', gstr1: 'GSTR-1', gstr2a: 'GSTR-2A', gstr2b: 'GSTR-2B' };
const STATUS: Record<string, string> = { matched: 'Matched', mismatch: 'Mismatch', probable: 'Probable match', not_in_portal: 'Missing in GSTR-2B', not_in_books: 'Not in books', ignored: 'Ignored' };

function sheet(wb: ExcelJS.Workbook, name: string, title: string, head: string[], rows: unknown[][], money: number[] = []) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 12 };
  const h = ws.addRow(head);
  h.font = { bold: true };
  h.eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
  for (const r of rows) {
    const row = ws.addRow(r as ExcelJS.CellValue[]);
    for (const j of money) row.getCell(j + 1).numFmt = MONEY;
  }
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  ws.columns = head.map((x, j) => ({ width: money.includes(j) ? 15 : Math.min(45, Math.max(10, x.length + 4)) }));
  return ws;
}

const invHead = ['Source', 'File', 'Page/Row', 'Type', 'Invoice no', 'Date', 'Supplier', 'Supplier GSTIN', 'Customer', 'Customer GSTIN', 'POS', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Total', 'Review', 'Issues'];
const invRow = (r: DocRecordDoc, file: string) => {
  const d = r.data as InvoiceData;
  return [
    SOURCE[r.source ?? ''] ?? r.source, file, r.loc?.page ? `p.${r.loc.page}` : r.loc?.sheet ? `${r.loc.sheet}!${r.loc.row}` : '', NOTE_LABEL[d.docType], d.invoiceNo, d.invoiceDate,
    d.supplierName ?? '', d.supplierGstin ?? '', d.customerName ?? '', d.customerGstin ?? '', d.pos ? `${d.pos}-${STATE_CODES[d.pos] ?? ''}` : '',
    d.taxable, d.igst, d.cgst, d.sgst, d.cess, d.total ?? null, r.review, (r.flags ?? []).map((f) => f.message).join(' | '),
  ];
};
const INV_MONEY = [11, 12, 13, 14, 15, 16];
const bankHead = ['File', 'Page/Row', 'Date', 'Narration', 'Reference', 'Mode', 'Debit', 'Credit', 'Balance', 'Review', 'Issues'];
const bankRow = (r: DocRecordDoc, file: string) => {
  const d = r.data as BankTxn;
  return [file, r.loc?.page ? `p.${r.loc.page}` : r.loc?.sheet ? `${r.loc.sheet}!${r.loc.row}` : '', d.date, d.narration, d.ref ?? '', d.mode, d.debit || null, d.credit || null, d.balance ?? null, r.review, (r.flags ?? []).map((f) => f.message).join(' | ')];
};

function partySummary(recs: DocRecordDoc[], side: 'sales' | 'purchase') {
  const m = new Map<string, { name: string; gstin: string; count: number; taxable: number; tax: number; total: number }>();
  for (const r of recs) {
    const d = r.data as InvoiceData;
    const gstin = (side === 'sales' ? d.customerGstin : d.supplierGstin) ?? '';
    const name = (side === 'sales' ? d.customerName : d.supplierName) ?? '';
    const k = gstin || name || '—';
    const s = d.docType === 'CN' ? -1 : 1;
    const cur = m.get(k) ?? { name, gstin, count: 0, taxable: 0, tax: 0, total: 0 };
    cur.count++; cur.taxable += s * d.taxable; cur.tax += s * (d.igst + d.cgst + d.sgst + d.cess); cur.total += s * (d.total ?? d.taxable + d.igst + d.cgst + d.sgst + d.cess);
    if (!cur.name && name) cur.name = name;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.taxable - a.taxable).map((x) => [x.name, x.gstin, x.count, x.taxable, x.tax, x.total]);
}

export async function exportReport(auth: Auth, companyId: string, fy: string, fp?: string) {
  const info = fyInfo(fy);
  if (!info) throw new HttpError(400, 'Financial year must look like 2026-27');
  const company = await loadCompany(auth, companyId);
  const base = { orgId: oid(auth.orgId), companyId: company._id, ...(fp ? { fp } : { fy }), review: { $ne: 'rejected' } };
  const all = (await DocRecord.find(base).sort({ fp: 1, 'data.invoiceDate': 1, 'data.date': 1 }).lean()) as DocRecordDoc[];
  const files = new Map((await ClientDoc.find({ _id: { $in: [...new Set(all.map((r) => String(r.docId)))].map(oid) } }).select({ fileName: 1 }).lean()).map((d) => [String(d._id), d.fileName]));
  const file = (r: DocRecordDoc) => files.get(String(r.docId)) ?? '';
  const recs: Rec[] = all.map((r) => ({ id: String(r._id), docId: String(r.docId), kind: r.kind as Rec['kind'], source: r.source as Rec['source'], direction: r.direction as Rec['direction'], fp: r.fp ?? '', data: r.data as Rec['data'], flags: (r.flags ?? []) as Rec['flags'], review: r.review as Rec['review'] }));
  const a = analyse(recs, { clientGstin: company.gstin, period: fp ?? info.fp, monthly: !!fp });
  const byId = new Map(all.map((r) => [String(r._id), r]));
  const label = fp ? `${fp.slice(0, 2)}/${fp.slice(2)}` : `FY ${fy}`;
  const title = (what: string) => `${what} – ${company.name} (${company.gstin}) – ${label}`;

  const wb = new ExcelJS.Workbook();
  const t = (x: { taxable: number; tax: number; count: number } | null) => (x ? [x.count, x.taxable, x.tax] : [null, null, null]);
  sheet(wb, 'Summary', title('Summary'), ['', 'Documents', 'Taxable value', 'Tax'], [
    [`Sales (books – ${a.sales.basis})`, ...t(a.sales.books)],
    ['Sales as per GSTR-1', ...t(a.sales.gstr1)],
    [`Purchases (books – ${a.purchases.basis})`, ...t(a.purchases.books)],
    [`Purchases as per ${a.purchases.portalSource === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B'}`, ...t(a.purchases.gstr2b)],
    ['ITC as per books', null, null, a.recon?.summary.itc.books ?? null],
    ['ITC as per portal', null, null, a.recon?.summary.itc.portal ?? null],
    ['ITC difference', null, null, a.recon?.summary.itc.difference ?? null],
    [],
    ['Records', a.counts.records], ['Duplicates', a.counts.duplicates], ['GSTIN errors', a.counts.gstinErrors], ['Missing in GSTR-2B', a.counts.missingIn2b],
    ['Waiting for review', a.counts.needsReview], ['Other issues', a.counts.otherIssues],
    [], ['Findings'], ...a.insights.map((x, i) => [`${i + 1}. ${x}`]),
  ], [2, 3]);

  const exRows: unknown[][] = [];
  for (const e of a.exceptions) {
    exRows.push([e.tone === 'ok' ? '✓' : '⚠', e.title, e.count, e.amount ?? null]);
    for (const id of e.ids.slice(0, 500)) {
      const r = byId.get(id);
      if (!r) continue;
      const d = r.data as InvoiceData & BankTxn;
      exRows.push(['', `   ${r.kind === 'invoice' ? `${d.invoiceNo} ${d.invoiceDate} ${d.supplierName ?? d.customerName ?? ''}` : `${d.date} ${d.narration}`}`, file(r), r.kind === 'invoice' ? d.taxable : d.debit || d.credit, (r.flags ?? []).map((f) => f.message).join(' | ')]);
    }
  }
  sheet(wb, 'Exceptions', title('Exceptions'), ['', 'What', 'Count / file', 'Amount', 'Details'], exRows, [3]);

  const inv = all.filter((r) => r.kind === 'invoice');
  const books = (dir: string) => inv.filter((r) => r.direction === dir && (r.source === 'document' || r.source === 'register'));
  sheet(wb, 'Sales', title('Sales (books)'), invHead, books('sales').map((r) => invRow(r, file(r))), INV_MONEY);
  sheet(wb, 'Purchases', title('Purchases (books)'), invHead, books('purchase').map((r) => invRow(r, file(r))), INV_MONEY);
  const portal = inv.filter((r) => r.source === 'gstr2b' || r.source === 'gstr2a');
  if (portal.length) sheet(wb, 'GSTR-2B', title('GSTR-2A / 2B'), invHead, portal.map((r) => invRow(r, file(r))), INV_MONEY);
  const g1 = inv.filter((r) => r.source === 'gstr1');
  if (g1.length) sheet(wb, 'GSTR-1', title('GSTR-1'), invHead, g1.map((r) => invRow(r, file(r))), INV_MONEY);

  if (a.recon) {
    const rows = a.recon.rows.map((r) => {
      const b = r.books, p = r.portal;
      const tax = (d?: { igst: number; cgst: number; sgst: number; cess: number }) => (d ? d.igst + d.cgst + d.sgst + d.cess : null);
      return [STATUS[r.status] ?? r.status, (b ?? p)!.supplierGstin, (b ?? p)!.supplierName ?? '', b?.docNo ?? '', b?.docDate ?? '', b?.taxable ?? null, tax(b), p?.docNo ?? '', p?.docDate ?? '', p?.taxable ?? null, tax(p),
        b && p ? Math.round(((tax(b) ?? 0) - (tax(p) ?? 0)) * 100) / 100 : null, r.diffs.map((d) => `${d.field}: ${d.books} vs ${d.portal}`).join('; '), r.notes.join('; ')];
    });
    sheet(wb, 'Reconciliation', title('Purchase register vs GSTR-2B'), ['Status', 'Supplier GSTIN', 'Supplier', 'Books inv no', 'Books date', 'Books taxable', 'Books tax', 'Portal inv no', 'Portal date', 'Portal taxable', 'Portal tax', 'Tax difference', 'Differences', 'Notes'], rows, [5, 6, 9, 10, 11]);
  }
  sheet(wb, 'Supplier summary', title('Supplier-wise purchases'), ['Supplier', 'GSTIN', 'Documents', 'Taxable', 'Tax', 'Total'], partySummary(books('purchase'), 'purchase'), [3, 4, 5]);
  sheet(wb, 'Customer summary', title('Customer-wise sales'), ['Customer', 'GSTIN', 'Documents', 'Taxable', 'Tax', 'Total'], partySummary(books('sales'), 'sales'), [3, 4, 5]);
  const bank = all.filter((r) => r.kind === 'bank');
  if (bank.length) sheet(wb, 'Bank', title('Bank transactions'), bankHead, bank.map((r) => bankRow(r, file(r))), [6, 7, 8]);
  const dups = all.filter((r) => r.flags?.some((f) => ['duplicate', 'possible_duplicate', 'duplicate_txn'].includes(f.code ?? '')));
  sheet(wb, 'Duplicates', title('Possible duplicates'), [...invHead.slice(0, 7), 'Taxable / amount', 'Reason'], dups.map((r) => {
    const d = r.data as InvoiceData & BankTxn;
    return r.kind === 'invoice'
      ? [...invRow(r, file(r)).slice(0, 7), d.taxable, (r.flags ?? []).filter((f) => /dup/.test(f.code ?? '')).map((f) => f.message).join(' | ')]
      : ['Bank', file(r), '', '', d.ref ?? '', d.date, d.narration, d.debit || d.credit, (r.flags ?? []).filter((f) => /dup/.test(f.code ?? '')).map((f) => f.message).join(' | ')];
  }), [7]);
  const errs = all.filter((r) => r.flags?.length && r.review !== 'approved');
  sheet(wb, 'Errors', title('Records with issues'), ['File', 'Page/Row', 'Document', 'Severity', 'Field', 'Issue'], errs.flatMap((r) => (r.flags ?? []).map((f) => {
    const d = r.data as InvoiceData & BankTxn;
    return [file(r), r.loc?.page ? `p.${r.loc.page}` : r.loc?.sheet ? `${r.loc.sheet}!${r.loc.row}` : '', r.kind === 'invoice' ? `${d.invoiceNo} ${d.invoiceDate}` : `${d.date} ${d.narration?.slice(0, 40)}`, f.severity, f.field ?? '', f.message];
  })));

  await audit(auth, 'docs.export', 'Company', String(company._id), { fy, fp: fp ?? null, kind: 'report' });
  return { fileName: `${company.gstin}_${fp ?? fy}_report.xlsx`, bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
}

/** Just the records matching the on-screen filters. */
export async function exportRecords(auth: Auth, q: RecordQuery) {
  const company = await loadCompany(auth, q.companyId);
  const rows = (await DocRecord.find(recordFilter(auth, company, q)).sort({ fp: 1, 'data.invoiceDate': 1, 'data.date': 1 }).limit(50_000).lean()) as DocRecordDoc[];
  const files = new Map((await ClientDoc.find({ _id: { $in: [...new Set(rows.map((r) => String(r.docId)))].map(oid) } }).select({ fileName: 1 }).lean()).map((d) => [String(d._id), d.fileName]));
  const wb = new ExcelJS.Workbook();
  const inv = rows.filter((r) => r.kind === 'invoice');
  const bank = rows.filter((r) => r.kind === 'bank');
  const title = `${company.name} (${company.gstin}) – ${q.fp ?? q.fy ?? ''}`;
  if (inv.length || !bank.length) sheet(wb, 'Invoices', title, invHead, inv.map((r) => invRow(r, files.get(String(r.docId)) ?? '')), INV_MONEY);
  if (bank.length) sheet(wb, 'Bank', title, bankHead, bank.map((r) => bankRow(r, files.get(String(r.docId)) ?? '')), [6, 7, 8]);
  await audit(auth, 'docs.export', 'Company', String(company._id), { kind: 'records', count: rows.length });
  return { fileName: `${company.gstin}_records.xlsx`, bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
}
