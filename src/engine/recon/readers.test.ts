import { describe, expect, it } from 'vitest';
import { R_KA, R_MH, SUPPLIER } from '../../../scripts/sample-workbook';
import type { SheetTable } from '../excel/parseGstr1';
import { readPortalJson, readPortalTables, readPurchaseRegister, reconcile } from './index';
import { periodOf } from './portal';

/*
 * Fixtures follow the layouts of the GST portal downloads: GSTR-2A JSON (b2b / cdn with itms[].itm_det),
 * GSTR-2B JSON before Oct-2024 (items[]) and after (invoice-level totals), and the Excel downloads with
 * their merged multi-row headers (B2BA lists the original invoice before the revised one).
 */

const gstr2a = {
  gstin: SUPPLIER, fp: '062025',
  b2b: [{
    ctin: R_MH, cfs: 'Y', cfs3b: 'Y', fldtr1: '11-Jul-25', flprdr1: 'Jun-25', dtcancel: '',
    inv: [{ inum: 'INV-9', idt: '05-06-2025', val: 14000, pos: '29', rchrg: 'N', inv_typ: 'R', itms: [
      { num: 1801, itm_det: { rt: 18, txval: 10000, iamt: 1800, camt: 0, samt: 0, csamt: 0 } },
      { num: 501, itm_det: { rt: 5, txval: 2000, iamt: 100, camt: 0, samt: 0, csamt: 0 } },
    ] }],
  }],
  cdn: [{ ctin: R_MH, cfs: 'N', nt: [{ ntty: 'C', nt_num: 'CN-3', nt_dt: '20-06-2025', val: 1180, pos: '29', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 18, txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } }] }] }],
  tds: [{ gstin_ded: R_KA, amt_ded: 100 }],
};

const gstr2bOld = {
  chksum: 'x',
  data: {
    gstin: SUPPLIER, rtnprd: '062025', gendt: '14-07-2025',
    docdata: {
      b2b: [{ ctin: R_KA, trdnm: 'B Corp', supfildt: '11-07-2025', supprd: '062025', inv: [
        { inum: 'B-100', typ: 'R', dt: '02-06-2025', val: 1180, pos: '29', rev: 'N', itcavl: 'Y', rsn: '', items: [{ num: 1, rt: 18, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] },
        { inum: 'B-101', typ: 'R', dt: '03-06-2025', val: 590, pos: '29', rev: 'Y', itcavl: 'N', rsn: 'P', items: [{ num: 1, rt: 18, txval: 500, igst: 0, cgst: 45, sgst: 45, cess: 0 }] },
      ] }],
      b2ba: [{ ctin: R_KA, trdnm: 'B Corp', supprd: '062025', inv: [{ oinum: 'B-090', oidt: '15-05-2025', inum: 'B-090R', typ: 'R', dt: '15-05-2025', val: 236, pos: '29', rev: 'N', itcavl: 'Y', items: [{ num: 1, rt: 18, txval: 200, igst: 0, cgst: 18, sgst: 18, cess: 0 }] }] }],
      cdnr: [{ ctin: R_KA, trdnm: 'B Corp', supprd: '062025', nt: [{ ntnum: 'D-1', typ: 'D', suptyp: 'R', dt: '10-06-2025', val: 118, pos: '29', rev: 'N', itcavl: 'Y', items: [{ num: 1, rt: 18, txval: 100, igst: 0, cgst: 9, sgst: 9, cess: 0 }] }] }],
      isd: [{ ctin: R_KA, doclist: [{ doctyp: 'ISDI', docnum: 'I1', igst: 10 }] }],
    },
  },
};

const gstr2bNew = { data: { gstin: SUPPLIER, rtnprd: '062025', docdata: { b2b: [{ ctin: R_MH, supprd: '062025', inv: [{ inum: 'M-1', dt: '04-06-2025', val: 1180, pos: '29', rev: 'N', itcavl: 'Y', txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, imsStatus: 'N' }] }] } } };

describe('portal JSON', () => {
  it('GSTR-2A: rate items summed, notes from "cdn", supplier filing status', () => {
    const r = readPortalJson(gstr2a, 'gstr2a', '2a.json', '062025');
    const inv = r.docs.find((d) => d.docNo === 'INV-9')!;
    expect(inv).toMatchObject({ docType: 'INV', taxable: 12000, igst: 1900, docDate: '2025-06-05', supplierPeriod: '062025', supplierFiled: true, supplierFilingDate: '2025-07-11' });
    expect(r.docs.find((d) => d.docNo === 'CN-3')).toMatchObject({ docType: 'CN', taxable: 1000, supplierFiled: false });
    expect(r.notes.join(' ')).toMatch(/tds/);
  });
  it('GSTR-2B before Oct-2024: items[], ITC availability + reason, amendments, debit notes', () => {
    const r = readPortalJson(gstr2bOld, 'gstr2b', '2b.json', '062025');
    expect(r.docs).toHaveLength(4);
    expect(r.docs.find((d) => d.docNo === 'B-100')).toMatchObject({ taxable: 1000, cgst: 90, sgst: 90, itcAvailable: true, supplierName: 'B Corp' });
    expect(r.docs.find((d) => d.docNo === 'B-101')).toMatchObject({ itcAvailable: false, rcm: true, itcReason: expect.stringMatching(/POS and supplier state/) });
    expect(r.docs.find((d) => d.docNo === 'B-090R')).toMatchObject({ amended: true, originalDocNo: 'B-090' });
    expect(r.docs.find((d) => d.docNo === 'D-1')).toMatchObject({ docType: 'DN', taxable: 100 });
    expect(r.notes.join(' ')).toMatch(/isd/);
  });
  it('GSTR-2B from Oct-2024: invoice-level totals', () => {
    const r = readPortalJson(gstr2bNew, 'gstr2b', '2b.json', '062025');
    expect(r.docs[0]).toMatchObject({ docNo: 'M-1', taxable: 1000, igst: 180 });
  });
  it('supplier period formats', () => {
    expect(periodOf('Jun-25')).toBe('062025');
    expect(periodOf("Jun'25")).toBe('062025');
    expect(periodOf('062025')).toBe('062025');
  });
});

describe('portal Excel', () => {
  const title = (n: number) => Array.from({ length: n }, () => 'Goods and Services Tax - GSTR-2B');
  it('GSTR-2B B2B with two-row headers and B2BA with original-then-revised columns', () => {
    const b2b: SheetTable = {
      name: 'B2B',
      rows: [title(5), [], [], ['Taxable inward supplies received from registered persons'],
        ['GSTIN of supplier', 'Trade/Legal name', 'Invoice Details', 'Invoice Details', 'Invoice Details', 'Invoice Details', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Tax Amount', 'Tax Amount', 'Tax Amount', 'Tax Amount', 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason'],
        ['GSTIN of supplier', 'Trade/Legal name', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason'],
        [R_MH, 'R Traders', 'INV/001/25-26', 'Regular', '05/06/2025', 11800, 'Karnataka', 'No', 10000, 1800, 0, 0, 0, "Jun'25", '11/07/2025', 'Yes', ''],
      ],
    };
    const b2ba: SheetTable = {
      name: 'B2BA',
      rows: [title(5), [], [], ['Amendments to previously filed invoices by supplier'],
        ['Original Details', 'Original Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details', 'Revised Details'],
        ['Invoice number', 'Invoice Date', 'GSTIN of supplier', 'Trade/Legal name', 'Invoice Details', 'Invoice Details', 'Invoice Details', 'Invoice Details', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Tax Amount', 'Tax Amount', 'Tax Amount', 'Tax Amount'],
        ['Invoice number', 'Invoice Date', 'GSTIN of supplier', 'Trade/Legal name', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
        ['OLD-77', '01/04/2025', R_KA, 'B Corp', 'NEW-77', 'Regular', '02/04/2025', 2360, 'Karnataka', 'No', 2000, 0, 180, 180, 0],
      ],
    };
    const r = readPortalTables([b2b, b2ba, { name: 'ITC Available', rows: [['Summary']] }], 'gstr2b', '2b.xlsx', '062025');
    expect(r.docs).toHaveLength(2);
    expect(r.docs[0]).toMatchObject({ docNo: 'INV/001/25-26', taxable: 10000, igst: 1800, docDate: '2025-06-05', pos: '29', rcm: false, itcAvailable: true, supplierPeriod: '062025' });
    expect(r.docs[1]).toMatchObject({ docNo: 'NEW-77', originalDocNo: 'OLD-77', amended: true, docDate: '2025-04-02', cgst: 180, sgst: 180 });
    expect(r.notes).toEqual([]);
  });
  it('GSTR-2A B2B with rate-wise rows and CDNR with debit notes', () => {
    const hdr5 = ['GSTIN of supplier', 'Trade/Legal name of the Supplier', 'Invoice details', null, null, null, 'Place of supply', 'Supply Attract Reverse Charge', 'Rate (%)', 'Taxable Value (₹)', 'Tax Amount', null, null, null, 'GSTR-1/IFF/GSTR-1A/5 Filing Status'];
    const hdr6 = [null, null, 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value (₹)', null, null, null, null, 'Integrated Tax  (₹)', 'Central Tax (₹)', 'State/UT tax (₹)', 'Cess  (₹)', null];
    const b2b: SheetTable = { name: 'B2B', rows: [[], [], [], ['Taxable inward supplies'], hdr5, hdr6,
      [R_MH, 'R', 'INV-9', 'Regular', '05-06-2025', 14000, '29-Karnataka', 'N', 18, 10000, 1800, 0, 0, 0, 'Y'],
      [R_MH, 'R', 'INV-9', 'Regular', '05-06-2025', 14000, '29-Karnataka', 'N', 5, 2000, 100, 0, 0, 0, 'Y']] };
    const cdnr: SheetTable = { name: 'CDNR', rows: [[], [], [], ['Notes'],
      ['GSTIN of Supplier', 'Trade/Legal name of the supplier', 'Credit note/Debit note details', null, null, null, null, 'Place of supply', 'Supply Attract Reverse Charge', 'Rate (%)', 'Taxable Value (₹)', 'Tax Amount', null, null, null],
      [null, null, 'Note type', 'Note number', 'Note Supply type', 'Note  date', 'Note Value (₹)', null, null, null, null, 'Integrated Tax (₹)', 'Central Tax (₹)', 'State Tax (₹)', 'Cess Amount (₹)'],
      [R_MH, 'R', 'Debit Note', 'DN-1', 'Regular', '20-06-2025', 590, '29-Karnataka', 'N', 18, 500, 90, 0, 0, 0]] };
    const r = readPortalTables([b2b, cdnr], 'gstr2a', '2a.xlsx', '062025');
    expect(r.docs.find((d) => d.docNo === 'INV-9')).toMatchObject({ taxable: 12000, igst: 1900, supplierFiled: true });
    expect(r.docs.find((d) => d.docNo === 'DN-1')).toMatchObject({ docType: 'DN', taxable: 500, igst: 90 });
  });
});

describe('books (purchase register)', () => {
  it('reads common column names, sums rate rows, credit notes, computes tax from rate when no tax columns', () => {
    const t: SheetTable = { name: 'Purchase Register', rows: [
      ['Purchase Register – June 2025'],
      ['Date', 'Particulars', 'GSTIN/UIN', 'Supplier Invoice No.', 'Supplier Invoice Date', 'Voucher Type', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State Tax Amount', 'Cess'],
      ['30-06-2025', 'R Traders', R_MH, 'INV/001/25-26', '05-06-2025', 'Purchase', 8000, 1440, 0, 0, 0],
      ['30-06-2025', 'R Traders', R_MH, 'INV/001/25-26', '05-06-2025', 'Purchase', 2000, 360, 0, 0, 0],
      ['30-06-2025', 'B Corp', R_KA, 'CN-77', '20-06-2025', 'Debit Note (Purchase Return)', 100, 0, 9, 9, 0],
      ['', 'Grand Total', '', '', '', '', 10100, 1800, 9, 9, 0],
    ] };
    const r = readPurchaseRegister([t], 'books.xlsx', '062025', SUPPLIER);
    expect(r.docs).toHaveLength(2);
    expect(r.docs[0]).toMatchObject({ docNo: 'INV/001/25-26', docDate: '2025-06-05', taxable: 10000, igst: 1800, supplierName: 'R Traders' });
    // Tally voucher "Debit Note (Purchase Return)" = the supplier's credit note in GSTR-2A/2B
    expect(r.docs[1]).toMatchObject({ docType: 'CN', cgst: 9 });

    const noTax: SheetTable = { name: 'S', rows: [['Supplier GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value', 'GST Rate'], [R_MH, 'X-1', '01-06-2025', 1000, 18], [R_KA, 'X-2', '01-06-2025', 1000, 18]] };
    const r2 = readPurchaseRegister([noTax], 'b.csv', '062025', SUPPLIER);
    expect(r2.docs[0]).toMatchObject({ igst: 180, cgst: 0 }); // Maharashtra → Karnataka: inter-state
    expect(r2.docs[1]).toMatchObject({ igst: 0, cgst: 90, sgst: 90 });
  });

  it('end to end: books vs GSTR-2B Excel', () => {
    const books = readPurchaseRegister([{ name: 'S', rows: [['Supplier GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST', 'CGST', 'SGST'], [R_MH, 'INV-1', '05-06-2025', 10000, 1800, 0, 0]] }], 'b.xlsx', '062025', SUPPLIER).docs;
    const portal = readPortalJson({ data: { rtnprd: '062025', docdata: { b2b: [{ ctin: R_MH, inv: [{ inum: 'inv/0001', dt: '05-06-2025', txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, itcavl: 'Y' }] }] } } }, 'gstr2b', 'x', '062025').docs;
    const { rows, summary } = reconcile(books, portal, { amountTolerance: 1, fuzzyDateDays: 30, recipientGstin: SUPPLIER }, [], { period: '062025' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'matched', matchedBy: 'normalised' });
    expect(summary.itc).toMatchObject({ books: 1800, portal: 1800, matched: 1800, difference: 0 });
  });
});
