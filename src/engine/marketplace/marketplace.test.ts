import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { R_KA, R_MH, SUPPLIER } from '../../../scripts/sample-workbook';
import {
  addTemplateSheets, buildMarketplaceRecords, generateGstr1Json, parseGstr1Tables, readWorkbook, seriesGaps, gstinCheckDigit, parseCsv, profileForPeriod, readMarketplaceTables,
  stateCode, validateGstr1Json, validateReturn, type AnyRecord, type BuildOptions, type ReturnContext, type SheetTable,
} from '../index';

/*
 * Synthetic reports built with the column headers the marketplaces actually use (Amazon MTR per the
 * SP-API report docs; Flipkart Sales Report from a real 2023 report; Meesho from code that parses
 * the real files). Supplier is in Karnataka (29).
 */

const FP = '062025';
const profile = profileForPeriod(FP);
const ECO = (() => { const g = '29AAICA3918J1Z'.replace(/Z$/, 'C'); return g + gstinCheckDigit(g); })(); // a TCS-type GSTIN
const opts = (marketplace: string, extra: Partial<BuildOptions> = {}): BuildOptions => ({
  marketplace, source: `mp:${marketplace}`, supplierGstin: SUPPLIER, fp: FP, hsnSplit: profile.hsnSplit,
  b2clThreshold: profile.b2clThreshold, allowedRates: profile.allowedRates, uqc: 'NOS', ...extra,
});
const ctx: ReturnContext = { supplierGstin: SUPPLIER, fp: FP, aatoAbove5Cr: false, profile };
const of = (recs: AnyRecord[], s: string) => recs.filter((r) => r.section === s);

/* ---------- Amazon ---------- */

const AMZ_HEAD = 'Seller Gstin,Invoice Number,Invoice Date,Transaction Type,Order Id,Shipment Id,Shipment Date,Order Date,Shipment Item Id,Quantity,Item Description,Asin,Hsn/sac,Sku,Product Tax Code,Bill From City,Bill From State,Bill From Country,Bill From Postal Code,Ship From City,Ship From State,Ship From Country,Ship From Postal Code,Ship To City,Ship To State,Ship To Country,Ship To Postal Code,Invoice Amount,Tax Exclusive Gross,Total Tax Amount,Cgst Rate,Sgst Rate,Utgst Rate,Igst Rate,Compensatory Cess Rate,Principal Amount,Principal Amount Basis,Cgst Tax,Sgst Tax,Igst Tax,Utgst Tax,Compensatory Cess Tax,Shipping Amount,Shipping Amount Basis,Shipping Cgst Tax,Shipping Sgst Tax,Shipping Utgst Tax,Shipping Igst Tax,Shipping Cess Tax Amount,Gift Wrap Amount,Gift Wrap Amount Basis,Gift Wrap Cgst Tax,Gift Wrap Sgst Tax,Gift Wrap Utgst Tax,Gift Wrap Igst Tax,Gift Wrap Compensatory Cess Tax,Item Promo Discount,Item Promo Discount Basis,Item Promo Tax,Shipping Promo Discount,Shipping Promo Discount Basis,Shipping Promo Tax,Gift Wrap Promo Discount,Gift Wrap Promo Discount Basis,Gift Wrap Promo Tax,Tcs Cgst Rate,Tcs Cgst Amount,Tcs Sgst Rate,Tcs Sgst Amount,Tcs Utgst Rate,Tcs Utgst Amount,Tcs Igst Rate,Tcs Igst Amount,Warehouse Id,Fulfillment Channel,Payment Method Code,Credit Note No,Credit Note Date';
const AMZ_B2B_TAIL = ',Bill To City,Bill To State,Bill To Country,Bill To Postalcode,Customer Bill To Gstid,Customer Ship To Gstid,Buyer Name';
const cols = AMZ_HEAD.split(',');

function amzRow(v: Record<string, string | number>, b2b?: Record<string, string>) {
  const row = cols.map((c) => (c in v ? String(v[c]) : ''));
  const csv = row.map((x) => (x.includes(',') ? `"${x}"` : x)).join(',');
  if (!b2b) return csv;
  return `${csv},${['Bill To City', 'Bill To State', 'Bill To Country', 'Bill To Postalcode', 'Customer Bill To Gstid', 'Customer Ship To Gstid', 'Buyer Name'].map((c) => b2b[c] ?? '').join(',')}`;
}
const amz = (inv: string, type: string, state: string, taxable: number, rate: { igst?: number; cgst?: number }, extra: Record<string, string | number> = {}) => ({
  'Seller Gstin': SUPPLIER, 'Invoice Number': inv, 'Invoice Date': '15-06-2025 10:22:11', 'Transaction Type': type, Quantity: 1,
  'Item Description': 'Cotton kurta, blue', 'Hsn/sac': '6204', 'Ship To State': state, 'Tax Exclusive Gross': taxable,
  'Total Tax Amount': Math.round(taxable * ((rate.igst ?? 0) + 2 * (rate.cgst ?? 0)) * 100) / 100,
  'Igst Rate': rate.igst ?? 0, 'Cgst Rate': rate.cgst ?? 0, 'Sgst Rate': rate.cgst ?? 0, 'Utgst Rate': 0, ...extra,
});

describe('marketplace helpers', () => {
  it('maps state names marketplaces use', () => {
    expect(stateCode('MAHARASHTRA')).toBe('27');
    expect(stateCode('Tamil Nadu')).toBe('33');
    expect(stateCode('NEW DELHI')).toBe('07');
    expect(stateCode('Andaman & Nicobar Islands')).toBe('35');
    expect(stateCode('ORISSA')).toBe('21');
    expect(stateCode('Dadra and Nagar Haveli and Daman and Diu')).toBe('26');
    expect(stateCode('29-Karnataka')).toBe('29');
    expect(stateCode('Atlantis')).toBe('');
  });
  it('parses quoted CSV', () => {
    const t = parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\n', 'f.csv');
    expect(t.rows).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"']]);
  });
});

describe('Amazon MTR', () => {
  const b2c = [
    AMZ_HEAD,
    amzRow(amz('KA-1001', 'Shipment', 'KARNATAKA', 1000, { cgst: 0.025 })), // intra 5%
    amzRow(amz('KA-1002', 'Shipment', 'TAMIL NADU', 500, { igst: 0.05 })), // inter 5%
    amzRow(amz('KA-1003', 'Shipment', 'MAHARASHTRA', 800, { igst: 0.12 })),
    amzRow(amz('KA-1003', 'Refund', 'MAHARASHTRA', -800, { igst: 0.12 }, { 'Credit Note No': 'CN-0001', 'Credit Note Date': '20-06-2025' })),
    amzRow(amz('KA-1004', 'Shipment', 'KERALA', 300, { igst: 0.05 })),
    amzRow(amz('KA-1004', 'Cancel', 'KERALA', -300, { igst: 0.05 })), // voided in full
    amzRow(amz('KA-1005', 'FreeReplacement', 'KERALA', 0, { igst: 0.05 })),
    amzRow({ ...amz('MH-9', 'Shipment', 'GOA', 999, { igst: 0.05 }), 'Seller Gstin': R_MH }), // another GSTIN
    amzRow(amz('KA-1006', 'Shipment', 'TAMIL NADU', 150000, { igst: 0.05 })), // B2CL (> ₹1 lakh inter-state)
  ].join('\n');

  const read = readMarketplaceTables([parseCsv(b2c, 'MTR_B2C-JUN-2025.csv')], 'MTR_B2C-JUN-2025.csv', 'auto', profile.allowedRates);

  it('recognises the report and treats fraction rates as percents', () => {
    expect(read.marketplace).toBe('amazon');
    expect(read.lines).toHaveLength(9);
    expect(read.lines[0]).toMatchObject({ kind: 'sale', pos: '29', rate: 5, taxable: 1000, hsn: '6204', invoiceDate: '2025-06-15' });
    expect(read.lines[3]).toMatchObject({ kind: 'return', pos: '27', rate: 12, taxable: 800, noteNo: 'CN-0001' });
    expect(read.lines[5]).toMatchObject({ kind: 'return', cancel: true });
    expect(read.lines[6]).toMatchObject({ kind: 'skip' });
  });

  const built = buildMarketplaceRecords(read.lines, opts('amazon', { etin: ECO }));

  it('builds B2CS net of returns and cancellations, B2CL, HSN and documents', () => {
    const b2cs = of(built.records, 'b2cs').map((r) => r.data as { pos: string; rt: number; txval: number; camt: number; samt: number; iamt: number; typ: string; etin?: string });
    expect(b2cs).toHaveLength(2); // KA intra, TN inter – MH nets to 0 and Kerala was cancelled
    expect(b2cs.find((r) => r.pos === '29')).toMatchObject({ txval: 1000, camt: 25, samt: 25, iamt: 0, typ: 'E', etin: ECO });
    expect(b2cs.find((r) => r.pos === '33')).toMatchObject({ txval: 500, iamt: 25 });
    expect(of(built.records, 'b2cl')).toHaveLength(1);
    expect(built.summary.otherGstinLines).toBe(1);
    expect(built.summary.cancelledInvoices).toBe(1);
    expect(built.summary.skipped).toEqual([{ reason: 'Free replacement (no value)', count: 1 }]);
    const hsn = of(built.records, 'hsn_b2c').map((r) => r.data as { hsn: string; rt: number; txval: number });
    expect(hsn.reduce((a, h) => a + h.txval, 0)).toBe(151500);
    const docs = of(built.records, 'docs').map((r) => r.data);
    expect(docs).toContainEqual({ docTyp: 'Invoices for outward supply', from: 'KA-1001', to: 'KA-1006', totnum: 5, cancel: 1 });
    expect(docs).toContainEqual({ docTyp: 'Credit Note', from: 'CN-0001', to: 'CN-0001', totnum: 1, cancel: 0 });
    expect(built.summary.table14).toMatchObject({ etin: ECO, netValue: 151500 });
  });

  it('produces a return that validates and a schema-valid JSON', () => {
    const { issues } = validateReturn(built.records, ctx);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { json } = generateGstr1Json(built.records, ctx);
    expect(validateGstr1Json(json).ok).toBe(true);
    expect((json.b2cs as unknown[]).length).toBe(2);
  });

  it('B2B report: invoices to registered buyers and credit notes', () => {
    const b2b = [
      AMZ_HEAD + AMZ_B2B_TAIL,
      amzRow(amz('KA-2001', 'Shipment', 'MAHARASHTRA', 2000, { igst: 0.18 }), { 'Customer Bill To Gstid': R_MH, 'Buyer Name': 'R Traders' }),
      amzRow(amz('KA-2001', 'Shipment', 'MAHARASHTRA', 1000, { igst: 0.05 }), { 'Customer Bill To Gstid': R_MH, 'Buyer Name': 'R Traders' }),
      amzRow(amz('KA-2002', 'Refund', 'KARNATAKA', -500, { cgst: 0.09 }, { 'Credit Note No': 'CN-B-7', 'Credit Note Date': '2025-06-21' }), { 'Customer Bill To Gstid': R_KA }),
    ].join('\n');
    const r = readMarketplaceTables([parseCsv(b2b, 'MTR_B2B.csv')], 'MTR_B2B.csv', 'amazon', profile.allowedRates);
    const out = buildMarketplaceRecords(r.lines, opts('amazon'));
    const inv = of(out.records, 'b2b')[0].data as { ctin: string; inum: string; val: number; items: { rt: number; txval: number; iamt: number }[] };
    expect(inv).toMatchObject({ ctin: R_MH, inum: 'KA-2001', val: 3410 });
    expect(inv.items).toEqual(expect.arrayContaining([expect.objectContaining({ rt: 18, txval: 2000, iamt: 360 }), expect.objectContaining({ rt: 5, txval: 1000, iamt: 50 })]));
    const cn = of(out.records, 'cdnr')[0].data as { ntNum: string; ntty: string; val: number };
    expect(cn).toMatchObject({ ntNum: 'CN-B-7', ntty: 'C', val: 590 });
    expect(of(out.records, 'hsn_b2b').length).toBeGreaterThan(0);
    expect(validateReturn(out.records, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

/* ---------- Flipkart ---------- */

const FK_HEAD = ['Seller GSTIN', 'Order ID', 'Order Item ID', 'Product Title/Description', 'FSN', 'SKU', 'HSN Code', 'Event Type', 'Event Sub Type', 'Order Type', 'Fulfilment Type', 'Order Date', 'Order Approval Date', 'Item Quantity', 'Order Shipped From (State)', 'Price before discount', 'Total Discount', 'Seller Share', 'Bank Offer Share', 'Price after discount (Price before discount-Total discount)', 'Shipping Charges', 'Final Invoice Amount (Price after discount+Shipping Charges)', 'Type of tax', 'Taxable Value (Final Invoice Amount -Taxes)', 'CST Rate', 'CST Amount', 'VAT Rate', 'VAT Amount', 'Luxury Cess Rate', 'Luxury Cess Amount', 'IGST Rate', 'IGST Amount', 'CGST Rate', 'CGST Amount', 'SGST Rate (or UTGST as applicable)', 'SGST Amount (Or UTGST as applicable)', 'TCS IGST Rate', 'TCS IGST Amount', 'TCS CGST Rate', 'TCS CGST Amount', 'TCS SGST Rate', 'TCS SGST Amount', 'Total TCS Deducted', 'Buyer Invoice ID', 'Buyer Invoice Date', 'Buyer Invoice Amount', "Customer's Billing Pincode", "Customer's Billing State", "Customer's Delivery Pincode", "Customer's Delivery State", 'Usual Price', 'Is Shopsy Order?', 'TDS Rate', 'TDS Amount'];

function fkRow(sub: string, inv: string, state: string, taxable: number, igst: number, cgst = 0) {
  const v: Record<string, unknown> = {
    'Seller GSTIN': SUPPLIER, 'HSN Code': 6109, 'Event Type': sub === 'Sale' ? 'Sale' : 'Return', 'Event Sub Type': sub,
    'Order Date': '2025-06-04 00:00:00.0', 'Item Quantity': sub === 'Sale' || sub === 'Return Cancellation' ? 1 : -1,
    'Taxable Value (Final Invoice Amount -Taxes)': taxable, 'IGST Rate': igst, 'IGST Amount': (taxable * igst) / 100,
    'CGST Rate': cgst, 'CGST Amount': (taxable * cgst) / 100, 'SGST Rate (or UTGST as applicable)': cgst, 'SGST Amount (Or UTGST as applicable)': (taxable * cgst) / 100,
    'Buyer Invoice ID': inv, 'Buyer Invoice Date': '2025-06-04 00:00:00.0', "Customer's Delivery State": state, 'Product Title/Description': 'T-shirt',
  };
  return FK_HEAD.map((h) => v[h] ?? null);
}

describe('Flipkart sales report', () => {
  const sales: SheetTable = {
    name: 'Sales Report',
    rows: [
      FK_HEAD,
      fkRow('Sale', 'FAKAAB2500000001', 'Uttar Pradesh', 1000, 12),
      fkRow('Sale', 'FAKAAB2500000002', 'Karnataka', 400, 0, 2.5),
      fkRow('Return', 'FAKAAB2500000001', 'Uttar Pradesh', -1000, 12),
      fkRow('Return Cancellation', 'FAKAAB2500000001', 'Uttar Pradesh', 1000, 12),
      fkRow('Sale', 'FAKAAB2500000003', 'Kerala', 250, 5),
      fkRow('Cancellation', 'FAKAAB2500000003', 'Kerala', -250, 5),
    ],
  };
  const cashback: SheetTable = { name: 'Cash Back Report', rows: [['Seller GSTIN', 'Order ID', 'Taxable Value', 'Document Type'], [SUPPLIER, 'OD1', 10, 'Credit Note']] };
  const r = readMarketplaceTables([sales, cashback], 'Flipkart-sales.xlsx', 'auto', profile.allowedRates);
  const out = buildMarketplaceRecords(r.lines, opts('flipkart'));

  it('reads events with percent rates and skips the cash-back sheet with a reason', () => {
    expect(r.marketplace).toBe('flipkart');
    expect(r.lines.map((l) => l.kind)).toEqual(['sale', 'sale', 'return', 'sale', 'sale', 'return']);
    expect(r.skipped[0].reason).toMatch(/cash-back/);
  });
  it('nets return + return-cancellation and drops the cancelled order', () => {
    const b2cs = of(out.records, 'b2cs').map((x) => x.data as { pos: string; txval: number; iamt: number; camt: number; typ: string });
    expect(b2cs).toEqual(expect.arrayContaining([
      expect.objectContaining({ pos: '09', txval: 1000, iamt: 120, typ: 'OE' }),
      expect.objectContaining({ pos: '29', txval: 400, camt: 10 }),
    ]));
    expect(b2cs).toHaveLength(2);
    expect(out.summary.cancelledInvoices).toBe(1);
    expect(of(out.records, 'hsn_b2c').map((x) => (x.data as { hsn: string }).hsn)).toEqual(['6109', '6109']);
    expect(validateReturn(out.records, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

/* ---------- Meesho ---------- */

const MS_HEAD = ['sup_name', 'supplier_id', 'gstin', 'eco_tcs_gstin', 'sub_order_num', 'order_date', 'manifest_date', 'hsn_code', 'quantity', 'gst_rate', 'total_taxable_sale_value', 'tax_amount', 'total_invoice_value', 'taxable_shipping', 'end_customer_state_new', 'financial_year', 'month_number'];
const ms = (sub: string, state: string, taxable: number, rate: number, qty = 1) =>
  ['My Shop', '3564327', SUPPLIER, ECO, sub, '2025-06-10', '2025-06-11', '61091000', qty, rate, taxable, (taxable * rate) / 100, taxable * (1 + rate / 100), 0, state, '2025-26', 6];

describe('Meesho GST report', () => {
  const sales: SheetTable = { name: 'tcs_sales.xlsx', rows: [MS_HEAD, ms('111_1', 'UTTAR PRADESH', 380.95, 5), ms('112_1', 'KARNATAKA', 476.19, 5), ms('113_1', 'UTTAR PRADESH', -20, 5, 0)] };
  const returns: SheetTable = { name: 'tcs_sales_return.xlsx', rows: [[...MS_HEAD, 'cancel_return_date'], [...ms('111_1', 'UTTAR PRADESH', 380.95, 5), '2025-06-20']] };
  const docs: SheetTable = {
    name: 'Tax_invoice_details.xlsx',
    rows: [['Type', 'Order Date', 'Suborder No.', 'Product Description', 'HSN', 'Invoice No.'],
      ['INVOICE', '2025-06-10', '111_1', 'Kurti', '6109', 'sk7tq25000001'], ['INVOICE', '2025-06-10', '112_1', 'Kurti', '6109', 'sk7tq25000002'],
      ['CREDIT NOTE', '2025-06-20', '111_1', 'Kurti', '6109', 'sk7tq25C00001']],
  };
  const reads = [readMarketplaceTables([sales], 'tcs_sales.xlsx', 'auto', profile.allowedRates), readMarketplaceTables([returns], 'tcs_sales_return.xlsx', 'auto', profile.allowedRates), readMarketplaceTables([docs], 'Tax_invoice_details.xlsx', 'auto', profile.allowedRates)];

  it('recognises all three files, returns file positive amounts as returns, adjustments as reversals', () => {
    expect(reads.map((x) => x.marketplace)).toEqual(['meesho', 'meesho', 'meesho']);
    expect(reads[0].lines.map((l) => l.kind)).toEqual(['sale', 'sale', 'return']);
    expect(reads[1].lines[0]).toMatchObject({ kind: 'return', taxable: 380.95, noteDate: '2025-06-20' });
    expect(reads[0].lines[0]).toMatchObject({ ecoGstin: ECO, pos: '09', rate: 5 });
    expect(reads[2].docs).toHaveLength(3);
  });
  it('nets the return, uses the document register for Table 13', () => {
    const out = buildMarketplaceRecords(reads.flatMap((x) => x.lines), opts('meesho', { etin: ECO }), reads.flatMap((x) => x.docs));
    const b2cs = of(out.records, 'b2cs').map((x) => x.data as { pos: string; txval: number });
    // UP: 380.95 sale − 380.95 return − 20 adjustment → −20 (flagged), KA: 476.19
    expect(b2cs.find((x) => x.pos === '29')?.txval).toBe(476.19);
    expect(b2cs.find((x) => x.pos === '09')?.txval).toBe(-20);
    expect(out.issues.find((i) => i.field === 'txval')?.message).toMatch(/Returns exceed sales/);
    const d = of(out.records, 'docs').map((x) => x.data);
    expect(d).toContainEqual({ docTyp: 'Invoices for outward supply', from: 'sk7tq25000001', to: 'sk7tq25000002', totnum: 2, cancel: 0 });
    expect(d).toContainEqual({ docTyp: 'Credit Note', from: 'sk7tq25C00001', to: 'sk7tq25C00001', totnum: 1, cancel: 0 });
  });
});

describe('generic sales register and merging sources', () => {
  it('reads a simple register and merges B2CS/HSN with other sources in the JSON', () => {
    const t: SheetTable = { name: 'Sales', rows: [['Invoice No', 'Date', 'Customer GSTIN', 'State', 'HSN', 'Qty', 'GST Rate', 'Taxable Value', 'Type'],
      ['S-1', '05/06/2025', '', 'Maharashtra', '6204', 2, 12, 1000, 'Sale'],
      ['S-2', '06/06/2025', R_MH, 'Maharashtra', '6204', 1, 12, 500, 'Sale']] };
    const r = readMarketplaceTables([t], 'register.xlsx', 'auto', profile.allowedRates);
    expect(r.marketplace).toBe('generic');
    const out = buildMarketplaceRecords(r.lines, opts('generic'));
    expect(of(out.records, 'b2b')).toHaveLength(1);
    // Same POS/rate B2C line typed in manually → one b2cs row of 1500 in the JSON.
    const manual: AnyRecord = { section: 'b2cs', key: 'b2cs|manual|x', source: { sheet: 'manual', rows: [] }, data: { typ: 'OE', pos: '27', rt: 12, txval: 500, iamt: 60, camt: 0, samt: 0, csamt: 0, diffPercent: null } };
    const manualHsn: AnyRecord = { section: 'hsn_b2c', key: 'hsn|manual|x', source: { sheet: 'manual', rows: [] }, data: { hsn: '6204', uqc: 'NOS', qty: 1, rt: 12, txval: 500, iamt: 60, camt: 0, samt: 0, csamt: 0 } };
    const all = [...out.records, manual, manualHsn];
    expect(validateReturn(all, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { json } = generateGstr1Json(all, ctx);
    expect(json.b2cs).toEqual([expect.objectContaining({ pos: '27', rt: 12, txval: 1500, iamt: 180 })]);
    const hsn = (json.hsn as { hsn_b2c: { hsn_sc: string; txval: number; qty: number }[] }).hsn_b2c;
    expect(hsn).toEqual([expect.objectContaining({ hsn_sc: '6204', txval: 1500, qty: 3 })]);
    expect(validateGstr1Json(json).ok).toBe(true);
  });

  it('reads an item-wise billing-software sale report (Ledger Name, GST No, GST Rate vs Rate, Unit, Free Qty)', () => {
    const head = ['S.No', 'Ledger Name', 'Bill No', 'Bill Date', 'Place of Supply', 'GST No', 'Category', 'Item Name', 'GST Rate', 'Bar Code', 'HSN', 'ItemCode', 'Batch No',
      'Packing Style', 'MFG Date', 'EXP Date', 'MRP', 'Qty', 'Unit', 'Free Qty', 'Free Qty Unit', 'Rate', 'Item line Total', 'Discount', 'Bill Discount(%)',
      'Bill Discount Amount', 'Taxable Amount', 'IGST', 'CGST', 'SGST/UTGST', 'Tax Amount', 'Sub Total Amount', 'Bill Amount', 'Cost Rate', 'Item Profit'];
    const row = (n: number, ledger: string, bill: string, date: string, pos: string, gst: string, item: string, rate: number, hsn: string, qty: number, unit: string, free: number, price: number, taxable: number, igst: number, half: number) =>
      [n, ledger, bill, date, pos, gst, 'Tablet', item, rate, '0571358104', hsn, 'X', 'B1', '10X10', '06/2026', '05/2028', 297, qty, unit, free.toFixed(2), '', price, taxable, 0, 0, 0, taxable, igst, half, half, igst + 2 * half, taxable + igst + 2 * half, 0, 21, 0];
    const t: SheetTable = { name: 'Sale Report', rows: [head,
      row(1, 'New Sanju Medical Store', '122/26-27', '03-06-2025', 'Karnataka', '', 'Progycure-500', 5, '30049099', 50, 'NOS', 0, 50, 2500, 0, 62.5),
      row(2, 'Divine Healthcare', '123/26-27', '03-06-2025', 'Maharashtra', '', 'Potadi Clave -625', 5, '3004', 4, 'BOX', 1, 540, 2160, 108, 0),
      row(3, 'Divine Healthcare', '123/26-27', '03-06-2025', 'Maharashtra', '', 'Deparadol -SP', 5, '3004', 19, 'BOX', 0, 130, 2470, 123.5, 0),
      row(4, 'Divine Healthcare', '126/26-27', '04-06-2025', 'Maharashtra', '', 'Tacillin-4.5 Gm', 5, '30041090', 1620, 'NOS', 0, 65, 105300, 5265, 0),
      row(5, 'H D B P Hospital', '127/26-27', '05-06-2025', 'Maharashtra', R_MH, 'PROXONE-1GM', 12, '3004', 300, 'Nos', 0, 22.5, 6750, 810, 0),
      row(6, 'H D B P Hospital', '127/26-27', '05-06-2025', 'Maharashtra', R_MH, 'Pinset-40', 5, '3004', 350, 'Nos', 0, 12.5, 4375, 218.75, 0),
    ] };
    // The report's total row at the bottom is not a sale.
    t.rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 2343, '', '', '', '', 123555, 0, 0, 0, 123555, 5546.25, 62.5, 62.5, 5671.25, 129226.25, 0, 0, 0]);
    const r = readMarketplaceTables([t], 'sale-report.xlsx', 'auto', profile.allowedRates);
    expect(r.marketplace).toBe('generic');
    expect(r.lines.filter((l) => l.kind === 'skip').map((l) => l.skipReason)).toEqual(['Total or summary row']);
    r.lines = r.lines.filter((l) => l.kind !== 'skip');
    // "GST Rate" (5/12) is the rate – not "Rate" (the selling price).
    expect(r.lines.map((l) => l.rate)).toEqual([5, 5, 5, 5, 12, 5]);
    expect(r.lines[1]).toMatchObject({ buyerName: 'Divine Healthcare', uqc: 'BOX', qty: 5, pos: '27' });
    const out = buildMarketplaceRecords(r.lines, opts('generic'));

    // B2B: one invoice to the registered hospital, items by rate.
    const b2b = of(out.records, 'b2b');
    expect(b2b).toHaveLength(1);
    expect(b2b[0].data).toMatchObject({ ctin: R_MH, inum: '127/26-27', receiverName: 'H D B P Hospital' });
    expect((b2b[0].data as { items: { rt: number; txval: number }[] }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ rt: 12, txval: 6750, iamt: 810 }), expect.objectContaining({ rt: 5, txval: 4375 })]));
    // B2CL: the inter-state bill above ₹1 lakh; the rest is B2CS by state and rate.
    expect(of(out.records, 'b2cl').map((x) => x.data)).toEqual([expect.objectContaining({ inum: '126/26-27', pos: '27' })]);
    expect(of(out.records, 'b2cs').map((x) => x.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pos: '29', rt: 5, txval: 2500, camt: 62.5 }), expect.objectContaining({ pos: '27', rt: 5, txval: 4630, iamt: 231.5 })]));
    // HSN summary by HSN, unit and rate; free quantity counted.
    const hsn = [...of(out.records, 'hsn_b2c'), ...of(out.records, 'hsn_b2b')].map((x) => x.data as { hsn: string; uqc: string; qty: number; rt: number });
    expect(hsn).toEqual(expect.arrayContaining([expect.objectContaining({ hsn: '3004', uqc: 'BOX', qty: 24, rt: 5 }), expect.objectContaining({ hsn: '30049099', uqc: 'NOS', qty: 50 })]));
    // Table 13 from the bill numbers.
    expect(of(out.records, 'docs').map((x) => x.data)).toEqual([expect.objectContaining({ from: '122/26-27', to: '127/26-27', totnum: 4 })]);
    // Missing bill numbers are flagged for Table 13.
    expect(out.issues.find((i) => i.section === 'docs')?.message).toContain('124/26-27, 125/26-27');
    expect(seriesGaps(['INV0001', 'INV0004', 'X-9', 'X-10'])).toEqual([{ from: 'INV0001', to: 'INV0004', missing: ['INV0002', 'INV0003'] }]);
    const { json } = generateGstr1Json(out.records, ctx);
    expect(validateGstr1Json(json).ok).toBe(true);

    // The same software's Sale Return report: B2C returns net off B2C Small (never Table 9B), a
    // registered buyer's return is a credit note (9B registered).
    const ret: SheetTable = { name: 'Sale Return Report', rows: [head,
      row(1, 'New Sanju Medical Store', 'SR-9', '08-06-2025', 'Karnataka', '', 'Progycure-500', 5, '30049099', 5, 'NOS', 0, 50, 250, 0, 6.25),
      row(2, 'Divine Healthcare', 'SR-10', '09-06-2025', 'Maharashtra', '', 'Deparadol -SP', 5, '3004', 2, 'BOX', 0, 130, 260, 13, 0),
      row(3, 'H D B P Hospital', 'SR-11', '09-06-2025', 'Maharashtra', R_MH, 'PROXONE-1GM', 12, '3004', 10, 'Nos', 0, 22.5, 225, 27, 0),
    ] };
    const r2 = readMarketplaceTables([t, ret], 'sale-report.xlsx', 'auto', profile.allowedRates);
    expect(r2.lines.filter((l) => l.kind === 'return').map((l) => l.noteNo)).toEqual(['SR-9', 'SR-10', 'SR-11']);
    const out2 = buildMarketplaceRecords(r2.lines, opts('generic'));
    expect(of(out2.records, 'cdnur')).toHaveLength(0);
    // A return of an item not sold this month: no negative HSN row, a warning instead.
    const only: SheetTable = { name: 'Sale Return Report', rows: [head, row(1, 'X', 'SR-12', '09-06-2025', 'Karnataka', '', 'Old item', 5, '30049011', 21, 'NOS', 0, 469.84, 9866.65, 0, 246.67)] };
    const out3 = buildMarketplaceRecords([...r.lines, ...readMarketplaceTables([only], 'r.xlsx', 'auto', profile.allowedRates).lines], opts('generic'));
    expect(of(out3.records, 'hsn_b2c').some((x) => (x.data as { hsn: string }).hsn === '30049011')).toBe(false);
    expect(out3.issues.some((i) => i.section === 'hsn_b2c' && /30049011.*returns exceed/.test(i.message))).toBe(true);
    expect(validateReturn(out3.records, ctx).issues.filter((i) => i.severity === 'error' && i.section.startsWith('hsn'))).toEqual([]);

    // 0% items → Table 8 (nil-rated), not B2C Small; inter-state returns above inter-state sales of an
    // HSN that also sells intra-state → no negative IGST in Table 12.
    const mix: SheetTable = { name: 'Sale Report', rows: [head,
      row(1, 'A', 'S-1', '10-06-2025', 'Karnataka', '', 'MEROVIX INJ', 0, '3004', 100, 'NOS', 0, 90, 9000, 0, 0),
      row(2, 'B', 'S-2', '10-06-2025', 'Maharashtra', '', 'Detacal 300', 0, '2309', 10, 'BTL', 0, 90, 900, 0, 0),
      row(3, 'C', 'S-3', '11-06-2025', 'Karnataka', '', 'PROXONE-1GM', 5, '3004', 300, 'NOS', 0, 22.5, 6750, 0, 168.75),
      row(4, 'E', 'S-4', '11-06-2025', 'Maharashtra', '', 'Deparadol -SP', 5, '3004', 19, 'BOX', 0, 130, 2470, 123.5, 0),
    ] };
    const mixRet: SheetTable = { name: 'Sale Return Report', rows: [head, row(1, 'D', 'SR-20', '12-06-2025', 'Maharashtra', '', 'PROXONE-1GM', 5, '3004', 50, 'NOS', 0, 22.5, 1125, 56.25, 0)] };
    const out4 = buildMarketplaceRecords(readMarketplaceTables([mix, mixRet], 'm.xlsx', 'auto', profile.allowedRates).lines, opts('generic'));
    expect(of(out4.records, 'nil').map((x) => x.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ splyTy: 'INTRAB2C', nilAmt: 9000 }), expect.objectContaining({ splyTy: 'INTRB2C', nilAmt: 900 })]));
    expect(of(out4.records, 'b2cs').every((x) => (x.data as { rt: number }).rt !== 0)).toBe(true);
    const h5 = of(out4.records, 'hsn_b2c').map((x) => x.data as { hsn: string; rt: number; txval: number; iamt: number; camt: number }).find((x) => x.hsn === '3004' && x.rt === 5)!;
    expect(h5).toMatchObject({ txval: 5625, iamt: 0, camt: 140.63 });
    expect(of(out4.records, 'hsn_b2c').some((x) => (x.data as { rt: number; hsn: string }).rt === 0 && (x.data as { hsn: string }).hsn === '3004')).toBe(true);
    expect(validateReturn(out4.records, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
    // HSN (B2C) = B2C Small + nil-rated B2C (Table 8): no reconciliation warning.
    expect(validateReturn(out4.records, ctx).issues.filter((i) => i.code === 'HSN_RECONCILIATION')).toEqual([]);
    expect(validateGstr1Json(generateGstr1Json(out4.records, ctx).json).ok).toBe(true);
    expect(of(out2.records, 'b2cs').map((x) => x.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pos: '29', txval: 2250 }), expect.objectContaining({ pos: '27', txval: 4370 })]));
    expect(of(out2.records, 'cdnr').map((x) => x.data)).toEqual([expect.objectContaining({ ctin: R_MH, ntNum: 'SR-11', ntty: 'C' })]);
    expect(of(out2.records, 'docs').map((x) => (x.data as { docTyp: string }).docTyp)).toContain('Credit Note');
    expect(validateGstr1Json(generateGstr1Json(out2.records, ctx).json).ok).toBe(true);
  });

  it('applies the GSTR-1 conditions to a billing-software report', () => {
    // Supplier in Karnataka (29). Columns: no "GST Rate" – only "Rate" (the price) and the tax amounts.
    const head = ['Bill No', 'Bill Date', 'Ledger Name', 'GST No', 'Place of Supply', 'Item Name', 'HSN', 'Qty', 'Unit', 'Rate', 'Taxable Amount', 'IGST', 'CGST', 'SGST', 'Bill Amount', 'Type'];
    const t: SheetTable = { name: 'Sale Report', rows: [head,
      // B2B with a blank place of supply → buyer's state from the GSTIN (27, inter-state); bill amount with round-off.
      ['B-1', '05/06/2025', 'Mumbai Traders', R_MH, '', 'Widget', '8471', 10, 'Nos', 18, 1000, 50, 0, 0, 1050.4, 'Sale'],
      // Mistyped GSTIN → B2C, with a warning.
      ['B-2', '05/06/2025', 'Typo Co', '27AAACR5055K1ZX', 'Maharashtra', 'Widget', '8471', 1, 'Nos', 500, 500, 25, 0, 0, 525, 'Sale'],
      // IGST charged within Karnataka → warning.
      ['B-3', '06/06/2025', 'Local', '', 'Karnataka', 'Widget', '8471', 1, 'Nos', 200, 200, 10, 0, 0, 210, 'Sale'],
      // Service (SAC) → UQC NA, qty 0.
      ['B-4', '06/06/2025', 'Local', '', 'Karnataka', 'Repair', '998319', 1, 'Nos', 1000, 1000, 0, 25, 25, 1050, 'Sale'],
      // Cancelled bill → Table 13 cancelled.
      ['B-5', '06/06/2025', 'Local', '', 'Karnataka', 'Widget', '8471', 1, 'Nos', 100, 100, 0, 2.5, 2.5, 105, 'Cancelled'],
      // Export → error, not in B2C.
      ['B-6', '07/06/2025', 'Dubai LLC', '', 'Other Country', 'Widget', '8471', 1, 'Nos', 9000, 9000, 450, 0, 0, 9450, 'Sale'],
      // Large inter-state B2C bill and its return (credit note) → B2CL and CDNUR (B2CL).
      ['B-7', '07/06/2025', 'Walk-in', '', 'Maharashtra', 'Widget', '8471', 100, 'Nos', 1200, 120000, 6000, 0, 0, 126000, 'Sale'],
      ['CN-1', '08/06/2025', 'Walk-in', '', 'Maharashtra', 'Widget', '8471', 100, 'Nos', 1200, 120000, 6000, 0, 0, 126000, 'Return'],
    ] };
    const r = readMarketplaceTables([t], 'sales.xlsx', 'auto', profile.allowedRates);
    // "Rate" 18 is the price; the tax says 5%.
    expect(r.lines[0].rate).toBe(5);
    const out = buildMarketplaceRecords(r.lines, opts('generic'));
    const b2b = of(out.records, 'b2b').map((x) => x.data as { ctin: string; pos: string; val: number });
    expect(b2b).toEqual([expect.objectContaining({ ctin: R_MH, pos: '27', val: 1050.4 })]);
    expect(out.issues.some((i) => i.field === 'ctin' && /27AAACR5055K1ZX/.test(i.message))).toBe(true);
    expect(out.issues.some((i) => i.field === 'iamt' && /B-3/.test(i.message))).toBe(true);
    expect(out.issues.some((i) => i.section === 'exp' && /B-6/.test(i.message))).toBe(true);
    expect(of(out.records, 'b2cs').some((x) => (x.data as { txval: number }).txval >= 9000)).toBe(false);
    expect(of(out.records, 'b2cl').map((x) => x.data)).toEqual([expect.objectContaining({ inum: 'B-7', val: 126000 })]);
    expect(of(out.records, 'cdnur').map((x) => x.data)).toEqual([expect.objectContaining({ ntNum: 'CN-1', urType: 'B2CL', pos: '27', ntty: 'C' })]);
    const sac = [...of(out.records, 'hsn_b2c'), ...of(out.records, 'hsn_b2b')].map((x) => x.data as { hsn: string; uqc: string; qty: number }).find((h) => h.hsn === '998319');
    expect(sac).toMatchObject({ uqc: 'NA', qty: 0 });
    const inv = of(out.records, 'docs').map((x) => x.data as { docTyp: string; cancel: number; totnum: number }).find((d) => d.docTyp === 'Invoices for outward supply');
    expect(inv).toMatchObject({ cancel: 1 });
    expect(validateReturn(out.records, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateGstr1Json(generateGstr1Json(out.records, ctx).json).ok).toBe(true);
  });

  it('a return written as the offline-tool template imports back unchanged', async () => {
    const head = ['Bill No', 'Bill Date', 'Ledger Name', 'GST No', 'Place of Supply', 'Item Name', 'HSN', 'Qty', 'Unit', 'GST Rate', 'Taxable Amount', 'IGST', 'CGST', 'SGST', 'Type'];
    const t: SheetTable = { name: 'Sale Report', rows: [head,
      ['B-1', '05/06/2025', 'Mumbai Traders', R_MH, 'Maharashtra', 'Widget', '8471', 10, 'Nos', 5, 1000, 50, 0, 0, 'Sale'],
      ['B-1', '05/06/2025', 'Mumbai Traders', R_MH, 'Maharashtra', 'Cable', '8544', 5, 'Box', 18, 500, 90, 0, 0, 'Sale'],
      ['B-2', '06/06/2025', 'Walk-in', '', 'Karnataka', 'Widget', '8471', 1, 'Nos', 5, 200, 0, 5, 5, 'Sale'],
      ['B-3', '07/06/2025', 'Walk-in', '', 'Maharashtra', 'Widget', '8471', 100, 'Nos', 5, 120000, 6000, 0, 0, 'Sale'],
      ['B-4', '07/06/2025', 'Walk-in', '', 'Karnataka', 'Medicine', '3004', 10, 'Btl', 0, 900, 0, 0, 0, 'Sale'],
      ['CN-1', '08/06/2025', 'Mumbai Traders', R_MH, 'Maharashtra', 'Widget', '8471', 1, 'Nos', 5, 100, 5, 0, 0, 'Return'],
    ] };
    const built = buildMarketplaceRecords(readMarketplaceTables([t], 's.xlsx', 'auto', profile.allowedRates).lines, opts('generic')).records;
    const wb = new ExcelJS.Workbook();
    addTemplateSheets(wb, built);
    const back = parseGstr1Tables(await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), { supplierGstin: SUPPLIER, hsnSplit: profile.hsnSplit });
    expect(back.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const count = (rs: AnyRecord[]) => Object.fromEntries([...new Set(rs.map((r) => r.section))].map((s) => [s, rs.filter((r) => r.section === s).length]));
    expect(count(back.records)).toEqual(count(built));
    // Same JSON from the re-imported records as from the original ones.
    const strip = (j: Record<string, unknown>) => { const { hash: _h, ...rest } = j; void _h; return rest; };
    expect(strip(generateGstr1Json(back.records, ctx).json)).toEqual(strip(generateGstr1Json(built, ctx).json));
    expect(validateReturn(back.records, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
