import { describe, expect, it } from 'vitest';
import { R_MH, SUPPLIER } from '../../scripts/sample-workbook';
import {
  blankRecordData, generateGstr1Json, parseGstr1Tables, profileForPeriod, recomputeRecordTax, validateGstr1Json, validateReturn,
  type AnyRecord, type ReturnContext, type SheetTable,
} from './index';
import { originalMonth } from './excel/parseGstr1';

/* Offline tool template V2.2 layout: summary rows 1–3, column headers on row 4, data from row 5. */
const sheet = (name: string, headers: string[], ...rows: unknown[][]): SheetTable => ({
  name, rows: [[`Summary For ${name}`], ['No. of …'], [1], headers, ...rows],
});

const FP = '082025';
const ctx: ReturnContext = { supplierGstin: SUPPLIER, fp: FP, aatoAbove5Cr: false, profile: profileForPeriod(FP) };

const tables: SheetTable[] = [
  sheet('b2ba', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Original Invoice Number', 'Original Invoice date', 'Revised Invoice Number', 'Revised Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
    [R_MH, 'R Traders', 'INV-10', '12-Jun-2025', 'INV-10A', '12-Jun-2025', 11800, '27-Maharashtra', 'N', null, 'Regular B2B', null, 18, 10000, 0]),
  sheet('b2cla', ['Original Invoice Number', 'Original Invoice date', 'Original Place Of Supply', 'Revised Invoice Number', 'Revised Invoice date', 'Invoice Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    ['L-5', '02-Jul-2025', '27-Maharashtra', 'L-5', '02-Jul-2025', 236000, null, 18, 200000, 0, null]),
  sheet('b2csa', ['Financial Year', 'Original Month', 'Place Of Supply', 'Type', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    ['2025-26', 'JUNE', '27-Maharashtra', 'OE', null, 18, 5000, 0, null],
    ['2025-26', 'JUNE', '27-Maharashtra', 'OE', null, 12, 1000, 0, null],
    ['2025-26', 'JULY', '29-Karnataka', 'OE', null, 5, 800, 0, null]),
  sheet('cdnra', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Original Note Number', 'Original Note Date', 'Revised Note Number', 'Revised Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    [R_MH, 'R', 'CN-1', '20-Jun-2025', 'CN-1', '20-Jun-2025', 'C', '27-Maharashtra', 'N', 'Regular B2B', 1180, null, 18, 1000, 0]),
  sheet('cdnura', ['UR Type', 'Original Note Number', 'Original Note Date', 'Revised Note Number', 'Revised Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    ['B2CL', 'UN-1', '15-Jul-2025', 'UN-1', '15-Jul-2025', 'C', '27-Maharashtra', 1180, null, 18, 1000, 0]),
  sheet('expa', ['Export Type', 'Original Invoice Number', 'Original Invoice date', 'Revised Invoice Number', 'Revised Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value', 'Cess Amount'],
    ['WOPAY', 'E-1', '10-Jul-2025', 'E-1', '10-Jul-2025', 50000, 'INBOM4', '1234567', '11-Jul-2025', 0.1, 50000, 0]),
  sheet('ata', ['Financial Year', 'Original Month', 'Original Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Received', 'Cess Amount'],
    ['2025-26', 'JULY', '29-Karnataka', null, 18, 10000, 0]),
  sheet('atadja', ['Financial Year', 'Original Month', 'Original Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Adjusted', 'Cess Amount'],
    ['2025-26', 'JULY', '29-Karnataka', null, 18, 4000, 0]),
];

describe('GSTR-1 amendments', () => {
  const parsed = parseGstr1Tables(tables, { supplierGstin: SUPPLIER, hsnSplit: true });
  const of = (s: string) => parsed.records.filter((r) => r.section === s);

  it('converts financial year + month name to the original period', () => {
    expect(originalMonth('2025-26', 'JUNE')).toBe('062025');
    expect(originalMonth('2025-26', 'JANUARY')).toBe('012026');
    expect(originalMonth('2025-26', 'Feb')).toBe('022026');
  });

  it('imports every amendment sheet of the offline-tool template', () => {
    expect(parsed.sheetsSkipped).toEqual([]);
    expect(parsed.sheetsParsed.map((s) => s.section)).toEqual(['b2ba', 'b2cla', 'b2csa', 'cdnra', 'cdnura', 'expa', 'ata', 'txpda']);
    expect(of('b2ba')[0].data).toMatchObject({ oinum: 'INV-10', oidt: '2025-06-12', inum: 'INV-10A', idt: '2025-06-12', invTyp: 'R', items: [{ rt: 18, txval: 10000, iamt: 1800 }] });
    expect(of('b2csa').map((r) => (r.data as { omon: string }).omon)).toEqual(['062025', '062025', '072025']);
    expect(of('cdnra')[0].data).toMatchObject({ ontNum: 'CN-1', ntNum: 'CN-1', ntty: 'C' });
    expect(of('txpda')[0].data).toMatchObject({ omon: '072025', items: [{ adAmt: 4000 }] });
  });

  it('validates cleanly and produces schema-valid JSON in the GSTN amendment structure', () => {
    const { issues } = validateReturn(parsed.records, ctx);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { json } = generateGstr1Json(parsed.records, ctx);
    const check = validateGstr1Json(json);
    expect(check.errors).toEqual([]);
    expect(json.b2ba).toEqual([{ ctin: R_MH, inv: [expect.objectContaining({ oinum: 'INV-10', oidt: '12-06-2025', inum: 'INV-10A', idt: '12-06-2025', inv_typ: 'R', itms: [{ num: 1801, itm_det: { txval: 10000, rt: 18, iamt: 1800, csamt: 0 } }] })] }]);
    expect(json.b2cla).toEqual([{ pos: '27', inv: [expect.objectContaining({ oinum: 'L-5', inum: 'L-5' })] }]);
    // B2CSA: one object per original month + POS + type, holding every rate
    const b2csa = json.b2csa as { omon: string; pos: string; sply_ty: string; itms: { rt: number }[] }[];
    expect(b2csa).toHaveLength(2);
    expect(b2csa.find((x) => x.omon === '062025')).toMatchObject({ pos: '27', sply_ty: 'INTER', typ: 'OE', itms: [{ rt: 18, txval: 5000, iamt: 900, csamt: 0 }, { rt: 12, txval: 1000, iamt: 120, csamt: 0 }] });
    expect(b2csa.find((x) => x.omon === '072025')).toMatchObject({ sply_ty: 'INTRA', itms: [{ rt: 5, txval: 800, camt: 20, samt: 20, csamt: 0 }] });
    expect(json.cdnra).toEqual([{ ctin: R_MH, nt: [expect.objectContaining({ ont_num: 'CN-1', ont_dt: '20-06-2025', nt_num: 'CN-1', ntty: 'C', inv_typ: 'R' })] }]);
    expect(json.cdnura).toEqual([expect.objectContaining({ typ: 'B2CL', ont_num: 'UN-1', pos: '27' })]);
    expect(json.expa).toEqual([{ exp_typ: 'WOPAY', inv: [expect.objectContaining({ oinum: 'E-1', sbpcode: 'INBOM4', itms: [{ txval: 50000, rt: 0.1, iamt: 0, csamt: 0 }] })] }]);
    expect(json.ata).toEqual([{ omon: '072025', pos: '29', sply_ty: 'INTRA', itms: [{ rt: 18, ad_amt: 10000, camt: 900, samt: 900, csamt: 0 }] }]);
    expect(json.txpda).toHaveLength(1);
  });

  it('rejects amending a document of this same period or a future original month', () => {
    const bad: AnyRecord[] = [
      { ...of('b2ba')[0], data: { ...of('b2ba')[0].data, oidt: '2025-08-05' } } as AnyRecord,
      { ...of('ata')[0], data: { ...of('ata')[0].data, omon: '082025' } } as AnyRecord,
    ];
    const msgs = validateReturn(bad, ctx).issues.filter((i) => i.severity === 'error').map((i) => i.field);
    expect(msgs).toEqual(expect.arrayContaining(['oidt', 'omon']));
  });

  it('manual entry: blank amendment records can be filled and taxed', () => {
    const blank = blankRecordData('b2csa', '29');
    expect(blank).toMatchObject({ omon: '', typ: 'OE', pos: '29' });
    const rec = recomputeRecordTax({ section: 'b2csa', key: 'k', source: { sheet: 'manual', rows: [] }, data: { ...blank, omon: '062025', pos: '27', rt: 18, txval: 100 } } as AnyRecord, SUPPLIER);
    expect(rec.data).toMatchObject({ iamt: 18, camt: 0 });
    expect(validateReturn([rec], ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
