import type {
  AnyRecord, B2bData, B2clData, B2csData, CdnrData, CdnurData, DocData, HsnData, Item, NilData, Section, ValidationIssue,
} from '../types';
import { checkGstin, computeTax, periodBounds, round2 } from '../util';

/**
 * Turns normalised marketplace lines (one per order item / refund) into GSTR-1 records:
 *   B2B buyer GSTIN → Table 4 invoices; B2B refunds → Table 9B credit notes
 *   B2C inter-state invoice above the B2CL limit → Table 5; everything else B2C → Table 7 (net of returns)
 *   all lines → Table 12 HSN summary (B2B / B2C split when the format profile requires it)
 * Taxes are recomputed from rate × taxable value on the aggregate, the way the portal checks them,
 * and compared with the tax the report itself shows so differences are visible.
 */

export type LineKind = 'sale' | 'return' | 'skip';

export interface SaleLine {
  file: string;
  row: number;
  kind: LineKind;
  /** Why a line is skipped (shown in the summary). */
  skipReason?: string;
  sellerGstin?: string;
  invoiceNo?: string;
  /** ISO yyyy-mm-dd */
  invoiceDate?: string;
  noteNo?: string;
  noteDate?: string;
  buyerGstin?: string;
  buyerName?: string;
  /** GST state code, '' when unknown. */
  pos: string;
  /** Raw state text, for messages. */
  posRaw?: string;
  hsn: string;
  description?: string;
  qty: number;
  /** GST unit (UQC) of the line when the report has a unit column; else the import's default unit. */
  uqc?: string;
  /** Total GST rate in percent (IGST, or CGST + SGST). null when not determinable. */
  rate: number | null;
  /** Taxable value as a positive amount; the kind decides the sign. */
  taxable: number;
  /** Tax shown in the report (positive), for reconciliation only. */
  reportedTax?: number;
  /** IGST and CGST shown in the report (positive) – to catch bills charged with the wrong tax type. */
  reportedIgst?: number;
  reportedCgst?: number;
  /** The bill's own total (taxable + tax + round-off + any 0% items), repeated on each of its rows. */
  invoiceValue?: number;
  /** Place of supply is outside India – an export (Table 6A), not a B2C sale. */
  export?: boolean;
  cess?: number;
  /** Amazon "Cancel" / Flipkart "Cancellation": voids the sale with the same invoice number. */
  cancel?: boolean;
  /** Marketplace (e-commerce operator) GSTIN when the report carries it (Meesho). */
  ecoGstin?: string;
}

/** A document number from a document register (Meesho Tax_invoice_details), for Table 13. */
export interface DocLine { type: 'invoice' | 'credit'; number: string }

export interface BuildOptions {
  marketplace: string;
  /** Source tag on every record, e.g. "mp:amazon". */
  source: string;
  supplierGstin: string;
  fp: string;
  quarterly?: boolean;
  hsnSplit: boolean;
  /** Turnover above ₹5 crore: HSN is then mandatory for B2C supplies too (up to ₹5 crore, only for B2B). */
  aatoAbove5Cr?: boolean;
  b2clThreshold: number;
  allowedRates: number[];
  /** E-commerce operator GSTIN (TCS registration of the marketplace in the seller's state). */
  etin?: string;
  /** Unit for Table 12 (marketplace reports give counts, not units). */
  uqc: string;
}

export interface MarketplaceSummary {
  marketplace: string;
  files: string[];
  lines: number;
  sales: number;
  returns: number;
  skipped: { reason: string; count: number }[];
  otherGstinLines: number;
  outsidePeriod: number;
  salesTaxable: number;
  returnsTaxable: number;
  netTaxable: number;
  computedTax: number;
  reportedTax: number | null;
  records: Record<string, number>;
  cancelledInvoices: number;
  /** Table 14(a) figures (supplies through the e-commerce operator, u/s 52) to enter on the portal. */
  table14: { etin: string; netValue: number; igst: number; cgst: number; sgst: number; cess: number } | null;
}

/** Snap e.g. 17.999 → 18 and 0.18 → 18; null if it is not a GST rate. */
export function normaliseRate(raw: number | null | undefined, allowed: number[]): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  for (const r of raw > 0 && raw < 1 ? [raw * 100, raw] : [raw]) {
    const hit = allowed.find((a) => Math.abs(a - r) < 0.02);
    if (hit != null) return hit;
  }
  return null;
}

/** Rate from tax ÷ taxable when the report has no rate column (only if it lands on a valid rate). */
export function rateFromTax(tax: number | null | undefined, taxable: number, allowed: number[]): number | null {
  if (tax == null || !taxable) return null;
  const r = (Math.abs(tax) / Math.abs(taxable)) * 100;
  const hit = allowed.reduce<number | null>((best, a) => (best == null || Math.abs(a - r) < Math.abs(best - r) ? a : best), null);
  return hit != null && Math.abs(hit - r) <= Math.max(0.3, hit * 0.02) ? hit : null;
}

const money = (n: number) => `₹${round2(n).toLocaleString('en-IN')}`;

/**
 * The running counter of a document number: "FAI1W52400000001" → prefix "FAI1W524", n 1, width 8 (the
 * trailing digit run); "122/26-27" or "INV-45/2026-27" → the digits before a financial-year suffix,
 * which becomes part of the series. width is kept only for zero-padded counters, so 99 → 100 stays
 * one series.
 */
export function splitDocNo(no: string) {
  const fy = no.match(/^(.*?)(\d+)(\s*[/-]\s*(?:\d{4}|\d{2})\s*-\s*(?:\d{4}|\d{2}))$/);
  const m = fy ?? no.match(/^(.*?)(\d+)$/);
  if (!m) return { prefix: no, n: 0, width: 0, head: no, tail: '', digits: '' };
  const digits = m[2];
  const tail = fy ? m[3] : '';
  return { prefix: `${m[1]}#${tail.replace(/\s/g, '')}`, n: Number(digits), width: digits.startsWith('0') ? digits.length : 0, head: m[1], tail, digits };
}

/** Numbers missing between the first and last of each series (by the running counter; at most 500 per series). */
export function seriesGaps(numbers: string[]) {
  const series = new Map<string, { n: number; no: string }[]>();
  for (const no of new Set(numbers.map((x) => x.trim()).filter(Boolean))) {
    const d = splitDocNo(no);
    if (!d.digits) continue;
    const k = `${d.prefix.toUpperCase()}|${d.width}`;
    if (!series.has(k)) series.set(k, []);
    series.get(k)!.push({ n: d.n, no });
  }
  const out: { from: string; to: string; missing: string[] }[] = [];
  for (const list of series.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.n - b.n);
    const have = new Set(list.map((x) => x.n));
    const first = list[0], last = list[list.length - 1];
    if (last.n - first.n > 5000) continue;
    const missing: string[] = [];
    // Rebuilt from the first number: same text around the counter, zero-padded when it was.
    const d = splitDocNo(first.no);
    for (let n = first.n + 1; n < last.n && missing.length < 500; n++) {
      if (!have.has(n)) missing.push(`${d.head}${d.width ? String(n).padStart(d.width, '0') : n}${d.tail}`);
    }
    if (missing.length) out.push({ from: first.no, to: last.no, missing });
  }
  return out;
}

/** Table 13: one row per document series (same prefix + counter width): first, last, count, cancelled. */
export function docRecords(docs: { type: 'invoice' | 'credit'; number: string; cancelled?: boolean }[], source: string): AnyRecord[] {
  const series = new Map<string, { docTyp: string; items: Map<string, { no: string; n: number; cancelled: boolean }> }>();
  for (const d of docs) {
    const no = d.number.trim();
    if (!no) continue;
    const { prefix, width } = splitDocNo(no);
    const docTyp = d.type === 'credit' ? 'Credit Note' : 'Invoices for outward supply';
    const k = `${docTyp}|${prefix.toUpperCase()}|${width}`;
    if (!series.has(k)) series.set(k, { docTyp, items: new Map() });
    // Keyed case-insensitively, but reported exactly as issued.
    const it = series.get(k)!.items;
    const prev = it.get(no.toUpperCase());
    it.set(no.toUpperCase(), { no: prev?.no ?? no, n: splitDocNo(no).n, cancelled: (prev?.cancelled ?? false) || !!d.cancelled });
  }
  return [...series.values()].map(({ docTyp, items }) => {
    const sorted = [...items].sort((a, b) => a[1].n - b[1].n || a[0].localeCompare(b[0]));
    const data: DocData = {
      docTyp, from: sorted[0][1].no, to: sorted[sorted.length - 1][1].no,
      totnum: sorted.length, cancel: sorted.filter(([, v]) => v.cancelled).length,
    };
    return { section: 'docs', key: `docs|${docTyp}|${data.from}|${source}`, source: { sheet: source, rows: [] }, data } as AnyRecord;
  });
}

export function buildMarketplaceRecords(input: SaleLine[], o: BuildOptions, docLines: DocLine[] = []) {
  // Cancelled invoices: a cancel that exactly voids a sale in the same report removes both
  // (the invoice is then counted as cancelled in Table 13); a cancel without its sale here acts as a return.
  const cancelledInvoices = new Set<string>();
  let all = input;
  const cancels = input.filter((l) => l.cancel && l.invoiceNo);
  if (cancels.length) {
    const byInv = new Map<string, SaleLine[]>();
    for (const l of input) if (l.invoiceNo && l.kind !== 'skip') {
      const k = l.invoiceNo.toUpperCase();
      if (!byInv.has(k)) byInv.set(k, []);
      byInv.get(k)!.push(l);
    }
    const drop = new Set<SaleLine>();
    for (const [inv, ls] of byInv) {
      if (!ls.some((l) => l.cancel)) continue;
      const net = ls.reduce((a, l) => a + (l.kind === 'return' ? -l.taxable : l.taxable), 0);
      if (ls.some((l) => !l.cancel && l.kind === 'sale') && Math.abs(net) < 0.5) {
        ls.forEach((l) => drop.add(l));
        cancelledInvoices.add(inv);
      }
    }
    all = input.filter((l) => !drop.has(l));
  }

  const st = o.supplierGstin.slice(0, 2);
  const records: AnyRecord[] = [];
  const issues: ValidationIssue[] = [];
  const issue = (severity: 'error' | 'warning', section: Section, field: string, message: string, extra: Partial<ValidationIssue> = {}) =>
    issues.push({ code: `MP_${field.toUpperCase()}`, severity, section, recordKey: '', sheet: o.source, field, message, ...extra });

  const summary: MarketplaceSummary = {
    marketplace: o.marketplace, files: [...new Set(all.map((l) => l.file))], lines: all.length, sales: 0, returns: 0,
    skipped: [], otherGstinLines: 0, outsidePeriod: 0, salesTaxable: 0, returnsTaxable: 0, netTaxable: 0,
    computedTax: 0, reportedTax: null, records: {}, cancelledInvoices: cancelledInvoices.size, table14: null,
  };

  // 1. keep only taxable events of this GSTIN
  const skipped = new Map<string, number>();
  const lines: SaleLine[] = [];
  const exports: SaleLine[] = [];
  const badGstin = new Map<string, string[]>();
  for (const l0 of all) {
    if (l0.kind === 'skip') { skipped.set(l0.skipReason ?? 'Not a sale or return', (skipped.get(l0.skipReason ?? 'Not a sale or return') ?? 0) + 1); continue; }
    if (l0.sellerGstin && l0.sellerGstin.toUpperCase() !== o.supplierGstin) { summary.otherGstinLines++; continue; }
    if (l0.export) { exports.push(l0); continue; }
    let l = l0;
    const g = l.buyerGstin?.toUpperCase();
    if (g && !checkGstin(g).ok) {
      // A mistyped GSTIN makes a B2B sale look like B2C – the buyer would lose the ITC.
      const bills = badGstin.get(g) ?? [];
      bills.push(l.kind === 'return' ? l.noteNo || l.invoiceNo || `row ${l.row}` : l.invoiceNo || `row ${l.row}`);
      badGstin.set(g, bills);
    } else if (g && !l.pos) {
      // B2B without a place of supply: the buyer's state (from the GSTIN).
      l = { ...l, pos: g.slice(0, 2) };
    }
    lines.push(l);
  }
  for (const [g, bills] of badGstin) {
    issue('warning', 'b2b', 'ctin', `GST No "${g}" is not a valid GSTIN (${(checkGstin(g) as { reason?: string }).reason ?? 'check digit'}) – bill(s) ${[...new Set(bills)].slice(0, 5).join(', ')} reported as B2C`, {
      value: g, suggestion: 'Correct the GSTIN in your billing software (party ledger) and import again, so the sale goes to B2B and the buyer gets the ITC.',
    });
  }
  if (exports.length) {
    const bills = [...new Set(exports.map((l) => l.invoiceNo || `row ${l.row}`))];
    issue('error', 'exp', 'pos', `${bills.length} export bill(s) (place of supply outside India) not included: ${bills.slice(0, 5).join(', ')}${bills.length > 5 ? ' …' : ''}`, {
      suggestion: 'Exports go to Table 6A with the export type (with/without payment), port code and shipping bill – add them on the Records tab (Exports).',
    });
  }
  summary.skipped = [...skipped].map(([reason, count]) => ({ reason, count }));
  if (summary.otherGstinLines) {
    issue('warning', 'b2cs', 'sellerGstin', `${summary.otherGstinLines} line(s) belong to another GSTIN of yours and were left out`, {
      suggestion: `Only lines for ${o.supplierGstin} are included. Import the same report into the return of the other GSTIN.`,
    });
  }

  const { start, end } = periodBounds(o.fp, o.quarterly);
  const etin = o.etin?.trim().toUpperCase() || '';
  summary.lines = input.length;
  const sign = (l: SaleLine) => (l.kind === 'return' ? -1 : 1);
  const posLabel = (l: SaleLine) => l.posRaw || l.pos || '(blank)';

  const badPos = new Map<string, number>();
  const badRate: SaleLine[] = [];
  let reported = 0, reportedSeen = false;
  for (const l of lines) {
    if (l.kind === 'sale') { summary.sales++; summary.salesTaxable += l.taxable; } else { summary.returns++; summary.returnsTaxable += l.taxable; }
    if (l.reportedTax != null) { reportedSeen = true; reported += sign(l) * l.reportedTax; }
    const d = l.kind === 'return' ? l.noteDate || l.invoiceDate : l.invoiceDate;
    if (d && (d < start || d > end)) summary.outsidePeriod++;
    if (!l.pos) badPos.set(posLabel(l), (badPos.get(posLabel(l)) ?? 0) + 1);
    if (l.rate == null) badRate.push(l);
  }
  summary.reportedTax = reportedSeen ? round2(reported) : null;
  // Bills charged with the wrong tax type: IGST within the state, or CGST/SGST across states.
  const wrongType = new Set<string>();
  for (const l of lines) {
    if (!l.pos || !l.rate || l.reportedIgst == null || l.reportedCgst == null) continue;
    const inter = l.pos !== st;
    if ((inter && l.reportedCgst > 0.5 && l.reportedIgst < 0.5) || (!inter && l.reportedIgst > 0.5 && l.reportedCgst < 0.5)) {
      wrongType.add(l.kind === 'return' ? l.noteNo || l.invoiceNo || `row ${l.row}` : l.invoiceNo || `row ${l.row}`);
    }
  }
  if (wrongType.size) {
    issue('warning', 'b2cs', 'iamt', `${wrongType.size} bill(s) charge IGST / CGST+SGST not matching the place of supply: ${[...wrongType].slice(0, 5).join(', ')}${wrongType.size > 5 ? ' …' : ''}`, {
      suggestion: 'GSTR-1 shows the tax the place of supply requires (IGST between states, CGST + SGST within the state). Check the party state in your billing software; a bill with the wrong tax type needs a credit note and a fresh bill.',
    });
  }
  for (const [raw, count] of badPos) {
    issue('error', 'b2cs', 'pos', `Place of supply "${raw}" not recognised on ${count} line(s)`, { value: raw, suggestion: 'Those lines are grouped under a blank place of supply – edit the B2C record to the correct state.' });
  }
  if (badRate.length) {
    issue('error', 'b2cs', 'rt', `GST rate missing or not a valid GST rate on ${badRate.length} line(s) (first: ${badRate[0].file} row ${badRate[0].row})`, {
      suggestion: 'Those lines are grouped with a blank rate – edit the records to the correct rate.',
    });
  }
  if (summary.outsidePeriod) {
    const share = summary.outsidePeriod / Math.max(1, lines.length);
    issue(share > 0.5 ? 'error' : 'warning', 'b2cs', 'idt', `${summary.outsidePeriod} of ${lines.length} line(s) are dated outside the return period ${start} – ${end}`, {
      suggestion: share > 0.5 ? 'This looks like the report of a different month. Download the report for this return period.' : 'Usually returns of earlier months\' sales – they are included in this period.',
    });
  }

  const tax = (rt: number | null, base: number, pos: string) => (rt == null || !pos ? { iamt: 0, camt: 0, samt: 0 } : computeTax(rt, base, { supplierState: st, pos }));
  const src = (ls: SaleLine[]) => ({ sheet: o.source, rows: ls.slice(0, 20).map((l) => l.row), raw: { file: ls[0].file, lines: ls.length } });
  const isB2b = (l: SaleLine) => !!l.buyerGstin && checkGstin(l.buyerGstin).ok && l.buyerGstin.toUpperCase() !== o.supplierGstin;

  // 2. Nil-rated (0%) supplies → Table 8, by inter/intra-state and registered/unregistered buyer, net
  // of returns. They stay in the HSN summary at 0% but not in B2B/B2C, which take only taxable rates.
  const nilLines = lines.filter((l) => l.rate === 0);
  if (nilLines.length) {
    const byType = new Map<string, SaleLine[]>();
    for (const l of nilLines) {
      const t = `${l.pos && l.pos !== st ? 'INTR' : 'INTRA'}${isB2b(l) ? 'B2B' : 'B2C'}`;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(l);
    }
    for (const [splyTy, ls] of byType) {
      const net = round2(ls.reduce((a, l) => a + sign(l) * l.taxable, 0));
      if (net === 0) continue;
      if (net < 0) {
        issue('warning', 'nil', 'nilAmt', `Nil-rated ${splyTy}: returns exceed this month’s sales (net ${money(net)}) – left out of Table 8`, { value: net });
        continue;
      }
      const data: NilData = { splyTy, nilAmt: net, exptAmt: 0, ngsupAmt: 0 };
      records.push({ section: 'nil', key: `nil|${splyTy}|${o.source}`, source: src(ls), data } as AnyRecord);
    }
    issue('warning', 'nil', 'nilAmt', `${nilLines.length} line(s) at 0% GST are reported as nil-rated supplies in Table 8`, {
      suggestion: 'If these items are exempt (not nil-rated) or non-GST, edit the Table 8 row and move the amount to the Exempted or Non-GST column.',
    });
  }
  const taxedLines = lines.filter((l) => l.rate !== 0);

  // 3. B2B invoices and credit notes
  const b2bLines = taxedLines.filter(isB2b);
  const byDoc = new Map<string, SaleLine[]>();
  for (const l of b2bLines) {
    const no = l.kind === 'return' ? l.noteNo || '' : l.invoiceNo || '';
    const k = `${l.kind}|${l.buyerGstin!.toUpperCase()}|${no.toUpperCase()}|${no ? '' : l.row}`;
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k)!.push(l);
  }
  const itemsOf = (ls: SaleLine[], pos: string): Item[] => {
    const byRate = new Map<string, number>();
    for (const l of ls) byRate.set(String(l.rate), (byRate.get(String(l.rate)) ?? 0) + l.taxable);
    return [...byRate].map(([r, tx]) => {
      const rt = r === 'null' ? null : Number(r);
      const t = tax(rt, tx, pos);
      return { rt, txval: round2(tx), ...t, csamt: round2(ls.filter((l) => String(l.rate) === r).reduce((a, l) => a + (l.cess ?? 0), 0)) };
    });
  };
  const docValue = (items: Item[]) => round2(items.reduce((a, i) => a + (i.txval ?? 0) + (i.iamt ?? 0) + (i.camt ?? 0) + (i.samt ?? 0) + (i.csamt ?? 0), 0));
  // The bill's own total when the report has it (includes round-off and 0% items); else taxable + tax.
  const billValue = new Map<string, number>();
  for (const l of lines) {
    const no = (l.kind === 'return' ? l.noteNo : l.invoiceNo)?.toUpperCase();
    if (no && l.invoiceValue && l.invoiceValue > 0) billValue.set(`${l.kind}|${no}`, Math.max(billValue.get(`${l.kind}|${no}`) ?? 0, l.invoiceValue));
  }
  const valueOf = (kind: LineKind, no: string | undefined, items: Item[]) => {
    const computed = docValue(items);
    const given = no ? billValue.get(`${kind}|${no.toUpperCase()}`) : undefined;
    return given != null && given >= computed - 1 ? round2(given) : computed;
  };
  for (const ls of byDoc.values()) {
    const f = ls[0];
    const items = itemsOf(ls, f.pos);
    const ctin = f.buyerGstin!.toUpperCase();
    if (f.kind === 'sale') {
      const data: B2bData = {
        ctin, receiverName: f.buyerName || undefined, inum: f.invoiceNo ?? '', idt: f.invoiceDate ?? '', val: valueOf('sale', f.invoiceNo, items), pos: f.pos,
        rchrg: 'N', invTyp: 'R', etin: etin || undefined, diffPercent: null, items,
      };
      if (!data.inum) issue('error', 'b2b', 'inum', `B2B sale to ${ctin} has no invoice number (${f.file} row ${f.row})`);
      records.push({ section: 'b2b', key: `b2b|${ctin}|${data.inum.toUpperCase() || `${o.source}:${f.row}`}`, source: src(ls), data });
    } else {
      const data: CdnrData = {
        ctin, receiverName: f.buyerName || undefined, ntNum: f.noteNo ?? '', ntDt: f.noteDate || f.invoiceDate || '', ntty: 'C', pos: f.pos,
        rchrg: 'N', invTyp: 'R', val: valueOf('return', f.noteNo, items), diffPercent: null, items,
      };
      if (!data.ntNum) issue('error', 'cdnr', 'ntNum', `B2B return from ${ctin} has no credit note number (${f.file} row ${f.row})`, { suggestion: 'Enter the credit note number the marketplace issued.' });
      records.push({ section: 'cdnr', key: `cdnr|${ctin}|${data.ntNum.toUpperCase() || `${o.source}:${f.row}`}`, source: src(ls), data });
    }
  }

  // 4. B2C: large inter-state invoices → B2CL, the rest (net of returns) → B2CS by POS + rate
  const b2cLines = taxedLines.filter((l) => !isB2b(l));
  // Value of each B2C bill / note for the B2C Large limit: the bill's own total when given (it also
  // counts 0% items), else taxable + tax of its lines.
  const docTotals = new Map<string, number>();
  for (const l of b2cLines) {
    const no = (l.kind === 'return' ? l.noteNo : l.invoiceNo)?.toUpperCase();
    if (!no) continue;
    const t = tax(l.rate, l.taxable, l.pos);
    const k = `${l.kind}|${no}`;
    docTotals.set(k, (docTotals.get(k) ?? 0) + l.taxable + t.iamt + t.camt + t.samt + (l.cess ?? 0));
  }
  for (const [k, v] of billValue) if (docTotals.has(k)) docTotals.set(k, Math.max(docTotals.get(k)!, v));
  const large = (l: SaleLine) => {
    const no = (l.kind === 'return' ? l.noteNo : l.invoiceNo)?.toUpperCase();
    return !!no && !!l.pos && l.pos !== st && (docTotals.get(`${l.kind}|${no}`) ?? 0) > o.b2clThreshold;
  };
  const b2clInv = new Map<string, SaleLine[]>();
  const cdnurNotes = new Map<string, SaleLine[]>();
  const b2csBuckets = new Map<string, SaleLine[]>();
  for (const l of b2cLines) {
    if (large(l)) {
      // Inter-state bill above the limit → B2C Large; a return of that size is a credit note against a
      // B2C Large bill → Table 9B (unregistered, B2CL), not a deduction from B2C Small.
      const target = l.kind === 'sale' ? b2clInv : cdnurNotes;
      const no = (l.kind === 'sale' ? l.invoiceNo : l.noteNo)!.toUpperCase();
      if (!target.has(no)) target.set(no, []);
      target.get(no)!.push(l);
      continue;
    }
    const k = `${l.pos}|${l.rate}`;
    if (!b2csBuckets.has(k)) b2csBuckets.set(k, []);
    b2csBuckets.get(k)!.push(l);
  }
  for (const ls of b2clInv.values()) {
    const f = ls[0];
    const items = itemsOf(ls, f.pos);
    const data: B2clData = { inum: f.invoiceNo!, idt: f.invoiceDate ?? '', val: valueOf('sale', f.invoiceNo, items), pos: f.pos, etin: etin || undefined, diffPercent: null, items };
    records.push({ section: 'b2cl', key: `b2cl|${f.invoiceNo!.toUpperCase()}`, source: src(ls), data });
  }
  for (const ls of cdnurNotes.values()) {
    const f = ls[0];
    const items = itemsOf(ls, f.pos);
    const data: CdnurData = { urType: 'B2CL', ntNum: f.noteNo!, ntDt: f.noteDate || f.invoiceDate || '', ntty: 'C', pos: f.pos, val: valueOf('return', f.noteNo, items), diffPercent: null, items };
    records.push({ section: 'cdnur', key: `cdnur|${f.noteNo!.toUpperCase()}`, source: src(ls), data });
    issue('warning', 'cdnur', 'urType', `Credit note ${f.noteNo} (${money(data.val ?? 0)}, inter-state, unregistered) reported in Table 9B as against a B2C Large bill`, {
      suggestion: 'If the original bill was below the B2C Large limit, delete this note from CDNUR and reduce B2C Small of that state instead.',
    });
  }
  for (const ls of b2csBuckets.values()) {
    const f = ls[0];
    const net = round2(ls.reduce((a, l) => a + sign(l) * l.taxable, 0));
    const cess = round2(ls.reduce((a, l) => a + sign(l) * (l.cess ?? 0), 0));
    if (net === 0 && cess === 0) continue;
    const data: B2csData = { typ: etin ? 'E' : 'OE', pos: f.pos, etin: etin || undefined, diffPercent: null, rt: f.rate, txval: net, ...tax(f.rate, net, f.pos), csamt: cess };
    const key = `b2cs|${data.typ}|${f.pos}|${f.rate}|${etin}||${o.source}`;
    records.push({ section: 'b2cs', key, source: src(ls), data });
    if (net < 0) {
      issue('error', 'b2cs', 'txval', `Returns exceed sales for ${f.pos || 'blank POS'} @ ${f.rate ?? '?'}%: net ${money(net)}`, {
        recordKey: key, value: net,
        suggestion: 'Table 7 cannot be negative. Reduce the original month\'s B2C figure through Table 10 (B2C amendment) instead, then delete this line.',
      });
    }
  }

  // 5. Table 12 – HSN summary
  const hsnSection = (l: SaleLine): 'hsn_b2b' | 'hsn_b2c' => (o.hsnSplit && !isB2b(l) ? 'hsn_b2c' : 'hsn_b2b');
  const hsnGroups = new Map<string, SaleLine[]>();
  // HSN codes as typed in the billing software: a blank one is taken from another line of the same
  // item; a code of the wrong length (5, 7, 9+ digits – an extra or missing digit) is cut to the
  // 4- or 6-digit code it starts with, which is a valid level of the same tariff entry.
  const digits = (l: SaleLine) => (l.hsn || '').replace(/\D/g, '');
  const itemKey = (l: SaleLine) => (l.description || '').trim().toUpperCase();
  const byItem = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const h = digits(l), it = itemKey(l);
    if (!h || !it) continue;
    if (!byItem.has(it)) byItem.set(it, new Map());
    byItem.get(it)!.set(h, (byItem.get(it)!.get(h) ?? 0) + 1);
  }
  const filled = new Map<string, string>();
  const trimmed = new Map<string, string>();
  const fixedHsn = new Map<SaleLine, string>();
  for (const l of lines) {
    let h = digits(l);
    if (!h) {
      const seen = byItem.get(itemKey(l));
      if (seen) { h = [...seen].sort((a, b) => b[1] - a[1])[0][0]; filled.set(l.description!.trim(), h); }
    }
    if (h && ![4, 6, 8].includes(h.length) && h.length > 4) {
      const cut = h.slice(0, h.length === 5 ? 4 : 6);
      trimmed.set(h, cut);
      h = cut;
    }
    fixedHsn.set(l, h);
  }
  const some = (xs: string[]) => `${xs.slice(0, 8).join(', ')}${xs.length > 8 ? ' …' : ''}`;
  const hsnSec = o.hsnSplit ? 'hsn_b2c' : 'hsn_b2b';
  if (trimmed.size) {
    issue('warning', hsnSec, 'hsn', `${trimmed.size} HSN code(s) with a wrong number of digits reported by their first digits: ${some([...trimmed].map(([a, b]) => `${a} → ${b}`))}`, {
      suggestion: 'HSN is 4, 6 or 8 digits. Check these codes and correct them in the item master of your billing software.',
    });
  }
  if (filled.size) {
    issue('warning', hsnSec, 'hsn', `HSN missing on some lines of ${filled.size} item(s) – taken from the same item's other bills: ${some([...filled].map(([a, b]) => `${a} → ${b}`))}`, {
      suggestion: 'Fill the HSN in the item master of your billing software.',
    });
  }
  // Lines still without an HSN. Up to ₹5 crore turnover HSN is optional for B2C supplies, so those
  // lines are left out of Table 12; otherwise they are an error under a blank HSN line.
  const names = (ls: SaleLine[]) => { const n = [...new Set(ls.map((l) => l.description?.trim()).filter((x): x is string => !!x))]; return n.length ? ` – item(s): ${n.slice(0, 100).join(', ')}${n.length > 100 ? ' …' : ''}` : ''; };
  const noHsn: SaleLine[] = [], leftOut: SaleLine[] = [];
  for (const l0 of lines) {
    const hsn = fixedHsn.get(l0) ?? '';
    const l = hsn === l0.hsn ? l0 : { ...l0, hsn };
    if (!hsn) {
      if (!o.aatoAbove5Cr && !isB2b(l)) { leftOut.push(l); continue; }
      noHsn.push(l);
    }
    const k = `${hsnSection(l)}|${hsn}|${l.uqc || o.uqc}|${l.rate}`;
    if (!hsnGroups.has(k)) hsnGroups.set(k, []);
    hsnGroups.get(k)!.push(l);
  }
  if (leftOut.length) {
    const net = round2(leftOut.reduce((a, l) => a + (l.kind === 'return' ? -l.taxable : l.taxable), 0));
    issue('warning', hsnSec, 'hsn', `${leftOut.length} B2C line(s) without an HSN code (taxable ${money(net)}) left out of the HSN summary${names(leftOut)}`, {
      suggestion: 'HSN is optional for B2C supplies up to ₹5 crore turnover, so the return can be filed; the HSN (B2C) total is lower than B2C sales by this amount. Fill the HSN of these items in your billing software to include them.',
    });
  }
  if (noHsn.length) issue('error', noHsn.some((l) => hsnSection(l) === 'hsn_b2b') ? 'hsn_b2b' : 'hsn_b2c', 'hsn', `${noHsn.length} line(s) have no HSN code${names(noHsn)}`, { suggestion: 'They are grouped under a blank HSN – edit that HSN line to the correct code, or fill the HSN of these items in your billing software and import again.' });
  for (const [k, ls] of hsnGroups) {
    const [section, hsn, uqc] = k.split('|') as ['hsn_b2b' | 'hsn_b2c', string, string];
    let inter = 0, intra = 0, qty = 0, cess = 0;
    for (const l of ls) {
      const v = sign(l) * l.taxable;
      if (l.pos && l.pos !== st) inter += v; else intra += v;
      qty += sign(l) * (l.qty || 0);
      cess += sign(l) * (l.cess ?? 0);
    }
    const rt = ls[0].rate;
    if ((inter < 0 && intra > 0) || (intra < 0 && inter > 0)) {
      // Returns on one side (e.g. inter-state) exceed that side's sales while the other side is positive.
      // Table 12 takes no negative tax, so the net is shown under the positive head – same rate, so the
      // total tax is unchanged.
      issue('warning', section, 'iamt', `HSN ${hsn || '(blank)'} (${uqc}, ${rt ?? '?'}%): ${inter < 0 ? 'inter' : 'intra'}-state returns exceed that side’s sales – shown net as ${inter < 0 ? 'CGST/SGST' : 'IGST'} (total tax unchanged)`, {
        suggestion: 'Table 12 cannot carry negative tax. The return itself still reduces B2C Small / the credit notes.',
      });
      if (inter < 0) { intra += inter; inter = 0; } else { inter += intra; intra = 0; }
    }
    const txval = round2(inter + intra);
    if (txval === 0 && qty === 0) continue;
    if (section === 'hsn_b2c' && (txval < 0 || qty < 0)) {
      // Returns of earlier months' sales exceed this month's sales of the item. Table 12 cannot be
      // negative, and GSTN does not tally the B2C tab with Table 7, so the HSN is left out here.
      issue('warning', 'hsn_b2c', 'txval', `HSN ${hsn || '(blank)'} (${uqc}, ${rt ?? '?'}%): returns exceed this month’s sales (net ${money(txval)}, qty ${round2(qty)}) – left out of the HSN summary (B2C)`, {
        value: txval, suggestion: 'Table 12 cannot be negative. The returns still reduce B2C Small (Table 7); GSTN does not match the B2C HSN tab against it.',
      });
      continue;
    }
    const ti = rt == null ? 0 : round2((inter * rt) / 100);
    const half = rt == null ? 0 : round2((intra * rt) / 200);
    // Services (SAC 99…) have no quantity: UQC "NA", quantity 0.
    const sac = hsn.startsWith('99');
    const data: HsnData = { hsn, desc: ls.find((l) => l.description)?.description?.slice(0, 30), uqc: sac ? 'NA' : uqc, qty: sac ? 0 : round2(qty), rt, txval, iamt: ti, camt: half, samt: half, csamt: round2(cess) };
    records.push({ section, key: `${section}|${hsn}|${uqc}|${rt}|${o.source}`, source: src(ls), data } as AnyRecord);
  }

  // 6. Table 13 – documents issued: the marketplace's document register when given, else the
  // invoice and credit-note numbers in the report.
  const docs = docLines.length
    ? docLines.map((d) => ({ ...d }))
    : [
        ...lines.filter((l) => l.kind === 'sale' && l.invoiceNo).map((l) => ({ type: 'invoice' as const, number: l.invoiceNo! })),
        ...[...cancelledInvoices].map((n) => ({ type: 'invoice' as const, number: n, cancelled: true })),
        // Bills the report marks as cancelled (kept as skipped lines) – counted as cancelled in Table 13.
        ...all.filter((l) => l.kind === 'skip' && l.cancel && l.invoiceNo).map((l) => ({ type: 'invoice' as const, number: l.invoiceNo!, cancelled: true })),
        ...lines.filter((l) => l.kind === 'return' && l.noteNo).map((l) => ({ type: 'credit' as const, number: l.noteNo! })),
      ];
  records.push(...docRecords(docs, o.source));
  // Numbers missing inside a series are usually cancelled (or not in the report) – Table 13 must count them.
  for (const g of seriesGaps(docs.filter((d) => d.type === 'invoice').map((d) => d.number))) {
    issue('warning', 'docs', 'cancel', `${g.missing.length} invoice number(s) missing between ${g.from} and ${g.to}: ${g.missing.slice(0, 10).join(', ')}${g.missing.length > 10 ? ' …' : ''}`, {
      suggestion: 'If these bills were cancelled, edit the Documents issued (Table 13) row: total number including them and the cancelled count. If they are missing from the report, export it again.',
    });
  }

  // 7. summary
  summary.salesTaxable = round2(summary.salesTaxable);
  summary.returnsTaxable = round2(summary.returnsTaxable);
  summary.netTaxable = round2(summary.salesTaxable - summary.returnsTaxable);
  const docTax = (r: AnyRecord) => {
    if (r.section === 'b2cs') return (r.data.iamt ?? 0) + (r.data.camt ?? 0) + (r.data.samt ?? 0);
    if (r.section === 'b2b' || r.section === 'b2cl' || r.section === 'cdnr') {
      const t = r.data.items.reduce((a, i) => a + (i.iamt ?? 0) + (i.camt ?? 0) + (i.samt ?? 0), 0);
      return r.section === 'cdnr' ? -t : t;
    }
    return 0;
  };
  summary.computedTax = round2(records.reduce((a, r) => a + docTax(r), 0));
  for (const r of records) summary.records[r.section] = (summary.records[r.section] ?? 0) + 1;
  if (etin) {
    // Table 14(a): net value of all supplies through this operator (B2B + B2C, net of returns) and the tax on it.
    const t = { etin, netValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const r of records) {
      const sgn = r.section === 'cdnr' ? -1 : 1;
      const rows = r.section === 'b2cs' ? [r.data] : r.section === 'b2b' || r.section === 'b2cl' || r.section === 'cdnr' ? r.data.items : [];
      for (const i of rows) {
        t.netValue += sgn * (i.txval ?? 0); t.igst += sgn * (i.iamt ?? 0); t.cgst += sgn * (i.camt ?? 0); t.sgst += sgn * (i.samt ?? 0); t.cess += sgn * (i.csamt ?? 0);
      }
    }
    summary.table14 = { etin, netValue: round2(t.netValue), igst: round2(t.igst), cgst: round2(t.cgst), sgst: round2(t.sgst), cess: round2(t.cess) };
  }
  if (summary.reportedTax != null && Math.abs(summary.reportedTax - summary.computedTax) > Math.max(10, Math.abs(summary.reportedTax) * 0.005)) {
    issue('warning', 'b2cs', 'tax', `Tax in the report (${money(summary.reportedTax)}) differs from rate × taxable value (${money(summary.computedTax)})`, {
      suggestion: 'Check a few lines in the report – a wrong rate or HSN in the marketplace catalogue is the usual cause.',
    });
  }
  return { records, issues, summary };
}
