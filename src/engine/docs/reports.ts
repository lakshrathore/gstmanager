import { booksFor, type Analysis, type Rec } from './analysis';
import { NOTE_LABEL, type BankTxn, type InvoiceData } from './types';

/**
 * Reports over a client's records for a month or a year, all as one table shape so the browser and
 * the Excel export render any of them the same way.
 */

export type ColType = 'text' | 'money' | 'num';
export interface ReportTable {
  id: string;
  title: string;
  note?: string;
  columns: { key: string; label: string; type?: ColType }[];
  rows: Record<string, string | number | null>[];
  /** Sum of the money/num columns, shown as the last row. */
  total?: boolean;
  /** Record behind each row (opens the record), by row index. */
  recordIds?: (string | null)[];
}

export const REPORTS: { id: string; label: string; group: string }[] = [
  { id: 'sales_summary', label: 'Sales summary', group: 'GST' },
  { id: 'purchase_summary', label: 'Purchase summary', group: 'GST' },
  { id: 'gst_summary', label: 'GST summary (output tax vs ITC)', group: 'GST' },
  { id: 'itc_summary', label: 'ITC summary (books vs GSTR-2B)', group: 'GST' },
  { id: 'recon', label: 'Purchase register vs GSTR-2B', group: 'GST' },
  { id: 'hsn', label: 'HSN-wise sales', group: 'GST' },
  { id: 'invoices', label: 'Invoice report', group: 'Parties' },
  { id: 'suppliers', label: 'Supplier report', group: 'Parties' },
  { id: 'customers', label: 'Customer report', group: 'Parties' },
  { id: 'bank_summary', label: 'Bank summary', group: 'Bank' },
  { id: 'bank_unmatched', label: 'Bank transactions without invoices', group: 'Bank' },
  { id: 'bank_unusual', label: 'Unusual bank transactions', group: 'Bank' },
  { id: 'exceptions', label: 'Exception report', group: 'Checks' },
  { id: 'duplicates', label: 'Duplicate report', group: 'Checks' },
  { id: 'errors', label: 'Error report', group: 'Checks' },
  { id: 'missing_documents', label: 'Missing document report', group: 'Checks' },
  { id: 'invoice_gaps', label: 'Missing invoice numbers', group: 'Checks' },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const s = (d: InvoiceData) => (d.docType === 'CN' ? -1 : 1);
const tax = (d: InvoiceData) => d.igst + d.cgst + d.sgst + d.cess;
const ml = (fp: string) => new Date(Number(fp.slice(2)), Number(fp.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
type Inv = Rec & { kind: 'invoice'; data: InvoiceData };
const isInv = (r: Rec): r is Inv => r.kind === 'invoice' && r.review !== 'rejected';
const isBank = (r: Rec): r is Rec & { kind: 'bank'; data: BankTxn } => r.kind === 'bank' && r.review !== 'rejected';
const money = (label: string, key: string) => ({ key, label, type: 'money' as const });

function sums(recs: Inv[]) {
  const t = { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  for (const r of recs) {
    const d = r.data; const k = s(d);
    t.count++; t.taxable += k * d.taxable; t.igst += k * d.igst; t.cgst += k * d.cgst; t.sgst += k * d.sgst; t.cess += k * d.cess; t.total += k * (d.total ?? d.taxable + tax(d));
  }
  return Object.fromEntries(Object.entries(t).map(([a, b]) => [a, a === 'count' ? b : r2(b)])) as typeof t;
}

function party(recs: Inv[], side: 'sales' | 'purchase') {
  const m = new Map<string, { name: string; gstin: string; recs: Inv[] }>();
  for (const r of recs) {
    const gstin = (side === 'sales' ? r.data.customerGstin : r.data.supplierGstin) ?? '';
    const name = (side === 'sales' ? r.data.customerName : r.data.supplierName) ?? '';
    const k = gstin || name || '—';
    const cur = m.get(k) ?? { name, gstin, recs: [] };
    if (!cur.name) cur.name = name;
    cur.recs.push(r);
    m.set(k, cur);
  }
  return [...m.values()].map((p) => ({ name: p.name || '—', gstin: p.gstin, ...sums(p.recs) })).sort((a, b) => b.taxable - a.taxable);
}

export function buildReport(id: string, recs: Rec[], a: Analysis, months: string[]): ReportTable {
  const inv = recs.filter(isInv);
  const bank = recs.filter(isBank);
  const byMonth = (fp: string) => inv.filter((r) => r.fp === fp);
  const sumCols = [{ key: 'count', label: 'Documents', type: 'num' as const }, money('Taxable', 'taxable'), money('IGST', 'igst'), money('CGST', 'cgst'), money('SGST', 'sgst'), money('Cess', 'cess'), money('Total', 'total')];

  switch (id) {
    case 'sales_summary':
    case 'purchase_summary': {
      const side = id === 'sales_summary' ? 'sales' : 'purchase';
      const portal = side === 'sales' ? ['gstr1'] : ['gstr2b', 'gstr2a'];
      const rows = months.map((fp) => {
        const m = byMonth(fp);
        const b = sums(booksFor(m, side).books);
        const p = sums(m.filter((r) => portal.includes(r.source ?? '')));
        return { month: ml(fp), ...b, portal: p.count ? p.taxable : null, diff: p.count ? r2(b.taxable - p.taxable) : null };
      });
      return {
        id, title: side === 'sales' ? 'Sales summary' : 'Purchase summary', total: true,
        note: `Books: the ${side} register when there is one for the month, else the ${side} invoices. Credit notes are subtracted.`,
        columns: [{ key: 'month', label: 'Month' }, ...sumCols, money(side === 'sales' ? 'GSTR-1 taxable' : 'GSTR-2B taxable', 'portal'), money('Difference', 'diff')],
        rows,
      };
    }
    case 'gst_summary': {
      const rows = months.map((fp) => {
        const m = byMonth(fp);
        const out = sums(booksFor(m, 'sales').books);
        const itc = sums(booksFor(m, 'purchase').books.filter((r) => r.data.itcAvailable !== false && !r.data.rcm));
        return {
          month: ml(fp), out_i: out.igst, out_c: out.cgst, out_s: out.sgst, itc_i: itc.igst, itc_c: itc.cgst, itc_s: itc.sgst,
          net: r2(out.igst + out.cgst + out.sgst - itc.igst - itc.cgst - itc.sgst),
        };
      });
      return {
        id, title: 'GST summary – output tax vs ITC (books)', total: true,
        note: 'Net = output tax − ITC, before the set-off order of section 49/49A and before cess. A negative net is carried-forward credit.',
        columns: [{ key: 'month', label: 'Month' }, money('Output IGST', 'out_i'), money('Output CGST', 'out_c'), money('Output SGST', 'out_s'), money('ITC IGST', 'itc_i'), money('ITC CGST', 'itc_c'), money('ITC SGST', 'itc_s'), money('Net', 'net')],
        rows,
      };
    }
    case 'itc_summary': {
      const rows = months.map((fp) => {
        const m = byMonth(fp);
        const books = sums(booksFor(m, 'purchase').books);
        const p = m.filter((r) => r.source === 'gstr2b' || r.source === 'gstr2a');
        const avail = sums(p.filter((r) => r.data.itcAvailable !== false));
        const blocked = sums(p.filter((r) => r.data.itcAvailable === false));
        const bt = r2(books.igst + books.cgst + books.sgst + books.cess);
        const pt = r2(avail.igst + avail.cgst + avail.sgst + avail.cess);
        return { month: ml(fp), books: bt, portal: p.length ? pt : null, blocked: p.length ? r2(blocked.igst + blocked.cgst + blocked.sgst + blocked.cess) : null, diff: p.length ? r2(bt - pt) : null };
      });
      return {
        id, title: 'ITC summary – books vs GSTR-2B', total: true,
        columns: [{ key: 'month', label: 'Month' }, money('ITC as per books', 'books'), money('ITC available in 2B', 'portal'), money('ITC not available in 2B', 'blocked'), money('Difference', 'diff')],
        rows,
      };
    }
    case 'recon': {
      const STATUS: Record<string, string> = { matched: 'Matched', mismatch: 'Mismatch', probable: 'Probable', not_in_portal: 'Missing in 2B', not_in_books: 'Not in books', ignored: 'Ignored' };
      const rows = a.recon?.rows ?? [];
      const t = (d?: { igst: number; cgst: number; sgst: number; cess: number }) => (d ? r2(d.igst + d.cgst + d.sgst + d.cess) : null);
      return {
        id, title: 'Purchase register vs GSTR-2B',
        note: a.recon ? undefined : 'Upload the purchase register (or purchase invoices) and the GSTR-2B to reconcile.',
        columns: [{ key: 'status', label: 'Status' }, { key: 'gstin', label: 'Supplier GSTIN' }, { key: 'name', label: 'Supplier' }, { key: 'bno', label: 'Books inv no' }, { key: 'bdate', label: 'Books date' }, money('Books tax', 'btax'), { key: 'pno', label: '2B inv no' }, money('2B tax', 'ptax'), money('Difference', 'diff'), { key: 'why', label: 'What differs' }],
        rows: rows.map((r) => {
          const d = (r.books ?? r.portal)!;
          return { status: STATUS[r.status], gstin: d.supplierGstin, name: d.supplierName ?? '', bno: r.books?.docNo ?? '', bdate: r.books?.docDate ?? '', btax: t(r.books), pno: r.portal?.docNo ?? '', ptax: t(r.portal), diff: r2((t(r.books) ?? 0) - (t(r.portal) ?? 0)), why: [...r.diffs.map((x) => `${x.field}: ${x.books} vs ${x.portal}`), ...r.notes].join('; ') };
        }),
        recordIds: rows.map((r) => r.books?.origin?.file ?? r.portal?.origin?.file ?? null),
      };
    }
    case 'hsn': {
      const m = new Map<string, { hsn: string; rate: number | null; count: number; qty: number; taxable: number; tax: number }>();
      for (const r of booksFor(inv, 'sales').books) {
        for (const it of r.data.items ?? []) {
          if (!it.hsn) continue;
          const k = `${it.hsn}|${it.gstRate ?? ''}`;
          const cur = m.get(k) ?? { hsn: it.hsn, rate: it.gstRate ?? null, count: 0, qty: 0, taxable: 0, tax: 0 };
          cur.count++; cur.qty += it.quantity ?? 0; cur.taxable += s(r.data) * (it.taxable ?? 0); cur.tax += s(r.data) * ((it.igst ?? 0) + (it.cgst ?? 0) + (it.sgst ?? 0) + (it.cess ?? 0));
          m.set(k, cur);
        }
      }
      return {
        id, title: 'HSN-wise sales (books)', total: true, note: m.size ? undefined : 'No HSN codes in the sales invoices or register for this period.',
        columns: [{ key: 'hsn', label: 'HSN/SAC' }, { key: 'rate', label: 'Rate %', type: 'num' }, { key: 'count', label: 'Lines', type: 'num' }, { key: 'qty', label: 'Quantity', type: 'num' }, money('Taxable', 'taxable'), money('Tax', 'tax')],
        rows: [...m.values()].sort((x, y) => y.taxable - x.taxable).map((x) => ({ ...x, taxable: r2(x.taxable), tax: r2(x.tax) })),
      };
    }
    case 'invoices': {
      const SRC: Record<string, string> = { document: 'Invoice', register: 'Register', gstr1: 'GSTR-1', gstr2a: 'GSTR-2A', gstr2b: 'GSTR-2B' };
      const list = [...inv].sort((x, y) => (x.data.invoiceDate || '').localeCompare(y.data.invoiceDate || ''));
      return {
        id, title: 'Invoice report', total: true,
        columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'no', label: 'Number' }, { key: 'side', label: 'Side' }, { key: 'source', label: 'Source' }, { key: 'party', label: 'Party' }, { key: 'gstin', label: 'GSTIN' }, money('Taxable', 'taxable'), money('Tax', 'tax'), money('Total', 'total'), { key: 'issues', label: 'Issues' }],
        rows: list.map((r) => {
          const sales = r.direction === 'sales';
          return { date: r.data.invoiceDate, type: NOTE_LABEL[r.data.docType], no: r.data.invoiceNo, side: r.direction ?? '?', source: SRC[r.source ?? ''] ?? '', party: (sales ? r.data.customerName : r.data.supplierName) ?? '', gstin: (sales ? r.data.customerGstin : r.data.supplierGstin) ?? '', taxable: r.data.taxable, tax: r2(tax(r.data)), total: r.data.total ?? null, issues: r.flags.map((f) => f.message).join(' | ') };
        }),
        recordIds: list.map((r) => r.id),
      };
    }
    case 'suppliers':
    case 'customers': {
      const side = id === 'customers' ? 'sales' : 'purchase';
      return {
        id, title: side === 'sales' ? 'Customer-wise sales (books)' : 'Supplier-wise purchases (books)', total: true,
        columns: [{ key: 'name', label: side === 'sales' ? 'Customer' : 'Supplier' }, { key: 'gstin', label: 'GSTIN' }, ...sumCols],
        rows: party(booksFor(inv, side).books, side),
      };
    }
    case 'bank_summary': {
      const m = new Map<string, { month: string; mode: string; count: number; credit: number; debit: number }>();
      for (const r of bank) {
        const k = `${r.fp}|${r.data.mode}`;
        const cur = m.get(k) ?? { month: r.fp ? ml(r.fp) : '—', mode: r.data.mode, count: 0, credit: 0, debit: 0 };
        cur.count++; cur.credit += r.data.credit; cur.debit += r.data.debit;
        m.set(k, cur);
      }
      const rows = [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, v]) => ({ ...v, credit: r2(v.credit), debit: r2(v.debit) }));
      return { id, title: 'Bank summary by month and mode', total: true, columns: [{ key: 'month', label: 'Month' }, { key: 'mode', label: 'Mode' }, { key: 'count', label: 'Transactions', type: 'num' }, money('Received', 'credit'), money('Paid', 'debit')], rows };
    }
    case 'bank_unmatched':
    case 'bank_unusual': {
      const pick = id === 'bank_unmatched' ? bank.filter((r) => a.bank?.matches[r.id]?.status === 'unmatched') : bank.filter((r) => a.bank?.unusual[r.id]);
      return {
        id, title: id === 'bank_unmatched' ? 'Bank transactions without a matching invoice' : 'Unusual bank transactions', total: true,
        note: id === 'bank_unmatched' ? 'Receipts matched to sales invoices and payments to purchase invoices by amount, date (30 days before to 180 days after) and party name. Bank charges and interest are left out.' : undefined,
        columns: [{ key: 'date', label: 'Date' }, { key: 'narration', label: 'Narration' }, { key: 'mode', label: 'Mode' }, money('Received', 'credit'), money('Paid', 'debit'), { key: 'why', label: id === 'bank_unmatched' ? 'Note' : 'Why' }],
        rows: pick.map((r) => ({ date: r.data.date, narration: r.data.narration, mode: r.data.mode, credit: r.data.credit || null, debit: r.data.debit || null, why: id === 'bank_unmatched' ? a.bank?.matches[r.id]?.note ?? '' : a.bank?.unusual[r.id] ?? '' })),
        recordIds: pick.map((r) => r.id),
      };
    }
    case 'exceptions':
      return { id, title: 'Exception report', columns: [{ key: 'status', label: '' }, { key: 'what', label: 'What' }, { key: 'count', label: 'Count', type: 'num' }, money('Amount', 'amount')], rows: a.exceptions.map((e) => ({ status: e.tone === 'ok' ? '✓' : '⚠', what: e.title, count: e.count, amount: e.amount ?? null })) };
    case 'duplicates':
    case 'errors': {
      const dup = (c?: string) => !!c && /dup/.test(c);
      const pick = recs.filter((r) => r.review !== 'rejected' && (id === 'duplicates' ? r.flags.some((f) => dup(f.code)) : r.flags.length > 0 && r.review !== 'approved'));
      return {
        id, title: id === 'duplicates' ? 'Possible duplicates' : 'Records with issues (not yet approved)',
        columns: [{ key: 'what', label: 'Record' }, { key: 'date', label: 'Date' }, money('Amount', 'amount'), { key: 'severity', label: 'Severity' }, { key: 'issue', label: id === 'duplicates' ? 'Why' : 'Issue' }],
        rows: pick.map((r) => {
          const d = r.data as InvoiceData & BankTxn;
          const fl = r.flags.filter((f) => (id === 'duplicates' ? dup(f.code) : true));
          return {
            what: r.kind === 'invoice' ? `${NOTE_LABEL[d.docType]} ${d.invoiceNo} – ${(r.direction === 'sales' ? d.customerName : d.supplierName) ?? ''}` : `Bank: ${d.narration.slice(0, 60)}`,
            date: r.kind === 'invoice' ? d.invoiceDate : d.date, amount: r.kind === 'invoice' ? d.total ?? d.taxable : d.debit || d.credit,
            severity: fl.some((f) => f.severity === 'error') ? 'Error' : 'Warning', issue: fl.map((f) => f.message).join(' | '),
          };
        }),
        recordIds: pick.map((r) => r.id),
      };
    }
    case 'missing_documents': {
      const has = (fp: string, f: (r: Rec) => boolean) => recs.filter((r) => r.fp === fp && r.review !== 'rejected' && f(r)).length;
      const mark = (n: number) => (n ? `✓ ${n}` : '✗');
      return {
        id, title: 'Missing document report', note: '✗ = nothing uploaded for that month. Quarterly (QRMP) filers have GSTR-1 only for quarter-end months.',
        columns: [{ key: 'month', label: 'Month' }, { key: 'sales', label: 'Sales (books)' }, { key: 'gstr1', label: 'GSTR-1' }, { key: 'purchase', label: 'Purchases (books)' }, { key: 'gstr2b', label: 'GSTR-2B' }, { key: 'bank', label: 'Bank' }],
        rows: months.map((fp) => ({
          month: ml(fp),
          sales: mark(has(fp, (r) => r.direction === 'sales' && (r.source === 'register' || r.source === 'document'))),
          gstr1: mark(has(fp, (r) => r.source === 'gstr1')),
          purchase: mark(has(fp, (r) => r.direction === 'purchase' && (r.source === 'register' || r.source === 'document'))),
          gstr2b: mark(has(fp, (r) => r.source === 'gstr2b' || r.source === 'gstr2a')),
          bank: mark(has(fp, (r) => r.kind === 'bank')),
        })),
      };
    }
    case 'invoice_gaps':
      return {
        id, title: 'Missing sales invoice numbers', note: a.gaps.length ? 'Numbers skipped inside a series – cancelled invoices should still be reported in GSTR-1 table 13.' : 'No gaps in the sales invoice series.',
        columns: [{ key: 'series', label: 'Series' }, { key: 'range', label: 'Range' }, { key: 'count', label: 'Missing', type: 'num' }, { key: 'missing', label: 'Missing numbers' }],
        rows: a.gaps.map((g) => ({ series: g.prefix || '(numbers only)', range: `${g.from} – ${g.to}`, count: g.missing.length, missing: g.missing.join(', ') })),
      };
    default:
      throw new Error(`Unknown report ${id}`);
  }
}

/** Totals row for a report (money and number columns). */
export function reportTotals(t: ReportTable): Record<string, number | null> {
  return Object.fromEntries(t.columns.filter((c) => c.type === 'money' || (c.type === 'num' && c.key !== 'rate')).map((c) => [c.key, r2(t.rows.reduce((a, r) => a + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0))]));
}
