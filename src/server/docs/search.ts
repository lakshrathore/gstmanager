import 'server-only';
import ExcelJS from 'exceljs';
import { analyse, buildReport, parseQuery, REPORTS, reportTotals, type BankTxn, type InvoiceData, type Rec } from '@/engine/docs';
import { canAccessCompany, type Auth } from '../auth';
import { HttpError } from '../http';
import { audit } from '../gst/gst-audit';
import { fyInfo } from '../gst/annual/common';
import { loadCompany } from '../gst/gstr1';
import { ClientDoc, Company, DocRecord, oid, type DocRecordDoc } from '../models';

/** "Search everything" across the clients the user can see, and the report tables. */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "INV-1023" also finds "INV/1023" and "inv 1023". */
export const docNoPattern = (s: string) => s.split(/[\s/\-_.]+/).filter(Boolean).map(esc).join('[\\s/\\-_.]*');

const recOf = (r: DocRecordDoc): Rec => ({
  id: String(r._id), docId: String(r.docId), kind: r.kind as Rec['kind'], source: (r.source ?? undefined) as Rec['source'], direction: (r.direction ?? null) as Rec['direction'],
  fp: r.fp ?? '', data: r.data as Rec['data'], flags: (r.flags ?? []) as Rec['flags'], review: r.review as Rec['review'],
});

export async function searchAll(auth: Auth, q: string, companyId?: string) {
  const text = q.trim().slice(0, 200);
  if (text.length < 2) throw new HttpError(400, 'Type at least 2 characters');
  const p = parseQuery(text);
  const companies = (await Company.find({ orgId: oid(auth.orgId) }).select({ name: 1, gstin: 1 }).lean())
    .filter((c) => canAccessCompany(auth, String(c._id)) && (!companyId || String(c._id) === companyId));
  const byId = new Map(companies.map((c) => [String(c._id), c]));

  const f: Record<string, unknown> = { orgId: oid(auth.orgId), companyId: { $in: companies.map((c) => c._id) }, review: { $ne: 'rejected' } };
  const kind = p.kind ?? (p.direction || p.docNos.length ? 'invoice' : undefined);
  if (kind) f.kind = kind;
  if (p.direction && kind !== 'bank') f.direction = p.direction;
  if (p.mode) f['data.mode'] = p.mode;
  if (p.flow === 'in') f['data.credit'] = { $gt: 0 };
  if (p.flow === 'out') f['data.debit'] = { $gt: 0 };
  if (p.fp) f.fp = p.fp; else if (p.fy) f.fy = p.fy;
  if (p.minAmount != null || p.maxAmount != null) f.amount = { ...(p.minAmount != null ? { $gte: p.minAmount } : {}), ...(p.maxAmount != null ? { $lte: p.maxAmount } : {}) };
  const and: Record<string, unknown>[] = [];
  if (p.gstins.length) and.push({ $or: [{ 'data.supplierGstin': { $in: p.gstins } }, { 'data.customerGstin': { $in: p.gstins } }] });
  for (const d of p.docNos) and.push({ $or: [{ docNo: { $regex: docNoPattern(d), $options: 'i' } }, { 'data.ref': { $regex: esc(d), $options: 'i' } }, { text: { $regex: esc(d.toLowerCase()) } }] });
  for (const w of p.words) and.push({ text: { $regex: esc(w) } });
  if (and.length) f.$and = and;

  // A company named in the query narrows the search to it rather than matching invoice text.
  const namedCompanies = companies.filter((c) => p.gstins.includes(c.gstin) || (p.words.length && p.words.every((w) => c.name.toLowerCase().includes(w))));

  const [rows, total, agg, docs] = await Promise.all([
    DocRecord.find(f).sort({ fp: -1, amount: -1 }).limit(200).lean(),
    DocRecord.countDocuments(f),
    DocRecord.aggregate<{ _id: string; n: number; amount: number; credit: number; debit: number; taxable: number }>([
      { $match: f },
      { $group: { _id: '$kind', n: { $sum: 1 }, amount: { $sum: '$amount' }, credit: { $sum: '$data.credit' }, debit: { $sum: '$data.debit' }, taxable: { $sum: { $cond: [{ $eq: ['$data.docType', 'CN'] }, { $multiply: ['$data.taxable', -1] }, '$data.taxable'] } } } },
    ]),
    p.words.length || p.docNos.length
      ? ClientDoc.find({ orgId: oid(auth.orgId), companyId: { $in: companies.map((c) => c._id) }, $and: [...p.words, ...p.docNos].map((w) => ({ fileName: { $regex: esc(w), $options: 'i' } })) }).sort({ createdAt: -1 }).limit(20).lean()
      : Promise.resolve([]),
  ]);
  const files = new Map((await ClientDoc.find({ _id: { $in: [...new Set(rows.map((r) => String(r.docId)))].map(oid) } }).select({ fileName: 1 }).lean()).map((d) => [String(d._id), d.fileName]));
  await audit(auth, 'docs.search', 'Organization', auth.orgId, { q: text, results: total });
  const inv = agg.find((x) => x._id === 'invoice');
  const bank = agg.find((x) => x._id === 'bank');
  return {
    query: text, understood: p.understood, total,
    totals: { invoices: inv ? { count: inv.n, taxable: Math.round(inv.taxable * 100) / 100, amount: Math.round(inv.amount * 100) / 100 } : null, bank: bank ? { count: bank.n, credit: Math.round(bank.credit * 100) / 100, debit: Math.round(bank.debit * 100) / 100 } : null },
    clients: namedCompanies.map((c) => ({ _id: String(c._id), name: c.name, gstin: c.gstin })),
    records: rows.map((r) => {
      const c = byId.get(String(r.companyId));
      return {
        _id: String(r._id), kind: r.kind, source: r.source ?? null, direction: r.direction ?? null, fp: r.fp ?? null, fy: r.fy ?? null, data: r.data as InvoiceData | BankTxn,
        flags: (r.flags ?? []).length, review: r.review, companyId: String(r.companyId), companyName: c?.name ?? '', gstin: c?.gstin ?? '', fileName: files.get(String(r.docId)) ?? '',
      };
    }),
    documents: docs.map((d) => ({ _id: String(d._id), fileName: d.fileName, kind: d.kind ?? null, fp: d.fp ?? null, fy: d.fy ?? null, status: d.status, companyId: String(d.companyId), companyName: byId.get(String(d.companyId))?.name ?? '' })),
  };
}

/* ---------- reports ---------- */

/** A client's records for a month (fp) or year and their analysis – what reports and the assistant work from. */
export async function periodData(auth: Auth, companyId: string, fy: string, fp?: string) {
  const info = fyInfo(fy);
  if (!info) throw new HttpError(400, 'Financial year must look like 2026-27');
  if (fp && !info.months.includes(fp)) throw new HttpError(400, `${fp} is not a month of FY ${fy}`);
  const company = await loadCompany(auth, companyId);
  const base = { orgId: oid(auth.orgId), companyId: company._id };
  const recs = (await DocRecord.find({ ...base, ...(fp ? { fp } : { fy }) }).lean()).map((r) => recOf(r as DocRecordDoc));
  const books = fp && recs.some((r) => r.kind === 'bank')
    ? (await DocRecord.find({ ...base, fy, kind: 'invoice', source: { $in: ['document', 'register'] } }).lean()).map((r) => recOf(r as DocRecordDoc))
    : undefined;
  const analysis = analyse(recs, { clientGstin: company.gstin, period: fp ?? info.fp, books, monthly: !!fp });
  return { company, info, recs, analysis, months: fp ? [fp] : info.months };
}

export async function report(auth: Auth, companyId: string, fy: string, fp: string | undefined, id: string) {
  if (!REPORTS.some((r) => r.id === id)) throw new HttpError(400, 'Unknown report');
  const { company, recs, analysis: a, months } = await periodData(auth, companyId, fy, fp);
  const table = buildReport(id, recs, a, months);
  return { company: { _id: String(company._id), name: company.name, gstin: company.gstin }, fy, fp: fp ?? null, table, totals: table.total ? reportTotals(table) : null };
}

export async function reportXlsx(auth: Auth, companyId: string, fy: string, fp: string | undefined, id: string) {
  const r = await report(auth, companyId, fy, fp, id);
  const t = r.table;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  ws.addRow([`${t.title} – ${r.company.name} (${r.company.gstin}) – ${fp ? `${fp.slice(0, 2)}/${fp.slice(2)}` : `FY ${fy}`}`]).font = { bold: true, size: 12 };
  if (t.note) ws.addRow([t.note]).font = { italic: true, color: { argb: 'FF666666' } };
  const h = ws.addRow(t.columns.map((c) => c.label));
  h.font = { bold: true };
  h.eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
  const fmt = (row: ExcelJS.Row) => t.columns.forEach((c, j) => { if (c.type === 'money') row.getCell(j + 1).numFmt = '#,##0.00'; });
  for (const x of t.rows) fmt(ws.addRow(t.columns.map((c) => x[c.key] ?? null)));
  if (r.totals) {
    const tr = ws.addRow(t.columns.map((c, j) => (j === 0 ? 'Total' : r.totals![c.key] ?? null)));
    tr.font = { bold: true };
    fmt(tr);
  }
  ws.columns = t.columns.map((c) => ({ width: c.type === 'money' ? 16 : Math.min(60, Math.max(12, c.label.length + 4)) }));
  await audit(auth, 'docs.export', 'Company', companyId, { kind: 'report', report: id, fy, fp: fp ?? null });
  return { fileName: `${r.company.gstin}_${id}_${fp ?? fy}.xlsx`, bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
}
