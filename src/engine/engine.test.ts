import { describe, expect, it } from 'vitest';
import { buildSampleWorkbook, R_KA, R_MH, SUPPLIER } from '../../scripts/sample-workbook';
import {
  checkGstin, generateGstr1Json, parseDate, parseGstr1Tables, parsePortalErrorReport, profileForPeriod,
  readWorkbook, validateGstr1Json, validateReturn, type ReturnContext,
} from './index';

const ctx = (): ReturnContext => ({ supplierGstin: SUPPLIER, fp: '062025', aatoAbove5Cr: false, profile: profileForPeriod('062025') });

async function load(withErrors: boolean) {
  const tables = await readWorkbook(await buildSampleWorkbook(withErrors));
  return parseGstr1Tables(tables, { supplierGstin: SUPPLIER, hsnSplit: true });
}

describe('utils', () => {
  it('validates GSTIN check digit', () => {
    expect(checkGstin(SUPPLIER).ok).toBe(true);
    expect(checkGstin(R_MH).ok).toBe(true);
    expect(checkGstin('27AAACR5055K1ZX').ok).toBe(false);
    expect(checkGstin('ABC').ok).toBe(false);
  });
  it('parses portal/excel date styles', () => {
    expect(parseDate('05-Jun-2025')).toBe('2025-06-05');
    expect(parseDate('05-Jun-25')).toBe('2025-06-05');
    expect(parseDate('31/12/2025')).toBe('2025-12-31');
    expect(parseDate('31-02-2025')).toBeNull();
    expect(parseDate(new Date(Date.UTC(2025, 5, 5)))).toBe('2025-06-05');
  });
  it('picks format profile by period', () => {
    expect(profileForPeriod('042025').hsnSplit).toBe(false);
    expect(profileForPeriod('062025').hsnSplit).toBe(true);
    expect(profileForPeriod('102025').allowedRates).toContain(40);
  });
});

describe('parser', () => {
  it('reads offline-template sheets, groups rate rows, computes tax', async () => {
    const res = await load(false);
    expect(res.sheetsSkipped.map((s) => s.sheet)).toContain('b2ba');
    const b2b = res.records.filter((r) => r.section === 'b2b');
    expect(b2b).toHaveLength(5);
    const inv2 = b2b.find((r) => r.section === 'b2b' && r.data.inum === 'INV/002')!;
    expect(inv2.data).toMatchObject({ ctin: R_KA, pos: '29', idt: '2025-06-10' });
    if (inv2.section !== 'b2b') throw new Error();
    expect(inv2.data.items).toHaveLength(2);
    expect(inv2.data.items[0]).toMatchObject({ rt: 12, txval: 10000, camt: 600, samt: 600, iamt: 0 });
    const inv1 = b2b.find((r) => r.section === 'b2b' && r.data.inum === 'INV/001')!;
    if (inv1.section !== 'b2b') throw new Error();
    expect(inv1.data.items[0]).toMatchObject({ iamt: 3600, camt: 0 });
  });
});

describe('validation', () => {
  it('passes the clean workbook with no errors', async () => {
    const res = await load(false);
    const { issues, summary } = validateReturn(res.records, ctx());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(summary.valid).toBe(summary.total);
  });

  it('catches injected mistakes with row/field/suggestion', async () => {
    const res = await load(true);
    const { issues, summary } = validateReturn(res.records, ctx());
    const codes = issues.filter((i) => i.severity === 'error').map((i) => `${i.section}:${i.field}:${i.documentNo ?? ''}`);
    expect(codes).toContain('b2b:ctin:INV/003'); // bad check digit
    expect(codes).toContain('b2b:idt:INV/005'); // after period
    expect(codes).toContain('b2b:items[0].rt:INV/005'); // invalid rate
    expect(codes).toContain('b2cl:val:B2CL/02'); // below threshold
    expect(codes).toContain('hsn_b2b:uqc:998314'); // SAC with NOS
    expect(issues.some((i) => i.code === 'DUPLICATE_DOCUMENT')).toBe(true);
    const ctinErr = issues.find((i) => i.field === 'ctin' && i.documentNo === 'INV/003')!;
    expect(ctinErr.row).toBeGreaterThan(4);
    expect(ctinErr.suggestion).toBeTruthy();
    expect(summary.withErrors).toBeGreaterThan(0);
    expect(summary.valid + summary.withErrors).toBe(summary.total);
  });
});

describe('json generator', () => {
  it('produces schema-valid GSTR-1 JSON', async () => {
    const res = await load(false);
    const { json, log } = generateGstr1Json(res.records, ctx());
    const check = validateGstr1Json(json);
    expect(check.errors).toEqual([]);
    expect(json).toMatchObject({ gstin: SUPPLIER, fp: '062025', version: 'GST3.2.2' });
    const b2b = json.b2b as { ctin: string; inv: { inum: string; idt: string; itms: { num: number; itm_det: Record<string, number> }[] }[] }[];
    const ka = b2b.find((x) => x.ctin === R_KA)!;
    expect(ka.inv[0]).toMatchObject({ inum: 'INV/002', idt: '10-06-2025' });
    expect(ka.inv[0].itms[0]).toEqual({ num: 1201, itm_det: { txval: 10000, rt: 12, camt: 600, samt: 600, csamt: 0 } });
    expect((json.hsn as Record<string, unknown[]>).hsn_b2b).toHaveLength(3);
    expect(log.sections.b2b.documents).toBe(5);
  });

  it('uses single hsn.data before the split profile', async () => {
    const res = await load(false);
    const c = { ...ctx(), fp: '042025', profile: profileForPeriod('042025') };
    const { json } = generateGstr1Json(res.records, c);
    expect(Object.keys(json.hsn as object)).toEqual(['data']);
  });
});

describe('portal error report', () => {
  it('extracts errors with document numbers', () => {
    const errs = parsePortalErrorReport({
      gstin: SUPPLIER, fp: '062025',
      error_report: { b2b: [{ ctin: R_MH, inv: [{ inum: 'INV/001', error_msg: 'Invoice already exists', error_cd: 'RET191106' }] }] },
    });
    expect(errs).toEqual([expect.objectContaining({ section: 'b2b', ctin: R_MH, documentNo: 'INV/001', errorCode: 'RET191106' })]);
  });
});
