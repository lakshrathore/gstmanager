import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildReport, REPORTS, reportTotals, type BankTxn, type InvoiceData } from '@/engine/docs';
import type { Auth } from '../auth';
import { recordFilter } from '../docs';
import { docNoPattern, periodData } from '../docs/search';
import { ClientDoc, DocRecord, oid } from '../models';
import { loadCompany } from '../gst/gstr1';

/**
 * What the assistant can look at – read-only queries over one client's stored records. The model
 * never sees anything else, so every figure in an answer comes from one of these results.
 */

const FY = z.string().regex(/^\d{4}-\d{2}$/).describe('Financial year, e.g. "2026-27" (April 2026 – March 2027)');
const MONTH = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/).describe('Month as MMYYYY, e.g. "092026" for September 2026. Leave out for the whole financial year.');
const ISSUES: Record<string, string> = {
  duplicates: 'duplicate,possible_duplicate,duplicate_txn', invalid_gstin: 'invalid_gstin',
  tax_errors: 'tax_calc,total_mismatch,cgst_sgst,items_total,tax_high,pos_tax,mixed_tax', missing_details: 'missing_invoice_no,missing_date,missing_gstin',
  any: 'any', large_cash: 'cash_large', low_confidence: 'low_confidence',
};

const SCHEMAS = {
  period_summary: z.object({ fy: FY, month: MONTH.optional() }),
  run_report: z.object({ report: z.enum(REPORTS.map((r) => r.id) as [string, ...string[]]), fy: FY, month: MONTH.optional(), max_rows: z.number().int().min(1).max(300).optional() }),
  find_records: z.object({
    fy: FY.optional(), month: MONTH.optional(),
    kind: z.enum(['invoice', 'bank']).optional().describe('invoice = sales/purchase invoices and notes; bank = bank statement lines'),
    side: z.enum(['sales', 'purchase']).optional(),
    source: z.enum(['books', 'register', 'document', 'gstr1', 'gstr2b', 'gstr2a']).optional().describe('books = the client\'s own registers and invoice documents; gstr1/gstr2b/gstr2a = data from the GST portal'),
    party: z.string().max(80).optional().describe('Words of the supplier/customer name or of the bank narration'),
    gstin: z.string().max(15).optional(), invoice_no: z.string().max(40).optional(),
    min_amount: z.number().optional(), max_amount: z.number().optional(),
    issue: z.enum(Object.keys(ISSUES) as [string, ...string[]]).optional(),
    review: z.enum(['waiting', 'approved']).optional(),
    bank_mode: z.enum(['UPI', 'NEFT', 'RTGS', 'IMPS', 'CASH', 'CHEQUE', 'ATM', 'CARD', 'NACH', 'INTEREST', 'CHARGES', 'TRANSFER', 'OTHER']).optional(),
    flow: z.enum(['in', 'out']).optional().describe('Bank: money received (in) or paid (out)'),
    sort: z.enum(['date', 'amount']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  reconciliation: z.object({ fy: FY, month: MONTH.optional(), status: z.enum(['differences', 'matched', 'mismatch', 'probable', 'not_in_portal', 'not_in_books', 'all']).optional() }),
  list_documents: z.object({ fy: FY.optional(), month: MONTH.optional() }),
};
type Name = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<Name, string> = {
  period_summary: 'Totals and checks for a month or a whole financial year: sales and purchases as per the books and as per GSTR-1 / GSTR-2B, ITC as per books vs GSTR-2B and the difference, counts (records, duplicates, GSTIN errors, invoices missing in GSTR-2B, records waiting for review), the list of exceptions, automatic findings and the bank totals. Start here for overview questions.',
  run_report: `One of the standard reports as a table: ${REPORTS.map((r) => `${r.id} (${r.label})`).join(', ')}. Use for month-wise, party-wise, rate/head-wise or HSN-wise breakdowns, bank summaries and the missing-document grid.`,
  find_records: 'Find individual invoices, credit/debit notes or bank transactions with filters (period, side, source, party, GSTIN, invoice number, amount range, issue type, review state, bank mode, money in/out). Returns the matching rows (up to limit) and totals over ALL matches.',
  reconciliation: 'Purchase register (books) vs GSTR-2B for a month or year: summary (taxable and ITC per books and per portal, difference) and the invoice rows of the chosen status – differences (default: everything not matched), matched, mismatch, probable, not_in_portal (missing in GSTR-2B), not_in_books.',
  list_documents: 'The uploaded documents: file name, what it was taken as, period, processing status, records read and how many wait for review.',
};

export const TOOLS: Anthropic.Beta.BetaTool[] = (Object.keys(SCHEMAS) as Name[]).map((name) => {
  const { $schema: _s, ...schema } = z.toJSONSchema(SCHEMAS[name]) as Record<string, unknown>;
  void _s;
  return { name, description: DESCRIPTIONS[name], input_schema: schema as Anthropic.Beta.BetaTool.InputSchema };
});

/** Short label for the screen ("Looked at …"). */
export function toolLabel(name: string, input: Record<string, unknown>) {
  const period = input.month ? `${String(input.month).slice(0, 2)}/${String(input.month).slice(2)}` : input.fy ? `FY ${input.fy}` : '';
  switch (name) {
    case 'period_summary': return `Summary ${period}`;
    case 'run_report': return `${REPORTS.find((r) => r.id === input.report)?.label ?? 'Report'} ${period}`;
    case 'find_records': return `Records ${[input.side, input.kind === 'bank' ? 'bank' : '', input.party ? `“${input.party}”` : '', input.invoice_no, input.gstin, input.issue, period].filter(Boolean).join(' ')}`;
    case 'reconciliation': return `Purchase vs GSTR-2B ${period}`;
    case 'list_documents': return `Documents ${period}`;
    default: return name;
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MAX_CHARS = 40_000;

function compactInvoice(d: InvoiceData) {
  return {
    type: d.docType, no: d.invoiceNo, date: d.invoiceDate, supplier: d.supplierName, supplier_gstin: d.supplierGstin, customer: d.customerName, customer_gstin: d.customerGstin,
    pos: d.pos, taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess, total: d.total ?? null, ...(d.itcAvailable === false ? { itc_available: false } : {}),
  };
}

export async function runTool(auth: Auth, companyId: string, name: string, raw: unknown): Promise<unknown> {
  if (!(name in SCHEMAS)) throw new Error(`Unknown tool ${name}`);
  const parsed = SCHEMAS[name as Name].safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const input = parsed.data as Record<string, unknown>;
  const fy = input.fy as string | undefined;
  const fp = input.month as string | undefined;

  switch (name as Name) {
    case 'period_summary': {
      const { analysis: a, recs } = await periodData(auth, companyId, fy!, fp);
      const t = (x: { count: number; taxable: number; tax: number; total: number } | null) => (x ? { documents: x.count, taxable: x.taxable, tax: x.tax, total: x.total } : null);
      return {
        period: fp ?? `FY ${fy}`, records: recs.length,
        sales_books: { basis: a.sales.basis, ...t(a.sales.books) }, sales_gstr1: t(a.sales.gstr1),
        purchases_books: { basis: a.purchases.basis, ...t(a.purchases.books) }, purchases_portal: a.purchases.gstr2b ? { source: a.purchases.portalSource, ...t(a.purchases.gstr2b) } : null,
        itc: a.recon ? a.recon.summary.itc : null,
        counts: a.counts,
        exceptions: a.exceptions.map((e) => ({ status: e.tone, what: e.title, count: e.count, amount: e.amount ?? null })),
        findings: a.insights,
        bank: a.bank ? { transactions: a.bank.count, received: a.bank.credit, paid: a.bank.debit, matched_to_invoices: a.bank.matched, without_invoice: a.bank.unmatched.length } : null,
        missing_invoice_numbers: a.gaps.flatMap((g) => g.missing).slice(0, 50),
      };
    }
    case 'run_report': {
      const { recs, analysis, months } = await periodData(auth, companyId, fy!, fp);
      const table = buildReport(input.report as string, recs, analysis, months);
      const max = (input.max_rows as number | undefined) ?? 100;
      return { title: table.title, note: table.note, period: fp ?? `FY ${fy}`, columns: table.columns.map((c) => c.label), rows: table.rows.slice(0, max).map((r) => table.columns.map((c) => r[c.key] ?? null)), total_rows: table.rows.length, totals: table.total ? reportTotals(table) : undefined, truncated: table.rows.length > max };
    }
    case 'find_records': {
      const company = await loadCompany(auth, companyId);
      const issue = input.issue ? ISSUES[input.issue as string] : undefined;
      const f = recordFilter(auth, company, {
        companyId, fy, fp, kind: input.kind as 'invoice' | 'bank' | undefined, direction: input.side as 'sales' | 'purchase' | undefined,
        source: input.source as string | undefined, flag: issue, review: input.review === 'waiting' ? 'open' : input.review as string | undefined,
        minAmount: input.min_amount as number | undefined, maxAmount: input.max_amount as number | undefined, q: input.party as string | undefined, mode: input.bank_mode as string | undefined,
      });
      const and = (f.$and as Record<string, unknown>[] | undefined) ?? [];
      if (input.gstin) and.push({ $or: [{ 'data.supplierGstin': String(input.gstin).toUpperCase() }, { 'data.customerGstin': String(input.gstin).toUpperCase() }] });
      if (input.invoice_no) and.push({ docNo: { $regex: docNoPattern(String(input.invoice_no)), $options: 'i' } });
      if (input.flow === 'in') f['data.credit'] = { $gt: 0 };
      if (input.flow === 'out') f['data.debit'] = { $gt: 0 };
      if (and.length) f.$and = and;
      const limit = (input.limit as number | undefined) ?? 30;
      const [rows, agg] = await Promise.all([
        DocRecord.find(f).sort(input.sort === 'amount' ? { amount: -1 } : { fp: 1, 'data.invoiceDate': 1, 'data.date': 1 }).limit(limit).lean(),
        DocRecord.aggregate<{ _id: string; n: number; taxable: number; tax: number; amount: number; credit: number; debit: number }>([
          { $match: f },
          { $set: { s: { $cond: [{ $eq: ['$data.docType', 'CN'] }, -1, 1] } } },
          { $group: { _id: '$kind', n: { $sum: 1 }, taxable: { $sum: { $multiply: ['$s', { $ifNull: ['$data.taxable', 0] }] } }, tax: { $sum: { $multiply: ['$s', { $add: [{ $ifNull: ['$data.igst', 0] }, { $ifNull: ['$data.cgst', 0] }, { $ifNull: ['$data.sgst', 0] }, { $ifNull: ['$data.cess', 0] }] }] } }, amount: { $sum: '$amount' }, credit: { $sum: { $ifNull: ['$data.credit', 0] } }, debit: { $sum: { $ifNull: ['$data.debit', 0] } } } },
        ]),
      ]);
      const inv = agg.find((x) => x._id === 'invoice');
      const bank = agg.find((x) => x._id === 'bank');
      return {
        matches: (inv?.n ?? 0) + (bank?.n ?? 0), shown: rows.length,
        totals: {
          ...(inv ? { invoices: inv.n, taxable_net_of_credit_notes: r2(inv.taxable), tax_net_of_credit_notes: r2(inv.tax) } : {}),
          ...(bank ? { bank_lines: bank.n, received: r2(bank.credit), paid: r2(bank.debit) } : {}),
        },
        rows: rows.map((r) => ({
          id: String(r._id), month: r.fp, side: r.direction ?? undefined, source: r.source ?? 'bank', review: r.review,
          ...(r.kind === 'invoice' ? compactInvoice(r.data as InvoiceData) : (() => { const t = r.data as BankTxn; return { date: t.date, narration: t.narration, ref: t.ref, mode: t.mode, received: t.credit || undefined, paid: t.debit || undefined }; })()),
          issues: (r.flags ?? []).map((x: { message?: string | null }) => x.message),
        })),
      };
    }
    case 'reconciliation': {
      const { analysis: a } = await periodData(auth, companyId, fy!, fp);
      if (!a.recon) return { note: 'No reconciliation: the period needs both purchase books (register or invoices) and GSTR-2B/2A.', purchases_books: a.purchases.books, portal: a.purchases.gstr2b };
      const status = (input.status as string | undefined) ?? 'differences';
      const rows = a.recon.rows.filter((r) => (status === 'all' ? true : status === 'differences' ? r.status !== 'matched' && r.status !== 'ignored' : r.status === status));
      const tax = (d?: { igst: number; cgst: number; sgst: number; cess: number }) => (d ? r2(d.igst + d.cgst + d.sgst + d.cess) : null);
      return {
        period: fp ?? `FY ${fy}`, portal: a.purchases.portalSource,
        summary: { books: a.recon.summary.books, portal: a.recon.summary.portal, itc: a.recon.summary.itc, by_status: Object.fromEntries(Object.entries(a.recon.summary.byStatus).map(([k, v]) => [k, v.count])) },
        rows: rows.slice(0, 150).map((r) => ({
          status: r.status, supplier: (r.books ?? r.portal)!.supplierName, gstin: (r.books ?? r.portal)!.supplierGstin,
          books: r.books ? { no: r.books.docNo, date: r.books.docDate, taxable: r.books.taxable, tax: tax(r.books) } : null,
          portal: r.portal ? { no: r.portal.docNo, date: r.portal.docDate, taxable: r.portal.taxable, tax: tax(r.portal), itc_available: r.portal.itcAvailable } : null,
          differences: r.diffs.map((d) => `${d.field}: books ${d.books} vs portal ${d.portal}`), notes: r.notes,
        })),
        total_rows: rows.length,
      };
    }
    case 'list_documents': {
      const company = await loadCompany(auth, companyId);
      const docs = await ClientDoc.find({ orgId: oid(auth.orgId), companyId: company._id, ...(fp ? { fp } : fy ? { fy } : {}) }).sort({ createdAt: -1 }).limit(200).lean();
      return { documents: docs.map((d) => ({ file: d.fileName, type: d.kind, month: d.fp, status: d.status, records: d.counts?.records ?? 0, waiting_for_review: d.counts?.review ?? 0, error: d.error ?? undefined })) };
    }
  }
}

/** JSON for a tool_result, cut to a size the model can use (it is told when it was cut). */
export function resultText(result: unknown) {
  const s = JSON.stringify(result);
  return s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}… [cut: result too long – ask for a narrower period or fewer rows]`;
}
