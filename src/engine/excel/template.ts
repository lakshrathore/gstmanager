import type { Section } from '../types';

/**
 * Mapping of the GSTR-1 offline-tool Excel template (sheet names + column headers) to internal fields.
 * Header matching is case/punctuation-insensitive and order-independent, so column re-ordering
 * in newer templates doesn't break import. Add aliases here when GSTN renames a column.
 */
export interface ColumnDef {
  key: string;
  headers: string[];
  required?: boolean;
}

export interface SheetDef {
  section: Section;
  sheetNames: string[];
  columns: ColumnDef[];
}

const RATE: ColumnDef = { key: 'rt', headers: ['Rate'], required: true };
const TXVAL: ColumnDef = { key: 'txval', headers: ['Taxable Value'], required: true };
const CESS: ColumnDef = { key: 'csamt', headers: ['Cess Amount'] };
const DIFF: ColumnDef = { key: 'diffPercent', headers: ['Applicable % of Tax Rate'] };
const POS: ColumnDef = { key: 'pos', headers: ['Place Of Supply'], required: true };
const ETIN: ColumnDef = { key: 'etin', headers: ['E-Commerce GSTIN'] };
// Optional tax columns – present in some ERP exports; if absent, tax is computed.
const TAX_COLS: ColumnDef[] = [
  { key: 'iamt', headers: ['Integrated Tax Amount', 'Integrated Tax', 'IGST Amount', 'IGST'] },
  { key: 'camt', headers: ['Central Tax Amount', 'Central Tax', 'CGST Amount', 'CGST'] },
  { key: 'samt', headers: ['State/UT Tax Amount', 'State/UT Tax', 'SGST/UTGST Amount', 'SGST Amount', 'SGST'] },
];

export const SHEETS: SheetDef[] = [
  {
    section: 'b2b',
    sheetNames: ['b2b,sez,de', 'b2b'],
    columns: [
      { key: 'ctin', headers: ['GSTIN/UIN of Recipient'], required: true },
      { key: 'receiverName', headers: ['Receiver Name'] },
      { key: 'inum', headers: ['Invoice Number'], required: true },
      { key: 'idt', headers: ['Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      POS,
      { key: 'rchrg', headers: ['Reverse Charge'] },
      DIFF,
      { key: 'invTyp', headers: ['Invoice Type'] },
      ETIN, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'b2cl',
    sheetNames: ['b2cl'],
    columns: [
      { key: 'inum', headers: ['Invoice Number'], required: true },
      { key: 'idt', headers: ['Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      POS, DIFF, RATE, TXVAL, CESS, ETIN, ...TAX_COLS,
    ],
  },
  {
    section: 'b2cs',
    sheetNames: ['b2cs'],
    columns: [{ key: 'typ', headers: ['Type'], required: true }, POS, DIFF, RATE, TXVAL, CESS, ETIN, ...TAX_COLS],
  },
  {
    section: 'cdnr',
    sheetNames: ['cdnr'],
    columns: [
      { key: 'ctin', headers: ['GSTIN/UIN of Recipient'], required: true },
      { key: 'receiverName', headers: ['Receiver Name'] },
      { key: 'ntNum', headers: ['Note Number', 'Note/Refund Voucher Number'], required: true },
      { key: 'ntDt', headers: ['Note Date', 'Note/Refund Voucher date'], required: true },
      { key: 'ntty', headers: ['Note Type', 'Document Type'], required: true },
      POS,
      { key: 'rchrg', headers: ['Reverse Charge'] },
      { key: 'invTyp', headers: ['Note Supply Type'] },
      { key: 'val', headers: ['Note Value', 'Note/Refund Voucher Value'], required: true },
      DIFF, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'cdnur',
    sheetNames: ['cdnur'],
    columns: [
      { key: 'urType', headers: ['UR Type'], required: true },
      { key: 'ntNum', headers: ['Note Number', 'Note/Refund Voucher Number'], required: true },
      { key: 'ntDt', headers: ['Note Date', 'Note/Refund Voucher date'], required: true },
      { key: 'ntty', headers: ['Note Type', 'Document Type'], required: true },
      { key: 'pos', headers: ['Place Of Supply'] },
      { key: 'val', headers: ['Note Value', 'Note/Refund Voucher Value'], required: true },
      DIFF, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'exp',
    sheetNames: ['exp'],
    columns: [
      { key: 'expTyp', headers: ['Export Type'], required: true },
      { key: 'inum', headers: ['Invoice Number'], required: true },
      { key: 'idt', headers: ['Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      { key: 'portCode', headers: ['Port Code'] },
      { key: 'sbNum', headers: ['Shipping Bill Number'] },
      { key: 'sbDt', headers: ['Shipping Bill Date'] },
      RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'at',
    sheetNames: ['at'],
    columns: [POS, DIFF, RATE, { key: 'adAmt', headers: ['Gross Advance Received'], required: true }, CESS, ...TAX_COLS],
  },
  {
    section: 'txpd',
    sheetNames: ['atadj'],
    columns: [POS, DIFF, RATE, { key: 'adAmt', headers: ['Gross Advance Adjusted'], required: true }, CESS, ...TAX_COLS],
  },
  {
    section: 'nil',
    sheetNames: ['exemp'],
    columns: [
      { key: 'desc', headers: ['Description'], required: true },
      { key: 'nilAmt', headers: ['Nil Rated Supplies'] },
      { key: 'exptAmt', headers: ['Exempted(other than nil rated/non GST supply)', 'Exempted (other than nil rated/non GST supply)', 'Exempted'] },
      { key: 'ngsupAmt', headers: ['Non-GST Supplies', 'Non GST Supplies'] },
    ],
  },
  ...(['hsn_b2b', 'hsn_b2c'] as const).map<SheetDef>((section) => ({
    section,
    sheetNames: section === 'hsn_b2b' ? ['hsn(b2b)', 'hsn b2b', 'hsn'] : ['hsn(b2c)', 'hsn b2c'],
    columns: [
      { key: 'hsn', headers: ['HSN', 'HSN/SAC'], required: true },
      { key: 'desc', headers: ['Description'] },
      { key: 'uqc', headers: ['UQC'], required: true },
      { key: 'qty', headers: ['Total Quantity'] },
      { key: 'rt', headers: ['Rate'] },
      TXVAL,
      { key: 'iamt', headers: ['Integrated Tax Amount'] },
      { key: 'camt', headers: ['Central Tax Amount'] },
      { key: 'samt', headers: ['State/UT Tax Amount'] },
      CESS,
    ],
  })),
  {
    section: 'docs',
    sheetNames: ['docs'],
    columns: [
      { key: 'docTyp', headers: ['Nature of Document'], required: true },
      { key: 'from', headers: ['Sr. No. From'], required: true },
      { key: 'to', headers: ['Sr. No. To'], required: true },
      { key: 'totnum', headers: ['Total Number'], required: true },
      { key: 'cancel', headers: ['Cancelled'] },
    ],
  },
  /* ---------- amendments (offline tool template V2.2, row-4 headers) ---------- */
  {
    section: 'b2ba',
    sheetNames: ['b2ba'],
    columns: [
      { key: 'ctin', headers: ['GSTIN/UIN of Recipient'], required: true },
      { key: 'receiverName', headers: ['Receiver Name'] },
      { key: 'oinum', headers: ['Original Invoice Number'], required: true },
      { key: 'oidt', headers: ['Original Invoice date'], required: true },
      { key: 'inum', headers: ['Revised Invoice Number'], required: true },
      { key: 'idt', headers: ['Revised Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      POS,
      { key: 'rchrg', headers: ['Reverse Charge'] },
      DIFF,
      { key: 'invTyp', headers: ['Invoice Type'] },
      ETIN, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'b2cla',
    sheetNames: ['b2cla'],
    columns: [
      { key: 'oinum', headers: ['Original Invoice Number'], required: true },
      { key: 'oidt', headers: ['Original Invoice date'], required: true },
      { key: 'pos', headers: ['Original Place Of Supply', 'Place Of Supply'], required: true },
      { key: 'inum', headers: ['Revised Invoice Number'], required: true },
      { key: 'idt', headers: ['Revised Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      DIFF, RATE, TXVAL, CESS, ETIN, ...TAX_COLS,
    ],
  },
  {
    section: 'b2csa',
    sheetNames: ['b2csa'],
    columns: [
      { key: 'fy', headers: ['Financial Year'], required: true },
      { key: 'omonth', headers: ['Original Month'], required: true },
      POS,
      { key: 'typ', headers: ['Type'], required: true },
      DIFF, RATE, TXVAL, CESS, ETIN, ...TAX_COLS,
    ],
  },
  {
    section: 'cdnra',
    sheetNames: ['cdnra'],
    columns: [
      { key: 'ctin', headers: ['GSTIN/UIN of Recipient'], required: true },
      { key: 'receiverName', headers: ['Receiver Name'] },
      { key: 'ontNum', headers: ['Original Note Number'], required: true },
      { key: 'ontDt', headers: ['Original Note Date'], required: true },
      { key: 'ntNum', headers: ['Revised Note Number'], required: true },
      { key: 'ntDt', headers: ['Revised Note Date'], required: true },
      { key: 'ntty', headers: ['Note Type'], required: true },
      POS,
      { key: 'rchrg', headers: ['Reverse Charge'] },
      { key: 'invTyp', headers: ['Note Supply Type'] },
      { key: 'val', headers: ['Note Value'], required: true },
      DIFF, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'cdnura',
    sheetNames: ['cdnura'],
    columns: [
      { key: 'urType', headers: ['UR Type'], required: true },
      { key: 'ontNum', headers: ['Original Note Number'], required: true },
      { key: 'ontDt', headers: ['Original Note Date'], required: true },
      { key: 'ntNum', headers: ['Revised Note Number'], required: true },
      { key: 'ntDt', headers: ['Revised Note Date'], required: true },
      { key: 'ntty', headers: ['Note Type'], required: true },
      { key: 'pos', headers: ['Place Of Supply'] },
      { key: 'val', headers: ['Note Value'], required: true },
      DIFF, RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  {
    section: 'expa',
    sheetNames: ['expa'],
    columns: [
      { key: 'expTyp', headers: ['Export Type'], required: true },
      { key: 'oinum', headers: ['Original Invoice Number'], required: true },
      { key: 'oidt', headers: ['Original Invoice date'], required: true },
      { key: 'inum', headers: ['Revised Invoice Number'], required: true },
      { key: 'idt', headers: ['Revised Invoice date'], required: true },
      { key: 'val', headers: ['Invoice Value'], required: true },
      { key: 'portCode', headers: ['Port Code'] },
      { key: 'sbNum', headers: ['Shipping Bill Number'] },
      { key: 'sbDt', headers: ['Shipping Bill Date'] },
      RATE, TXVAL, CESS, ...TAX_COLS,
    ],
  },
  ...(['ata', 'txpda'] as const).map<SheetDef>((section) => ({
    section,
    sheetNames: section === 'ata' ? ['ata'] : ['atadja'],
    columns: [
      { key: 'fy', headers: ['Financial Year'], required: true },
      { key: 'omonth', headers: ['Original Month'], required: true },
      { key: 'pos', headers: ['Original Place Of Supply', 'Place Of Supply'], required: true },
      DIFF, RATE,
      { key: 'adAmt', headers: [section === 'ata' ? 'Gross Advance Received' : 'Gross Advance Adjusted'], required: true },
      CESS, ...TAX_COLS,
    ],
  })),
];

/** Sheets that exist in the offline template but are not imported yet (reported, never silently dropped). */
export const KNOWN_UNSUPPORTED: Record<string, string> = {
  eco: 'Supplies through ECO (Table 14) – not supported in this version',
  ecoa: 'Amendment of ECO supplies – not supported in this version',
  'ecob2b': 'ECO 9(5) B2B (Table 15) – not supported in this version',
  'ecourp2b': 'ECO 9(5) URP2B (Table 15) – not supported in this version',
  'ecob2c': 'ECO 9(5) B2C (Table 15) – not supported in this version',
  'ecourp2c': 'ECO 9(5) URP2C (Table 15) – not supported in this version',
};
