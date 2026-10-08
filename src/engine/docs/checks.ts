import { STATE_CODES } from '../masters';
import { normaliseDocNo } from '../recon/normalize';
import { checkGstin } from '../util';
import type { BankTxn, Direction, Flag, InvoiceData, InvoiceSource } from './types';

/**
 * Checks on extracted records: GSTINs, missing details, tax arithmetic, place of supply, totals, dates,
 * and duplicates across everything already filed for the client. Every flag says why, in words a CA
 * can act on.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const rs = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

export interface CheckContext {
  clientGstin: string;
  direction: Direction | null;
  /** Fields the extractor was not sure about (AI). */
  uncertain?: string[];
  today?: string;
}

export function checkInvoice(d: InvoiceData, ctx: CheckContext): Flag[] {
  const f: Flag[] = [];
  const err = (code: string, message: string, field?: string) => f.push({ code, severity: 'error', field, message });
  const warn = (code: string, message: string, field?: string) => f.push({ code, severity: 'warning', field, message });
  const party = ctx.direction === 'sales' ? 'customer' : 'supplier';
  const partyGstin = ctx.direction === 'sales' ? d.customerGstin : d.supplierGstin;
  const partyField = ctx.direction === 'sales' ? 'customerGstin' : 'supplierGstin';

  for (const [field, g] of [['supplierGstin', d.supplierGstin], ['customerGstin', d.customerGstin]] as const) {
    if (!g) continue;
    const c = checkGstin(g);
    if (!c.ok) err('invalid_gstin', `${field === 'supplierGstin' ? 'Supplier' : 'Customer'} GSTIN ${g}: ${c.reason}.`, field);
  }
  if (!d.summary) {
    if (!d.invoiceNo) err('missing_invoice_no', 'Invoice number is missing.', 'invoiceNo');
    if (!d.invoiceDate) err('missing_date', 'Invoice date is missing or unreadable.', 'invoiceDate');
    if (ctx.direction === 'purchase' && !d.supplierGstin) warn('missing_gstin', 'Supplier GSTIN is missing – no ITC can be claimed on an invoice without it.', 'supplierGstin');
    if (ctx.direction === 'sales' && !d.customerGstin && d.total != null && d.total > 250000 && d.pos && d.pos !== ctx.clientGstin.slice(0, 2)) {
      warn('b2cl', 'Inter-state sale to an unregistered person above ₹2.5 lakh: check the customer GSTIN (B2C large).', 'customerGstin');
    }
    if (partyGstin && ctx.clientGstin && partyGstin === ctx.clientGstin) warn('own_gstin', `The ${party} GSTIN is the client’s own GSTIN.`, partyField);
  }

  if (d.invoiceDate) {
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    if (d.invoiceDate > today) err('future_date', `Invoice date ${d.invoiceDate} is in the future.`, 'invoiceDate');
    if (d.invoiceDate < '2017-07-01') warn('old_date', `Invoice date ${d.invoiceDate} is before GST (July 2017).`, 'invoiceDate');
  }

  // Tax heads: intra-state = CGST + SGST (equal), inter-state = IGST.
  if (d.igst && (d.cgst || d.sgst)) warn('mixed_tax', 'Both IGST and CGST/SGST are charged on one document.', 'igst');
  if (Math.abs(d.cgst - d.sgst) > 1) err('cgst_sgst', `CGST (${rs(d.cgst)}) and SGST (${rs(d.sgst)}) should be equal.`, 'sgst');
  const supplierState = (ctx.direction === 'sales' ? ctx.clientGstin : d.supplierGstin)?.slice(0, 2);
  const dest = d.pos || (ctx.direction === 'sales' ? d.customerGstin : ctx.clientGstin)?.slice(0, 2);
  if (supplierState && dest && STATE_CODES[supplierState] && dest !== '96' && !d.summary) {
    const inter = supplierState !== dest;
    if (inter && (d.cgst || d.sgst) && !d.igst) warn('pos_tax', `Supplier state ${supplierState} and place of supply ${dest} differ (inter-state) but CGST/SGST is charged instead of IGST.`, 'igst');
    if (!inter && d.igst && !d.cgst && !d.sgst) warn('pos_tax', `Supplier state and place of supply are both ${dest} (intra-state) but IGST is charged.`, 'cgst');
  }

  // Tax against the rate.
  const tax = r2(d.igst + d.cgst + d.sgst);
  const rateCheck = (taxable: number, rate: number, actual: number, where: string) => {
    const want = (taxable * rate) / 100;
    if (taxable > 0 && Math.abs(actual - want) > Math.max(1, taxable * 0.005)) {
      err('tax_calc', `${where}: tax ${rs(actual)} is not ${rate}% of ${rs(taxable)} (should be ${rs(want)}).`, 'igst');
      return false;
    }
    return true;
  };
  if (d.rate != null) {
    if (!RATES.includes(d.rate)) warn('odd_rate', `${d.rate}% is not a GST rate.`, 'rate');
    else rateCheck(d.taxable, d.rate, tax, 'Invoice');
  } else if (d.items?.length) {
    const rated = d.items.filter((i) => i.gstRate != null && i.taxable);
    rated.forEach((i, n) => {
      const t = (i.igst ?? 0) + (i.cgst ?? 0) + (i.sgst ?? 0);
      if (t) rateCheck(i.taxable!, i.gstRate!, t, `Item ${n + 1}${i.description ? ` (${i.description.slice(0, 40)})` : ''}`);
      if (!RATES.includes(i.gstRate!)) warn('odd_rate', `Item ${n + 1}: ${i.gstRate}% is not a GST rate.`, 'items');
    });
    const itemsTaxable = r2(d.items.reduce((a, i) => a + (i.taxable ?? 0), 0));
    if (itemsTaxable && Math.abs(itemsTaxable - d.taxable) > 1) err('items_total', `Items add up to ${rs(itemsTaxable)} but the taxable value is ${rs(d.taxable)}.`, 'taxable');
  }
  if (d.taxable > 0 && tax > d.taxable * 0.4 + 1) err('tax_high', `Tax ${rs(tax)} is more than 40% of the taxable value ${rs(d.taxable)}.`, 'igst');
  if (!d.summary && d.taxable > 0 && !tax && ctx.direction === 'purchase' && d.itcAvailable !== false) warn('no_tax', 'No tax on this invoice – exempt, nil-rated or from an unregistered/composition supplier?', 'igst');

  // Invoice value = taxable + tax + cess (± round-off).
  if (d.total != null && d.total > 0) {
    const want = r2(d.taxable + tax + d.cess);
    if (Math.abs(d.total - want) > 1 && Math.abs(d.total - (want - (d.discount ?? 0))) > 1) {
      err('total_mismatch', `Invoice value ${rs(d.total)} ≠ taxable ${rs(d.taxable)} + tax ${rs(tax + d.cess)} = ${rs(want)} (difference ${rs(r2(d.total - want))}).`, 'total');
    }
  }
  if (d.taxable < 0 || tax < 0) err('negative', 'Amounts are negative – enter credit notes as positive amounts of a credit note.', 'taxable');

  for (const u of ctx.uncertain ?? []) {
    if (!f.some((x) => x.field === u)) warn('low_confidence', `Not sure this was read correctly – check “${FIELD_LABEL[u] ?? u}” against the document.`, u);
  }
  return f;
}

export const FIELD_LABEL: Record<string, string> = {
  docType: 'Document type', supplierName: 'Supplier name', supplierGstin: 'Supplier GSTIN', customerName: 'Customer name', customerGstin: 'Customer GSTIN',
  invoiceNo: 'Invoice number', invoiceDate: 'Invoice date', pos: 'Place of supply', taxable: 'Taxable value', cgst: 'CGST', sgst: 'SGST',
  igst: 'IGST', cess: 'Cess', discount: 'Discount', total: 'Invoice value', rate: 'Rate', items: 'Items',
  date: 'Date', narration: 'Narration', debit: 'Debit', credit: 'Credit', balance: 'Balance', ref: 'Reference',
};

/** Records that may repeat each other: same family (books or portal data), side, party, type and number. */
export function dupKey(source: InvoiceSource, direction: Direction | null, d: InvoiceData): string | null {
  if (d.summary || !d.invoiceNo) return null;
  const party = direction === 'sales' ? d.customerGstin ?? d.customerName ?? '' : d.supplierGstin ?? d.supplierName ?? '';
  // An invoice PDF and the register row for the same invoice are the same entry, not a duplicate.
  const family = source === 'document' ? 'document' : source;
  return [family, direction ?? '', party.toUpperCase(), d.docType, normaliseDocNo(d.invoiceNo)].join('|');
}

/** Same party, date and amount but a different number – often the same bill entered twice. */
export function nearDupKey(source: InvoiceSource, direction: Direction | null, d: InvoiceData): string | null {
  if (d.summary || !d.invoiceDate || !(d.total ?? d.taxable)) return null;
  const party = direction === 'sales' ? d.customerGstin ?? d.customerName ?? '' : d.supplierGstin ?? d.supplierName ?? '';
  if (!party) return null;
  // Within one family only: the same bill in the register and in GSTR-2B is a match, not a duplicate.
  return [source, direction ?? '', party.toUpperCase(), d.docType, d.invoiceDate, Math.round(d.total ?? d.taxable)].join('|');
}

export function bankDupKey(t: BankTxn) {
  return [t.date, Math.round(t.debit * 100), Math.round(t.credit * 100), (t.ref || t.narration).replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 60)].join('|');
}

export function checkBank(t: BankTxn, uncertain: string[] = []): Flag[] {
  const f: Flag[] = [];
  if (!t.date) f.push({ code: 'missing_date', severity: 'error', field: 'date', message: 'Transaction date is missing.' });
  if (t.debit && t.credit) f.push({ code: 'both_sides', severity: 'warning', field: 'debit', message: 'Both a debit and a credit on one line.' });
  if (t.mode === 'CASH' && t.credit >= 200000) f.push({ code: 'cash_large', severity: 'warning', field: 'credit', message: `Cash deposit of ${rs(t.credit)} (₹2 lakh or more – section 269ST).` });
  for (const u of uncertain) f.push({ code: 'low_confidence', severity: 'warning', field: u, message: `Not sure this was read correctly – check “${FIELD_LABEL[u] ?? u}”.` });
  return f;
}

/** Running balance check: previous balance − debit + credit should give this balance. */
export function balanceBreaks(txns: { id: string; data: BankTxn }[]): Map<string, Flag> {
  const out = new Map<string, Flag>();
  for (let i = 1; i < txns.length; i++) {
    const prev = txns[i - 1].data.balance;
    const cur = txns[i].data;
    if (prev == null || cur.balance == null) continue;
    const want = r2(prev - cur.debit + cur.credit);
    if (Math.abs(want - cur.balance) > 1) {
      out.set(txns[i].id, { code: 'balance_break', severity: 'warning', field: 'balance', message: `Balance ${rs(cur.balance)} does not follow from the previous balance ${rs(prev)} (expected ${rs(want)}) – a line may be missing or misread.` });
    }
  }
  return out;
}
