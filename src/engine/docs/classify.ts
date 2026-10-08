import type { SheetTable } from '../excel/parseGstr1';
import { parseGstr1Tables } from '../excel/parseGstr1';
import { recordsFromGstr1Json } from '../json/check';
import { periodOf, readPortalJson, readPortalTables } from '../recon/portal';
import type { PurchaseDoc } from '../recon/types';
import type { AnyRecord } from '../types';
import { bankHeader, isoDate, readBankStatement, readRegister, registerHeader } from './registers';
import type { DocKind, Extracted, InvoiceData } from './types';

/**
 * Structured files (Excel, CSV, JSON) are recognised and read by rules – no AI, no cost: GSTN's
 * GSTR-1 / 2A / 2B / 3B files, sales and purchase registers, bank statements. Anything else returns
 * null and goes to the AI reader.
 */

export interface StructuredRead {
  kind: DocKind;
  reason: string;
  /** Return period for GSTN files (MMYYYY). */
  period?: string;
  /** GSTINs the file names as its own (the taxpayer of a GSTN file). */
  ownerGstin?: string;
  records: Extracted[];
  notes: string[];
}

const GSTIN_RE = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;

/** Text of the first rows of every sheet, the sheet names and the file name – for title matching. */
function titleText(tables: SheetTable[], fileName: string) {
  const parts = [fileName, ...tables.map((t) => t.name)];
  for (const t of tables) for (const row of t.rows.slice(0, 8)) for (const c of row ?? []) if (c != null) parts.push(String(c));
  return parts.join(' | ');
}

/** "Tax Period: September 2026", "Return Period 092026" … in the title rows. */
function titlePeriod(tables: SheetTable[]): string {
  for (const t of tables) {
    for (const row of t.rows.slice(0, 12)) {
      const cells = (row ?? []).map((c) => (c == null ? '' : String(c).trim()));
      for (let i = 0; i < cells.length; i++) {
        if (!/period|month/i.test(cells[i])) continue;
        const inline = periodOf(cells[i].replace(/^.*?(period|month)\s*[:-]?\s*/i, '').replace(/\s+/g, '-'));
        if (inline) return inline;
        const next = cells.slice(i + 1).find(Boolean);
        if (next && periodOf(next.replace(/\s+/g, '-'))) return periodOf(next.replace(/\s+/g, '-'));
      }
    }
  }
  return '';
}

export function purchaseDocToInvoice(d: PurchaseDoc, clientGstin: string): InvoiceData {
  return {
    docType: d.docType, supplierGstin: d.supplierGstin, supplierName: d.supplierName, customerGstin: clientGstin || undefined,
    invoiceNo: d.docNo, invoiceDate: d.docDate, pos: d.pos, rcm: d.rcm, taxable: d.taxable, cgst: d.cgst, sgst: d.sgst, igst: d.igst, cess: d.cess,
    total: d.invoiceValue ?? null, itcAvailable: d.itcAvailable, itcReason: d.itcReason, supplierPeriod: d.supplierPeriod, returnPeriod: d.period,
  };
}

const sumItems = (items: { txval: number | null; iamt: number | null; camt: number | null; samt: number | null; csamt: number | null }[]) => {
  const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const i of items) { t.taxable += i.txval ?? 0; t.igst += i.iamt ?? 0; t.cgst += i.camt ?? 0; t.sgst += i.samt ?? 0; t.cess += i.csamt ?? 0; }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * 100) / 100])) as typeof t;
};

/** GSTR-1 records → sales invoices (B2C others and nil/HSN/document summaries are summary lines or skipped). */
export function gstr1ToInvoices(records: AnyRecord[], clientGstin: string, period: string): Extracted[] {
  const out: Extracted[] = [];
  const base = { supplierGstin: clientGstin || undefined, returnPeriod: period || undefined };
  for (const r of records) {
    const loc = r.source?.sheet ? { sheet: r.source.sheet, row: r.source.rows?.[0] } : undefined;
    const push = (data: InvoiceData) => out.push({ kind: 'invoice', source: 'gstr1', direction: 'sales', data, loc });
    switch (r.section) {
      case 'b2b': case 'b2ba':
        push({ ...base, docType: 'INV', customerGstin: r.data.ctin, customerName: r.data.receiverName, invoiceNo: r.data.inum, invoiceDate: r.data.idt, pos: r.data.pos, rcm: r.data.rchrg === 'Y', total: r.data.val, ...sumItems(r.data.items) });
        break;
      case 'b2cl': case 'b2cla':
        push({ ...base, docType: 'INV', customerName: 'B2C (large)', invoiceNo: r.data.inum, invoiceDate: r.data.idt, pos: r.data.pos, total: r.data.val, ...sumItems(r.data.items) });
        break;
      case 'exp': case 'expa':
        push({ ...base, docType: 'INV', customerName: `Export (${r.data.expTyp})`, invoiceNo: r.data.inum, invoiceDate: r.data.idt, pos: '96', total: r.data.val, ...sumItems(r.data.items) });
        break;
      case 'cdnr': case 'cdnra':
        push({ ...base, docType: r.data.ntty === 'D' ? 'DN' : 'CN', customerGstin: r.data.ctin, customerName: r.data.receiverName, invoiceNo: r.data.ntNum, invoiceDate: r.data.ntDt, pos: r.data.pos, total: r.data.val, ...sumItems(r.data.items) });
        break;
      case 'cdnur': case 'cdnura':
        push({ ...base, docType: r.data.ntty === 'D' ? 'DN' : 'CN', customerName: `Unregistered (${r.data.urType})`, invoiceNo: r.data.ntNum, invoiceDate: r.data.ntDt, pos: r.data.pos, total: r.data.val, ...sumItems(r.data.items) });
        break;
      case 'b2cs': case 'b2csa':
        push({ ...base, docType: 'INV', customerName: `B2C others – POS ${r.data.pos}`, invoiceNo: '', invoiceDate: '', pos: r.data.pos, rate: r.data.rt, summary: true, ...sumItems([r.data]) });
        break;
      default: break;
    }
  }
  return out;
}

/** Reads a spreadsheet (or CSV) whose layout the rules recognise; null when it is something else. */
export function readStructuredTables(tables: SheetTable[], fileName: string, clientGstin: string): StructuredRead | null {
  const title = titleText(tables, fileName);
  const ownerGstin = title.toUpperCase().match(GSTIN_RE)?.[0];
  const period = titlePeriod(tables) || periodOf(fileName.match(/(\d{6})/)?.[1] ?? '');
  const gstinFor = ownerGstin ?? clientGstin;

  for (const [re, kind] of [[/GSTR[\s-]*2B/i, 'gstr2b'], [/GSTR[\s-]*2A/i, 'gstr2a']] as const) {
    if (!re.test(title)) continue;
    const res = readPortalTables(tables, kind, fileName, period);
    if (res.docs.length) {
      return {
        kind, reason: `${kind === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} title and B2B/CDNR sheets`, period: period || res.docs[0]?.period, ownerGstin,
        records: res.docs.map((d) => ({ kind: 'invoice', source: kind, direction: 'purchase', data: purchaseDocToInvoice(d, gstinFor), loc: d.origin ? { sheet: d.origin.sheet, row: d.origin.row } : undefined })),
        notes: res.notes,
      };
    }
  }

  if (/GSTR[\s-]*3B/i.test(title) || tables.some((t) => /^3\.1 to 5\.1$/i.test(t.name))) {
    return { kind: 'gstr3b', reason: 'GSTR-3B title or template sheets', period, ownerGstin, records: [], notes: ['GSTR-3B is kept as a document; open the GSTR-3B page to work on it.'] };
  }

  const gstr1Sheets = tables.filter((t) => /^(b2b,sez,de|b2b|b2cl|b2cs|cdnr|cdnur|exp|hsn|exemp|docs|at|atadj)$/i.test(t.name.trim()));
  if (gstr1Sheets.length >= 2 || /GSTR[\s-]*1\b/i.test(title)) {
    const parsed = parseGstr1Tables(tables, { supplierGstin: gstinFor, hsnSplit: true });
    if (parsed.sheetsParsed.length) {
      return { kind: 'gstr1', reason: `GSTR-1 template sheets (${parsed.sheetsParsed.map((s) => s.sheet).join(', ')})`, period, ownerGstin, records: gstr1ToInvoices(parsed.records, gstinFor, period), notes: [] };
    }
  }

  if (tables.some((t) => bankHeader(t))) {
    const res = readBankStatement(tables);
    if (res.records.length) return { kind: 'bank_statement', reason: 'Date, narration and debit/credit columns', records: res.records, notes: res.notes };
  }

  const headers = tables.map((t) => registerHeader(t)).filter(Boolean);
  if (headers.length) {
    // Which side: the party columns, else words in the file and sheet names.
    let direction = headers.find((h) => h!.direction)?.direction ?? null;
    let reason = direction ? `${direction === 'sales' ? 'Customer' : 'Supplier'} columns with invoice number, taxable value and tax` : '';
    if (!direction) {
      const words = title.toLowerCase();
      if (/purchase|inward|vendor|supplier/.test(words)) direction = 'purchase';
      else if (/sales|sale\b|outward|customer|debtor/.test(words)) direction = 'sales';
      reason = direction ? `Invoice columns; "${direction}" from the file or sheet name` : '';
    }
    const guessed = !direction;
    const res = readRegister(tables, direction ?? 'purchase', clientGstin);
    if (res.records.length) {
      return {
        kind: direction === 'sales' ? 'sales_register' : 'purchase_register',
        reason: guessed ? 'Invoice columns; could not tell sales from purchases – taken as a purchase register' : reason,
        records: res.records,
        notes: guessed ? ['Could not tell whether this is a sales or a purchase register. Taken as purchases – change it if wrong.', ...res.notes] : res.notes,
      };
    }
  }
  return null;
}

/** Sections only a GSTR-1 has, and supplier fields only GSTR-2A has. */
const GSTR1_ONLY = ['b2cs', 'b2cl', 'hsn', 'doc_issue', 'nil', 'exp', 'at', 'txpd', 'cdnur', 'b2csa', 'b2cla', 'expa', 'ata', 'txpda', 'cdnura'];
const GSTR2A_SUPPLIER = ['cfs3b', 'fldtr1', 'flprdr1', 'dtcancel'];

/**
 * Reads a GSTN JSON file (GSTR-1, GSTR-2A, GSTR-2B, GSTR-3B); null when it is something else. `hint`
 * is the type when it is known (a return downloaded from the portal by type); otherwise the content
 * decides, with the file name ("GSTR1…", "GSTR2A…") settling a GSTR-1 that has only B2B invoices
 * (GSTN's GSTR-1 also carries the customer's filing status "cfs", like GSTR-2A).
 */
export function readStructuredJson(json: unknown, fileName: string, clientGstin: string, hint?: string | null): StructuredRead | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const ownerGstin = typeof data.gstin === 'string' ? data.gstin.toUpperCase() : undefined;
  const gstinFor = ownerGstin ?? clientGstin;

  if (data.docdata || (data.rtnprd && data.gendt)) {
    const res = readPortalJson(json, 'gstr2b', fileName, '');
    return {
      kind: 'gstr2b', reason: 'GSTR-2B JSON (docdata, rtnprd)', period: res.docs[0]?.period ?? periodOf(data.rtnprd), ownerGstin,
      records: res.docs.map((d) => ({ kind: 'invoice', source: 'gstr2b', direction: 'purchase', data: purchaseDocToInvoice(d, gstinFor) })), notes: res.notes,
    };
  }
  const b2b = Array.isArray(data.b2b) ? (data.b2b as Record<string, unknown>[]) : [];
  // The known type first, then content that only one of them has, then the file name for a b2b-only file.
  const is2a = hint === 'gstr2a' ? true : hint === 'gstr1' ? false
    : GSTR1_ONLY.some((k) => k in data) ? false
      : b2b.some((x) => GSTR2A_SUPPLIER.some((k) => k in x)) || (Array.isArray(data.cdn) && !Array.isArray(data.cdnr)) ? true
        : b2b.some((x) => 'cfs' in x) && !/gstr[-_ ]?1(?![0-9a-z])/i.test(fileName);
  if (is2a) {
    const res = readPortalJson(json, 'gstr2a', fileName, periodOf(data.fp));
    return {
      kind: 'gstr2a', reason: 'GSTR-2A JSON (supplier filing status)', period: periodOf(data.fp) || res.docs[0]?.period, ownerGstin,
      records: res.docs.map((d) => ({ kind: 'invoice', source: 'gstr2a', direction: 'purchase', data: purchaseDocToInvoice(d, gstinFor) })), notes: res.notes,
    };
  }
  if (('fp' in data || hint === 'gstr1') && (b2b.length || 'b2cs' in data || 'hsn' in data || 'cdnr' in data || 'exp' in data)) {
    const period = periodOf(data.fp);
    return { kind: 'gstr1', reason: 'GSTR-1 JSON (fp, b2b/b2cs/hsn)', period, ownerGstin, records: gstr1ToInvoices(recordsFromGstr1Json(data), gstinFor, period), notes: [] };
  }
  if (data.sup_details && data.itc_elg) return { kind: 'gstr3b', reason: 'GSTR-3B JSON (sup_details, itc_elg)', period: periodOf(data.ret_period), ownerGstin, records: [], notes: [] };
  return null;
}

/** CSV → one table (quotes, embedded commas and newlines handled). */
export function parseCsv(text: string, name = 'CSV'): SheetTable {
  const rows: unknown[][] = [];
  let row: unknown[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/\t/g)?.length ?? 0) > (s.split('\n')[0].match(/,/g)?.length ?? 0) ? '\t' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return { name, rows: rows.map((r) => r.map((c) => (c === '' ? null : c))) };
}

export { isoDate };
