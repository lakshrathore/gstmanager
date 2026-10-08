import { describe, expect, it, vi } from 'vitest';
import { readWorkbook, type AnyRecord } from '@/engine';
import { blankForm as blank3b } from '../gstr3b/protocol';
import { fyInfo, fyOf, parseAnnualExcel, type AnnualForm } from './common';
import { blankGstr9, fromGstr9Json, gstr9FromSources, gstr9Json, GSTR9_TABLES, resolveGstr9, validateGstr9 } from './gstr9';
import { blankGstr9c, fromGstr9cJson, gstr9cFromGstr9, gstr9cJson, gstr9Figures, GSTR9C_TABLES, resolveGstr9c, validateGstr9c } from './gstr9c';

vi.mock('server-only', () => ({}));

const ctx9 = { fy: '2024-25', aatoAbove5Cr: false };

/** A consistent GSTR-9: B2B 1,00,000 @18% intra-state, ITC 9,000, tax paid. */
function sample9(): AnnualForm {
  const f = blankGstr9();
  f.v['4B'] = { txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 };
  f.v['5D'] = { txval: 5000 };
  f.v['6A'] = { iamt: 0, camt: 4500, samt: 4500, csamt: 0 };
  f.v['6B Inputs'] = { iamt: 0, camt: 4000, samt: 4000, csamt: 0 };
  f.v['6B Capital goods'] = { iamt: 0, camt: 500, samt: 500, csamt: 0 };
  f.v['8A'] = { iamt: 0, camt: 4500, samt: 4500, csamt: 0 };
  f.v['9 CGST'] = { txpyble: 9000, txpaid_cash: 4500, tax_paid_itc_iamt: 0, tax_paid_itc_camt: 4500 };
  f.v['9 SGST'] = { txpyble: 9000, txpaid_cash: 4500, tax_paid_itc_iamt: 0, tax_paid_itc_samt: 4500 };
  f.lists['17'] = [{ hsn_sc: '8471', uqc: 'NOS', qty: 10, isconcesstional: 'N', rt: 18, txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 }];
  f.lists['7H'] = [{ desc: 'Credit notes from suppliers', iamt: 0, camt: 10, samt: 10, csamt: 0 }];
  return f;
}

describe('financial year', () => {
  it('lists the months and the March return period', () => {
    expect(fyInfo('2024-25')).toMatchObject({ start: 2024, fp: '032025' });
    expect(fyInfo('2024-25')!.months).toEqual(['042024', '052024', '062024', '072024', '082024', '092024', '102024', '112024', '122024', '012025', '022025', '032025']);
    expect(fyInfo('2024-26')).toBeNull();
    expect(fyOf('032025')).toBe('2024-25');
    expect(fyOf('042025')).toBe('2025-26');
  });
});

describe('GSTR-9', () => {
  it('computes sub-totals the way the form does', () => {
    const f = sample9();
    f.v['4I'] = { txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 };
    f.v['4G'] = { txval: 2000, iamt: 0, camt: 180, samt: 180, csamt: 0 };
    const r = resolveGstr9(f);
    expect(r['4H'].txval).toBe(102000);
    expect(r['4M'].txval).toBe(-1000);
    expect(r['4N'].camt).toBe(9090);
    expect(r['5N'].txval).toBe(100000 + 5000 + 2000 - 1000 - 2000);
    expect(r['6I'].camt).toBe(4500);
    expect(r['6J'].camt).toBe(0);
    expect(r['7I'].camt).toBe(10);
    expect(r['7J'].camt).toBe(4490);
    expect(r['8B'].camt).toBe(4500);
    expect(r['8D'].camt).toBe(0);
  });

  it('passes a consistent return and flags real problems', () => {
    expect(validateGstr9(sample9(), ctx9).filter((i) => i.severity === 'error')).toEqual([]);
    const f = sample9();
    f.v['4B'].camt = -5;
    f.v['7A'] = { iamt: 0, camt: 99999, samt: 99999, csamt: 0 };
    f.lists['17'].push({ ...f.lists['17'][0] }, { hsn_sc: '84', uqc: 'XYZ', qty: 1, isconcesstional: 'N', rt: 17, txval: 10, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    const msgs = validateGstr9(f, { fy: '2024-25', aatoAbove5Cr: true }).filter((i) => i.severity === 'error').map((i) => i.message).join('\n');
    expect(msgs).toMatch(/4B: CGST cannot be negative/);
    expect(msgs).toMatch(/7J: ITC reversed/);
    expect(msgs).toMatch(/Combine them into one row/);
    expect(msgs).toMatch(/at least 6 digits/);
    expect(msgs).toMatch(/HSN must be 4, 6 or 8 digits/);
    expect(msgs).toMatch(/UQC "XYZ"/);
    expect(msgs).toMatch(/17% is not a GST rate/);
  });

  it('warns where the portal would show a difference', () => {
    const f = sample9();
    f.v['6A'] = { iamt: 0, camt: 5000, samt: 5000, csamt: 0 };
    f.v['9 CGST'].txpyble = 8000;
    const w = validateGstr9(f, ctx9).filter((i) => i.severity === 'warning').map((i) => i.message).join('\n');
    expect(w).toMatch(/6J: CGST/);
    expect(w).toMatch(/9 CGST: tax payable/);
  });

  it('writes GSTN JSON: no sub-totals, no GSTN-filled columns, typed ITC rows', () => {
    const j = gstr9Json(sample9(), '29AABCS1234Q1Z5', '2024-25') as unknown as Record<string, Record<string, unknown>>;
    expect(j.fp).toBe('032025');
    expect(j.gstin).toBe('29AABCS1234Q1Z5');
    expect(j.table4.b2b).toEqual({ txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 });
    expect(j.table4.exp).toEqual({ txval: 0, iamt: 0, csamt: 0 });
    expect(j.table4.sub_totalAG).toBeUndefined();
    expect(j.table6.itc_3b).toBeUndefined();
    expect(j.table6.supp_non_rchrg).toEqual([
      { itc_typ: 'ip', iamt: 0, camt: 4000, samt: 4000, csamt: 0 },
      { itc_typ: 'cg', iamt: 0, camt: 500, samt: 500, csamt: 0 },
      { itc_typ: 'is', iamt: 0, camt: 0, samt: 0, csamt: 0 },
    ]);
    expect(j.table6.iog).toEqual([{ itc_typ: 'ip', iamt: 0, csamt: 0 }, { itc_typ: 'cg', iamt: 0, csamt: 0 }]);
    expect(j.table6.tran1).toEqual({ camt: 0, samt: 0 });
    expect(j.table7.other).toEqual([{ desc: 'Credit notes from suppliers', iamt: 0, camt: 10, samt: 10, csamt: 0 }]);
    expect(j.table9.camt).toEqual({ txpyble: 9000 });
    expect(j.table17.items).toEqual([{ hsn_sc: '8471', uqc: 'NOS', qty: 10, txval: 100000, isconcesstional: 'N', rt: 18, iamt: 0, camt: 9000, samt: 9000, csamt: 0 }]);
    expect(j.table8.itc_2b).toBeUndefined();
  });

  it('reads GSTN JSON back, including GSTN-filled columns and the { data } wrapper', () => {
    const f = sample9();
    const j = gstr9Json(f, 'X', '2024-25') as unknown as Record<string, Record<string, unknown>>;
    j.table6.itc_3b = { iamt: 0, camt: 4500, samt: 4500, csamt: 0 };
    j.table8.itc_2a = { iamt: 0, camt: 4500, samt: 4500, csamt: 0 };
    (j.table9.camt as Record<string, number>).txpaid_cash = 4500;
    (j.table9.camt as Record<string, number>).tax_paid_itc_camt = 4500;
    (j.table9.samt as Record<string, number>).txpaid_cash = 4500;
    (j.table9.samt as Record<string, number>).tax_paid_itc_samt = 4500;
    const back = fromGstr9Json({ status_cd: '1', data: j });
    expect(back.fp).toBe('032025');
    expect(back.form).toEqual(f);
  });

  it('round-trips the Excel template', async () => {
    const { annualWorkbook } = await import('./excel');
    const f = sample9();
    const res = parseAnnualExcel(GSTR9_TABLES, await readWorkbook(await annualWorkbook(GSTR9_TABLES, f, 'GSTR-9 test')), 'GSTR-9');
    expect(res.issues).toEqual([]);
    expect(res.form).toEqual(f);
  });

  it('reports what it cannot read in Excel', () => {
    const res = parseAnnualExcel(GSTR9_TABLES, [
      { name: 'Mine', rows: [['Code', 'Description', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'], ['4 C', '', 100, 18, 9, 0, 0], ['4B', '', 'abc', 0, 0, 0, 0], ['4H', 'calc', 5, 5, 5, 5, 5]] },
      { name: '17 HSN', rows: [['HSN', 'UQC', 'Rate', 'Taxable value', 'IGST'], ['1001', 'kgs', 5, 100, 5]] },
    ], 'GSTR-9');
    expect(res.form.v['4C']).toEqual({ txval: 100, iamt: 18, csamt: 0 });
    expect(res.form.lists['17']).toEqual([expect.objectContaining({ hsn_sc: '1001', uqc: 'KGS', rt: 5, txval: 100, iamt: 5, camt: 0 })]);
    expect(res.issues.join('\n')).toMatch(/4C has no CGST on the GST portal – 9 ignored/);
    expect(res.issues.join('\n')).toMatch(/4B Taxable value "abc" is not a number/);
    expect(parseAnnualExcel(GSTR9_TABLES, [{ name: 'x', rows: [['a']] }], 'GSTR-9').issues[0]).toMatch(/No GSTR-9 rows/);
  });

  it('fills from GSTR-1 records and GSTR-3B returns', () => {
    const item = (txval: number, camt: number) => ({ rt: 18, txval, iamt: 0, camt, samt: camt, csamt: 0 });
    const records = [
      { section: 'b2b', key: 'a', source: { sheet: '', rows: [] }, data: { ctin: 'X', inum: '1', idt: '2024-04-01', val: 0, pos: '29', rchrg: 'N', invTyp: 'R', items: [item(1000, 90)] } },
      { section: 'b2b', key: 'b', source: { sheet: '', rows: [] }, data: { ctin: 'X', inum: '2', idt: '2024-04-01', val: 0, pos: '29', rchrg: 'Y', invTyp: 'R', items: [item(500, 0)] } },
      { section: 'b2cs', key: 'c', source: { sheet: '', rows: [] }, data: { typ: 'OE', pos: '29', ...item(200, 18) } },
      { section: 'exp', key: 'd', source: { sheet: '', rows: [] }, data: { expTyp: 'WOPAY', inum: '3', idt: '2024-04-02', val: 0, items: [{ rt: 0, txval: 700, iamt: 0, camt: 0, samt: 0, csamt: 0 }] } },
      { section: 'cdnr', key: 'e', source: { sheet: '', rows: [] }, data: { ctin: 'X', ntNum: 'C1', ntDt: '2024-04-05', ntty: 'C', pos: '29', rchrg: 'N', invTyp: 'R', val: 0, items: [item(100, 9)] } },
      { section: 'nil', key: 'f', source: { sheet: '', rows: [] }, data: { splyTy: 'INTRAB2C', nilAmt: 10, exptAmt: 20, ngsupAmt: 30 } },
      { section: 'hsn_b2b', key: 'g', source: { sheet: '', rows: [] }, data: { hsn: '8471', uqc: 'NOS', qty: 2, rt: 18, txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 } },
      { section: 'hsn_b2c', key: 'h', source: { sheet: '', rows: [] }, data: { hsn: '8471', uqc: 'NOS', qty: 1, rt: 18, txval: 200, iamt: 0, camt: 18, samt: 18, csamt: 0 } },
      { section: 'b2ba', key: 'i', source: { sheet: '', rows: [] }, data: { ctin: 'X', inum: '9', idt: '2024-04-01', val: 0, pos: '29', rchrg: 'N', invTyp: 'R', items: [], oinum: '8', oidt: '2024-03-01' } },
    ] as unknown as AnyRecord[];
    const g = blank3b();
    g.sup_details.osup_det = { txval: 1200, iamt: 0, camt: 108, samt: 108, csamt: 0 };
    g.sup_details.isup_rev = { txval: 300, iamt: 0, camt: 27, samt: 27, csamt: 0 };
    g.itc_elg.itc_avl = g.itc_elg.itc_avl.map((r) => (r.ty === 'OTH' ? { ...r, camt: 50, samt: 50 } : r.ty === 'IMPG' ? { ...r, iamt: 70 } : r));
    g.itc_elg.itc_rev = g.itc_elg.itc_rev.map((r) => (r.ty === 'RUL' ? { ...r, camt: 5, samt: 5 } : r));
    const payment = { pdcash: [{ cpd: 100, spd: 100, c_intrpd: 3 }], pditc: { c_pdc: 35, s_pds: 35 } };
    const { form: f, notes } = gstr9FromSources('2024-25', [{ fp: '042024', records }], [{ fp: '042024', form: g, payment }]);
    expect(f.v['4B']).toEqual({ txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 });
    expect(f.v['5C']).toEqual({ txval: 500 });
    expect(f.v['4A'].txval).toBe(200);
    expect(f.v['5A']).toEqual({ txval: 700 });
    expect(f.v['4I'].camt).toBe(9);
    expect([f.v['5E'].txval, f.v['5D'].txval, f.v['5F'].txval]).toEqual([10, 20, 30]);
    expect(f.lists['17']).toEqual([expect.objectContaining({ hsn_sc: '8471', qty: 3, txval: 1200, camt: 108 })]);
    expect(f.v['4G'].camt).toBe(27);
    expect(f.v['6A']).toEqual({ iamt: 70, camt: 50, samt: 50, csamt: 0 });
    expect(f.v['6B Inputs'].camt).toBe(50);
    expect(f.v['6E Inputs']).toEqual({ iamt: 70, csamt: 0 });
    expect(f.lists['7H']).toEqual([expect.objectContaining({ camt: 5, samt: 5 })]);
    expect(f.v['9 CGST']).toEqual({ txpyble: 135, txpaid_cash: 100, tax_paid_itc_iamt: 0, tax_paid_itc_camt: 35 });
    expect(f.v['9 Interest']).toEqual({ txpyble: 0, txpaid_cash: 3 });
    expect(notes.join('\n')).toMatch(/1 amendment row/);
    expect(notes.join('\n')).toMatch(/No GSTR-1 data for 05\/2024, 06\/2024/);
    const q = gstr9FromSources('2024-25', [{ fp: '062024', quarterly: true, records }], []);
    expect(q.notes.join('\n')).toMatch(/No GSTR-1 data for 09\/2024, 12\/2024, 03\/2025\./);
  });
});

describe('GSTR-9C', () => {
  function sample9c() {
    const g9 = sample9();
    const figures = gstr9Figures(g9);
    const f = blankGstr9c();
    f.v['5A'] = { amt: 6e7 };
    return { g9, figures, ...gstr9cFromGstr9(f, figures, g9) };
  }

  it('takes the annual-return figures from GSTR-9', () => {
    const { form: f, figures } = sample9c();
    expect(figures).toMatchObject({ turnover: 105000, exemptNilNonGst: 5000, taxableTurnover: 100000, netItc: 8980 });
    expect(figures.paid).toEqual({ iamt: 0, camt: 9000, samt: 9000, csamt: 0 });
    expect(f.v['5A'].amt).toBe(6e7);
    expect(f.v['5Q'].amt).toBe(105000);
    expect(f.v['12E'].amt).toBe(8980);
    expect(f.lists['9 Rate']).toEqual([{ rt: 18, rc: 'N', txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 }]);
  });

  it('computes the reconciliation and asks for reasons', () => {
    const { form: f, figures } = sample9c();
    const r = resolveGstr9c(f);
    expect(r['5P'].amt).toBe(6e7);
    expect(r['5R'].amt).toBe(105000 - 6e7);
    expect(r['9P']).toEqual({ txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 });
    expect(r['9R']).toEqual({ iamt: 0, camt: 0, samt: 0, csamt: 0 });
    let errs = validateGstr9c(f, { fy: '2024-25', gstr9: figures }).filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs.some((m) => /table 6/.test(m))).toBe(true);
    expect(errs.some((m) => /table 15/.test(m))).toBe(false); // table 14 left blank (optional)
    f.text['6'] = 'Turnover of other State registrations';
    f.text['8'] = 'Same';
    f.text['13'] = 'ITC not in books';
    errs = validateGstr9c(f, { fy: '2024-25', gstr9: figures }).filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs).toEqual([]);
  });

  it('flags figures that differ from GSTR-9 and wrong rates', () => {
    const { form: f, figures } = sample9c();
    f.v['5Q'] = { amt: 1 };
    f.lists['9 Rate'].push({ rt: 7, rc: 'N', txval: 100, iamt: 0, camt: 50, samt: 50, csamt: 0 });
    const all = validateGstr9c(f, { fy: '2024-25', gstr9: figures }).map((i) => i.message).join('\n');
    expect(all).toMatch(/5Q: .* differs from the total turnover/);
    expect(all).toMatch(/7% is not a GST rate/);
    expect(all).toMatch(/tax ₹100.00 is not 7%/);
  });

  it('round-trips its JSON and the Excel template', async () => {
    const { form: f } = sample9c();
    f.text['6'] = 'Line one\nline two';
    expect(fromGstr9cJson(JSON.parse(JSON.stringify(gstr9cJson(f, 'G', '2024-25'))))!.form).toEqual(f);
    expect(fromGstr9cJson(blank9cGstn())).toBeNull();
    const { annualWorkbook } = await import('./excel');
    const res = parseAnnualExcel(GSTR9C_TABLES, await readWorkbook(await annualWorkbook(GSTR9C_TABLES, f, 'GSTR-9C test')), 'GSTR-9C');
    expect(res.issues).toEqual([]);
    expect(res.form).toEqual(f);
  });
});

const blank9cGstn = () => ({ gstin: 'X', table5: {} });
