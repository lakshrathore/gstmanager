/**
 * GSTR-9 (annual return): tables 4 – 18 as on the GST portal, validation, GSTN's JSON (the shape of
 * Save GSTR-9 / the offline tool upload) and auto-fill from the GSTR-1 and GSTR-3B data in the app.
 * Pure – shared with the browser.
 */

import type { AnyRecord } from '@/engine/types';
import { profileForPeriod } from '@/engine/config/versions';
import { liabilityPreview, normalizeForm as normalize3b, type Gstr3bForm } from '../gstr3b/protocol';
import {
  add, basicIssues, blankForm, cleanListRow, COL_LABEL, differs, fyInfo, HEADS, listSum, neg, normalize, r2, resolve, rows, rs, TAXED, total,
  type AnnualForm, type Col, type Issue, type ListDef, type ListRow, type TableDef, type Vals,
} from './common';

const T = TAXED;
const H = HEADS;
const IG = ['txval', 'iamt', 'csamt'] as const;
const TV = ['txval'] as const;
const CS = ['camt', 'samt'] as const;
const IC = ['iamt', 'csamt'] as const;

const C_T: Col[] = [{ key: 'txval', label: 'Taxable value' }, { key: 'iamt', label: 'IGST' }, { key: 'camt', label: 'CGST' }, { key: 'samt', label: 'SGST/UTGST' }, { key: 'csamt', label: 'Cess' }];
const C_H = C_T.slice(1);

const ITC_TYPES = [['ip', 'Inputs'], ['cg', 'Capital goods'], ['is', 'Input services']] as const;
const itcRows = (letter: string, label: string, arr: string, types: readonly (readonly [string, string])[] = ITC_TYPES, cols: readonly string[] = H) =>
  types.map(([ty, name]) => ({ code: `${letter} ${name}`, label: `${label} – ${name.toLowerCase()}`, cols, json: ['table6', arr, ty], sub: true }));
const codes6 = (letter: string, types: readonly (readonly [string, string])[] = ITC_TYPES) => types.map(([, n]) => `${letter} ${n}`);

const HSN_LIST = (code: '17' | '18', title: string): ListDef => ({
  code, title, json: [`table${code}`, 'items'],
  cols: [
    { key: 'hsn_sc', label: 'HSN', type: 'hsn' },
    { key: 'uqc', label: 'UQC', type: 'uqc' },
    { key: 'qty', label: 'Total quantity', type: 'num' },
    { key: 'isconcesstional', label: 'Concessional rate (Y/N)', type: 'yn' },
    { key: 'rt', label: 'Rate', type: 'rate' },
    { key: 'txval', label: 'Taxable value', type: 'num' },
    { key: 'iamt', label: 'IGST', type: 'num' },
    { key: 'camt', label: 'CGST', type: 'num' },
    { key: 'samt', label: 'SGST/UTGST', type: 'num' },
    { key: 'csamt', label: 'Cess', type: 'num' },
  ],
  blank: () => ({ hsn_sc: '', uqc: '', qty: 0, isconcesstional: 'N', rt: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }),
});

const OTHER_REV: ListDef = {
  code: '7H', title: '7H Other reversals', json: ['table7', 'other'],
  cols: [{ key: 'desc', label: 'Description', type: 'text' }, ...C_H.map((c) => ({ key: c.key, label: c.label, type: 'num' as const }))],
  blank: () => ({ desc: '', iamt: 0, camt: 0, samt: 0, csamt: 0 }),
};

const TAX_ROWS = [['IGST', 'iamt'], ['CGST', 'camt'], ['SGST', 'samt'], ['Cess', 'csamt']] as const;
const TAX_NAME: Record<string, string> = { IGST: 'Integrated tax', CGST: 'Central tax', SGST: 'State/UT tax', Cess: 'Cess' };
/** Which credit can pay which tax (sections 49, 49A): CGST credit never pays SGST and vice versa; cess only cess. */
const T9_PAID_BY: Record<string, string[]> = {
  iamt: ['tax_paid_itc_iamt', 'tax_paid_itc_camt', 'tax_paid_itc_samt'],
  camt: ['tax_paid_itc_iamt', 'tax_paid_itc_camt'],
  samt: ['tax_paid_itc_iamt', 'tax_paid_itc_samt'],
  csamt: ['tax_paid_itc_csamt'],
};

export const GSTR9_TABLES: TableDef[] = [
  {
    id: '4', sheet: '4 Outward taxable', cols: C_T,
    title: '4. Advances, inward and outward supplies on which tax is payable',
    rows: [
      { code: '4A', label: 'Supplies made to unregistered persons (B2C)', cols: T, json: ['table4', 'b2c'] },
      { code: '4B', label: 'Supplies made to registered persons (B2B)', cols: T, json: ['table4', 'b2b'] },
      { code: '4C', label: 'Zero rated supply (export) on payment of tax (except supplies to SEZs)', cols: IG, json: ['table4', 'exp'] },
      { code: '4D', label: 'Supply to SEZs on payment of tax', cols: IG, json: ['table4', 'sez'] },
      { code: '4E', label: 'Deemed exports', cols: T, json: ['table4', 'deemed'] },
      { code: '4F', label: 'Advances on which tax has been paid but invoice has not been issued', cols: T, json: ['table4', 'at'] },
      { code: '4G', label: 'Inward supplies on which tax is to be paid on reverse charge basis', cols: T, json: ['table4', 'rchrg'] },
      { code: '4H', label: 'Sub-total (A to G)', cols: T, calc: (r) => rows(r, ['4A', '4B', '4C', '4D', '4E', '4F', '4G']) },
      { code: '4I', label: 'Credit notes issued in respect of transactions in B to E (−)', cols: T, json: ['table4', 'cr_nt'] },
      { code: '4J', label: 'Debit notes issued in respect of transactions in B to E (+)', cols: T, json: ['table4', 'dr_nt'] },
      { code: '4K', label: 'Supplies / tax declared through amendments (+)', cols: T, json: ['table4', 'amd_pos'] },
      { code: '4L', label: 'Supplies / tax reduced through amendments (−)', cols: T, json: ['table4', 'amd_neg'] },
      { code: '4M', label: 'Sub-total (I to L)', cols: T, signed: true, calc: (r) => add(neg(r['4I']), r['4J'], r['4K'], neg(r['4L'])) },
      { code: '4N', label: 'Supplies and advances on which tax is to be paid (H + M)', cols: T, signed: true, calc: (r) => add(r['4H'], r['4M']) },
    ],
  },
  {
    id: '5', sheet: '5 Outward non-taxable', cols: C_T,
    title: '5. Outward supplies on which tax is not payable',
    rows: [
      { code: '5A', label: 'Zero rated supply (export) without payment of tax', cols: TV, json: ['table5', 'zero_rtd'] },
      { code: '5B', label: 'Supply to SEZs without payment of tax', cols: TV, json: ['table5', 'sez'] },
      { code: '5C', label: 'Supplies on which tax is to be paid by the recipient on reverse charge basis', cols: TV, json: ['table5', 'rchrg'] },
      { code: '5D', label: 'Exempted', cols: TV, json: ['table5', 'exmt'] },
      { code: '5E', label: 'Nil rated', cols: TV, json: ['table5', 'nil'] },
      { code: '5F', label: 'Non-GST supply (includes no supply)', cols: TV, json: ['table5', 'non_gst'] },
      { code: '5G', label: 'Sub-total (A to F)', cols: TV, calc: (r) => rows(r, ['5A', '5B', '5C', '5D', '5E', '5F']) },
      { code: '5H', label: 'Credit notes issued in respect of transactions in A to F (−)', cols: TV, json: ['table5', 'cr_nt'] },
      { code: '5I', label: 'Debit notes issued in respect of transactions in A to F (+)', cols: TV, json: ['table5', 'dr_nt'] },
      { code: '5J', label: 'Supplies declared through amendments (+)', cols: TV, json: ['table5', 'amd_pos'] },
      { code: '5K', label: 'Supplies reduced through amendments (−)', cols: TV, json: ['table5', 'amd_neg'] },
      { code: '5L', label: 'Sub-total (H to K)', cols: TV, signed: true, calc: (r) => add(neg(r['5H']), r['5I'], r['5J'], neg(r['5K'])) },
      { code: '5M', label: 'Turnover on which tax is not to be paid (G + L)', cols: TV, signed: true, calc: (r) => add(r['5G'], r['5L']) },
      { code: '5N', label: 'Total turnover, including advances (4N + 5M − 4G)', cols: T, signed: true, calc: (r) => add(r['4N'], r['5M'], neg(r['4G'])) },
    ],
  },
  {
    id: '6', sheet: '6 ITC availed', cols: C_H,
    title: '6. Input tax credit availed during the financial year',
    rows: [
      { code: '6A', label: 'Total ITC availed through GSTR-3B (sum of table 4A of GSTR-3B)', cols: H, ref: true, json: ['table6', 'itc_3b'] },
      ...itcRows('6B', 'Inward supplies (other than imports and RCM inward supplies)', 'supp_non_rchrg'),
      ...itcRows('6C', 'Inward supplies from unregistered persons liable to reverse charge (tax paid)', 'supp_rchrg_unreg'),
      ...itcRows('6D', 'Inward supplies from registered persons liable to reverse charge (tax paid)', 'supp_rchrg_reg'),
      ...itcRows('6E', 'Import of goods (including supplies from SEZs)', 'iog', ITC_TYPES.slice(0, 2), IC),
      { code: '6F', label: 'Import of services (excluding inward supplies from SEZs)', cols: IC, json: ['table6', 'ios'] },
      { code: '6G', label: 'Input tax credit received from ISD', cols: H, json: ['table6', 'isd'] },
      { code: '6H', label: 'Amount of ITC reclaimed (other than B above) under the Act', cols: H, json: ['table6', 'itc_clmd'] },
      { code: '6I', label: 'Sub-total (B to H)', cols: H, calc: (r) => rows(r, [...codes6('6B'), ...codes6('6C'), ...codes6('6D'), ...codes6('6E', ITC_TYPES.slice(0, 2)), '6F', '6G', '6H']) },
      { code: '6J', label: 'Difference (I − A)', cols: H, signed: true, calc: (r) => add(r['6I'], neg(r['6A'])) },
      { code: '6K', label: 'Transition credit through TRAN-1 (including revisions)', cols: CS, json: ['table6', 'tran1'] },
      { code: '6L', label: 'Transition credit through TRAN-2', cols: CS, json: ['table6', 'tran2'] },
      { code: '6M', label: 'Any other ITC availed but not specified above', cols: H, json: ['table6', 'other'] },
      { code: '6N', label: 'Sub-total (K to M)', cols: H, calc: (r) => rows(r, ['6K', '6L', '6M']) },
      { code: '6O', label: 'Total ITC availed (I + N)', cols: H, calc: (r) => add(r['6I'], r['6N']) },
    ],
  },
  {
    id: '7', sheet: '7 ITC reversed', cols: C_H, lists: [OTHER_REV],
    title: '7. ITC reversed and ineligible ITC for the financial year',
    rows: [
      { code: '7A', label: 'As per rule 37', cols: H, json: ['table7', 'rule37'] },
      { code: '7B', label: 'As per rule 39', cols: H, json: ['table7', 'rule39'] },
      { code: '7C', label: 'As per rule 42', cols: H, json: ['table7', 'rule42'] },
      { code: '7D', label: 'As per rule 43', cols: H, json: ['table7', 'rule43'] },
      { code: '7E', label: 'As per section 17(5)', cols: H, json: ['table7', 'sec17'] },
      { code: '7F', label: 'Reversal of TRAN-1 credit', cols: CS, json: ['table7', 'revsl_tran1'] },
      { code: '7G', label: 'Reversal of TRAN-2 credit', cols: CS, json: ['table7', 'revsl_tran2'] },
      { code: '7H', label: 'Other reversals', cols: H, list: '7H' },
      { code: '7I', label: 'Total ITC reversed (A to H)', cols: H, calc: (r, f) => add(rows(r, ['7A', '7B', '7C', '7D', '7E', '7F', '7G']), listSum(f, '7H', H)) },
      { code: '7J', label: 'Net ITC available for utilisation (6O − 7I)', cols: H, signed: true, calc: (r) => add(r['6O'], neg(r['7I'])) },
    ],
  },
  {
    id: '8', sheet: '8 Other ITC', cols: C_H,
    title: '8. Other ITC related information',
    rows: [
      { code: '8A', label: 'ITC as per GSTR-2B (table 3 and 5)', cols: H, ref: true, json: ['table8', 'itc_2b'] },
      { code: '8B', label: 'ITC as per sum total of 6B and 6H above', cols: H, calc: (r) => add(rows(r, codes6('6B')), r['6H']) },
      { code: '8C', label: 'ITC on inward supplies (other than imports and RCM) received during the year but availed in the next year', cols: H, json: ['table8', 'itc_inwd_supp'] },
      { code: '8D', label: 'Difference [A − (B + C)]', cols: H, signed: true, calc: (r) => add(r['8A'], neg(r['8B']), neg(r['8C'])) },
      { code: '8E', label: 'ITC available but not availed', cols: H, json: ['table8', 'itc_nt_availd'] },
      { code: '8F', label: 'ITC available but ineligible', cols: H, json: ['table8', 'itc_nt_eleg'] },
      { code: '8G', label: 'IGST paid on import of goods (including supplies from SEZ)', cols: H, json: ['table8', 'iog_taxpaid'] },
      { code: '8H', label: 'IGST credit availed on import of goods (as per 6E above)', cols: H, calc: (r) => rows(r, codes6('6E', ITC_TYPES.slice(0, 2))) },
      { code: '8I', label: 'Difference (G − H)', cols: H, signed: true, calc: (r) => add(r['8G'], neg(r['8H'])) },
      { code: '8J', label: 'ITC available but not availed on import of goods (equal to I)', cols: H, signed: true, calc: (r) => r['8I'] },
      { code: '8K', label: 'Total ITC to be lapsed in the current year (E + F + J)', cols: H, signed: true, calc: (r) => add(r['8E'], r['8F'], r['8J']) },
    ],
  },
  {
    id: '9', sheet: '9 Tax paid',
    title: '9. Tax paid as declared in returns filed during the financial year',
    note: 'Only “Tax payable” is sent to GSTN; the portal fills the paid columns from your GSTR-3B. They are kept here to check the payment.',
    cols: [
      { key: 'txpyble', label: 'Tax payable' }, { key: 'txpaid_cash', label: 'Paid in cash', ref: true },
      { key: 'tax_paid_itc_iamt', label: 'Paid through ITC – IGST', ref: true }, { key: 'tax_paid_itc_camt', label: 'Paid through ITC – CGST', ref: true },
      { key: 'tax_paid_itc_samt', label: 'Paid through ITC – SGST/UTGST', ref: true }, { key: 'tax_paid_itc_csamt', label: 'Paid through ITC – Cess', ref: true },
    ],
    rows: [
      ...TAX_ROWS.map(([name, k]) => ({ code: `9 ${name}`, label: TAX_NAME[name], cols: ['txpyble', 'txpaid_cash', ...T9_PAID_BY[k]], json: ['table9', k] })),
      { code: '9 Interest', label: 'Interest', cols: ['txpyble', 'txpaid_cash'], json: ['table9', 'intr'] },
      { code: '9 Late fee', label: 'Late fee', cols: ['txpyble', 'txpaid_cash'], json: ['table9', 'fee'] },
      { code: '9 Penalty', label: 'Penalty', cols: ['txpyble', 'txpaid_cash'], json: ['table9', 'pen'] },
      { code: '9 Other', label: 'Other', cols: ['txpyble', 'txpaid_cash'], json: ['table9', 'other'] },
    ],
  },
  {
    id: '10', sheet: '10-13 Next year', cols: C_T,
    title: '10 – 13. Transactions for the year declared in returns of the next financial year',
    rows: [
      { code: '10', label: 'Supplies / tax declared through amendments (+) (net of debit notes)', cols: T, json: ['table10', 'dbn_amd'] },
      { code: '11', label: 'Supplies / tax reduced through amendments (−) (net of credit notes)', cols: T, json: ['table10', 'cdn_amd'] },
      { code: '12', label: 'Reversal of ITC availed during the previous financial year', cols: H, json: ['table10', 'itc_rvsl'] },
      { code: '13', label: 'ITC availed for the previous financial year', cols: H, json: ['table10', 'itc_availd'] },
    ],
  },
  {
    id: '14', sheet: '14 Differential tax',
    title: '14. Differential tax paid on account of declaration in 10 and 11',
    cols: [{ key: 'txpyble', label: 'Payable' }, { key: 'txpaid', label: 'Paid' }],
    rows: [
      ...TAX_ROWS.map(([name, k]) => ({ code: `14 ${name}`, label: TAX_NAME[name], cols: ['txpyble', 'txpaid'], json: ['table14', k] })),
      { code: '14 Interest', label: 'Interest', cols: ['txpyble', 'txpaid'], json: ['table14', 'intr'] },
    ],
  },
  {
    id: '15', sheet: '15 Demands & refunds',
    title: '15. Particulars of demands and refunds',
    cols: [...C_H, { key: 'intr', label: 'Interest' }, { key: 'pen', label: 'Penalty' }, { key: 'fee', label: 'Late fee / others' }],
    rows: [
      { code: '15A', label: 'Total refund claimed', cols: H, json: ['table15', 'rfd_clmd'] },
      { code: '15B', label: 'Total refund sanctioned', cols: H, json: ['table15', 'rfd_sanc'] },
      { code: '15C', label: 'Total refund rejected', cols: H, json: ['table15', 'rfd_rejt'] },
      { code: '15D', label: 'Total refund pending', cols: H, json: ['table15', 'rfd_pend'] },
      { code: '15E', label: 'Total demand of taxes', cols: [...H, 'intr', 'pen', 'fee'], json: ['table15', 'tax_dmnd'] },
      { code: '15F', label: 'Total taxes paid in respect of E above', cols: [...H, 'intr', 'pen', 'fee'], json: ['table15', 'tax_paid'] },
      { code: '15G', label: 'Total demands pending out of E above', cols: [...H, 'intr', 'pen', 'fee'], json: ['table15', 'dmnd_pend'] },
    ],
  },
  {
    id: '16', sheet: '16 Composition & deemed', cols: C_T,
    title: '16. Supplies received from composition taxpayers, deemed supply and goods sent on approval',
    rows: [
      { code: '16A', label: 'Supplies received from composition taxpayers', cols: TV, json: ['table16', 'comp_supp'] },
      { code: '16B', label: 'Deemed supply under section 143', cols: T, json: ['table16', 'deemed_supp'] },
      { code: '16C', label: 'Goods sent on approval basis but not returned', cols: T, json: ['table16', 'not_returned'] },
    ],
  },
  { id: '17', sheet: '17 HSN outward', cols: [], rows: [], lists: [HSN_LIST('17', '17 HSN-wise summary of outward supplies')], title: '17. HSN-wise summary of outward supplies' },
  { id: '18', sheet: '18 HSN inward', cols: [], rows: [], lists: [HSN_LIST('18', '18 HSN-wise summary of inward supplies')], title: '18. HSN-wise summary of inward supplies' },
];

export const blankGstr9 = () => blankForm(GSTR9_TABLES);
export const normalizeGstr9 = (src: unknown) => normalize(GSTR9_TABLES, src);
export const resolveGstr9 = (f: AnnualForm) => resolve(GSTR9_TABLES, f);

/* ---------- validation ---------- */

export interface Gstr9Context {
  fy: string;
  /** Aggregate turnover above ₹5 crore: 6-digit HSN in table 17. */
  aatoAbove5Cr: boolean;
}

const RATE_TOL = (txval: number) => Math.max(1, txval * 0.005);

/** Every check the GST portal and the law apply to the annual return that can be made offline. */
export function validateGstr9(f: AnnualForm, ctx: Gstr9Context): Issue[] {
  const out = basicIssues(GSTR9_TABLES, f);
  const r = resolveGstr9(f);
  const err = (table: string, message: string, code?: string) => out.push({ severity: 'error', table, code, message });
  const warn = (table: string, message: string, code?: string) => out.push({ severity: 'warning', table, code, message });
  const fy = fyInfo(ctx.fy);

  // Table 4: tax must follow taxable value.
  for (const code of ['4A', '4B', '4C', '4D', '4E', '4F', '4G', '4I', '4J', '4K', '4L']) {
    const x = r[code];
    const tax = total(x, ['iamt', 'camt', 'samt']);
    if (!x.txval && tax > 0) warn('4', `${code}: tax ${rs(tax)} is reported without any taxable value.`, code);
    else if (x.txval > 0 && !tax && !['4I', '4J', '4K', '4L'].includes(code)) warn('4', `${code}: taxable value ${rs(x.txval)} has no tax. Report exempt, nil-rated and zero-rated supplies without tax in table 5.`, code);
    else if (x.txval > 0 && tax > x.txval * 0.4 + 1) warn('4', `${code}: tax ${rs(tax)} is more than 40% of the taxable value ${rs(x.txval)}.`, code);
    if (x.iamt && (x.camt || x.samt) && ['4C', '4D'].includes(code)) err('4', `${code}: exports and SEZ supplies carry IGST only.`, code);
  }
  if (r['4N'].txval < 0) err('4', '4N: credit notes and amendments reduce taxable supplies below zero.', '4N');
  if (r['5N'].txval < 0) err('5', '5N: total turnover cannot be negative.', '5N');

  // Table 6: what was claimed in GSTR-3B should be broken up in 6B – 6H.
  if (total(r['6A']) > 0) {
    for (const k of H) {
      if (differs(r['6J'][k], 0)) {
        warn('6', `6J: ${COL_LABEL[k]} in 6B – 6H (${rs(r['6I'][k])}) differs from the ITC claimed in GSTR-3B (6A, ${rs(r['6A'][k])}) by ${rs(r['6J'][k])}. Rows 6B – 6H should add up to 6A; explain or correct the difference.`, '6J');
      }
    }
  } else if (total(r['6I']) > 0) warn('6', '6A is blank: enter the total ITC availed through GSTR-3B (the portal fills it) so 6J can show the difference.', '6A');

  if (fy && fy.start >= 2019) {
    for (const code of ['6K', '6L', '7F', '7G']) if (total(r[code], CS) > 0) warn(code[0], `${code}: transition credit (TRAN-1/TRAN-2) applies only to 2017-18 and 2018-19.`, code);
  }

  // Table 7.
  for (const k of H) if (r['7J'][k] < -1) err('7', `7J: ITC reversed (${rs(r['7I'][k])}) is more than the ITC availed (${rs(r['6O'][k])}) for ${COL_LABEL[k]}.`, '7J');

  // Table 8.
  if (total(r['8A']) > 0) {
    const d = total(r['8D']);
    if (d < -1) warn('8', `8D: ITC claimed (6B + 6H + 8C) is ${rs(-d)} more than GSTR-2B shows. Check for excess claims – they may need to be reversed with interest.`, '8D');
  } else if (total(r['6I']) > 0) warn('8', '8A is blank: enter the ITC as per GSTR-2B (the portal fills it) to see the difference in 8D.', '8A');
  if (total(r['8I']) < -1) warn('8', '8I: IGST credit availed on imports (6E) is more than the IGST paid on imports (8G).', '8I');

  // Table 9: payable vs. 4N, paid vs. payable, ITC used vs. ITC available.
  const t9 = TAX_ROWS.map(([name, k]) => ({ name, k, x: r[`9 ${name}`] }));
  const anyPaid = t9.some(({ x }) => total(x, Object.keys(x).filter((c) => c !== 'txpyble')) > 0);
  for (const { name, k, x } of t9) {
    const code = `9 ${name}`;
    const expected = r['4N'][k] ?? 0;
    if (differs(x.txpyble, expected)) {
      warn('9', `${code}: tax payable ${rs(x.txpyble)} differs from the tax in 4N (${rs(expected)}). Pay any shortfall through DRC-03.`, code);
    }
    const paid = total(x, ['txpaid_cash', ...T9_PAID_BY[k]]);
    if (anyPaid && paid < x.txpyble - 1) warn('9', `${code}: paid ${rs(paid)} is less than payable ${rs(x.txpyble)}. Pay the difference through DRC-03 before filing.`, code);
    if (anyPaid && paid > x.txpyble + 1) warn('9', `${code}: paid ${rs(paid)} is more than payable ${rs(x.txpyble)}.`, code);
  }
  for (const [k, col] of [['iamt', 'tax_paid_itc_iamt'], ['camt', 'tax_paid_itc_camt'], ['samt', 'tax_paid_itc_samt'], ['csamt', 'tax_paid_itc_csamt']] as const) {
    const used = r2(t9.reduce((a, { x }) => a + (x[col] ?? 0), 0));
    if (used > r['7J'][k] + 1 && total(r['6O']) > 0) warn('9', `Table 9: ${col.slice(13).toUpperCase()} credit used (${rs(used)}) is more than the net ITC available in 7J (${rs(r['7J'][k])}).`);
  }
  for (const code of ['9 Interest', '9 Late fee', '9 Penalty', '9 Other']) {
    const x = r[code];
    if (x.txpaid_cash < x.txpyble - 1) warn('9', `${code}: paid ${rs(x.txpaid_cash)} is less than payable ${rs(x.txpyble)}.`, code);
  }

  // Table 14: differential tax.
  for (const [name] of [...TAX_ROWS, ['Interest']]) {
    const x = r[`14 ${name}`];
    if (x.txpaid < x.txpyble - 1) warn('14', `14 ${name}: paid ${rs(x.txpaid)} is less than payable ${rs(x.txpyble)}.`, `14 ${name}`);
  }
  const extra = add(r['10'], neg(r['11']));
  if (total(extra, ['iamt', 'camt', 'samt', 'csamt']) > 1 && TAX_ROWS.every(([n]) => !r[`14 ${n}`].txpyble)) {
    warn('14', 'Table 10 declares more tax than table 11 reduces, but table 14 shows no differential tax payable.');
  }

  // Table 15: pending = demand − paid; refunds.
  for (const k of [...H, 'intr', 'pen', 'fee']) {
    const pend = r2((r['15E'][k] ?? 0) - (r['15F'][k] ?? 0));
    if (differs(r['15G'][k] ?? 0, pend) && (r['15E'][k] || r['15F'][k] || r['15G'][k])) warn('15', `15G: pending ${k} (${rs(r['15G'][k] ?? 0)}) should be demand (15E) − paid (15F) = ${rs(pend)}.`, '15G');
    if (k === 'intr' || k === 'pen' || k === 'fee') continue;
    if ((r['15B'][k] ?? 0) + (r['15C'][k] ?? 0) + (r['15D'][k] ?? 0) > (r['15A'][k] ?? 0) + 1) warn('15', `15A – 15D: refunds sanctioned, rejected and pending (${k}) add up to more than the refund claimed.`, '15A');
  }

  // Tables 17 and 18: HSN summary.
  const rates = new Set(fy ? profileForPeriod(fy.fp).allowedRates : profileForPeriod('032026').allowedRates);
  const minDigits = ctx.aatoAbove5Cr ? 6 : 4;
  for (const code of ['17', '18'] as const) {
    const items = f.lists[code] ?? [];
    const seen = new Map<string, number>();
    items.forEach((x, i) => {
      const at = `Table ${code} row ${i + 1}${x.hsn_sc ? ` (HSN ${x.hsn_sc})` : ''}`;
      const hsn = String(x.hsn_sc);
      const service = hsn.startsWith('99');
      if (!/^\d+$/.test(hsn) || ![4, 6, 8].includes(hsn.length)) err(code, `${at}: HSN must be 4, 6 or 8 digits.`);
      else if (code === '17' && hsn.length < minDigits) err(code, `${at}: HSN must have at least ${minDigits} digits ${ctx.aatoAbove5Cr ? '(turnover above ₹5 crore)' : ''}.`);
      if (!rates.has(Number(x.rt))) err(code, `${at}: ${x.rt}% is not a GST rate.`);
      if (!service && !x.uqc) err(code, `${at}: enter the UQC (unit) for goods.`);
      if (service && x.uqc && x.uqc !== 'NA') warn(code, `${at}: services (SAC 99…) are reported with UQC "NA".`);
      if (service && Number(x.qty)) warn(code, `${at}: services are reported without quantity.`);
      const txval = Number(x.txval);
      const tax = r2(Number(x.iamt) + Number(x.camt) + Number(x.samt));
      if (x.isconcesstional !== 'Y' && txval > 0 && Math.abs(tax - (txval * Number(x.rt)) / 100) > RATE_TOL(txval)) {
        warn(code, `${at}: tax ${rs(tax)} is not ${x.rt}% of ${rs(txval)} (${rs((txval * Number(x.rt)) / 100)}). Mark concessional-rate supplies with Y.`);
      }
      if (Number(x.iamt) && (Number(x.camt) || Number(x.samt))) warn(code, `${at}: has both IGST and CGST/SGST – report inter-state and intra-state supplies on separate rows if the portal rejects it.`);
      if (Math.abs(Number(x.camt) - Number(x.samt)) > 1) warn(code, `${at}: CGST and SGST/UTGST are normally equal.`);
      const key = [hsn, x.uqc, Number(x.rt), x.isconcesstional].join('|');
      if (seen.has(key)) err(code, `${at}: same HSN, UQC, rate and concessional flag as row ${seen.get(key)! + 1}. Combine them into one row.`);
      else seen.set(key, i);
    });
  }
  const outwardTax = total(add(rows(r, ['4A', '4B', '4C', '4D', '4E']), neg(r['4I']), r['4J'], r['4K'], neg(r['4L'])));
  const hsnTax = total(listSum(f, '17', H));
  if (!(f.lists['17'] ?? []).length && r['4N'].txval > 0) {
    warn('17', 'Table 17 (HSN summary of outward supplies) is empty. It is mandatory when aggregate turnover is above ₹1.5 crore.');
  } else if ((f.lists['17'] ?? []).length && differs(hsnTax, outwardTax) && Math.abs(hsnTax - outwardTax) > Math.max(10, outwardTax * 0.01)) {
    warn('17', `Tax in table 17 (${rs(hsnTax)}) differs from the tax on outward supplies in table 4 (4A to 4E, net of notes and amendments: ${rs(outwardTax)}).`);
  }
  return out;
}

/* ---------- GSTN JSON ---------- */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * GSTR-9 in GSTN's JSON (Save GSTR-9 / offline tool upload): every table GSTN accepts, values only for
 * the columns each row has, computed sub-totals and GSTN-filled columns (6A, 8A, paid in table 9) left out.
 */
export function gstr9Json(f: AnnualForm, gstin: string, fy: string) {
  const info = fyInfo(fy);
  const n = normalizeGstr9(f);
  const out: Record<string, Record<string, unknown>> = {};
  const at = (table: string) => (out[table] ??= {});
  for (const t of GSTR9_TABLES) {
    const refCols = new Set(t.cols.filter((c) => c.ref).map((c) => c.key));
    for (const row of t.rows) {
      if (row.calc || row.ref || !row.json) continue;
      const vals = Object.fromEntries(row.cols.filter((c) => !refCols.has(c)).map((c) => [c, n.v[row.code]?.[c] ?? 0]));
      const [table, key, ty] = row.json;
      if (ty) (((at(table)[key] as unknown[] | undefined) ?? (at(table)[key] = [])) as unknown[]).push({ itc_typ: ty, ...vals });
      else at(table)[key] = vals;
    }
    for (const l of t.lists ?? []) {
      if (!l.json) continue;
      const items = (n.lists[l.code] ?? []).map((x) => {
        if (l.code === '7H') return { desc: x.desc, iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt };
        const service = String(x.hsn_sc).startsWith('99');
        return {
          hsn_sc: x.hsn_sc, ...(service ? {} : { uqc: x.uqc, qty: x.qty }), txval: x.txval, isconcesstional: x.isconcesstional, rt: x.rt,
          iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt,
        };
      });
      if (l.json[1] === 'items') at(l.json[0]).items = items;
      else at(l.json[0])[l.json[1]] = items;
    }
  }
  return { gstin, fp: info?.fp ?? '', ...out };
}

/**
 * GSTN's GSTR-9 JSON → form. Accepts the save/upload shape, GSTN's Get GSTR-9 Details response
 * (with or without the { data } wrapper) and the system-computed JSON (which also has 6A, 8A and the
 * paid columns of table 9). Unknown keys are ignored.
 */
export function fromGstr9Json(src: unknown): { form: AnnualForm; gstin?: string; fp?: string; read: number } {
  let s = obj(src);
  for (let i = 0; i < 3 && !s.table4 && !s.table6 && !s.table17; i++) s = obj(s.data ?? s.gstr9 ?? s.GSTR9 ?? s.result);
  const f = blankGstr9();
  let read = 0;
  for (const t of GSTR9_TABLES) {
    for (const row of t.rows) {
      if (row.calc || !row.json) continue;
      const [table, key, ty] = row.json;
      let src2: unknown = obj(s[table])[key];
      if (ty) src2 = arr(src2).map(obj).find((x) => x.itc_typ === ty);
      if (row.code === '8A' && !src2) src2 = obj(s.table8).itc_2a;
      if (!src2) continue;
      const x = obj(src2);
      f.v[row.code] = Object.fromEntries(row.cols.map((c) => [c, r2(x[c])]));
      read++;
    }
    for (const l of t.lists ?? []) {
      if (!l.json) continue;
      const items = arr(obj(s[l.json[0]])[l.json[1]]);
      f.lists[l.code] = items.map((x) => cleanListRow(l, obj(x)));
      read += items.length;
    }
  }
  return { form: normalizeGstr9(f), gstin: typeof s.gstin === 'string' ? s.gstin : undefined, fp: typeof s.fp === 'string' ? s.fp : undefined, read };
}

/* ---------- auto-fill from GSTR-1 and GSTR-3B ---------- */

export interface Gstr3bSource {
  fp: string;
  form: unknown;
  /** GSTN's payment table of the filed return ({ pdcash, pditc }), when known. */
  payment?: { pdcash?: Record<string, number>[]; pditc?: Record<string, number> | null } | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const itemVals = (x: { txval?: number | null; adAmt?: number | null; iamt: number | null; camt: number | null; samt: number | null; csamt: number | null }): Vals =>
  ({ txval: num(x.txval ?? x.adAmt), iamt: num(x.iamt), camt: num(x.camt), samt: num(x.samt), csamt: num(x.csamt) });

/**
 * GSTR-9 from the year's GSTR-1 records (tables 4, 5, 17) and GSTR-3B returns (4G, 6, 7, 9), the way
 * the portal pre-fills it. Splits the portal cannot know (inputs / capital goods / input services,
 * rule-wise reversals, amendments) are left to the user and listed in `notes`.
 */
export function gstr9FromSources(fy: string, gstr1: { fp: string; quarterly?: boolean; records: AnyRecord[] }[], gstr3b: Gstr3bSource[]) {
  const info = fyInfo(fy)!;
  const f = blankGstr9();
  const notes: string[] = [];
  const v = (code: string, x: Vals) => { f.v[code] = add(f.v[code], x); };
  const only = (x: Vals, cols: readonly string[]) => Object.fromEntries(cols.map((c) => [c, x[c] ?? 0]));
  let amendments = 0;

  const hsn = new Map<string, ListRow>();
  for (const ret of gstr1) {
    for (const rec of ret.records) {
      switch (rec.section) {
        case 'b2b':
          for (const it of rec.data.items) {
            const x = itemVals(it);
            if (rec.data.rchrg === 'Y') v('5C', only(x, TV));
            else if (rec.data.invTyp === 'SEWP') v('4D', only(x, IG));
            else if (rec.data.invTyp === 'SEWOP') v('5B', only(x, TV));
            else if (rec.data.invTyp === 'DE') v('4E', x);
            else v('4B', x);
          }
          break;
        case 'b2cl': case 'b2cs':
          for (const it of rec.section === 'b2cs' ? [rec.data] : rec.data.items) v('4A', itemVals(it));
          break;
        case 'exp':
          for (const it of rec.data.items) {
            if (rec.data.expTyp === 'WOPAY') v('5A', only(itemVals(it), TV));
            else v('4C', only(itemVals(it), IG));
          }
          break;
        case 'at': for (const it of rec.data.items) v('4F', itemVals(it)); break;
        case 'txpd': for (const it of rec.data.items) v('4F', neg(itemVals(it))); break;
        case 'cdnr': case 'cdnur': {
          const credit = rec.data.ntty === 'C';
          const typ = rec.section === 'cdnr' ? rec.data.invTyp : rec.data.urType;
          const noTax = typ === 'SEWOP' || typ === 'EXPWOP' || (rec.section === 'cdnr' && rec.data.rchrg === 'Y');
          for (const it of rec.data.items) {
            const x = itemVals(it);
            if (noTax) v(credit ? '5H' : '5I', only(x, TV));
            else v(credit ? '4I' : '4J', x);
          }
          break;
        }
        case 'nil':
          v('5E', { txval: num(rec.data.nilAmt) }); v('5D', { txval: num(rec.data.exptAmt) }); v('5F', { txval: num(rec.data.ngsupAmt) });
          break;
        case 'hsn_b2b': case 'hsn_b2c': {
          const d = rec.data;
          const service = String(d.hsn).startsWith('99');
          const uqc = service ? 'NA' : String(d.uqc ?? '').toUpperCase();
          const key = [d.hsn, uqc, num(d.rt)].join('|');
          const cur = hsn.get(key) ?? { hsn_sc: String(d.hsn), uqc, qty: 0, isconcesstional: 'N', rt: num(d.rt), txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
          for (const k of ['qty', 'txval', 'iamt', 'camt', 'samt', 'csamt'] as const) cur[k] = r2(Number(cur[k]) + (k === 'qty' && service ? 0 : num(d[k])));
          hsn.set(key, cur);
          break;
        }
        default:
          if (rec.section.endsWith('a')) amendments++;
      }
    }
  }
  if (f.v['4F'] && Object.values(f.v['4F']).some((n) => n < 0)) {
    f.v['4F'] = Object.fromEntries(Object.entries(f.v['4F']).map(([k, n]) => [k, Math.max(0, n)]));
    notes.push('Advances adjusted (GSTR-1 11B) exceed advances received (11A) for the year; 4F is set to zero where negative.');
  }
  f.lists['17'] = [...hsn.values()];
  if (amendments) notes.push(`GSTR-1 has ${amendments} amendment row(s) (tables 9A, 9C, 10, 11). Enter their net effect in 4K/4L and 5J/5K.`);

  // GSTR-3B.
  const paid: Record<string, Vals> = {};
  const p = (code: string, x: Vals) => { paid[code] = add(paid[code], x); };
  let paidMonths = 0;
  for (const m of gstr3b) {
    const g: Gstr3bForm = normalize3b(m.form);
    const itc = (table: 'itc_avl' | 'itc_rev' | 'itc_inelg', ty: string): Vals => {
      const x = g.itc_elg[table].find((r) => r.ty === ty);
      return x ? { iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt } : {};
    };
    v('4G', g.sup_details.isup_rev as Vals);
    v('6A', add(...g.itc_elg.itc_avl.map((x) => ({ iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt }))));
    const reclaimed = itc('itc_inelg', 'RUL');
    v('6B Inputs', add(itc('itc_avl', 'OTH'), neg(reclaimed)));
    v('6D Inputs', itc('itc_avl', 'ISRC'));
    v('6E Inputs', only(itc('itc_avl', 'IMPG'), IC));
    v('6F', only(itc('itc_avl', 'IMPS'), IC));
    v('6G', itc('itc_avl', 'ISD'));
    v('6H', reclaimed);
    v('7H:rul', itc('itc_rev', 'RUL'));
    v('7H:oth', itc('itc_rev', 'OTH'));

    const lp = liabilityPreview(g);
    for (const [name, k] of TAX_ROWS) v(`9 ${name}`, { txpyble: (lp.forward[k] ?? 0) + (lp.reverse[k] ?? 0) });
    v('9 Interest', { txpyble: total(lp.interest) });
    v('9 Late fee', { txpyble: total(lp.lateFee) });

    if (m.payment && (m.payment.pdcash?.length || m.payment.pditc)) {
      paidMonths++;
      const c = (keys: string[]) => r2((m.payment!.pdcash ?? []).reduce((a, r) => a + keys.reduce((b, k) => b + num(r[k]), 0), 0));
      const i = m.payment.pditc ?? {};
      p('9 IGST', { txpaid_cash: c(['ipd']), tax_paid_itc_iamt: num(i.i_pdi), tax_paid_itc_camt: num(i.c_pdi), tax_paid_itc_samt: num(i.s_pdi) });
      p('9 CGST', { txpaid_cash: c(['cpd']), tax_paid_itc_iamt: num(i.i_pdc), tax_paid_itc_camt: num(i.c_pdc) });
      p('9 SGST', { txpaid_cash: c(['spd']), tax_paid_itc_iamt: num(i.i_pds), tax_paid_itc_samt: num(i.s_pds) });
      p('9 Cess', { txpaid_cash: c(['cspd']), tax_paid_itc_csamt: num(i.cs_pdcs) });
      p('9 Interest', { txpaid_cash: c(['i_intrpd', 'c_intrpd', 's_intrpd', 'cs_intrpd']) });
      p('9 Late fee', { txpaid_cash: c(['i_lfeepd', 'c_lfeepd', 's_lfeepd', 'cs_lfeepd']) });
    }
  }
  for (const [code, x] of Object.entries(paid)) f.v[code] = { ...f.v[code], ...x };

  const rul = f.v['7H:rul'];
  const oth = f.v['7H:oth'];
  delete f.v['7H:rul']; delete f.v['7H:oth'];
  const other: ListRow[] = [];
  if (total(rul) > 0) other.push({ desc: 'As per GSTR-3B 4(B)(1) – rules 38, 42, 43 and section 17(5)', ...only(rul, H) });
  if (total(oth) > 0) other.push({ desc: 'As per GSTR-3B 4(B)(2) – others', ...only(oth, H) });
  f.lists['7H'] = other;

  const have1 = new Set(gstr1.map((x) => x.fp));
  const have3b = new Set(gstr3b.map((x) => x.fp));
  const label = (fp: string) => `${fp.slice(0, 2)}/${fp.slice(2)}`;
  // Quarterly (QRMP) filers have one GSTR-1 per quarter, filed for the quarter-ending month.
  const quarterly = gstr1.some((x) => x.quarterly);
  const due = info.months.filter((m) => !quarterly || ['03', '06', '09', '12'].includes(m.slice(0, 2)));
  const missing1 = due.filter((m) => !have1.has(m));
  const missing3b = info.months.filter((m) => !have3b.has(m) && (!quarterly || due.includes(m)));
  if (!gstr1.length) notes.push('No GSTR-1 data for this year in the app: tables 4, 5 and 17 are blank.');
  else if (missing1.length) notes.push(`No GSTR-1 data for ${missing1.map(label).join(', ')}.`);
  if (!gstr3b.length) notes.push('No GSTR-3B data for this year in the app: 4G, tables 6, 7 and 9 are blank.');
  else {
    if (missing3b.length) notes.push(`No GSTR-3B data for ${missing3b.map(label).join(', ')}.`);
    notes.push('ITC from GSTR-3B is put under “Inputs” (6B, 6D, 6E). Move capital goods and input services to their rows, and split reverse-charge ITC between 6C (unregistered) and 6D (registered).');
    if (other.length) notes.push('ITC reversed in GSTR-3B is put in 7H. Move it to the rule-wise rows 7A – 7E where it belongs.');
    if (paidMonths < gstr3b.length) notes.push(`The paid columns of table 9 come from GSTN's payment table, available here for ${paidMonths} of ${gstr3b.length} GSTR-3B return(s). The portal fills them on filing.`);
  }
  notes.push('Enter 6A (ITC in GSTR-3B) and 8A (ITC as per GSTR-2B) from the portal if they differ, and tables 8, 10 – 16 and 18 from your books.');
  return { form: normalizeGstr9(f), notes };
}
