import type { SheetTable } from '../excel/parseGstr1';
import { stateCode } from '../marketplace/states';
import { norm, parseDate, parseNumber, round2 } from '../util';
import { docKey } from './normalize';
import type { PurchaseDoc, PurchaseDocType } from './types';

/**
 * Purchase register (books) reader. Column names vary between Tally, Busy, Zoho, Excel registers…
 * so each field accepts several spellings; for each field the first alias found in the header wins.
 * Rate-wise rows of the same document (same supplier GSTIN + type + number) are added together.
 */

export const BOOKS_COLUMNS: Record<string, string[]> = {
  supplierGstin: ['GSTIN of Supplier', 'Supplier GSTIN', 'GSTIN/UIN of Supplier', 'GSTIN/UIN', 'Party GSTIN', 'Vendor GSTIN', 'GSTIN', 'GST No', 'GST Number'],
  supplierName: ['Supplier Name', 'Trade/Legal Name', 'Party Name', 'Vendor Name', 'Name of Supplier', 'Particulars', 'Party'],
  docNo: ['Supplier Invoice No', 'Supplier Invoice Number', 'Supplier Inv No', 'Invoice No', 'Invoice Number', 'Bill No', 'Bill Number', 'Note No', 'Note Number', 'Document No', 'Document Number', 'Doc No', 'Reference No', 'Ref No'],
  docDate: ['Supplier Invoice Date', 'Invoice Date', 'Bill Date', 'Note Date', 'Document Date', 'Doc Date', 'Date'],
  docType: ['Document Type', 'Doc Type', 'Note Type', 'Invoice Type', 'Voucher Type', 'Type'],
  pos: ['Place of Supply', 'POS', 'State'],
  rcm: ['Reverse Charge', 'Supply Attract Reverse Charge', 'RCM'],
  taxable: ['Taxable Value', 'Taxable Amount', 'Assessable Value', 'Taxable'],
  rate: ['GST Rate', 'Tax Rate', 'Rate (%)', 'Rate'],
  igst: ['Integrated Tax', 'Integrated Tax Amount', 'IGST Amount', 'IGST'],
  cgst: ['Central Tax', 'Central Tax Amount', 'CGST Amount', 'CGST'],
  sgst: ['State/UT Tax', 'State Tax', 'SGST/UTGST', 'SGST Amount', 'SGST', 'UTGST'],
  cess: ['Cess Amount', 'Cess'],
  invoiceValue: ['Invoice Value', 'Bill Amount', 'Invoice Amount', 'Gross Total', 'Total Amount', 'Total'],
};

const REQUIRED = ['supplierGstin', 'docNo', 'taxable'];

function mapHeader(table: SheetTable) {
  for (let r = 0; r < Math.min(table.rows.length, 30); r++) {
    const cells = (table.rows[r] ?? []).map(norm);
    const map = new Map<string, number>();
    for (const [key, aliases] of Object.entries(BOOKS_COLUMNS)) {
      for (const a of aliases) {
        const idx = cells.findIndex((c, i) => c === norm(a) && ![...map.values()].includes(i));
        if (idx >= 0) { map.set(key, idx); break; }
      }
    }
    // A "Voucher Type" column is the buyer's own voucher (Tally): its debit note is the supplier's credit note.
    const voucherType = map.has('docType') && cells[map.get('docType')!] === norm('Voucher Type');
    if (REQUIRED.every((k) => map.has(k))) return { rowIdx: r, map, voucherType };
  }
  return null;
}

/**
 * Supplier-side document type. In a document/note type column the value is the supplier's document.
 * In a buyer's voucher type (Tally "Debit Note" = purchase return) it is the opposite note.
 */
export function docTypeOf(v: unknown, voucherType = false): PurchaseDocType {
  const s = String(v ?? '').trim().toUpperCase();
  if (/PURCHASE\s*RETURN|RETURN\s*OUTWARD/.test(s)) return 'CN';
  const credit = /CREDIT|^C$|^CN$|^CDN/.test(s);
  const debit = /DEBIT|^D$|^DN$/.test(s);
  if (voucherType) return debit ? 'CN' : credit ? 'DN' : 'INV';
  return credit ? 'CN' : debit ? 'DN' : 'INV';
}

const yes = (v: unknown) => /^(Y|YES|TRUE|1)$/i.test(String(v ?? '').trim());
const isoDate = (v: unknown) => (v instanceof Date || typeof v === 'number' ? parseDate(v) : parseDate(String(v ?? '').trim().split(/[ T]/)[0])) ?? '';

export interface BooksReadResult {
  docs: PurchaseDoc[];
  skipped: { sheet: string; reason: string }[];
  issues: { sheet: string; row: number; message: string }[];
}

export function readPurchaseRegister(tables: SheetTable[], file: string, period: string, recipientGstin: string): BooksReadResult {
  const out: BooksReadResult = { docs: [], skipped: [], issues: [] };
  const byKey = new Map<string, PurchaseDoc>();
  for (const table of tables) {
    const h = mapHeader(table);
    if (!h) {
      if (table.rows.some((r) => r?.some((c) => c != null && String(c).trim() !== ''))) {
        out.skipped.push({ sheet: table.name, reason: 'No purchase register header found (needs supplier GSTIN, invoice number and taxable value columns)' });
      }
      continue;
    }
    const supplierState = recipientGstin.slice(0, 2);
    for (let r = h.rowIdx + 1; r < table.rows.length; r++) {
      const cells = table.rows[r] ?? [];
      const get = (k: string) => (h.map.has(k) ? cells[h.map.get(k)!] : undefined);
      const gstin = String(get('supplierGstin') ?? '').trim().toUpperCase();
      const no = String(get('docNo') ?? '').trim();
      if (!gstin && !no) continue;
      if (/^(total|grand total)/i.test(String(cells.find((c) => c != null && String(c).trim()) ?? ''))) continue;
      if (!gstin || !no) { out.issues.push({ sheet: table.name, row: r + 1, message: !gstin ? 'Supplier GSTIN missing – row skipped (unregistered purchases have no ITC to reconcile)' : 'Invoice number missing – row skipped' }); continue; }
      const type = docTypeOf(get('docType'), h.voucherType);
      const taxable = Math.abs(parseNumber(get('taxable')) ?? 0);
      let igst = Math.abs(parseNumber(get('igst')) ?? 0);
      let cgst = Math.abs(parseNumber(get('cgst')) ?? 0);
      let sgst = Math.abs(parseNumber(get('sgst')) ?? 0);
      const rate = parseNumber(get('rate'));
      const posRaw = get('pos');
      const pos = posRaw != null && String(posRaw).trim() ? stateCode(posRaw) : '';
      if (!h.map.has('igst') && !h.map.has('cgst') && rate != null) {
        // Register without tax columns: compute from rate (inter-state when supplier state ≠ place of supply/us).
        const tax = (taxable * rate) / 100;
        const inter = (pos || supplierState) !== gstin.slice(0, 2);
        if (inter) igst = round2(tax); else { cgst = round2(tax / 2); sgst = round2(tax / 2); }
      }
      const key = docKey('books', gstin, type, no);
      const prev = byKey.get(key);
      if (prev) {
        prev.taxable = round2(prev.taxable + taxable); prev.igst = round2(prev.igst + igst); prev.cgst = round2(prev.cgst + cgst);
        prev.sgst = round2(prev.sgst + sgst); prev.cess = round2(prev.cess + Math.abs(parseNumber(get('cess')) ?? 0));
        continue;
      }
      const doc: PurchaseDoc = {
        key, source: 'books', docType: type, supplierGstin: gstin, supplierName: String(get('supplierName') ?? '').trim() || undefined,
        docNo: no, docDate: isoDate(get('docDate')), pos: pos || undefined, rcm: h.map.has('rcm') ? yes(get('rcm')) : undefined,
        taxable, igst, cgst, sgst, cess: Math.abs(parseNumber(get('cess')) ?? 0),
        invoiceValue: parseNumber(get('invoiceValue')) ?? undefined, period, origin: { file, sheet: table.name, row: r + 1 },
      };
      byKey.set(key, doc);
      out.docs.push(doc);
    }
  }
  return out;
}
