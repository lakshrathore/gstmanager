/**
 * Client documents: what a document is, and the records extracted from it (invoices and bank
 * transactions) in one shape whatever the source – an invoice PDF, a register, GSTR-1/2A/2B or a
 * bank statement. Pure – shared by the server, the AI extractor and the browser.
 */

export const DOC_KINDS = [
  'tax_invoice', 'credit_note', 'debit_note', 'sales_register', 'purchase_register',
  'gstr1', 'gstr2a', 'gstr2b', 'gstr3b', 'bank_statement', 'eway_bill', 'gst_certificate', 'accounting_report', 'other',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  tax_invoice: 'Tax invoice', credit_note: 'Credit note', debit_note: 'Debit note', sales_register: 'Sales register',
  purchase_register: 'Purchase register', gstr1: 'GSTR-1', gstr2a: 'GSTR-2A', gstr2b: 'GSTR-2B', gstr3b: 'GSTR-3B',
  bank_statement: 'Bank statement', eway_bill: 'E-way bill', gst_certificate: 'GST certificate', accounting_report: 'Accounting report', other: 'Other document',
};

export type Direction = 'sales' | 'purchase';
export type NoteType = 'INV' | 'CN' | 'DN';

/** Where an invoice record came from: the books (invoice documents, registers) or the GST portal. */
export type InvoiceSource = 'document' | 'register' | 'gstr1' | 'gstr2a' | 'gstr2b';

export interface InvoiceItem {
  description?: string; hsn?: string; quantity?: number | null; unit?: string; unitPrice?: number | null;
  discount?: number | null; taxable?: number | null; gstRate?: number | null;
  cgst?: number | null; sgst?: number | null; igst?: number | null; cess?: number | null;
}

export interface InvoiceData {
  docType: NoteType;
  supplierName?: string; supplierGstin?: string;
  customerName?: string; customerGstin?: string;
  invoiceNo: string;
  /** ISO yyyy-mm-dd, '' when unknown. */
  invoiceDate: string;
  /** State code "29". */
  pos?: string;
  rcm?: boolean;
  taxable: number; cgst: number; sgst: number; igst: number; cess: number;
  discount?: number;
  total?: number | null;
  /** Tax rate when the source gives one rate for the whole row (registers). */
  rate?: number | null;
  items?: InvoiceItem[];
  /** A summary line, not a document (GSTR-1 B2C others): no number, no duplicate checks. */
  summary?: boolean;
  /** GSTR-2A/2B details. */
  itcAvailable?: boolean | null;
  itcReason?: string;
  supplierPeriod?: string;
  /** Return period of the portal data (MMYYYY). */
  returnPeriod?: string;
}

export type BankMode = 'UPI' | 'NEFT' | 'RTGS' | 'IMPS' | 'CASH' | 'CHEQUE' | 'ATM' | 'CARD' | 'NACH' | 'INTEREST' | 'CHARGES' | 'TRANSFER' | 'OTHER';

export interface BankTxn {
  /** ISO yyyy-mm-dd */
  date: string;
  narration: string;
  ref?: string;
  debit: number;
  credit: number;
  balance?: number | null;
  mode: BankMode;
  account?: string;
}

export type Severity = 'error' | 'warning';

/** Something about a record that needs the CA's attention. */
export interface Flag {
  code: string;
  severity: Severity;
  field?: string;
  message: string;
  /** Another record this one relates to (the duplicate it repeats). */
  relatedId?: string;
}

export type Extracted =
  | { kind: 'invoice'; source: InvoiceSource; direction: Direction | null; data: InvoiceData; loc?: Loc; uncertain?: string[] }
  | { kind: 'bank'; data: BankTxn; loc?: Loc; uncertain?: string[] };

/** Position in the original file: page of a PDF, or sheet and row of a spreadsheet. */
export interface Loc { page?: number; sheet?: string; row?: number }

export const NOTE_LABEL: Record<NoteType, string> = { INV: 'Invoice', CN: 'Credit note', DN: 'Debit note' };
