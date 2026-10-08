import type { SheetTable } from '../excel/parseGstr1';
import { UQC_CODES } from '../masters';
import { norm, parseDate, parseNumber } from '../util';
import { normaliseRate, rateFromTax, type DocLine, type LineKind, type SaleLine } from './build';
import { stateCode } from './states';

/**
 * Report layouts of each marketplace. A sheet is recognised by its header row (column order and
 * extra columns don't matter), then every data row becomes a normalised SaleLine.
 */

export type MarketplaceId = 'amazon' | 'flipkart' | 'meesho' | 'generic';

export const MARKETPLACES: Record<MarketplaceId, { label: string }> = {
  amazon: { label: 'Amazon' },
  flipkart: { label: 'Flipkart' },
  meesho: { label: 'Meesho' },
  generic: { label: 'Sales register (billing software)' },
};

type Get = (key: string) => unknown;
interface RowCtx { file: string; row: number; sheet: string; allowedRates: number[]; has: (key: string) => boolean }

interface FormatDef {
  id: MarketplaceId;
  /** Column keys that must all be found for the sheet to be this format. */
  signature: string[];
  /** key → accepted header spellings (compared after lower-casing and removing non-alphanumerics). */
  columns: Record<string, string[]>;
  toLine?(get: Get, ctx: RowCtx): SaleLine | null;
  /** Document registers (Table 13) instead of sales lines. */
  toDoc?(get: Get, ctx: RowCtx): DocLine | null;
}

/* ---------- value helpers ---------- */

export const num = (v: unknown) => parseNumber(v) ?? 0;
const str = (v: unknown) => (v == null ? '' : String(v).trim());

/** Dates with a time part ("2025-04-03 18:22:10", "03-04-2025 06:22 PM", ISO with zone) → yyyy-mm-dd. */
export function dateOf(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  if (v instanceof Date || typeof v === 'number') return parseDate(v) ?? undefined;
  const s = String(v).trim();
  return parseDate(s) ?? parseDate(s.split(/[ T]/)[0]) ?? undefined;
}

/** A unit as billing software writes it ("Nos", "Box", "Strip", "Bottle", "Kg") → GST UQC; undefined if not known. */
const UNIT_ALIASES: Record<string, string> = {
  NO: 'NOS', NOS: 'NOS', NUMBER: 'NOS', NUMBERS: 'NOS', NUM: 'NOS', UNIT: 'UNT', UNITS: 'UNT', PC: 'PCS', PCS: 'PCS', PIECE: 'PCS', PIECES: 'PCS',
  BOXES: 'BOX', BOTTLE: 'BTL', BOTTLES: 'BTL', BOTL: 'BTL', TAB: 'TBS', TABS: 'TBS', TABLET: 'TBS', TABLETS: 'TBS', KG: 'KGS', KGS: 'KGS', KILO: 'KGS',
  G: 'GMS', GM: 'GMS', GMS: 'GMS', GRAM: 'GMS', GRAMS: 'GMS', L: 'LTR', LT: 'LTR', LTR: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR', ML: 'MLT',
  M: 'MTR', MTR: 'MTR', METER: 'MTR', METRE: 'MTR', PKT: 'PAC', PACK: 'PAC', PACKET: 'PAC', PACKS: 'PAC', DOZEN: 'DOZ', PAIR: 'PRS', PAIRS: 'PRS',
  CARTON: 'CTN', CARTONS: 'CTN', ROLL: 'ROL', ROLLS: 'ROL', TUBE: 'TUB', TUBES: 'TUB', BAGS: 'BAG', SETS: 'SET', TON: 'TON', TONNE: 'TON', QUINTAL: 'QTL',
  STRIP: 'OTH', STRIPS: 'OTH', VIAL: 'NOS', VIALS: 'NOS', AMP: 'NOS', AMPOULE: 'NOS', JAR: 'NOS', CAN: 'CAN', DRUM: 'DRM',
};
export function uqcOf(v: unknown): string | undefined {
  const u = str(v).toUpperCase().replace(/[^A-Z]/g, '');
  if (!u) return undefined;
  if (UNIT_ALIASES[u]) return UNIT_ALIASES[u];
  return UQC_CODES[u] ? u : undefined;
}

/** HSN as digits; numbers from Excel keep their value (leading zeros cannot be recovered). */
const hsnOf = (v: unknown) => str(v).replace(/\.0+$/, '').replace(/\D/g, '');

/** Sum of the rate columns given; each may be a fraction (0.09) or a percent (9). */
function totalRate(get: Get, keys: string[], allowed: number[]): number | null {
  const parts = keys.map((k) => parseNumber(get(k))).filter((n): n is number => n != null && n > 0);
  if (!parts.length) return keys.some((k) => parseNumber(get(k)) === 0) ? 0 : null;
  const asPct = parts.map((p) => (p < 1 ? p * 100 : p));
  return normaliseRate(asPct.reduce((a, b) => a + b, 0), allowed);
}

function line(base: Omit<SaleLine, 'kind'> & { kind?: LineKind }): SaleLine {
  return { kind: 'sale', ...base };
}

/** A negative amount reverses the row's nature: a negative sale is a return, a negative return a sale. */
const kindBySign = (base: 'sale' | 'return', amount: number): LineKind => (amount < 0 ? (base === 'sale' ? 'return' : 'sale') : base);

/* ---------- Amazon MTR (B2C and B2B), CSV ---------- */

const AMAZON: FormatDef = {
  id: 'amazon',
  signature: ['transactionType', 'taxableGross', 'shipToState'],
  columns: {
    sellerGstin: ['Seller Gstin'],
    invoiceNo: ['Invoice Number'],
    invoiceDate: ['Invoice Date'],
    transactionType: ['Transaction Type'],
    qty: ['Quantity'],
    description: ['Item Description'],
    hsn: ['Hsn/sac', 'Hsn Sac', 'HSN'],
    shipToState: ['Ship To State'],
    billToState: ['Bill To State'],
    invoiceAmount: ['Invoice Amount'],
    taxableGross: ['Tax Exclusive Gross'],
    totalTax: ['Total Tax Amount'],
    cgstRate: ['Cgst Rate'], sgstRate: ['Sgst Rate'], utgstRate: ['Utgst Rate'], igstRate: ['Igst Rate'],
    cess: ['Compensatory Cess Tax'],
    buyerGstin: ['Customer Bill To Gstid', 'Customer Ship To Gstid'],
    buyerName: ['Buyer Name'],
    noteNo: ['Credit Note No'],
    noteDate: ['Credit Note Date'],
  },
  toLine(get, ctx) {
    const type = str(get('transactionType')).toLowerCase().replace(/[^a-z]/g, '');
    const base = { file: ctx.file, row: ctx.row, pos: '', hsn: '', qty: 0, rate: null, taxable: 0 };
    if (type === 'freereplacement') return { ...base, kind: 'skip', skipReason: 'Free replacement (no value)' };
    if (!['shipment', 'refund', 'cancel'].includes(type)) return { ...base, kind: 'skip', skipReason: `Transaction type "${str(get('transactionType')) || 'blank'}"` };
    let taxable = parseNumber(get('taxableGross'));
    if (taxable == null) taxable = num(get('invoiceAmount')) - num(get('totalTax'));
    const tax = Math.abs(num(get('totalTax')));
    const rate = totalRate(get, ['igstRate', 'cgstRate', 'sgstRate', 'utgstRate'], ctx.allowedRates) ?? rateFromTax(tax || null, taxable, ctx.allowedRates);
    const state = str(get('shipToState')) || str(get('billToState'));
    return line({
      ...base,
      // Refund / Cancel rows are returns whatever sign the file uses for them.
      kind: type === 'shipment' ? kindBySign('sale', taxable) : 'return',
      cancel: type === 'cancel' || undefined,
      sellerGstin: str(get('sellerGstin')).toUpperCase() || undefined,
      invoiceNo: str(get('invoiceNo')) || undefined, invoiceDate: dateOf(get('invoiceDate')),
      noteNo: str(get('noteNo')) || undefined, noteDate: dateOf(get('noteDate')),
      buyerGstin: str(get('buyerGstin')).toUpperCase() || undefined, buyerName: str(get('buyerName')) || undefined,
      pos: stateCode(state), posRaw: state, hsn: hsnOf(get('hsn')), description: str(get('description')) || undefined,
      qty: Math.abs(num(get('qty'))), rate, taxable: Math.abs(taxable), reportedTax: tax, cess: Math.abs(num(get('cess'))) || undefined,
    });
  },
};

/* ---------- Flipkart Seller Hub "Sales Report" sheet, xlsx ---------- */

const FLIPKART: FormatDef = {
  id: 'flipkart',
  signature: ['eventSubType', 'taxable', 'deliveryState'],
  columns: {
    sellerGstin: ['Seller GSTIN'],
    eventType: ['Event Type'],
    eventSubType: ['Event Sub Type'],
    hsn: ['HSN Code'],
    description: ['Product Title/Description'],
    qty: ['Item Quantity'],
    taxable: ['Taxable Value (Final Invoice Amount -Taxes)', 'Taxable Value'],
    igstRate: ['IGST Rate'], igst: ['IGST Amount'],
    cgstRate: ['CGST Rate'], cgst: ['CGST Amount'],
    sgstRate: ['SGST Rate (or UTGST as applicable)', 'SGST Rate'], sgst: ['SGST Amount (Or UTGST as applicable)', 'SGST Amount'],
    cess: ['Luxury Cess Amount'],
    invoiceNo: ['Buyer Invoice ID'],
    invoiceDate: ['Buyer Invoice Date'],
    orderDate: ['Order Date'],
    deliveryState: ["Customer's Delivery State", 'Customers Delivery State'],
    billingState: ["Customer's Billing State"],
    buyerGstin: ['Buyer GSTIN', "Customer's GSTIN", 'Customer GSTIN'],
  },
  toLine(get, ctx) {
    const sub = str(get('eventSubType')).toLowerCase().replace(/[^a-z]/g, '');
    const base = { file: ctx.file, row: ctx.row, pos: '', hsn: '', qty: 0, rate: null, taxable: 0 };
    const taxable = num(get('taxable'));
    let kind: LineKind;
    let cancel = false;
    if (sub === 'sale' || sub === 'returncancellation') kind = kindBySign('sale', taxable);
    else if (sub === 'return') kind = 'return';
    else if (sub === 'cancellation') { kind = 'return'; cancel = true; }
    else return { ...base, kind: 'skip', skipReason: `Event "${str(get('eventSubType')) || 'blank'}"` };
    const tax = Math.abs(num(get('igst'))) + Math.abs(num(get('cgst'))) + Math.abs(num(get('sgst')));
    const rate = totalRate(get, ['igstRate', 'cgstRate', 'sgstRate'], ctx.allowedRates) ?? rateFromTax(tax || null, taxable, ctx.allowedRates);
    const state = str(get('deliveryState')) || str(get('billingState'));
    return line({
      ...base, kind, cancel: cancel || undefined,
      sellerGstin: str(get('sellerGstin')).toUpperCase() || undefined,
      invoiceNo: str(get('invoiceNo')) || undefined, invoiceDate: dateOf(get('invoiceDate')) ?? dateOf(get('orderDate')),
      buyerGstin: str(get('buyerGstin')).toUpperCase() || undefined,
      pos: stateCode(state), posRaw: state, hsn: hsnOf(get('hsn')), description: str(get('description')) || undefined,
      qty: Math.abs(num(get('qty'))), rate, taxable: Math.abs(taxable), reportedTax: tax, cess: Math.abs(num(get('cess'))) || undefined,
    });
  },
};

/* ---------- Meesho GST report: tcs_sales.xlsx, tcs_sales_return.xlsx, Tax_invoice_details.xlsx ---------- */

const MEESHO: FormatDef = {
  id: 'meesho',
  signature: ['subOrder', 'taxable', 'state'],
  columns: {
    sellerGstin: ['gstin'],
    ecoGstin: ['eco_tcs_gstin'],
    subOrder: ['sub_order_num'],
    orderDate: ['order_date'],
    returnDate: ['cancel_return_date'],
    hsn: ['hsn_code'],
    qty: ['quantity'],
    rate: ['gst_rate'],
    taxable: ['total_taxable_sale_value'],
    tax: ['tax_amount'],
    state: ['end_customer_state_new', 'end_customer_state'],
  },
  toLine(get, ctx) {
    // The returns file has a cancel_return_date column (and "return" in its name); its amounts are positive.
    const isReturnFile = ctx.has('returnDate') || /return/i.test(ctx.file);
    const taxable = num(get('taxable'));
    const tax = num(get('tax'));
    const rate = normaliseRate(parseNumber(get('rate')), ctx.allowedRates) ?? rateFromTax(tax || null, taxable, ctx.allowedRates);
    const state = str(get('state'));
    const date = dateOf(isReturnFile ? get('returnDate') : get('orderDate')) ?? dateOf(get('orderDate'));
    return line({
      file: ctx.file, row: ctx.row,
      // Returns file amounts are positive; Meesho's negative adjustment lines flip the row.
      kind: kindBySign(isReturnFile ? 'return' : 'sale', taxable),
      sellerGstin: str(get('sellerGstin')).toUpperCase() || undefined,
      ecoGstin: str(get('ecoGstin')).toUpperCase() || undefined,
      invoiceDate: date, noteDate: isReturnFile ? date : undefined,
      pos: stateCode(state), posRaw: state, hsn: hsnOf(get('hsn')),
      qty: Math.abs(num(get('qty'))), rate, taxable: Math.abs(taxable), reportedTax: Math.abs(tax),
    });
  },
};

const MEESHO_DOCS: FormatDef = {
  id: 'meesho',
  signature: ['type', 'invoiceNo', 'subOrder'],
  columns: { type: ['Type'], invoiceNo: ['Invoice No.', 'Invoice No'], subOrder: ['Suborder No.', 'Suborder No', 'Sub Order No'] },
  toDoc(get) {
    const t = str(get('type')).toUpperCase();
    const number = str(get('invoiceNo'));
    if (!number) return null;
    if (t === 'INVOICE') return { type: 'invoice', number };
    if (t.startsWith('CREDIT')) return { type: 'credit', number };
    return null;
  },
};

/* ---------- generic sales register ---------- */

const GENERIC: FormatDef = {
  id: 'generic',
  signature: ['taxable', 'state'],
  columns: {
    type: ['type', 'transaction type', 'transactiontype', 'voucher type', 'document type', 'doc type', 'sale/return', 'event'],
    invoiceNo: ['invoice no', 'invoice number', 'invoice no.', 'bill no', 'voucher no', 'document no', 'doc no'],
    invoiceDate: ['invoice date', 'date', 'bill date', 'voucher date', 'document date'],
    noteNo: ['credit note no', 'credit note number', 'cn no', 'return no'],
    noteDate: ['credit note date', 'cn date', 'return date'],
    buyerGstin: ['customer gstin', 'buyer gstin', 'gstin of recipient', 'party gstin', 'recipient gstin', 'gstin', 'gst no', 'gst no.', 'gst number', 'gstin no', 'gstin/uin', 'party gst no'],
    buyerName: ['customer name', 'buyer name', 'party name', 'receiver name', 'ledger name', 'party', 'customer', 'ledger'],
    state: ['place of supply', 'pos', 'state', 'customer state', 'ship to state', 'delivery state', 'state of supply'],
    hsn: ['hsn', 'hsn code', 'hsn/sac', 'hsn sac', 'sac'],
    description: ['item', 'item name', 'product', 'description', 'product name'],
    qty: ['qty', 'quantity', 'units'],
    freeQty: ['free qty', 'free quantity', 'scheme qty', 'bonus qty'],
    unit: ['unit', 'uqc', 'uom', 'unit of measure', 'qty unit'],
    rate: ['gst rate', 'rate', 'tax rate', 'gst %', 'gst', 'rate %'],
    taxable: ['taxable value', 'taxable amount', 'taxable', 'assessable value', 'net amount'],
    igst: ['igst', 'igst amount'],
    cgst: ['cgst', 'cgst amount'],
    sgst: ['sgst', 'sgst amount', 'sgst/utgst', 'utgst'],
    cess: ['cess', 'cess amount'],
    sellerGstin: ['seller gstin', 'supplier gstin', 'our gstin'],
  },
  toLine(get, ctx) {
    // Total / summary rows at the end of a report: no bill, item, HSN or state – or labelled "Total".
    const label = `${str(get('invoiceNo'))} ${str(get('buyerName'))}`.trim();
    if (/^(grand\s*)?(sub\s*)?total\b/i.test(label) || (!str(get('invoiceNo')) && !str(get('hsn')) && !str(get('description')) && !stateCode(get('state')))) {
      return line({ file: ctx.file, row: ctx.row, kind: 'skip', skipReason: 'Total or summary row', pos: '', hsn: '', qty: 0, rate: null, taxable: 0 });
    }
    const type = str(get('type')).toLowerCase();
    // A separate sale-return / credit-note report (same columns, positive amounts) is recognised by its
    // sheet or file name, or by a filled credit-note number.
    const returnReport = !type && (/return|credit\s*note|\bcn\b/i.test(`${ctx.sheet} ${ctx.file}`) || !!str(get('noteNo')));
    const named: LineKind = /return|credit|refund|cn\b/.test(type) || returnReport ? 'return' : /cancel/.test(type) ? 'skip' : 'sale';
    const taxable = num(get('taxable'));
    const kind: LineKind = named === 'sale' && taxable < 0 ? 'return' : named;
    const reportedTax = Math.abs(num(get('igst'))) + Math.abs(num(get('cgst'))) + Math.abs(num(get('sgst')));
    const rate = normaliseRate(parseNumber(get('rate')), ctx.allowedRates) ?? rateFromTax(reportedTax || null, taxable, ctx.allowedRates);
    return line({
      file: ctx.file, row: ctx.row, kind, skipReason: kind === 'skip' ? 'Cancelled' : undefined,
      sellerGstin: str(get('sellerGstin')).toUpperCase() || undefined,
      invoiceNo: str(get('invoiceNo')) || undefined, invoiceDate: dateOf(get('invoiceDate')),
      // In a return report the bill number is the credit note's own number.
      noteNo: str(get('noteNo')) || (kind === 'return' ? str(get('invoiceNo')) : '') || undefined,
      noteDate: dateOf(get('noteDate')) ?? (kind === 'return' ? dateOf(get('invoiceDate')) : undefined),
      buyerGstin: str(get('buyerGstin')).toUpperCase() || undefined, buyerName: str(get('buyerName')) || undefined,
      pos: stateCode(get('state')), posRaw: str(get('state')), hsn: hsnOf(get('hsn')), description: str(get('description')) || undefined,
      // Free (scheme) quantity is supplied too, so it counts in the HSN quantity.
      qty: Math.abs(num(get('qty'))) + Math.abs(num(get('freeQty'))), uqc: uqcOf(get('unit')),
      rate, taxable: Math.abs(taxable), reportedTax: reportedTax || undefined, cess: Math.abs(num(get('cess'))) || undefined,
    });
  },
};

/* ---------- registry & reader ---------- */

/** Marketplace formats first – their signatures are specific; the generic register is the fallback. */
export const FORMATS: FormatDef[] = [AMAZON, FLIPKART, MEESHO, MEESHO_DOCS, GENERIC];

function mapHeader(table: SheetTable, def: FormatDef) {
  const limit = Math.min(table.rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const cells = (table.rows[r] ?? []).map(norm);
    const map = new Map<string, number>();
    // Aliases are in order of preference: with both "GST Rate" and "Rate" (the price) in the sheet,
    // the rate is read from "GST Rate".
    for (const [key, aliases] of Object.entries(def.columns)) {
      for (const a of aliases) {
        const idx = cells.findIndex((c) => c && c === norm(a));
        if (idx >= 0) { map.set(key, idx); break; }
      }
    }
    if (def.signature.every((k) => map.has(k))) return { rowIdx: r, map };
  }
  return null;
}

export interface ReadResult {
  marketplace: MarketplaceId | null;
  lines: SaleLine[];
  docs: DocLine[];
  skipped: { file: string; reason: string }[];
}

export function readMarketplaceTables(tables: SheetTable[], file: string, hint: MarketplaceId | 'auto', allowedRates: number[]): ReadResult {
  const out: ReadResult = { marketplace: null, lines: [], docs: [], skipped: [] };
  const defs = hint === 'auto' ? FORMATS : FORMATS.filter((f) => f.id === hint);
  for (const table of tables) {
    let found: { def: FormatDef; header: { rowIdx: number; map: Map<string, number> } } | null = null;
    for (const def of defs) {
      const header = mapHeader(table, def);
      if (header) { found = { def, header }; break; }
    }
    if (!found) {
      if (/cash\s*back/i.test(table.name)) {
        out.skipped.push({ file: table.name, reason: 'Flipkart cash-back sheet is not imported – cashback is a post-sale discount; ask your CA whether to issue credit notes for it' });
      } else if (/help|summary|instruction/i.test(table.name)) {
        continue;
      } else if (table.rows.some((r) => r?.some((c) => c != null && String(c).trim() !== ''))) {
        out.skipped.push({ file: table.name, reason: hint === 'auto' ? 'Not a recognised marketplace sales report' : `Columns do not match the ${MARKETPLACES[hint].label} report` });
      }
      continue;
    }
    if (out.marketplace && out.marketplace !== found.def.id) {
      out.skipped.push({ file: table.name, reason: `Looks like a ${MARKETPLACES[found.def.id].label} report – import it separately` });
      continue;
    }
    out.marketplace = found.def.id;
    const { rowIdx, map } = found.header;
    for (let r = rowIdx + 1; r < table.rows.length; r++) {
      const cells = table.rows[r] ?? [];
      if (!cells.some((c) => c != null && String(c).trim() !== '')) continue;
      const get: Get = (k) => (map.has(k) ? cells[map.get(k)!] : undefined);
      const rc: RowCtx = { file, row: r + 1, sheet: table.name, allowedRates, has: (k) => map.has(k) };
      if (found.def.toDoc) {
        const d = found.def.toDoc(get, rc);
        if (d) out.docs.push(d);
        continue;
      }
      const l = found.def.toLine?.(get, rc);
      if (l) out.lines.push(l);
    }
  }
  return out;
}
