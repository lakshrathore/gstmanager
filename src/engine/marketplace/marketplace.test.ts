import { describe, expect, it } from 'vitest';
import { R_KA, R_MH, SUPPLIER } from '../../../scripts/sample-workbook';
import {
  buildMarketplaceRecords, generateGstr1Json, gstinCheckDigit, parseCsv, profileForPeriod, readMarketplaceTables,
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
});
