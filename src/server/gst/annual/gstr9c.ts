/**
 * GSTR-9C (self-certified reconciliation statement, Part A): tables 5 – 16 as on the GST portal's
 * offline tool, validation, and pre-fill of the "as per annual return" figures from GSTR-9.
 * Pure – shared with the browser.
 *
 * GSTN publishes no upload schema for GSTR-9C (the offline tool generates its JSON), so the JSON
 * this app exports is its own backup format; the Excel follows the form for keying into the tool.
 */

import { profileForPeriod } from '@/engine/config/versions';
import {
  add, basicIssues, blankForm, COL_LABEL, differs, fyInfo, HEADS, listSum, neg, normalize, r2, resolve, rows, rs, TAXED, total,
  type AnnualForm, type Col, type Issue, type ListDef, type ListRow, type TableDef,
} from './common';
import { resolveGstr9 } from './gstr9';

const A = ['amt'] as const;
const T = TAXED;
const H = HEADS;
const C_A: Col[] = [{ key: 'amt', label: 'Amount' }];
const C_T: Col[] = [{ key: 'txval', label: 'Taxable value' }, { key: 'iamt', label: 'IGST' }, { key: 'camt', label: 'CGST' }, { key: 'samt', label: 'SGST/UTGST' }, { key: 'csamt', label: 'Cess' }];

const rateList = (code: string, title: string, rc: boolean): ListDef => ({
  code, title,
  cols: [
    { key: 'rt', label: 'Rate', type: 'rate' },
    ...(rc ? [{ key: 'rc', label: 'Reverse charge (Y/N)', type: 'yn' as const }] : []),
    ...C_T.map((c) => ({ key: c.key, label: c.label, type: 'num' as const })),
  ],
  blank: () => ({ rt: 0, ...(rc ? { rc: 'N' } : {}), txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }),
});
const RATE9 = rateList('9 Rate', '9 Rate-wise liability', true);
const RATE11 = rateList('11 Rate', '11 Rate-wise additional liability', false);

const sumList = (f: AnnualForm, code: string) => listSum(f, code, T);

const EXPENSES = [
  ['14A', 'Purchases'], ['14B', 'Freight / carriage'], ['14C', 'Power and fuel'], ['14D', 'Imported material'], ['14E', 'Rent and insurance'],
  ['14F', 'Goods lost, stolen, destroyed, written off or disposed of by way of gift or free samples'], ['14G', 'Royalties'], ['14H', 'Employees’ cost (salaries, wages, bonus etc.)'],
  ['14I', 'Conveyance charges'], ['14J', 'Bank charges'], ['14K', 'Entertainment charges'], ['14L', 'Stationery expenses (including postage etc.)'],
  ['14M', 'Repair and maintenance'], ['14N', 'Other miscellaneous expenses'], ['14O', 'Capital goods'], ['14P', 'Any other expense 1'], ['14Q', 'Any other expense 2'],
] as const;

const reasons = (id: string, title: string, sheet = 'Reasons'): TableDef => ({ id, title, sheet, cols: [], rows: [], text: id });

export const GSTR9C_TABLES: TableDef[] = [
  {
    id: '5', sheet: '5 & 7 Turnover', cols: C_A,
    title: '5. Reconciliation of gross turnover',
    rows: [
      { code: '5A', label: 'Turnover (including exports) as per audited financial statements for the State / UT', cols: A },
      { code: '5B', label: 'Unbilled revenue at the beginning of the financial year (+)', cols: A },
      { code: '5C', label: 'Unadjusted advances at the end of the financial year (+)', cols: A },
      { code: '5D', label: 'Deemed supply under Schedule I (+)', cols: A },
      { code: '5E', label: 'Credit notes issued after the end of the year but reflected in the annual return (+)', cols: A },
      { code: '5F', label: 'Trade discounts accounted for in the audited statements but not permissible under GST (+)', cols: A },
      { code: '5G', label: 'Turnover from April 2017 to June 2017 (−)', cols: A },
      { code: '5H', label: 'Unbilled revenue at the end of the financial year (−)', cols: A },
      { code: '5I', label: 'Unadjusted advances at the beginning of the financial year (−)', cols: A },
      { code: '5J', label: 'Credit notes accounted for in the audited statements but not permissible under GST (−)', cols: A },
      { code: '5K', label: 'Adjustments on account of supply of goods by SEZ units to DTA units (−)', cols: A },
      { code: '5L', label: 'Turnover for the period under composition scheme (−)', cols: A },
      { code: '5M', label: 'Adjustments in turnover under section 15 and rules thereunder (±)', cols: A, signed: true },
      { code: '5N', label: 'Adjustments in turnover due to foreign exchange fluctuations (±)', cols: A, signed: true },
      { code: '5O', label: 'Adjustments in turnover due to reasons not listed above (±)', cols: A, signed: true },
      {
        code: '5P', label: 'Annual turnover after adjustments', cols: A, signed: true,
        calc: (r) => add(rows(r, ['5A', '5B', '5C', '5D', '5E', '5F']), neg(rows(r, ['5G', '5H', '5I', '5J', '5K', '5L'])), rows(r, ['5M', '5N', '5O'])),
      },
      { code: '5Q', label: 'Turnover as declared in the annual return (GSTR-9, 5N)', cols: A, signed: true },
      { code: '5R', label: 'Un-reconciled turnover (Q − P)', cols: A, signed: true, calc: (r) => add(r['5Q'], neg(r['5P'])) },
    ],
  },
  reasons('6', '6. Reasons for un-reconciled difference in annual gross turnover'),
  {
    id: '7', sheet: '5 & 7 Turnover', cols: C_A,
    title: '7. Reconciliation of taxable turnover',
    rows: [
      { code: '7A', label: 'Annual turnover after adjustments (from 5P)', cols: A, signed: true, calc: (r) => r['5P'] },
      { code: '7B', label: 'Value of exempted, nil-rated, non-GST supplies and no-supply turnover', cols: A },
      { code: '7C', label: 'Zero-rated supplies without payment of tax', cols: A },
      { code: '7D', label: 'Supplies on which tax is to be paid by the recipient on reverse charge basis', cols: A },
      { code: '7E', label: 'Taxable turnover as per adjustments above (A − B − C − D)', cols: A, signed: true, calc: (r) => add(r['7A'], neg(rows(r, ['7B', '7C', '7D']))) },
      { code: '7F', label: 'Taxable turnover as per liability declared in the annual return (GSTR-9)', cols: A },
      { code: '7G', label: 'Un-reconciled taxable turnover (F − E)', cols: A, signed: true, calc: (r) => add(r['7F'], neg(r['7E'])) },
    ],
  },
  reasons('8', '8. Reasons for un-reconciled difference in taxable turnover'),
  {
    id: '9', sheet: '9 Rate-wise liability', cols: C_T, lists: [RATE9],
    title: '9. Reconciliation of rate-wise liability and amount payable thereon',
    rows: [
      { code: '9 Rate', label: 'Rate-wise taxable value and tax', cols: T, list: '9 Rate' },
      { code: '9 Interest', label: 'Interest', cols: H },
      { code: '9 Late fee', label: 'Late fee', cols: H },
      { code: '9 Penalty', label: 'Penalty', cols: H },
      { code: '9 Others', label: 'Others', cols: T },
      { code: '9P', label: 'Total amount to be paid as per the tables above', cols: T, calc: (r, f) => add(sumList(f, '9 Rate'), rows(r, ['9 Interest', '9 Late fee', '9 Penalty', '9 Others'])) },
      { code: '9Q', label: 'Total amount paid as declared in the annual return (GSTR-9)', cols: H },
      { code: '9R', label: 'Un-reconciled payment of amount (Q − P)', cols: H, signed: true, calc: (r) => add(r['9Q'], neg(r['9P'])) },
    ],
  },
  reasons('10', '10. Reasons for un-reconciled payment of amount'),
  {
    id: '11', sheet: '11 Additional liability', cols: C_T, lists: [RATE11],
    title: '11. Additional amount payable but not paid (due to reasons in 6, 8 and 10)',
    rows: [
      { code: '11 Rate', label: 'Rate-wise taxable value and tax', cols: T, list: '11 Rate' },
      { code: '11 Interest', label: 'Interest', cols: H },
      { code: '11 Late fee', label: 'Late fee', cols: H },
      { code: '11 Penalty', label: 'Penalty', cols: H },
      { code: '11 Others', label: 'Any other amount paid for supplies not included in the annual return', cols: T },
    ],
  },
  {
    id: '12', sheet: '12 & 14 ITC', cols: C_A,
    title: '12. Reconciliation of net input tax credit',
    rows: [
      { code: '12A', label: 'ITC availed as per audited financial statements for the State / UT', cols: A },
      { code: '12B', label: 'ITC booked in earlier financial years claimed in the current year (+)', cols: A },
      { code: '12C', label: 'ITC booked in the current year to be claimed in subsequent years (−)', cols: A },
      { code: '12D', label: 'ITC availed as per audited financial statements or books of account (A + B − C)', cols: A, signed: true, calc: (r) => add(r['12A'], r['12B'], neg(r['12C'])) },
      { code: '12E', label: 'ITC claimed in the annual return (GSTR-9, 7J)', cols: A, signed: true },
      { code: '12F', label: 'Un-reconciled ITC (E − D)', cols: A, signed: true, calc: (r) => add(r['12E'], neg(r['12D'])) },
    ],
  },
  reasons('13', '13. Reasons for un-reconciled difference in ITC'),
  {
    id: '14', sheet: '12 & 14 ITC',
    title: '14. Reconciliation of ITC declared in the annual return with ITC availed on expenses (optional)',
    cols: [{ key: 'value', label: 'Value' }, { key: 'itc', label: 'Amount of total ITC' }, { key: 'itc_elg', label: 'Amount of eligible ITC availed' }],
    rows: [
      ...EXPENSES.map(([code, label]) => ({ code, label, cols: ['value', 'itc', 'itc_elg'] })),
      { code: '14R', label: 'Total amount of eligible ITC availed', cols: ['value', 'itc', 'itc_elg'], calc: (r) => rows(r, EXPENSES.map(([c]) => c)) },
      { code: '14S', label: 'ITC claimed in the annual return (GSTR-9)', cols: ['itc_elg'], signed: true },
      { code: '14T', label: 'Un-reconciled ITC (S − R)', cols: ['itc_elg'], signed: true, calc: (r) => add(r['14S'], neg(r['14R'])) },
    ],
  },
  reasons('15', '15. Reasons for un-reconciled difference in ITC'),
  {
    id: '16', sheet: '16 Tax payable', cols: C_A,
    title: '16. Tax payable on un-reconciled difference in ITC (due to reasons in 13 and 15)',
    rows: [
      { code: '16 CGST', label: 'Central tax', cols: A }, { code: '16 SGST', label: 'State/UT tax', cols: A },
      { code: '16 IGST', label: 'Integrated tax', cols: A }, { code: '16 Cess', label: 'Cess', cols: A },
      { code: '16 Interest', label: 'Interest', cols: A }, { code: '16 Penalty', label: 'Penalty', cols: A },
    ],
  },
];

export const blankGstr9c = () => blankForm(GSTR9C_TABLES);
export const normalizeGstr9c = (src: unknown) => normalize(GSTR9C_TABLES, src);
export const resolveGstr9c = (f: AnnualForm) => resolve(GSTR9C_TABLES, f);

/** Figures of the year's GSTR-9 that GSTR-9C reconciles against. */
export interface Gstr9Figures {
  turnover: number; exemptNilNonGst: number; zeroRated: number; reverseCharge: number; taxableTurnover: number;
  paid: Record<string, number>; netItc: number;
}

export function gstr9Figures(gstr9: AnnualForm): Gstr9Figures {
  const r = resolveGstr9(gstr9);
  const paid = Object.fromEntries(([['iamt', '9 IGST'], ['camt', '9 CGST'], ['samt', '9 SGST'], ['csamt', '9 Cess']] as const).map(([k, code]) => {
    const x = r[code];
    return [k, r2(Object.entries(x).filter(([c]) => c !== 'txpyble').reduce((a, [, n]) => a + n, 0))];
  }));
  return {
    turnover: r['5N'].txval,
    exemptNilNonGst: total(rows(r, ['5D', '5E', '5F']), ['txval']),
    zeroRated: total(rows(r, ['5A', '5B']), ['txval']),
    reverseCharge: r['5C'].txval,
    // Taxable turnover = supplies on which tax is payable (4N) without inward reverse charge (4G).
    taxableTurnover: r2(r['4N'].txval - r['4G'].txval),
    paid,
    netItc: total(r['7J']),
  };
}

export interface Gstr9cContext {
  fy: string;
  /** The year's GSTR-9 in the app, if any – the "as per annual return" figures must match it. */
  gstr9?: Gstr9Figures | null;
}

const TEXT_FOR: [string, string, string][] = [['5R', 'amt', '6'], ['7G', 'amt', '8'], ['12F', 'amt', '13'], ['14T', 'itc_elg', '15']];

export function validateGstr9c(f: AnnualForm, ctx: Gstr9cContext): Issue[] {
  const out = basicIssues(GSTR9C_TABLES, f);
  const r = resolveGstr9c(f);
  const err = (table: string, message: string, code?: string) => out.push({ severity: 'error', table, code, message });
  const warn = (table: string, message: string, code?: string) => out.push({ severity: 'warning', table, code, message });
  const fy = fyInfo(ctx.fy);

  if (!r['5A'].amt) err('5', '5A: enter the turnover as per the audited financial statements.', '5A');
  else if (r['5A'].amt <= 5e7) warn('5', `5A: turnover ${rs(r['5A'].amt)} is not above ₹5 crore – GSTR-9C is required only when aggregate turnover exceeds ₹5 crore.`, '5A');
  if (fy && fy.start >= 2018 && r['5G'].amt) warn('5', '5G: turnover from April – June 2017 applies only to 2017-18.', '5G');

  // Each un-reconciled difference must be explained.
  for (const [code, col, table] of TEXT_FOR) {
    // Table 14 is optional: only reconciled when expenses are entered.
    if (table === '15' && !EXPENSES.some(([c]) => Object.values(f.v[c] ?? {}).some(Boolean))) continue;
    if (differs(r[code][col], 0) && !(f.text[table] ?? '').trim()) err(table, `${code} shows an un-reconciled difference of ${rs(r[code][col])}. Give the reasons in table ${table}.`, code);
  }
  if (r['7E'].amt < -1) err('7', '7E: exempt, zero-rated and reverse-charge turnover (7B – 7D) is more than the annual turnover (7A).', '7E');

  // "As per annual return" figures must be the ones in GSTR-9.
  const g = ctx.gstr9;
  if (g) {
    const same = (code: string, col: string, want: number, what: string) => {
      if (differs(r[code][col] ?? 0, want)) warn(code.replace(/\D.*$/, ''), `${code}: ${rs(r[code][col] ?? 0)} differs from ${what} in GSTR-9 (${rs(want)}).`, code);
    };
    same('5Q', 'amt', g.turnover, 'the total turnover (5N)');
    same('7B', 'amt', g.exemptNilNonGst, 'exempt, nil-rated and non-GST supplies (5D + 5E + 5F)');
    same('7C', 'amt', g.zeroRated, 'zero-rated supplies without tax (5A + 5B)');
    same('7D', 'amt', g.reverseCharge, 'reverse-charge supplies (5C)');
    same('7F', 'amt', g.taxableTurnover, 'the taxable turnover (4N − 4G)');
    for (const k of H) same('9Q', k, g.paid[k] ?? 0, `the ${COL_LABEL[k]} paid (table 9)`);
    same('12E', 'amt', g.netItc, 'the net ITC (7J)');
    if (r['14S'].itc_elg) same('14S', 'itc_elg', g.netItc, 'the net ITC (7J)');
  } else {
    warn('5', 'No GSTR-9 for this year in the app: the “as per annual return” figures (5Q, 7B – 7F, 9Q, 12E) cannot be checked against it.');
  }

  // Rate-wise rows: tax must follow the rate.
  const rates = new Set(fy ? profileForPeriod(fy.fp).allowedRates : profileForPeriod('032026').allowedRates);
  for (const [code, table] of [['9 Rate', '9'], ['11 Rate', '11']] as const) {
    const seen = new Set<string>();
    (f.lists[code] ?? []).forEach((x: ListRow, i) => {
      const at = `Table ${table} row ${i + 1} (${x.rt}%${x.rc === 'Y' ? ' RC' : ''})`;
      if (!rates.has(Number(x.rt)) || !Number(x.rt)) err(table, `${at}: ${x.rt}% is not a GST rate on which tax is payable.`);
      const txval = Number(x.txval);
      const tax = r2(Number(x.iamt) + Number(x.camt) + Number(x.samt));
      if (txval > 0 && Math.abs(tax - (txval * Number(x.rt)) / 100) > Math.max(1, txval * 0.005)) {
        warn(table, `${at}: tax ${rs(tax)} is not ${x.rt}% of ${rs(txval)} (${rs((txval * Number(x.rt)) / 100)}).`);
      }
      if (Math.abs(Number(x.camt) - Number(x.samt)) > 1) warn(table, `${at}: CGST and SGST/UTGST are normally equal.`);
      const key = `${Number(x.rt)}|${x.rc ?? 'N'}`;
      if (seen.has(key)) err(table, `${at}: the same rate appears twice. Combine the rows.`);
      seen.add(key);
    });
  }
  const forward = r2((f.lists['9 Rate'] ?? []).filter((x) => x.rc !== 'Y').reduce((a, x) => a + Number(x.txval), 0));
  if (forward && g && differs(forward, g.taxableTurnover)) {
    warn('9', `9: taxable value in the rate-wise rows other than reverse charge (${rs(forward)}) differs from the taxable turnover in GSTR-9 (${rs(g.taxableTurnover)}).`);
  }

  const addl = add(sumList(f, '11 Rate'), rows(r, ['11 Interest', '11 Late fee', '11 Penalty', '11 Others']));
  if (total(addl) > 0) warn('11', `Table 11 shows ${rs(total(addl))} payable but not paid. Pay it through DRC-03 before filing GSTR-9C.`);
  const t16 = total(rows(r, ['16 CGST', '16 SGST', '16 IGST', '16 Cess', '16 Interest', '16 Penalty']), ['amt']);
  if (t16 > 0) warn('16', `Table 16 shows ${rs(t16)} payable on un-reconciled ITC. Pay it through DRC-03 before filing.`);
  if (r['12F'].amt > 1 && !t16) warn('16', '12F: ITC claimed in GSTR-9 is more than in the books, but table 16 shows no tax payable on the difference.', '12F');
  return out;
}

/** "As per annual return" figures filled from GSTR-9; the rest of the form is kept. */
export function gstr9cFromGstr9(current: AnnualForm, g: Gstr9Figures, gstr9: AnnualForm): { form: AnnualForm; notes: string[] } {
  const f = normalizeGstr9c(current);
  f.v['5Q'] = { amt: g.turnover };
  f.v['7B'] = { amt: g.exemptNilNonGst };
  f.v['7C'] = { amt: g.zeroRated };
  f.v['7D'] = { amt: g.reverseCharge };
  f.v['7F'] = { amt: g.taxableTurnover };
  f.v['9Q'] = { iamt: g.paid.iamt ?? 0, camt: g.paid.camt ?? 0, samt: g.paid.samt ?? 0, csamt: g.paid.csamt ?? 0 };
  f.v['12E'] = { amt: g.netItc };
  f.v['14S'] = { itc_elg: g.netItc };
  const notes = ['Filled 5Q, 7B – 7D, 7F, 9Q, 12E and 14S from GSTR-9. Enter the audited figures (5A – 5O, 12A – 12C, 14) from the financial statements.'];
  if (!(f.lists['9 Rate'] ?? []).length) {
    const byRate = new Map<number, ListRow>();
    for (const x of gstr9.lists['17'] ?? []) {
      const rt = Number(x.rt);
      if (!rt) continue;
      const cur = byRate.get(rt) ?? { rt, rc: 'N', txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      for (const k of T) cur[k] = r2(Number(cur[k]) + Number(x[k]));
      byRate.set(rt, cur);
    }
    f.lists['9 Rate'] = [...byRate.values()].sort((a, b) => Number(a.rt) - Number(b.rt));
    notes.push(byRate.size
      ? 'Rate-wise rows of table 9 are taken from the HSN summary (GSTR-9 table 17). Add reverse-charge rows (RC = Y) and check them against the books.'
      : 'GSTR-9 has no HSN summary with tax rates – fill the rate-wise rows of table 9 yourself.');
  }
  return { form: normalizeGstr9c(f), notes };
}

/** This app's GSTR-9C JSON (a backup that can be imported again; not a GSTN upload format). */
export const gstr9cJson = (f: AnnualForm, gstin: string, fy: string) => ({ form: 'GSTR-9C', format: 'gst-return-desk/1', gstin, fy, ...normalizeGstr9c(f) });

export function fromGstr9cJson(src: unknown) {
  const s = src && typeof src === 'object' ? (src as Record<string, unknown>) : {};
  if (s.form !== 'GSTR-9C' || !s.v) return null;
  return { form: normalizeGstr9c(s), gstin: typeof s.gstin === 'string' ? s.gstin : undefined, fy: typeof s.fy === 'string' ? s.fy : undefined };
}
