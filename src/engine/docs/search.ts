import type { BankMode, Direction } from './types';

/**
 * "Search everything" queries in plain English, Hindi or Hinglish → filters. No AI: amounts with
 * above/below words (₹50,000 से ज्यादा, 5 lakh se kam), months (September 2026 की, सितंबर), sales or
 * purchases (खरीद, bikri), bank words (UPI, cash, receipts), GSTINs, invoice numbers, and whatever
 * is left as party or text words. `understood` says back how the query was read.
 */

export interface ParsedQuery {
  gstins: string[];
  docNos: string[];
  minAmount?: number;
  maxAmount?: number;
  fp?: string;
  fy?: string;
  direction?: Direction;
  kind?: 'invoice' | 'bank';
  mode?: BankMode;
  /** Bank: money in (receipts) or out (payments). */
  flow?: 'in' | 'out';
  words: string[];
  understood: string[];
}

const MONTHS: [RegExp, number][] = [
  [/^(january|jan|जनवरी)$/, 1], [/^(february|feb|फरवरी|फ़रवरी)$/, 2], [/^(march|mar|मार्च)$/, 3], [/^(april|apr|अप्रैल|अप्रेल)$/, 4],
  [/^(may|मई)$/, 5], [/^(june|jun|जून)$/, 6], [/^(july|jul|जुलाई)$/, 7], [/^(august|aug|अगस्त)$/, 8],
  [/^(september|sept|sep|सितंबर|सितम्बर)$/, 9], [/^(october|oct|अक्टूबर|अक्तूबर)$/, 10], [/^(november|nov|नवंबर|नवम्बर)$/, 11], [/^(december|dec|दिसंबर|दिसम्बर)$/, 12],
];
const MULT: [RegExp, number][] = [[/^(k|thousand|hazar|hazaar|हजार|हज़ार)$/, 1e3], [/^(lakh|lakhs|lac|lacs|l|लाख)$/, 1e5], [/^(cr|crore|crores|करोड़|करोड)$/, 1e7]];
const MORE = /^(above|over|more|greater|min|minimum|atleast|zyada|jyada|jada|zyaada|adhik|upar|ज्यादा|ज़्यादा|अधिक|ऊपर|plus|\+|>|>=)$/;
const LESS = /^(below|under|less|max|maximum|upto|kam|कम|tak|तक|<|<=)$/;
const PURCHASE = /^(purchase|purchases|purchased|kharid|kharidi|kharide|खरीद|खरीदी|inward|supplier|suppliers|vendor|vendors)$/;
const SALES = /^(sale|sales|sold|bikri|bikree|बिक्री|outward|customer|customers)$/;
const BANK = /^(bank|transaction|transactions|txn|txns|statement|बैंक|लेनदेन)$/;
const INVOICE = /^(invoice|invoices|bill|bills|बिल|चालान)$/;
const MODES: [RegExp, BankMode][] = [[/^upi$/, 'UPI'], [/^neft$/, 'NEFT'], [/^rtgs$/, 'RTGS'], [/^imps$/, 'IMPS'], [/^(cash|nakad|nakd|नकद|कैश)$/, 'CASH'], [/^(cheque|chq|check|चेक)$/, 'CHEQUE'], [/^atm$/, 'ATM'], [/^(card|pos)$/, 'CARD']];
const IN = /^(receipt|receipts|received|credit|credits|jama|जमा|deposit|deposits|aaya|aayi)$/;
const OUT = /^(payment|payments|paid|debit|debits|withdrawal|withdrawals|निकासी|bheja|diya)$/;
const STOP = new Set([
  'ki', 'ke', 'ka', 'ko', 'se', 'me', 'mein', 'mai', 'में', 'की', 'के', 'का', 'को', 'से', 'सारी', 'सारे', 'sari', 'saari', 'sare', 'saare', 'sabhi', 'सभी', 'all', 'show', 'list',
  'dikhao', 'दिखाओ', 'batao', 'बताओ', 'give', 'the', 'of', 'for', 'in', 'from', 'to', 'with', 'and', 'what', 'is', 'are', 'total', 'kitni', 'कितनी', 'kitna', 'कितना', 'hai', 'है', 'wale', 'वाले',
  'wali', 'waali', 'वाली', 'than', 'least', 'or', 'more', 'rs', 'rs.', 'inr', '₹', 'month', 'mahine', 'महीने', 'find', 'me', 'please', 'all', 'entries', 'entry', 'between', 'and', 'aur', 'और',
]);

const r2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function parseQuery(input: string, today = new Date()): ParsedQuery {
  const out: ParsedQuery = { gstins: [], docNos: [], words: [], understood: [] };
  let text = ` ${input} `;

  // GSTINs (case-insensitive).
  text = text.replace(/\b[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][0-9A-Za-z][Zz][0-9A-Za-z]\b/g, (g) => { out.gstins.push(g.toUpperCase()); return ' '; });
  // "FY 2026-27" / "2026-27".
  text = text.replace(/\b(?:fy\s*)?(20\d{2})\s*-\s*(\d{2})\b/gi, (m, a, b) => { if ((Number(a) + 1) % 100 === Number(b)) { out.fy = `${a}-${b}`; return ' '; } return m; });
  // "09/2026", "092026", "sep-26".
  text = text.replace(/\b(0[1-9]|1[0-2])[/-]?(20\d{2})\b/g, (_m, mm, yy) => { out.fp = `${mm}${yy}`; return ' '; });

  const tokens = text.replace(/₹/g, ' ₹ ').replace(/([<>]=?)/g, ' $1 ').split(/\s+/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase().replace(/[?!,;:।]+$/, ''));
  const used = new Set<number>();
  const amounts: { i: number; v: number }[] = [];

  for (let i = 0; i < lower.length; i++) {
    const t = lower[i];
    // Month (+ optional year).
    const mon = MONTHS.find(([re]) => re.test(t.replace(/[.,'’-]+$/, '')));
    if (mon && !out.fp) {
      const nextYear = /^(20\d{2})$/.test(lower[i + 1] ?? '') ? Number(lower[i + 1]) : /^'?(\d{2})$/.test(lower[i + 1] ?? '') ? 2000 + Number(lower[i + 1].replace("'", '')) : null;
      // "May" is a common word – only a month when a year follows or the query is otherwise about periods.
      if (mon[1] !== 5 || nextYear) {
        const y = nextYear ?? (mon[1] > today.getMonth() + 1 ? today.getFullYear() - 1 : today.getFullYear());
        out.fp = `${String(mon[1]).padStart(2, '0')}${y}`;
        used.add(i); if (nextYear) used.add(i + 1);
        continue;
      }
    }
    // Amounts: a number with ₹/rs, a multiplier or a comparator next to it.
    const numM = /^(\d[\d,]*(?:\.\d+)?)(k|l|cr)?$/.exec(t.replace(/^(₹|rs\.?|inr)/, ''));
    if (numM && !used.has(i)) {
      let v = Number(numM[1].replace(/,/g, ''));
      const mul = MULT.find(([re]) => re.test(numM[2] ?? lower[i + 1] ?? ''));
      if (mul) { v *= mul[1]; if (!numM[2]) used.add(i + 1); }
      const money = /^(₹|rs|inr)/.test(t) || ['₹', 'rs', 'rs.', 'inr'].includes(lower[i - 1] ?? '') || !!mul || MORE.test(lower[i + 1] ?? '') || MORE.test(lower[i + 2] ?? '') || LESS.test(lower[i + 1] ?? '') || LESS.test(lower[i + 2] ?? '')
        || [MORE, LESS].some((re) => re.test(lower[i - 1] ?? '') || re.test(lower[i - 2] ?? ''));
      const year = /^20\d{2}$/.test(numM[1]) && !money;
      if (money && !year) { amounts.push({ i, v: r2(v) }); used.add(i); continue; }
    }
  }

  // Comparators around each amount ("above 50000", "50000 se zyada", "5 lakh se kam", "between 1 and 2 lakh").
  const near = (i: number, re: RegExp) => [i - 2, i - 1, i + 1, i + 2, i + 3].some((j) => re.test(lower[j] ?? '') && !(j > i && MULT.some(([m]) => m.test(lower[j]))));
  if (amounts.length === 2 && lower.some((t) => /^(between|beech|बीच)$/.test(t))) {
    out.minAmount = Math.min(amounts[0].v, amounts[1].v); out.maxAmount = Math.max(amounts[0].v, amounts[1].v);
  } else {
    for (const a of amounts) {
      if (near(a.i, LESS)) out.maxAmount = a.v;
      else out.minAmount = a.v; // a bare amount means "this much or more" in most CA questions
    }
  }
  lower.forEach((t, i) => { if (MORE.test(t) || LESS.test(t) || MULT.some(([re]) => re.test(t))) used.add(i); });

  for (let i = 0; i < lower.length; i++) {
    if (used.has(i)) continue;
    const t = lower[i].replace(/^[("']+|[)"'.]+$/g, '');
    if (!t) continue;
    if (PURCHASE.test(t)) { out.direction = 'purchase'; continue; }
    if (SALES.test(t)) { out.direction = 'sales'; continue; }
    if (BANK.test(t)) { out.kind = 'bank'; continue; }
    if (INVOICE.test(t)) { out.kind ??= 'invoice'; continue; }
    const mode = MODES.find(([re]) => re.test(t));
    if (mode) { out.kind = 'bank'; out.mode = mode[1]; continue; }
    if (IN.test(t)) { out.flow = 'in'; continue; }
    if (OUT.test(t)) { out.flow = 'out'; continue; }
    if (STOP.has(t)) continue;
    // Document numbers: digits with letters or separators ("INV-1023", "26-27/105"), or 3+ digits.
    if (/\d/.test(t) && (/[a-z]/i.test(t) || /[/-]/.test(t) || /^\d{3,}$/.test(t))) { out.docNos.push(tokens[i].replace(/[?!,;:।]+$/, '')); continue; }
    if (t.length >= 2) out.words.push(t);
  }
  // A flow word on its own means bank ("UPI receipts", "cash deposits"); with sales/purchases it stays on invoices.
  if (out.flow && !out.direction) out.kind ??= 'bank';
  if (out.flow && out.kind === 'invoice') out.flow = undefined;

  const u = out.understood;
  if (out.kind === 'bank') u.push(out.mode ? `${out.mode} transactions` : 'Bank transactions');
  else if (out.direction) u.push(out.direction === 'sales' ? 'Sales' : 'Purchases');
  else if (out.kind === 'invoice') u.push('Invoices');
  if (out.flow) u.push(out.flow === 'in' ? 'Money received' : 'Money paid');
  if (out.fp) u.push(new Date(Number(out.fp.slice(2)), Number(out.fp.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }));
  if (out.fy) u.push(`FY ${out.fy}`);
  if (out.minAmount != null && out.maxAmount != null) u.push(`${inr(out.minAmount)} – ${inr(out.maxAmount)}`);
  else if (out.minAmount != null) u.push(`${inr(out.minAmount)} or more`);
  else if (out.maxAmount != null) u.push(`up to ${inr(out.maxAmount)}`);
  for (const g of out.gstins) u.push(`GSTIN ${g}`);
  for (const d of out.docNos) u.push(`Number “${d}”`);
  if (out.words.length) u.push(`“${out.words.join(' ')}”`);
  return out;
}
