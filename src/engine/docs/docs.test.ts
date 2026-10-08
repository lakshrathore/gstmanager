import { describe, expect, it } from 'vitest';
import { buildSampleWorkbook, R_KA, R_MH, SUPPLIER } from '../../../scripts/sample-workbook';
import { readWorkbook } from '../excel/readWorkbook';
import {
  analyse, balanceBreaks, bankMode, buildReport, checkInvoice, dupKey, matchBank, nearDupKey, parseCsv, readStructuredJson, readStructuredTables, reportTotals, seriesGaps,
  type BankTxn, type InvoiceData, type Rec,
} from './index';

const CLIENT = SUPPLIER; // 29… Karnataka
const inv = (o: Partial<InvoiceData> = {}): InvoiceData => ({
  docType: 'INV', supplierGstin: R_MH, supplierName: 'Rao Industries', customerGstin: CLIENT, invoiceNo: 'INV-1', invoiceDate: '2026-09-05',
  taxable: 100000, cgst: 0, sgst: 0, igst: 18000, cess: 0, total: 118000, ...o,
});

describe('structured files', () => {
  it('reads a purchase register (rate-wise rows added together) and tells it from a sales register', () => {
    const t = { name: 'Purchase', rows: [
      ['ABC Industries – Purchase Register – Sep 2026'],
      [],
      ['Date', 'Supplier Name', 'GSTIN of Supplier', 'Invoice No', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Invoice Value'],
      ['05/09/2026', 'Rao Industries', R_MH, 'INV-1', 60000, 10800, 0, 0, 118000],
      ['05/09/2026', 'Rao Industries', R_MH, 'INV-1', 40000, 7200, 0, 0, 118000],
      ['07/09/2026', 'Local Traders', R_KA, 'LT/9', 10000, 0, 900, 900, 11800],
      ['Total', '', '', '', 110000, 18000, 900, 900, 129800],
    ] };
    const r = readStructuredTables([t], 'purchase.xlsx', CLIENT)!;
    expect(r.kind).toBe('purchase_register');
    expect(r.records).toHaveLength(2);
    const first = r.records[0];
    expect(first.kind === 'invoice' && first.data).toMatchObject({ supplierGstin: R_MH, customerGstin: CLIENT, invoiceNo: 'INV-1', invoiceDate: '2026-09-05', taxable: 100000, igst: 18000, total: 118000 });
    expect(first.loc).toEqual({ sheet: 'Purchase', row: 4 });

    const s = readStructuredTables([{ name: 'Sheet1', rows: [['Invoice No', 'Date', 'Customer Name', 'Customer GSTIN', 'Taxable Value', 'Rate'], ['S-1', '2026-09-01', 'Bharat', R_KA, 1000, 18]] }], 'register.csv', CLIENT)!;
    expect(s.kind).toBe('sales_register');
    expect(s.records[0].kind === 'invoice' && s.records[0].data).toMatchObject({ supplierGstin: CLIENT, customerGstin: R_KA, cgst: 90, sgst: 90, igst: 0 });
  });

  it('reads a bank statement CSV, joins wrapped narrations and names the payment mode', () => {
    const t = parseCsv('Txn Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n01/09/2026,UPI/123/ramesh@okaxis,,500,,9500\n02/09/2026,"CASH DEPOSIT, BRANCH",,,250000,259500\n,AT KORAMANGALA,,,,\n03/09/2026,NEFT-ABC SUPPLIERS,N123,10000,,250000\n');
    const r = readStructuredTables([t], 'stmt.csv', CLIENT)!;
    expect(r.kind).toBe('bank_statement');
    const tx = r.records.map((x) => x.kind === 'bank' && x.data);
    expect(tx.map((x) => x && x.mode)).toEqual(['UPI', 'CASH', 'NEFT']);
    expect(tx[1] && tx[1].narration).toBe('CASH DEPOSIT, BRANCH AT KORAMANGALA');
    expect(bankMode('INT.PD:XX1234')).toBe('INTEREST');
    const breaks = balanceBreaks(r.records.map((x, i) => ({ id: String(i), data: (x as unknown as { data: BankTxn }).data })));
    expect([...breaks.keys()]).toEqual(['2']); // 259500 − 10000 = 249500, statement says 250000
  });

  it('recognises GSTR-2B JSON and the GSTR-1 Excel template', async () => {
    const j = { data: { gstin: CLIENT, rtnprd: '092026', gendt: '14-10-2026', docdata: { b2b: [{ ctin: R_MH, trdnm: 'Rao', inv: [{ inum: 'INV-1', dt: '05-09-2026', val: 118000, pos: '29', rev: 'N', itcavl: 'Y', txval: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0 }] }] } } };
    const r = readStructuredJson(j, '2b.json', CLIENT)!;
    expect(r).toMatchObject({ kind: 'gstr2b', period: '092026', ownerGstin: CLIENT });
    expect(r.records[0].kind === 'invoice' && r.records[0].data).toMatchObject({ invoiceNo: 'INV-1', invoiceDate: '2026-09-05', supplierGstin: R_MH, taxable: 100000, itcAvailable: true });

    const g1 = readStructuredTables(await readWorkbook(await buildSampleWorkbook(false)), 'GSTR1_062025.xlsx', CLIENT)!;
    expect(g1.kind).toBe('gstr1');
    expect(g1.records.length).toBeGreaterThan(5);
    expect(g1.records.every((x) => x.kind === 'invoice' && x.direction === 'sales')).toBe(true);
    expect(readStructuredTables([{ name: 'x', rows: [['hello', 'world']] }], 'notes.xlsx', CLIENT)).toBeNull();
  });
});

describe('checks', () => {
  const ctx = { clientGstin: CLIENT, direction: 'purchase' as const, today: '2026-10-08' };
  it('passes a correct invoice', () => {
    expect(checkInvoice(inv(), ctx)).toEqual([]);
  });
  it('explains what is wrong', () => {
    const codes = (d: InvoiceData) => checkInvoice(d, ctx).map((f) => f.code);
    expect(codes(inv({ supplierGstin: '27AAACR5055K1ZX' }))).toContain('invalid_gstin');
    expect(codes(inv({ total: 120000 }))).toContain('total_mismatch');
    expect(codes(inv({ igst: 0, cgst: 9000, sgst: 8000 }))).toEqual(expect.arrayContaining(['cgst_sgst', 'pos_tax']));
    expect(codes(inv({ rate: 12 }))).toContain('tax_calc');
    expect(codes(inv({ invoiceNo: '', invoiceDate: '2027-01-01' }))).toEqual(expect.arrayContaining(['missing_invoice_no', 'future_date']));
    expect(codes(inv({ supplierGstin: undefined }))).toContain('missing_gstin');
    expect(checkInvoice(inv(), { ...ctx, uncertain: ['total'] })[0]).toMatchObject({ code: 'low_confidence', field: 'total' });
  });
  it('keys duplicates by family, party and normalised number', () => {
    expect(dupKey('document', 'purchase', inv({ invoiceNo: 'INV/0001' }))).toBe(dupKey('document', 'purchase', inv({ invoiceNo: 'inv-1' })));
    expect(dupKey('document', 'purchase', inv())).not.toBe(dupKey('register', 'purchase', inv()));
    expect(nearDupKey('register', 'purchase', inv({ invoiceNo: 'A' }))).toBe(nearDupKey('register', 'purchase', inv({ invoiceNo: 'B' })));
    expect(nearDupKey('register', 'purchase', inv())).not.toBe(nearDupKey('gstr2b', 'purchase', inv())); // a match, not a duplicate
  });
});

describe('analysis', () => {
  const rec = (id: string, source: Rec['source'], data: InvoiceData, extra: Partial<Rec> = {}): Rec => ({ id, docId: 'd', kind: 'invoice', source, direction: 'purchase', fp: '092026', data, flags: [], review: 'ok', ...extra });
  it('reconciles the purchase register with GSTR-2B and lists only the exceptions', () => {
    const recs: Rec[] = [
      rec('b1', 'register', inv({ invoiceNo: 'INV-1' })),
      rec('b2', 'register', inv({ invoiceNo: 'INV-2', taxable: 50000, igst: 9000, total: 59000 })),
      rec('b3', 'register', inv({ invoiceNo: 'INV-3', taxable: 20000, igst: 3600, total: 23600 })),
      rec('p1', 'gstr2b', inv({ invoiceNo: 'INV-1' })),
      rec('p2', 'gstr2b', inv({ invoiceNo: 'INV-2', taxable: 45000, igst: 8100, total: 53100 })),
      rec('p4', 'gstr2b', inv({ invoiceNo: 'INV-4', taxable: 1000, igst: 180, total: 1180 })),
      rec('doc1', 'document', inv({ invoiceNo: 'INV-9', taxable: 500, igst: 90, total: 590 })),
      rec('x', 'register', inv({ invoiceNo: 'INV-5' }), { review: 'rejected' }),
    ];
    const a = analyse(recs, { clientGstin: CLIENT, period: '092026' });
    expect(a.purchases.basis).toBe('register');
    expect(a.purchases.books.taxable).toBe(170000);
    expect(a.purchases.gstr2b!.taxable).toBe(146000);
    expect(a.recon!.summary.itc.difference).toBe(30600 - 26280);
    const byCode = Object.fromEntries(a.exceptions.map((e) => [e.code, e]));
    expect(byCode.matched.count).toBe(1);
    expect(byCode.not_in_portal).toMatchObject({ count: 1, amount: 3600, ids: ['b3'] });
    expect(byCode.not_in_books.ids).toEqual(['p4']);
    expect(byCode.mismatch.ids.sort()).toEqual(['b2', 'p2']);
    expect(byCode.not_in_register.ids).toEqual(['doc1']);
    expect(a.exceptions[0].tone).toBe('ok');
    expect(a.insights[0]).toMatch(/ITC difference of ₹4,320/);
  });
});

describe('bank and reports', () => {
  const sale = (id: string, no: string, total: number, date = '2026-09-02', customerName = 'Bharat Traders Pvt Ltd'): Rec => ({ id, docId: 'd', kind: 'invoice', source: 'register', direction: 'sales', fp: '092026', flags: [], review: 'ok', data: { ...inv({ supplierGstin: CLIENT, customerGstin: R_KA, customerName, invoiceNo: no, invoiceDate: date, taxable: total, igst: 0, total }) } });
  const txn = (id: string, date: string, narration: string, credit: number, debit = 0): Rec => ({ id, docId: 'b', kind: 'bank', fp: '092026', flags: [], review: 'ok', data: { date, narration, debit, credit, mode: bankMode(narration) } });

  it('matches receipts to invoices by amount, date and party name', () => {
    const m = matchBank(
      [{ id: 't1', data: txn('t1', '2026-09-10', 'NEFT-BHARAT TRADERS-UTR1', 5000).data as BankTxn }, { id: 't2', data: txn('t2', '2026-09-11', 'UPI/RAMESH', 777).data as BankTxn },
        { id: 't3', data: txn('t3', '2026-09-12', 'NEFT BHARAT TRADERS', 3000).data as BankTxn }, { id: 't4', data: txn('t4', '2026-09-30', 'INT.PD', 12).data as BankTxn }],
      [sale('s1', 'S-1', 5000), sale('s2', 'S-2', 1000), sale('s3', 'S-3', 2000)].map((r) => ({ id: r.id, direction: 'sales' as const, data: r.data as InvoiceData })),
    );
    expect(m.get('t1')).toMatchObject({ status: 'matched', invoiceIds: ['s1'] });
    expect(m.get('t2')?.status).toBe('unmatched');
    expect(m.get('t3')).toMatchObject({ status: 'matched', invoiceIds: ['s2', 's3'] }); // two invoices paid together
    expect(m.get('t4')?.status).toBe('not_applicable');
  });

  it('finds gaps in invoice series', () => {
    expect(seriesGaps(['INV/26-27/0001', 'INV/26-27/0002', 'INV/26-27/0005', 'X-9'])).toEqual([{ prefix: 'INV/26-27/', from: 'INV/26-27/0001', to: 'INV/26-27/0005', missing: ['INV/26-27/0003', 'INV/26-27/0004'] }]);
  });

  it('builds the GST summary and missing-document grid', () => {
    const recs: Rec[] = [sale('s1', 'S-1', 100000), { ...sale('p1', 'P-1', 50000), direction: 'purchase', data: inv({ taxable: 50000, igst: 9000, total: 59000 }) }, txn('t1', '2026-09-10', 'NEFT X', 10)];
    recs[0].data = { ...(recs[0].data as InvoiceData), cgst: 9000, sgst: 9000, total: 118000 };
    const a = analyse(recs, { clientGstin: CLIENT, period: '092026', monthly: true });
    const g = buildReport('gst_summary', recs, a, ['092026']);
    expect(g.rows[0]).toMatchObject({ out_c: 9000, out_s: 9000, itc_i: 9000, net: 9000 });
    const md = buildReport('missing_documents', recs, a, ['082026', '092026']);
    expect(md.rows.map((r) => [r.sales, r.gstr2b, r.bank])).toEqual([['✗', '✗', '✗'], ['✓ 1', '✗', '✓ 1']]);
    expect(a.exceptions.some((e) => e.code === 'missing_2b')).toBe(true);
    expect(reportTotals(g).net).toBe(9000);
  });
});
