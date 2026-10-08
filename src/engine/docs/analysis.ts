import { reconcile } from '../recon/match';
import { docKey, normaliseDocNo } from '../recon/normalize';
import type { PurchaseDoc, ReconRow, ReconSummary } from '../recon/types';
import { matchBank, seriesGaps, unusualTxns, type BankMatch } from './bank';
import type { BankTxn, Direction, Flag, InvoiceData, InvoiceSource } from './types';

/**
 * What a client's documents add up to for a period: sales and purchases as per books and as per
 * GSTN, the Purchase register ↔ GSTR-2B reconciliation, and the short list of things that need the
 * CA – everything else is taken as fine. Pure; the inputs are the stored records.
 */

export interface Rec {
  id: string;
  docId: string;
  kind: 'invoice' | 'bank';
  source?: InvoiceSource;
  direction?: Direction | null;
  fp: string;
  data: InvoiceData | BankTxn;
  flags: Flag[];
  review: 'ok' | 'review' | 'approved' | 'rejected';
}
type InvRec = Rec & { kind: 'invoice'; data: InvoiceData };
type BankRec = Rec & { kind: 'bank'; data: BankTxn };

export interface Totals { count: number; taxable: number; tax: number; total: number }

export interface Exception {
  code: string;
  tone: 'ok' | 'warn' | 'error';
  title: string;
  count: number;
  /** ₹ involved (tax for ITC items, value otherwise). */
  amount?: number;
  /** Records (or reconciliation rows) behind it. */
  ids: string[];
}

/** What matched first (✓), then errors, then warnings. */
const TONE_ORDER = { ok: 0, error: 1, warn: 2 } as const;
const r2 = (n: number) => Math.round(n * 100) / 100;
const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const sign = (d: InvoiceData) => (d.docType === 'CN' ? -1 : 1);
const taxOf = (d: InvoiceData) => d.igst + d.cgst + d.sgst + d.cess;

export function totals(recs: InvRec[]): Totals {
  const t = { count: 0, taxable: 0, tax: 0, total: 0 };
  for (const r of recs) {
    const s = sign(r.data);
    t.count++; t.taxable += s * r.data.taxable; t.tax += s * taxOf(r.data);
    t.total += s * (r.data.total ?? r.data.taxable + taxOf(r.data));
  }
  return { count: t.count, taxable: r2(t.taxable), tax: r2(t.tax), total: r2(t.total) };
}

const live = (r: Rec) => r.review !== 'rejected';
const isInv = (r: Rec): r is InvRec => r.kind === 'invoice';

/** The books for one side: the register when there is one for the period, else the invoice documents. */
export function booksFor(recs: InvRec[], direction: Direction) {
  const side = recs.filter((r) => r.direction === direction && (r.source === 'register' || r.source === 'document'));
  const register = side.filter((r) => r.source === 'register');
  const documents = side.filter((r) => r.source === 'document');
  if (!register.length) return { books: documents, basis: documents.length ? 'documents' as const : 'none' as const, notInRegister: [] as InvRec[] };
  const key = (r: InvRec) => `${(direction === 'sales' ? r.data.customerGstin : r.data.supplierGstin) ?? ''}|${r.data.docType}|${normaliseDocNo(r.data.invoiceNo)}`;
  const inRegister = new Set(register.map(key));
  return { books: register, basis: 'register' as const, notInRegister: documents.filter((r) => !inRegister.has(key(r))) };
}

function toPurchaseDoc(r: InvRec, source: 'books' | 'gstr2a' | 'gstr2b', period: string): PurchaseDoc | null {
  const d = r.data;
  if (!d.supplierGstin || !d.invoiceNo) return null;
  return {
    key: docKey(source, d.supplierGstin, d.docType, d.invoiceNo), source, docType: d.docType, supplierGstin: d.supplierGstin, supplierName: d.supplierName,
    docNo: d.invoiceNo, docDate: d.invoiceDate, pos: d.pos, rcm: d.rcm, taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess,
    invoiceValue: d.total ?? undefined, period: d.returnPeriod || period, itcAvailable: d.itcAvailable, itcReason: d.itcReason, supplierPeriod: d.supplierPeriod,
    origin: { file: r.id },
  };
}

export interface Analysis {
  sales: { books: Totals; basis: string; gstr1: Totals | null };
  purchases: { books: Totals; basis: string; gstr2b: Totals | null; portalSource: 'gstr2b' | 'gstr2a' | null };
  recon: { rows: ReconRow[]; summary: ReconSummary } | null;
  bank: {
    count: number; debit: number; credit: number;
    matched: number; party: number; unmatched: string[]; unusual: Record<string, string>;
    /** Per transaction: which invoice(s) it pays, or why none. */
    matches: Record<string, BankMatch>;
  } | null;
  /** Sales invoice numbers missing from a series. */
  gaps: { prefix: string; from: string; to: string; missing: string[] }[];
  counts: { records: number; invoices: number; duplicates: number; gstinErrors: number; missingIn2b: number; needsReview: number; otherIssues: number };
  exceptions: Exception[];
  insights: string[];
}

/** Sales invoices in the books that are not in GSTR-1 (registered customers, by GSTIN + number). */
function salesNotInGstr1(books: InvRec[], gstr1: InvRec[]) {
  const key = (d: InvoiceData) => `${d.customerGstin ?? ''}|${d.docType}|${normaliseDocNo(d.invoiceNo)}`;
  const filed = new Set(gstr1.filter((r) => r.data.customerGstin).map((r) => key(r.data)));
  return books.filter((r) => r.data.customerGstin && !filed.has(key(r.data)));
}

/**
 * `books` (optional): the client's book invoices over a wider range (the whole year) – bank lines of a
 * month often pay invoices of earlier months.
 */
export function analyse(all: Rec[], opts: { clientGstin: string; period: string; previous?: Rec[]; books?: Rec[]; monthly?: boolean }): Analysis {
  const recs = all.filter(live);
  const inv = recs.filter(isInv);
  const bankRecs = recs.filter((r): r is BankRec => r.kind === 'bank');

  const sales = booksFor(inv, 'sales');
  const purch = booksFor(inv, 'purchase');
  const gstr1 = inv.filter((r) => r.source === 'gstr1');
  const g2b = inv.filter((r) => r.source === 'gstr2b');
  const g2a = inv.filter((r) => r.source === 'gstr2a');
  const portal = g2b.length ? g2b : g2a;
  const portalSource = g2b.length ? 'gstr2b' as const : g2a.length ? 'gstr2a' as const : null;

  let recon: Analysis['recon'] = null;
  if (purch.books.length && portal.length) {
    const b = purch.books.map((r) => toPurchaseDoc(r, 'books', opts.period)).filter((x): x is PurchaseDoc => !!x);
    const p = portal.map((r) => toPurchaseDoc(r, portalSource!, opts.period)).filter((x): x is PurchaseDoc => !!x);
    recon = reconcile(b, p, { recipientGstin: opts.clientGstin, amountTolerance: 1, fuzzyDateDays: 30 }, [], { period: opts.period });
  }

  const flagged = (codes: string[]) => recs.filter((r) => r.flags.some((f) => codes.includes(f.code)));
  const dups = flagged(['duplicate', 'possible_duplicate', 'duplicate_txn']);
  const gstinErr = flagged(['invalid_gstin']);
  const calc = flagged(['tax_calc', 'total_mismatch', 'cgst_sgst', 'items_total', 'tax_high', 'pos_tax', 'mixed_tax']);
  const missing = flagged(['missing_invoice_no', 'missing_date', 'missing_gstin']);
  const review = recs.filter((r) => r.review === 'review');
  const rowsBy = (s: string) => recon?.rows.filter((r) => r.status === s) ?? [];
  const recIds = (rows: ReconRow[]) => rows.flatMap((r) => [r.books?.origin?.file, r.portal?.origin?.file]).filter((x): x is string => !!x);
  const taxSum = (rows: ReconRow[], side: 'books' | 'portal') => r2(rows.reduce((a, r) => { const d = r[side]; return a + (d ? (d.docType === 'CN' ? -1 : 1) * (d.igst + d.cgst + d.sgst + d.cess) : 0); }, 0));

  const ex: Exception[] = [];
  const add = (e: Exception) => { if (e.count) ex.push(e); };
  if (recon) {
    const matched = rowsBy('matched');
    add({ code: 'matched', tone: 'ok', title: `${matched.length} purchase invoice(s) match ${portalSource === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'}`, count: matched.length, ids: [] });
    const nip = rowsBy('not_in_portal');
    add({ code: 'not_in_portal', tone: 'error', title: `${nip.length} purchase invoice(s) missing in ${portalSource === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} – ITC ${rs(taxSum(nip, 'books'))} at risk`, count: nip.length, amount: taxSum(nip, 'books'), ids: recIds(nip) });
    const nib = rowsBy('not_in_books');
    add({ code: 'not_in_books', tone: 'warn', title: `${nib.length} invoice(s) in ${portalSource === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} but not in the purchase books (ITC ${rs(taxSum(nib, 'portal'))} not claimed)`, count: nib.length, amount: taxSum(nib, 'portal'), ids: recIds(nib) });
    const mm = rowsBy('mismatch');
    add({ code: 'mismatch', tone: 'error', title: `${mm.length} invoice(s) with different amounts, dates or GSTIN in books and portal`, count: mm.length, ids: recIds(mm) });
    const pr = rowsBy('probable');
    add({ code: 'probable', tone: 'warn', title: `${pr.length} probable match(es) – invoice number or GSTIN differs slightly`, count: pr.length, ids: recIds(pr) });
    if (Math.abs(recon.summary.itc.difference) > 1) {
      add({ code: 'itc_difference', tone: 'error', title: `ITC difference ${rs(recon.summary.itc.difference)} (books ${rs(recon.summary.itc.books)} vs portal ${rs(recon.summary.itc.portal)})`, count: 1, amount: recon.summary.itc.difference, ids: [] });
    }
  }
  add({ code: 'duplicates', tone: 'error', title: `${dups.length} possible duplicate(s)`, count: dups.length, ids: dups.map((r) => r.id) });
  add({ code: 'gstin', tone: 'error', title: `${gstinErr.length} record(s) with an invalid GSTIN`, count: gstinErr.length, ids: gstinErr.map((r) => r.id) });
  add({ code: 'calc', tone: 'error', title: `${calc.length} record(s) with tax or total errors`, count: calc.length, ids: calc.map((r) => r.id) });
  add({ code: 'missing', tone: 'warn', title: `${missing.length} record(s) missing an invoice number, date or GSTIN`, count: missing.length, ids: missing.map((r) => r.id) });
  add({ code: 'not_in_register', tone: 'warn', title: `${purch.notInRegister.length + sales.notInRegister.length} invoice document(s) not entered in the register`, count: purch.notInRegister.length + sales.notInRegister.length, ids: [...purch.notInRegister, ...sales.notInRegister].map((r) => r.id) });
  if (gstr1.length && sales.books.length) {
    const nf = salesNotInGstr1(sales.books, gstr1);
    add({ code: 'not_in_gstr1', tone: 'warn', title: `${nf.length} B2B sales invoice(s) in the books but not in GSTR-1`, count: nf.length, ids: nf.map((r) => r.id) });
  }
  add({ code: 'review', tone: 'warn', title: `${review.length} record(s) waiting for your review`, count: review.length, ids: review.map((r) => r.id) });

  // Bank ↔ books.
  let bank: Analysis['bank'] = null;
  if (bankRecs.length) {
    const bookInv = (opts.books ?? recs).filter(live).filter(isInv).filter((r) => (r.source === 'register' || r.source === 'document') && r.direction);
    const m = matchBank(bankRecs.map((r) => ({ id: r.id, data: r.data })), bookInv.map((r) => ({ id: r.id, direction: r.direction!, data: r.data })));
    const unusual = unusualTxns(bankRecs.map((r) => ({ id: r.id, data: r.data })));
    const unmatched = bankRecs.filter((r) => m.get(r.id)?.status === 'unmatched').map((r) => r.id);
    const count = (s: string) => [...m.values()].filter((x) => x.status === s).length;
    bank = {
      count: bankRecs.length, debit: r2(bankRecs.reduce((a, r) => a + r.data.debit, 0)), credit: r2(bankRecs.reduce((a, r) => a + r.data.credit, 0)),
      matched: count('matched'), party: count('party'), unmatched, unusual: Object.fromEntries(unusual), matches: Object.fromEntries(m),
    };
    if (bookInv.length) add({ code: 'bank_unmatched', tone: 'warn', title: `${unmatched.length} bank transaction(s) without a matching invoice in the books`, count: unmatched.length, ids: unmatched });
    add({ code: 'bank_unusual', tone: 'warn', title: `${unusual.size} unusual bank transaction(s)`, count: unusual.size, ids: [...unusual.keys()] });
  }

  // Missing documents for the month.
  if (opts.monthly) {
    if (purch.books.length && !portal.length) add({ code: 'missing_2b', tone: 'warn', title: 'GSTR-2B for this month is not uploaded – purchases cannot be reconciled', count: 1, ids: [] });
    if (portal.length && !purch.books.length) add({ code: 'missing_purchases', tone: 'warn', title: 'GSTR-2B is here but no purchase register or purchase invoices for this month', count: 1, ids: [] });
    if (gstr1.length && !sales.books.length) add({ code: 'missing_sales', tone: 'warn', title: 'GSTR-1 is here but no sales register or sales invoices for this month', count: 1, ids: [] });
  }

  const gaps = seriesGaps(sales.books.filter((r) => r.data.docType === 'INV').map((r) => r.data.invoiceNo).filter(Boolean));
  const missingNos = gaps.flatMap((g) => g.missing);
  add({ code: 'invoice_gaps', tone: 'warn', title: `${missingNos.length} sales invoice number(s) missing from the series (${missingNos.slice(0, 4).join(', ')}${missingNos.length > 4 ? '…' : ''})`, count: missingNos.length, ids: [] });

  const salesT = totals(sales.books);
  const purchT = totals(purch.books);
  const gstr1T = gstr1.length ? totals(gstr1) : null;
  const portalT = portal.length ? totals(portal) : null;

  // Findings worth telling the CA without being asked, most important first.
  const insights: string[] = [];
  if (recon && Math.abs(recon.summary.itc.difference) > 1) insights.push(`ITC difference of ${rs(recon.summary.itc.difference)} between the purchase books and ${portalSource === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'}.`);
  const nip = rowsBy('not_in_portal').length;
  if (nip) insights.push(`${nip} purchase invoice(s) are not in ${portalSource === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} yet – follow up with the suppliers before claiming ITC.`);
  if (dups.length) insights.push(`${dups.length} possible duplicate record(s) found.`);
  if (gstinErr.length) insights.push(`${gstinErr.length} record(s) have an invalid GSTIN.`);
  if (gstr1T && sales.books.length && Math.abs(gstr1T.taxable - salesT.taxable) > 1) {
    insights.push(`Sales in the books (${rs(salesT.taxable)}) differ from GSTR-1 (${rs(gstr1T.taxable)}) by ${rs(salesT.taxable - gstr1T.taxable)}.`);
  }
  if (opts.previous?.length) {
    const prevInv = opts.previous.filter(live).filter(isInv);
    for (const [label, dir, now] of [['Purchases', 'purchase', purchT], ['Sales', 'sales', salesT]] as const) {
      const before = totals(booksFor(prevInv, dir).books);
      if (before.taxable > 0 && now.taxable > 0) {
        const pct = Math.round(((now.taxable - before.taxable) / before.taxable) * 100);
        if (Math.abs(pct) >= 20) insights.push(`${label} ${pct > 0 ? 'rose' : 'fell'} ${Math.abs(pct)}% compared with the previous month (${rs(before.taxable)} → ${rs(now.taxable)}).`);
      }
    }
  }
  const bySupplier = new Map<string, number>();
  for (const r of purch.books) { const k = r.data.supplierName || r.data.supplierGstin || '—'; bySupplier.set(k, (bySupplier.get(k) ?? 0) + sign(r.data) * r.data.taxable); }
  const top = [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && purchT.taxable > 0 && bySupplier.size > 2 && top[1] / purchT.taxable >= 0.4) insights.push(`${top[0]} accounts for ${Math.round((top[1] / purchT.taxable) * 100)}% of purchases.`);
  const cash = bankRecs.filter((r) => r.data.mode === 'CASH' && r.data.credit >= 200000);
  if (cash.length) insights.push(`${cash.length} cash deposit(s) of ₹2 lakh or more in the bank statement.`);
  if (bank?.unmatched.length) {
    const amt = bankRecs.filter((r) => bank!.unmatched.includes(r.id)).reduce((a, r) => a + r.data.debit + r.data.credit, 0);
    insights.push(`${bank.unmatched.length} bank transaction(s) worth ${rs(amt)} have no matching invoice – entries may be missing from the books.`);
  }
  if (missingNos.length) insights.push(`Sales invoice numbers missing from the series: ${missingNos.slice(0, 6).join(', ')}${missingNos.length > 6 ? ` and ${missingNos.length - 6} more` : ''}.`);

  return {
    sales: { books: salesT, basis: sales.basis, gstr1: gstr1T },
    purchases: { books: purchT, basis: purch.basis, gstr2b: portalT, portalSource },
    recon,
    bank,
    gaps,
    counts: {
      records: recs.length, invoices: inv.length, duplicates: dups.length, gstinErrors: gstinErr.length,
      missingIn2b: nip, needsReview: review.length, otherIssues: new Set([...calc, ...missing].map((r) => r.id)).size,
    },
    exceptions: ex.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]),
    insights,
  };
}
