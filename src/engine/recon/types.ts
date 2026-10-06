/** Purchase-side documents (books purchase register, GSTR-2A, GSTR-2B) in one normalised shape. */

export type PurchaseSource = 'books' | 'gstr2a' | 'gstr2b';
export type PurchaseDocType = 'INV' | 'CN' | 'DN';

export interface PurchaseDoc {
  /** Stable natural key: source|gstin|type|normalised doc no (decisions refer to it, so it survives re-uploads). */
  key: string;
  source: PurchaseSource;
  docType: PurchaseDocType;
  supplierGstin: string;
  supplierName?: string;
  docNo: string;
  /** ISO yyyy-mm-dd ('' when unknown) */
  docDate: string;
  pos?: string;
  rcm?: boolean;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoiceValue?: number;
  /** Return period this document belongs to in the uploaded data (MMYYYY). */
  period: string;
  /* portal-only details */
  itcAvailable?: boolean | null;
  itcReason?: string;
  /** Supplier's GSTR-1/IFF period and filing date (2A/2B). */
  supplierPeriod?: string;
  supplierFilingDate?: string;
  /** 2A: has the supplier filed GSTR-1 ("Y"/"N"). */
  supplierFiled?: boolean;
  gstinCancelledOn?: string;
  /** Came from an amendment table (B2BA/CDNRA); docNo is the revised number, originalDocNo the old one. */
  amended?: boolean;
  originalDocNo?: string;
  origin?: { file: string; row?: number; sheet?: string };
}

export type ReconStatus = 'matched' | 'mismatch' | 'probable' | 'not_in_portal' | 'not_in_books' | 'ignored';

export type DiffField = 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess' | 'totalTax' | 'taxHead' | 'docDate' | 'docNo' | 'rcm' | 'pos' | 'gstin';

export interface Diff {
  field: DiffField;
  books: string | number | boolean | null;
  portal: string | number | boolean | null;
  /** books − portal for amounts */
  diff?: number;
}

export interface ReconRow {
  /** Stable id of the row: books key and/or portal key. */
  id: string;
  status: ReconStatus;
  books?: PurchaseDoc;
  portal?: PurchaseDoc;
  matchedBy?: 'exact' | 'normalised' | 'fuzzy' | 'pan' | 'manual';
  /** User accepted a probable match / the differences. */
  accepted?: boolean;
  diffs: Diff[];
  notes: string[];
  ignoredReason?: string;
}

export interface ReconDecision {
  action: 'ignore' | 'link' | 'accept';
  booksKey?: string;
  portalKey?: string;
  reason?: string;
}

export interface ReconOptions {
  /** ₹ tolerance per amount (taxable, each tax head). */
  amountTolerance: number;
  /** Days a date may differ in fuzzy matching. */
  fuzzyDateDays: number;
  /** The recipient's own GSTIN (state for POS checks). */
  recipientGstin: string;
}

export interface ReconTotals { count: number; taxable: number; tax: number }

export interface ReconSummary {
  byStatus: Record<ReconStatus, ReconTotals>;
  books: ReconTotals;
  portal: ReconTotals;
  /** ITC per books vs ITC in portal (tax of matched + portal-only, ITC-available docs). */
  itc: { books: number; portal: number; matched: number; difference: number };
}
