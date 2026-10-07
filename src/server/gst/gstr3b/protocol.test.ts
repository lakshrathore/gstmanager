import { describe, expect, it } from 'vitest';
import {
  blankForm, fromAutoLiability, isNilForm, isOffset, itcAvailable, itcNet, liabilityRows, normalizeForm, offsetBody,
  parseLedger, planOffset, saveBody, suggestItcUse, type LiabilityRow,
} from './protocol';

const row = (trans_typ: number, tx: { igst?: number; cgst?: number; sgst?: number; cess?: number }, extra: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', { intr?: number; fee?: number }>> = {}): LiabilityRow => {
  const c = (k: 'igst' | 'cgst' | 'sgst' | 'cess') => ({ tx: tx[k] ?? 0, intr: extra[k]?.intr ?? 0, fee: extra[k]?.fee ?? 0 });
  return { trans_typ, trans_desc: trans_typ === 30002 ? 'Other than reverse charge' : 'Reverse charge', liab_ldg_id: trans_typ * 10, igst: c('igst'), cgst: c('cgst'), sgst: c('sgst'), cess: c('cess') };
};

const ledger = (itc: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', number>>, cash: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', number>> = {}) => parseLedger({
  cash_bal: Object.fromEntries(['igst', 'cgst', 'sgst', 'cess'].flatMap((k) => [[k, { tx: cash[k as 'igst'] ?? 0 }], [`${k}_tot_bal`, cash[k as 'igst'] ?? 0]])),
  itc_bal: { igst_bal: itc.igst ?? 0, cgst_bal: itc.cgst ?? 0, sgst_bal: itc.sgst ?? 0, cess_bal: itc.cess ?? 0 },
});

describe('form', () => {
  it('normalises GSTN details into every table, keeping only each table’s columns', () => {
    const f = normalizeForm({
      sup_details: { osup_det: { txval: '100.005', iamt: 18, camt: 'x' }, osup_zero: { txval: 5, camt: 9 } },
      inter_sup: { unreg_details: [{ pos: '7', txval: 10, iamt: 1.8 }, { pos: '', txval: 0, iamt: 0 }] },
      itc_elg: { itc_avl: [{ ty: 'OTH', iamt: 50, camt: 5, samt: 5, csamt: 0 }], itc_rev: [{ ty: 'RUL', iamt: 10 }] },
    });
    expect(f.sup_details.osup_det).toEqual({ txval: 100.01, iamt: 18, camt: 0, samt: 0, csamt: 0 });
    expect(f.sup_details.osup_zero).toEqual({ txval: 5, iamt: 0, csamt: 0 });
    expect(f.inter_sup.unreg_details).toEqual([{ pos: '07', txval: 10, iamt: 1.8 }]);
    expect(f.itc_elg.itc_avl.map((r) => r.ty)).toEqual(['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH']);
    expect(itcNet(f)).toEqual({ iamt: 40, camt: 5, samt: 5, csamt: 0 });
    expect(saveBody(f, '29AAACQ3770E000', '122023').itc_elg.itc_net).toEqual({ iamt: 40, camt: 5, samt: 5, csamt: 0 });
  });

  it('detects a nil return', () => {
    expect(isNilForm(blankForm())).toBe(true);
    const f = blankForm();
    f.sup_details.osup_nil_exmp.txval = 1;
    expect(isNilForm(f)).toBe(false);
  });

  it('maps GSTN’s auto-calculated liability onto the 3B tables', () => {
    const a = fromAutoLiability({
      r3bautopop: {
        r1fildt: '09-01-2024', r2bgendt: '14-01-2024',
        liabitc: {
          sup_details: { osup_3_1a: { subtotal: { txval: 1346200.68, iamt: 237746.41, camt: 2284.92, samt: 2284.92, csamt: 0 } }, osup_3_1c: { subtotal: { txval: 7 } } },
          inter_sup: { osup_unreg_3_2: { subtotal: [{ iamt: 5596.26, pos: '10', txval: 31090.3 }, { iamt: 0, pos: '', txval: 0 }] } },
          elgitc: { itc4a5: { subtotal: { camt: 5550.22, csamt: 0, iamt: -62029.62, samt: 5550.22 } }, itc4d2: { subtotal: { iamt: 3 } } },
        },
      },
    });
    expect(a.gstr1FiledOn).toBe('09-01-2024');
    expect(a.form.sup_details.osup_det.iamt).toBe(237746.41);
    expect(a.form.sup_details.osup_nil_exmp.txval).toBe(7);
    expect(a.form.inter_sup.unreg_details).toEqual([{ pos: '10', txval: 31090.3, iamt: 5596.26 }]);
    expect(a.form.itc_elg.itc_avl.find((r) => r.ty === 'OTH')).toEqual({ ty: 'OTH', iamt: -62029.62, camt: 5550.22, samt: 5550.22, csamt: 0 });
    expect(a.form.itc_elg.itc_inelg.find((r) => r.ty === 'OTH')?.iamt).toBe(3);
  });
});

describe('ledger and liability', () => {
  it('reads the cash and credit ledger balance', () => {
    const l = parseLedger({
      cash_bal: { igst: { tx: 100, intr: 5, fee: 0, pen: 0, oth: 0 }, igst_tot_bal: 105 },
      itc_bal: { igst_bal: 1000, cgst_bal: 20 }, itc_blck_bal: { cgst_blck_bal: 4 },
    });
    expect(l.cash.igst).toEqual({ tx: 100, intr: 5, fee: 0, pen: 0, oth: 0, total: 105 });
    expect(l.cash.cgst.total).toBe(0);
    expect(l.itc).toEqual({ igst: 1000, cgst: 20, sgst: 0, cess: 0 });
    expect(l.blocked.cgst).toBe(4);
    expect(itcAvailable(l, { iamt: 10.6, camt: 0, samt: 1, csamt: 0 })).toEqual({ igst: 1010, cgst: 20, sgst: 1, cess: 0 });
  });

  it('reads tax payable rows and detects a completed set-off', () => {
    const details = {
      tx_pmt: {
        net_tax_pay: [{ trans_typ: 30002, tran_desc: 'Other than Reverse Charge', liab_ldg_id: 649677714, igst: { tx: 237746.43, intr: 0, fee: 0 }, cgst: { tx: 10 } }],
        pdcash: [{ liab_ldg_id: 649677714, trans_typ: 30002, ipd: 0 }], pditc: { liab_ldg_id: 1, trans_typ: 30002, i_pdi: 0 },
      },
    };
    expect(liabilityRows(details)).toEqual([{
      trans_typ: 30002, trans_desc: 'Other than Reverse Charge', liab_ldg_id: 649677714,
      igst: { tx: 237746, intr: 0, fee: 0 }, cgst: { tx: 10, intr: 0, fee: 0 }, sgst: { tx: 0, intr: 0, fee: 0 }, cess: { tx: 0, intr: 0, fee: 0 },
    }]);
    expect(isOffset(details)).toBe(false);
    expect(isOffset({ tx_pmt: { pdcash: [{ liab_ldg_id: 1, trans_typ: 30002, ipd: 165147 }] } })).toBe(true);
  });
});

describe('set-off', () => {
  it('uses IGST credit on IGST first, then on CGST/SGST, before CGST/SGST credit', () => {
    const rows = [row(30002, { igst: 100, cgst: 50, sgst: 50 })];
    const u = suggestItcUse(rows, { igst: 160, cgst: 40, sgst: 40, cess: 0 });
    expect(u.i_pdi).toBe(100);
    expect(u.i_pdc + u.i_pds).toBe(60); // IGST credit fully used
    expect(u.i_pdc + u.c_pdc).toBe(50);
    expect(u.i_pds + u.s_pds).toBe(50);
    const plan = planOffset(rows, ledger({ igst: 160, cgst: 40, sgst: 40 }), { igst: 160, cgst: 40, sgst: 40, cess: 0 }, u);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.cashNeeded).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(plan.itcLeft).toEqual({ igst: 0, cgst: 20, sgst: 20, cess: 0 });
  });

  it('pays the IGST balance with CGST and SGST credit when IGST credit is short', () => {
    const rows = [row(30002, { igst: 100, cgst: 10, sgst: 10 })];
    const u = suggestItcUse(rows, { igst: 30, cgst: 50, sgst: 50, cess: 0 });
    expect(u).toMatchObject({ i_pdi: 30, i_pdc: 0, i_pds: 0, c_pdc: 10, c_pdi: 40, s_pds: 10, s_pdi: 30 });
  });

  it('puts reverse charge, interest and late fee in cash and reports the shortfall', () => {
    const rows = [row(30002, { igst: 100 }, { cgst: { intr: 3, fee: 25 }, sgst: { fee: 25 } }), row(30003, { cgst: 9, sgst: 9 })];
    const itc = { igst: 60, cgst: 0, sgst: 0, cess: 0 };
    const l = ledger(itc, { igst: 10, cgst: 20, sgst: 40 });
    const plan = planOffset(rows, l, itc, suggestItcUse(rows, itc));
    expect(plan.cash[0]).toMatchObject({ ipd: 40, c_intrpd: 3, c_lfeepd: 25, s_lfeepd: 25 });
    expect(plan.cash[1]).toMatchObject({ cpd: 9, spd: 9 });
    expect(plan.cashNeeded).toEqual({ igst: 40, cgst: 37, sgst: 34, cess: 0 });
    expect(plan.shortfall).toEqual({ igst: 30, cgst: 17, sgst: 0, cess: 0 });
    const body = offsetBody(rows, plan);
    expect(body.pditc).toMatchObject({ liab_ldg_id: 300020, trans_typ: 30002, i_pdi: 60 });
    expect(body.nettaxpay[1]).toMatchObject({ trans_typ: 30003, trans_desc: 'Reverse charge' });
  });

  it('rejects using more credit than available or than payable', () => {
    const rows = [row(30002, { igst: 10 })];
    const itc = { igst: 5, cgst: 0, sgst: 0, cess: 0 };
    const plan = planOffset(rows, ledger(itc), itc, { i_pdi: 20, i_pdc: 0, i_pds: 0, c_pdi: 0, c_pdc: 0, s_pdi: 0, s_pds: 0, cs_pdcs: 0 });
    expect(plan.errors.length).toBe(2);
  });
});
