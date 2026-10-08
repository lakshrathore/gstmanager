import type { BankTxn, Direction, InvoiceData } from './types';

/**
 * Bank statement ↔ books: each receipt is matched to a sales invoice and each payment to a purchase
 * invoice – same amount (±₹1), within a date window, preferring the party named in the narration.
 * What is left is money that moved without an accounting entry here. Also flags unusual amounts.
 */

export interface BankLine { id: string; data: BankTxn }
export interface BookInvoice { id: string; direction: Direction; data: InvoiceData }

export type BankMatchStatus = 'matched' | 'party' | 'unmatched' | 'not_applicable';
export interface BankMatch { status: BankMatchStatus; invoiceIds: string[]; note: string }

/** Bank charges, interest and the like never have a sales/purchase invoice. */
const NOT_APPLICABLE = new Set(['INTEREST', 'CHARGES']);
const STOP = new Set(['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'THE', 'AND', 'CO', 'COMPANY', 'INDIA', 'ENTERPRISES', 'ENTERPRISE', 'TRADERS', 'TRADING', 'INDUSTRIES', 'SERVICES', 'SOLUTIONS', 'M/S', 'MS', 'SONS', 'BROS', 'BROTHERS', 'AGENCIES', 'AGENCY']);

/** Distinctive words of a party name ("Rao Industries Pvt Ltd" → ["RAO"]). */
export function nameTokens(name?: string): string[] {
  return (name ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
const amountOf = (d: InvoiceData) => d.total ?? d.taxable + d.igst + d.cgst + d.sgst + d.cess;

export function matchBank(lines: BankLine[], invoices: BookInvoice[]): Map<string, BankMatch> {
  const out = new Map<string, BankMatch>();
  const used = new Set<string>();
  const usable = invoices.filter((i) => i.data.docType === 'INV' && i.data.invoiceDate && !i.data.summary);
  for (const l of [...lines].sort((a, b) => a.data.date.localeCompare(b.data.date))) {
    const t = l.data;
    if (NOT_APPLICABLE.has(t.mode)) { out.set(l.id, { status: 'not_applicable', invoiceIds: [], note: t.mode === 'INTEREST' ? 'Interest' : 'Bank charges' }); continue; }
    const credit = t.credit > 0;
    const amount = credit ? t.credit : t.debit;
    const side: Direction = credit ? 'sales' : 'purchase';
    const narr = ` ${t.narration.toUpperCase().replace(/[^A-Z0-9]/g, ' ')} `;
    const nameHit = (i: BookInvoice) => {
      const toks = nameTokens(side === 'sales' ? i.data.customerName : i.data.supplierName);
      return toks.length ? toks.filter((w) => narr.includes(` ${w} `)).length / toks.length : 0;
    };
    // Paid up to 30 days before (advance) and 180 days after the invoice.
    const window = usable.filter((i) => i.direction === side && !used.has(i.id) && days(t.date, i.data.invoiceDate) >= -30 && days(t.date, i.data.invoiceDate) <= 180);
    const exact = window.filter((i) => Math.abs(amountOf(i.data) - amount) <= 1)
      .map((i) => ({ i, score: nameHit(i), gap: Math.abs(days(t.date, i.data.invoiceDate)) }))
      .sort((a, b) => b.score - a.score || a.gap - b.gap);
    if (exact.length && (exact[0].score > 0 || exact.length === 1)) {
      used.add(exact[0].i.id);
      out.set(l.id, { status: 'matched', invoiceIds: [exact[0].i.id], note: `${side === 'sales' ? 'Receipt for' : 'Payment of'} ${exact[0].i.data.invoiceNo}` });
      continue;
    }
    // Several invoices of one party paid together.
    const named = window.filter((i) => nameHit(i) >= 0.5);
    const total = named.reduce((a, i) => a + amountOf(i.data), 0);
    if (named.length > 1 && Math.abs(total - amount) <= 1) {
      named.forEach((i) => used.add(i.id));
      out.set(l.id, { status: 'matched', invoiceIds: named.map((i) => i.id), note: `${named.length} invoices of ${side === 'sales' ? named[0].data.customerName : named[0].data.supplierName} together` });
      continue;
    }
    if (named.length) {
      out.set(l.id, { status: 'party', invoiceIds: named.map((i) => i.id).slice(0, 5), note: `Party has invoices here but no amount matches (on account, part payment or TDS?)` });
      continue;
    }
    out.set(l.id, { status: 'unmatched', invoiceIds: [], note: exact.length ? `${exact.length} invoices of the same amount – could not tell which` : `No ${side === 'sales' ? 'sales' : 'purchase'} invoice of this amount` });
  }
  return out;
}

/** Amounts far above the usual on the same side, and big round-figure transfers. */
export function unusualTxns(lines: BankLine[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const side of ['debit', 'credit'] as const) {
    const amts = lines.map((l) => l.data[side]).filter((x) => x > 0).sort((a, b) => a - b);
    if (amts.length < 5) continue;
    const median = amts[Math.floor(amts.length / 2)];
    for (const l of lines) {
      const a = l.data[side];
      if (!a || NOT_APPLICABLE.has(l.data.mode)) continue;
      if (a >= 100000 && a >= median * 10) out.set(l.id, `${side === 'debit' ? 'Payment' : 'Receipt'} of ₹${Math.round(a).toLocaleString('en-IN')} is over 10× the usual (₹${Math.round(median).toLocaleString('en-IN')}).`);
      else if (a >= 500000 && a % 100000 === 0) out.set(l.id, `Round-figure ${side === 'debit' ? 'payment' : 'receipt'} of ₹${a.toLocaleString('en-IN')}.`);
    }
  }
  return out;
}

/** Gaps in invoice number series ("INV/26-27/0012 … 0015" → 0013, 0014 missing). */
export function seriesGaps(invoiceNos: string[], maxGap = 50) {
  const series = new Map<string, { width: number; nums: Set<number> }>();
  for (const no of invoiceNos) {
    const m = /^(.*?)(\d+)$/.exec(no.trim());
    if (!m) continue;
    const s = series.get(m[1]) ?? { width: m[2].length, nums: new Set<number>() };
    s.nums.add(Number(m[2]));
    series.set(m[1], s);
  }
  const out: { prefix: string; from: string; to: string; missing: string[] }[] = [];
  for (const [prefix, s] of series) {
    if (s.nums.size < 3) continue;
    const nums = [...s.nums].sort((a, b) => a - b);
    const missing: string[] = [];
    for (let i = 1; i < nums.length; i++) {
      const gap = nums[i] - nums[i - 1] - 1;
      if (gap > 0 && gap <= maxGap) for (let n = nums[i - 1] + 1; n < nums[i]; n++) missing.push(prefix + String(n).padStart(s.width, '0'));
    }
    const fmt = (n: number) => prefix + String(n).padStart(s.width, '0');
    if (missing.length) out.push({ prefix, from: fmt(nums[0]), to: fmt(nums[nums.length - 1]), missing });
  }
  return out;
}
