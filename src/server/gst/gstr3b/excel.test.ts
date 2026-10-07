import { describe, expect, it, vi } from 'vitest';
import { readWorkbook } from '@/engine';
import { STATE_CODES } from '@/engine/masters';
import { blankForm, parseGstr3bExcel, posCode } from './protocol';

vi.mock('server-only', () => ({}));

describe('GSTR-3B Excel', () => {
  it('round-trips the template: download → read → same tables', async () => {
    const { gstr3bWorkbook } = await import('./excel');
    const f = blankForm();
    f.sup_details.osup_det = { txval: 100000, iamt: 9000, camt: 4500, samt: 4500, csamt: 0 };
    f.sup_details.osup_nil_exmp = { txval: 2500.5 };
    f.inter_sup.unreg_details = [{ pos: '29', txval: 50000, iamt: 9000 }];
    f.itc_elg.itc_avl = f.itc_elg.itc_avl.map((r) => (r.ty === 'OTH' ? { ...r, iamt: 3000, camt: 1000, samt: 1000 } : r));
    f.itc_elg.itc_rev = f.itc_elg.itc_rev.map((r) => (r.ty === 'RUL' ? { ...r, camt: 100, samt: 100 } : r));
    f.inward_sup.isup_details = [{ ty: 'GST', inter: 10, intra: 20 }, { ty: 'NONGST', inter: 0, intra: 5 }];
    f.intr_ltfee.ltfee_details = { iamt: 0, camt: 25, samt: 25, csamt: 0 };
    const buf = await gstr3bWorkbook(f, 'GSTR-3B test');
    const res = parseGstr3bExcel(await readWorkbook(buf), STATE_CODES);
    expect(res.issues).toEqual([]);
    expect(res.form).toEqual(f);
    expect(res.read).toEqual({ tables: 18, interState: 1, inward: 2 });
  });

  it('reads typed sheets with loose codes, Indian number formats and state names', () => {
    const res = parseGstr3bExcel([
      { name: 'Main', rows: [['Table', 'Nature', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'], ['3.1 (a)', '', '1,23,456.78', '₹ 1,000', 500, 500, ''], ['4A(5)', '', null, 200, '(50)', 0, 0], ['Total', '', 1, 1, 1, 1, 1]] },
      { name: '3.2', rows: [['Type', 'Place of Supply', 'Taxable value', 'IGST'], ['Unregistered', 'Karnataka', 100, 18], ['unregistered persons', '29-Karnataka', 50, 9], ['Composition', '27', 10, 1.8]] },
    ], STATE_CODES);
    expect(res.issues).toEqual([]);
    expect(res.form.sup_details.osup_det).toEqual({ txval: 123456.78, iamt: 1000, camt: 500, samt: 500, csamt: 0 });
    expect(res.form.itc_elg.itc_avl.find((r) => r.ty === 'OTH')).toEqual({ ty: 'OTH', iamt: 200, camt: -50, samt: 0, csamt: 0 });
    expect(res.form.inter_sup.unreg_details).toEqual([{ pos: '29', txval: 150, iamt: 27 }]);
    expect(res.form.inter_sup.comp_details).toEqual([{ pos: '27', txval: 10, iamt: 1.8 }]);
  });

  it('reports what it cannot read instead of guessing', () => {
    const res = parseGstr3bExcel([
      { name: 'Main', rows: [['Code', 'Description', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'], ['3.1(c)', '', 10, 5, 0, 0, 0], ['3.1(a)', '', 'abc', 0, 0, 0, 0]] },
      { name: '3.2', rows: [['Type', 'Place of supply', 'Taxable value', 'IGST'], ['Unregistered persons', '96', 1, 1], ['Someone', '29', 1, 1]] },
    ], STATE_CODES);
    expect(res.form.sup_details.osup_nil_exmp).toEqual({ txval: 10 });
    expect(res.form.sup_details.osup_det.txval).toBe(0);
    expect(res.issues).toHaveLength(4);
    expect(parseGstr3bExcel([{ name: 'x', rows: [['a', 'b']] }], STATE_CODES).issues[0]).toMatch(/No GSTR-3B rows/);
  });

  it('accepts place of supply as code, number or name', () => {
    expect(posCode(7, STATE_CODES)).toBe('07');
    expect(posCode('29-Karnataka', STATE_CODES)).toBe('29');
    expect(posCode('96', STATE_CODES)).toBeNull();
    expect(posCode('Nowhere', STATE_CODES)).toBeNull();
  });
});
