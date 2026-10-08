import type { SheetTable } from '../excel/parseGstr1';
import { stateCode } from '../marketplace/states';
import { docTypeOf } from '../recon/books';
import { normaliseDocNo } from '../recon/normalize';
import { norm, parseDate, parseNumber, round2 } from '../util';
import type { BankMode, BankTxn, Direction, Extracted, InvoiceData } from './types';

/**
 * Sales / purchase registers and bank statements exported from Tally, Busy, Zoho, bank portals or
 * kept in Excel/CSV. Columns are found by name (several spellings each, case and punctuation
 * ignored); the heading row may be anywhere in the first 30 rows.
 */

const PURCHASE_PARTY = { gstin: ['GSTIN of Supplier', 'Supplier GSTIN', 'GSTIN/UIN of Supplier', 'Vendor GSTIN', 'Seller GSTIN'], name: ['Supplier Name', 'Vendor Name', 'Name of Supplier', 'Seller Name'] };
const SALES_PARTY = { gstin: ['GSTIN/UIN of Recipient', 'Customer GSTIN', 'Buyer GSTIN', 'Recipient GSTIN', 'Receiver GSTIN', 'Billed To GSTIN'], name: ['Customer Name', 'Buyer Name', 'Receiver Name', 'Recipient Name', 'Name of Customer', 'Billed To', 'Bill To'] };
const ANY_PARTY = { gstin: ['Party GSTIN', 'GSTIN/UIN', 'GSTIN', 'GST No', 'GST Number', 'GSTIN No', 'GST No.'], name: ['Party Name', 'Party', 'Particulars', 'Ledger Name', 'Trade/Legal Name', 'Name'] };

export const REGISTER_COLUMNS: Record<string, string[]> = {
  docNo: ['Supplier Invoice No', 'Supplier Invoice Number', 'Supplier Inv No', 'Invoice No', 'Invoice Number', 'Inv No', 'Bill No', 'Bill Number', 'Voucher No', 'Voucher Number', 'Vch No', 'Note No', 'Note Number', 'Document No', 'Document Number', 'Doc No', 'Reference No', 'Ref No'],
  docDate: ['Supplier Invoice Date', 'Invoice Date', 'Inv Date', 'Bill Date', 'Voucher Date', 'Note Date', 'Document Date', 'Doc Date', 'Date'],
  docType: ['Document Type', 'Doc Type', 'Note Type', 'Invoice Type', 'Voucher Type', 'Type'],
  pos: ['Place of Supply', 'POS', 'State'],
  rcm: ['Reverse Charge', 'Supply Attract Reverse Charge', 'RCM'],
  hsn: ['HSN/SAC', 'HSN', 'SAC', 'HSN Code', 'HSN/SAC Code'],
  taxable: ['Taxable Value', 'Taxable Amount', 'Assessable Value', 'Taxable', 'Net Amount'],
  rate: ['GST Rate', 'Tax Rate', 'Rate (%)', 'GST %', 'Rate'],
  discount: ['Discount', 'Discount Amount'],
  igst: ['Integrated Tax', 'Integrated Tax Amount', 'IGST Amount', 'IGST'],
  cgst: ['Central Tax', 'Central Tax Amount', 'CGST Amount', 'CGST'],
  sgst: ['State/UT Tax', 'State Tax', 'SGST/UTGST', 'SGST Amount', 'SGST', 'UTGST'],
  cess: ['Cess Amount', 'Cess'],
  total: ['Invoice Value', 'Bill Amount', 'Invoice Amount', 'Gross Total', 'Total Amount', 'Total', 'Grand Total'],
};

const yes = (v: unknown) => /^(Y|YES|TRUE|1)$/i.test(String(v ?? '').trim());
export const isoDate = (v: unknown) => (v instanceof Date || typeof v === 'number' ? parseDate(v) : parseDate(String(v ?? '').trim().split(/[ T]/)[0])) ?? '';
const num = (v: unknown) => parseNumber(v) ?? 0;
const str = (v: unknown) => (v == null ? '' : String(v).trim());

interface Header { rowIdx: number; map: Map<string, number>; direction: Direction | null; voucherType: boolean }

function findCols(cells: string[], fields: Record<string, string[]>, map: Map<string, number>) {
  for (const [key, aliases] of Object.entries(fields)) {
    if (map.has(key)) continue;
    for (const a of aliases) {
      const idx = cells.findIndex((c, i) => c === norm(a) && ![...map.values()].includes(i));
      if (idx >= 0) { map.set(key, idx); break; }
    }
  }
}

/** The register heading row and which side (supplier or customer) its party columns name. */
export function registerHeader(table: SheetTable): Header | null {
  for (let r = 0; r < Math.min(table.rows.length, 30); r++) {
    const cells = (table.rows[r] ?? []).map(norm);
    const map = new Map<string, number>();
    let direction: Direction | null = null;
    const tryParty = (p: typeof ANY_PARTY, d: Direction | null) => {
      const m = new Map<string, number>(map);
      findCols(cells, { partyGstin: p.gstin, partyName: p.name }, m);
      if (m.has('partyGstin') || m.has('partyName')) { for (const [k, v] of m) map.set(k, v); direction = d; return true; }
      return false;
    };
    // Specific supplier/customer columns decide the side; generic party columns leave it open.
    if (!tryParty(PURCHASE_PARTY, 'purchase') && !tryParty(SALES_PARTY, 'sales')) tryParty(ANY_PARTY, null);
    findCols(cells, REGISTER_COLUMNS, map);
    const hasTax = map.has('igst') || map.has('cgst') || map.has('rate');
    if (map.has('docNo') && map.has('taxable') && hasTax) {
      const voucherType = map.has('docType') && cells[map.get('docType')!] === norm('Voucher Type');
      return { rowIdx: r, map, direction, voucherType };
    }
  }
  return null;
}

/**
 * Register rows → invoices. Rate-wise rows of one document (same party, type and number) are added
 * together; tax is computed from the rate when the register has no tax columns.
 */
export function readRegister(tables: SheetTable[], direction: Direction, clientGstin: string): { records: Extracted[]; notes: string[] } {
  const notes: string[] = [];
  const byKey = new Map<string, Extracted & { kind: 'invoice' }>();
  const records: Extracted[] = [];
  const clientState = clientGstin.slice(0, 2);
  for (const t of tables) {
    const h = registerHeader(t);
    if (!h) continue;
    const get = (row: unknown[], k: string) => (h.map.has(k) ? row[h.map.get(k)!] : undefined);
    for (let r = h.rowIdx + 1; r < t.rows.length; r++) {
      const row = t.rows[r] ?? [];
      const no = str(get(row, 'docNo'));
      const first = str(row.find((c) => c != null && str(c)));
      if (!first || /^(total|grand total|sub ?total)/i.test(first)) continue;
      const taxableRaw = get(row, 'taxable');
      if (!no && (taxableRaw == null || str(taxableRaw) === '')) continue;
      const gstin = str(get(row, 'partyGstin')).toUpperCase().replace(/\s/g, '');
      const name = str(get(row, 'partyName'));
      const docType = docTypeOf(get(row, 'docType'), h.voucherType && direction === 'purchase');
      const taxable = Math.abs(num(taxableRaw));
      let igst = Math.abs(num(get(row, 'igst')));
      let cgst = Math.abs(num(get(row, 'cgst')));
      let sgst = Math.abs(num(get(row, 'sgst')));
      const rate = parseNumber(get(row, 'rate'));
      const posRaw = get(row, 'pos');
      const pos = posRaw != null && str(posRaw) ? stateCode(posRaw) : '';
      if (!h.map.has('igst') && !h.map.has('cgst') && rate != null) {
        // Inter-state when the supplier's state differs from the place of supply (or else the recipient's state).
        const supplierState = direction === 'purchase' ? gstin.slice(0, 2) : clientState;
        const dest = pos || (direction === 'purchase' ? clientState : gstin.slice(0, 2) || clientState);
        const tax = (taxable * rate) / 100;
        const inter = !!supplierState && !!dest && dest !== supplierState;
        if (inter) igst = round2(tax); else { cgst = round2(tax / 2); sgst = round2(tax / 2); }
      }
      const cess = Math.abs(num(get(row, 'cess')));
      const totalRaw = parseNumber(get(row, 'total'));
      const key = `${gstin}|${docType}|${normaliseDocNo(no)}`;
      const prev = no ? byKey.get(key) : undefined;
      if (prev) {
        const d = prev.data;
        d.taxable = round2(d.taxable + taxable); d.igst = round2(d.igst + igst); d.cgst = round2(d.cgst + cgst); d.sgst = round2(d.sgst + sgst); d.cess = round2(d.cess + cess);
        if (d.rate != null && rate != null && d.rate !== rate) d.rate = null;
        // The invoice value is usually repeated on every rate row; keep it unless the rows carry their own totals.
        if (totalRaw != null && d.total != null && Math.abs(totalRaw - d.total) > 1 && Math.abs(totalRaw) < Math.abs(d.total)) d.total = round2(d.total + Math.abs(totalRaw));
        continue;
      }
      const party = direction === 'purchase'
        ? { supplierGstin: gstin || undefined, supplierName: name || undefined, customerGstin: clientGstin || undefined }
        : { customerGstin: gstin || undefined, customerName: name || undefined, supplierGstin: clientGstin || undefined };
      const data: InvoiceData = {
        docType, ...party, invoiceNo: no, invoiceDate: isoDate(get(row, 'docDate')), pos: pos || undefined,
        rcm: h.map.has('rcm') ? yes(get(row, 'rcm')) : undefined,
        taxable, igst, cgst, sgst, cess, rate, discount: h.map.has('discount') ? Math.abs(num(get(row, 'discount'))) : undefined,
        total: totalRaw != null ? Math.abs(totalRaw) : null,
        items: h.map.has('hsn') && str(get(row, 'hsn')) ? [{ hsn: str(get(row, 'hsn')), taxable, gstRate: rate }] : undefined,
      };
      const rec = { kind: 'invoice' as const, source: 'register' as const, direction, data, loc: { sheet: t.name, row: r + 1 } };
      if (no) byKey.set(key, rec);
      records.push(rec);
    }
  }
  if (!records.length) notes.push('No register rows found (needs invoice number, taxable value and tax or rate columns).');
  return { records, notes };
}

/* ---------- bank statements ---------- */

const BANK_COLUMNS: Record<string, string[]> = {
  date: ['Txn Date', 'Transaction Date', 'Tran Date', 'Date', 'Value Date', 'Posting Date', 'Value Dt'],
  narration: ['Narration', 'Description', 'Particulars', 'Remarks', 'Transaction Details', 'Transaction Remarks', 'Details'],
  ref: ['Chq./Ref.No.', 'Chq/Ref No', 'Cheque No', 'Cheque Number', 'Ref No', 'Reference No', 'Chq No', 'UTR', 'UTR No', 'Instrument No'],
  debit: ['Withdrawal Amt.', 'Withdrawal Amt', 'Withdrawal Amount', 'Withdrawal', 'Withdrawals', 'Debit', 'Debit Amount', 'Dr Amount', 'Dr'],
  credit: ['Deposit Amt.', 'Deposit Amt', 'Deposit Amount', 'Deposit', 'Deposits', 'Credit', 'Credit Amount', 'Cr Amount', 'Cr'],
  amount: ['Amount', 'Transaction Amount', 'Amount (INR)'],
  drcr: ['Dr/Cr', 'Cr/Dr', 'Type', 'Debit/Credit', 'Txn Type'],
  balance: ['Closing Balance', 'Balance', 'Running Balance', 'Available Balance'],
};

export function bankHeader(table: SheetTable) {
  for (let r = 0; r < Math.min(table.rows.length, 40); r++) {
    const cells = (table.rows[r] ?? []).map(norm);
    const map = new Map<string, number>();
    findCols(cells, BANK_COLUMNS, map);
    if (map.has('date') && map.has('narration') && ((map.has('debit') && map.has('credit')) || (map.has('amount') && map.has('drcr')))) return { rowIdx: r, map };
  }
  return null;
}

/** How the money moved, from the narration. */
export function bankMode(narration: string): BankMode {
  const n = narration.toUpperCase();
  if (/\bUPI\b|UPI\/|@[A-Z]/.test(n)) return 'UPI';
  if (/\bNEFT\b/.test(n)) return 'NEFT';
  if (/\bRTGS\b/.test(n)) return 'RTGS';
  if (/\bIMPS\b|\bMMT\b/.test(n)) return 'IMPS';
  if (/\bNACH\b|\bACH\b|\bECS\b|MANDATE/.test(n)) return 'NACH';
  if (/\bATM\b|\bATW\b|CASH ?WDL|NWD/.test(n)) return 'ATM';
  if (/CASH ?DEP|\bCSH\b|BY CASH|CASH DEPOSIT|\bCDM\b/.test(n)) return 'CASH';
  if (/\bCHQ\b|CHEQUE|\bCLG\b|CLEARING|\bCTS\b/.test(n)) return 'CHEQUE';
  if (/\bPOS\b|DEBIT CARD|CARD ?\d|ECOM/.test(n)) return 'CARD';
  if (/\bINT\b.*\b(PD|CR|PAID|CREDIT)|INTEREST/.test(n)) return 'INTEREST';
  if (/CHRG|CHARGES|\bGST ON\b|FEE|COMMISSION/.test(n)) return 'CHARGES';
  if (/\bTRF\b|TRANSFER|\bFT\b|\bIFT\b/.test(n)) return 'TRANSFER';
  return 'OTHER';
}

export function readBankStatement(tables: SheetTable[]): { records: Extracted[]; notes: string[] } {
  const records: Extracted[] = [];
  const notes: string[] = [];
  for (const t of tables) {
    const h = bankHeader(t);
    if (!h) continue;
    const get = (row: unknown[], k: string) => (h.map.has(k) ? row[h.map.get(k)!] : undefined);
    for (let r = h.rowIdx + 1; r < t.rows.length; r++) {
      const row = t.rows[r] ?? [];
      const date = isoDate(get(row, 'date'));
      const narration = str(get(row, 'narration'));
      if (!date) {
        // A narration that wraps onto the next row belongs to the transaction above.
        const last = records[records.length - 1];
        if (last?.kind === 'bank' && narration && !num(get(row, 'debit')) && !num(get(row, 'credit')) && !num(get(row, 'amount'))) last.data.narration += ` ${narration}`;
        continue;
      }
      let debit = Math.abs(num(get(row, 'debit')));
      let credit = Math.abs(num(get(row, 'credit')));
      if (h.map.has('amount') && !h.map.has('debit')) {
        const amt = Math.abs(num(get(row, 'amount')));
        if (/^(D|DR|DEBIT)/i.test(str(get(row, 'drcr')))) debit = amt; else credit = amt;
      }
      if (!debit && !credit) continue;
      const bal = parseNumber(get(row, 'balance'));
      records.push({ kind: 'bank', data: { date, narration, ref: str(get(row, 'ref')) || undefined, debit, credit, balance: bal, mode: bankMode(narration) }, loc: { sheet: t.name, row: r + 1 } });
    }
  }
  for (const rec of records) if (rec.kind === 'bank') rec.data.mode = bankMode(rec.data.narration);
  if (!records.length) notes.push('No transactions found (needs date, narration and debit/credit columns).');
  return { records, notes };
}

export type { BankTxn };
