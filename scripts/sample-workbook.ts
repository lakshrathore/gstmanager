import ExcelJS from 'exceljs';
import { gstinCheckDigit } from '../src/engine/util';

export const withCheck = (first14: string) => first14 + gstinCheckDigit(first14);
export const SUPPLIER = withCheck('29AABCS1234Q1Z'); // Karnataka
export const R_MH = withCheck('27AAACR5055K1Z');
export const R_KA = withCheck('29AADCB2230M1Z');

type Rows = (string | number | Date | null)[][];

function sheet(wb: ExcelJS.Workbook, name: string, headers: string[], rows: Rows) {
  const ws = wb.addWorksheet(name);
  ws.addRow([`Summary For ${name}`]);
  ws.addRow(['(summary row)']);
  ws.addRow([]);
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
}

/**
 * Offline-tool style workbook for April 2025 (pre HSN-split) / any period.
 * `withErrors` injects realistic mistakes to exercise the validator.
 */
export async function buildSampleWorkbook(withErrors = true): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const d = (s: string) => s; // offline template stores dates as dd-MMM-yy text

  sheet(wb, 'b2b,sez,de', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'], [
    [R_MH, 'Rao Industries', 'INV/001', d('05-Jun-2025'), 23600, '27-Maharashtra', 'N', null, 'Regular B2B', null, 18, 20000, 0],
    [R_KA, 'Bharat Traders', 'INV/002', d('10-Jun-2025'), 16800, '29-Karnataka', 'N', null, 'Regular B2B', null, 12, 10000, 0],
    [R_KA, 'Bharat Traders', 'INV/002', d('10-Jun-2025'), 16800, '29-Karnataka', 'N', null, 'Regular B2B', null, 5, 4000, 0],
    [withErrors ? '27AAACR5055K1ZX' : R_MH, 'Typo Ltd', 'INV/003', d('12-Jun-2025'), 11800, '27-Maharashtra', 'N', null, 'Regular B2B', null, 18, 10000, 0],
    [withErrors ? R_KA : R_MH, 'Rao Industries', withErrors ? 'INV/001' : 'INV/004', d('15-Jun-2025'), 5900, '27-Maharashtra', 'N', null, 'Regular B2B', null, 18, 5000, 0],
    [R_MH, 'Rao Industries', 'INV/005', withErrors ? d('03-Jul-2025') : d('20-Jun-2025'), 1180, '27-Maharashtra', 'N', null, 'Regular B2B', null, withErrors ? 17 : 18, 1000, 0],
  ]);
  sheet(wb, 'b2cl', ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], [
    ['B2CL/01', d('18-Jun-2025'), 236000, '07-Delhi', null, 18, 200000, 0, null],
    ...(withErrors ? [['B2CL/02', d('19-Jun-2025'), 59000, '07-Delhi', null, 18, 50000, 0, null]] : []),
  ]);
  sheet(wb, 'b2cs', ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], [
    ['OE', '29-Karnataka', null, 18, 50000, 0, null],
    ['OE', '33-Tamil Nadu', null, 12, 8000, 0, null],
  ]);
  sheet(wb, 'cdnr', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'], [
    [R_KA, 'Bharat Traders', 'CN/001', d('25-Jun-2025'), 'C', '29-Karnataka', 'N', 'Regular B2B', 1120, null, 12, 1000, 0],
  ]);
  sheet(wb, 'exp', ['Export Type', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value', 'Cess Amount'], [
    ['WPAY', 'EXP/001', d('22-Jun-2025'), 354000, 'INBLR4', '1234567', d('24-Jun-2025'), 18, 300000, 0],
  ]);
  sheet(wb, 'exemp', ['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'], [
    ['Intra-State supplies to unregistered persons', 5000, 2000, 0],
  ]);
  sheet(wb, 'hsn(b2b)', ['HSN', 'Description', 'UQC', 'Total Quantity', 'Taxable Value', 'Rate', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'], [
    ['8471', 'Computers', 'NOS', 10, 36000, 18, 6480, 0, 0, 0],
    ['8473', 'Parts', 'NOS', 50, 9000, 12, 0, 540, 540, 0],
    ['8504', 'Adapters', 'PCS', 40, 4000, 5, 0, 100, 100, 0],
    ...(withErrors ? [['998314', 'IT services', 'NOS', 1, 0, 18, 0, 0, 0, 0]] : []),
  ]);
  sheet(wb, 'hsn(b2c)', ['HSN', 'Description', 'UQC', 'Total Quantity', 'Taxable Value', 'Rate', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'], [
    ['8471', 'Computers', 'NOS', 20, 250000, 18, 36000, 4500, 4500, 0],
    ['8473', 'Parts', 'NOS', 30, 8000, 12, 960, 0, 0, 0],
    ['8473', 'Parts', 'NOS', 300, 300000, 18, 54000, 0, 0, 0],
  ]);
  sheet(wb, 'docs', ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'], [
    ['Invoices for outward supply', 'INV/001', 'INV/005', 5, 0],
    ['Credit Note', 'CN/001', 'CN/001', 1, 0],
  ]);
  wb.addWorksheet('b2ba').addRow(['Summary']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// CLI: npx tsx scripts/sample-workbook.ts [out.xlsx] [--clean]
if (process.argv[1]?.endsWith('sample-workbook.ts')) {
  const out = process.argv[2] ?? 'sample-gstr1.xlsx';
  buildSampleWorkbook(!process.argv.includes('--clean')).then(async (b) => {
    (await import('node:fs')).writeFileSync(out, b);
    console.log(`Wrote ${out} (supplier GSTIN ${SUPPLIER})`);
  });
}
