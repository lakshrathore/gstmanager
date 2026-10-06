import type { FormatProfile } from './config/versions';

export const SECTIONS = [
  'b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exp', 'at', 'txpd', 'nil', 'hsn_b2b', 'hsn_b2c', 'docs',
  'b2ba', 'b2cla', 'expa', 'cdnra', 'cdnura', 'b2csa', 'ata', 'txpda',
] as const;

/** Amendment sections (Tables 9A, 9C, 10, 11) and the section each one amends. */
export const AMENDS: Partial<Record<Section, Section>> = {
  b2ba: 'b2b', b2cla: 'b2cl', expa: 'exp', cdnra: 'cdnr', cdnura: 'cdnur', b2csa: 'b2cs', ata: 'at', txpda: 'txpd',
};
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  b2b: '4A/4B/6B/6C – B2B, SEZ, Deemed Exports',
  b2cl: '5 – B2C Large',
  b2cs: '7 – B2C Others',
  cdnr: '9B – Credit/Debit Notes (Registered)',
  cdnur: '9B – Credit/Debit Notes (Unregistered)',
  exp: '6A – Exports',
  at: '11A – Advances Received',
  txpd: '11B – Advances Adjusted',
  nil: '8 – Nil/Exempt/Non-GST',
  hsn_b2b: '12 – HSN Summary (B2B)',
  hsn_b2c: '12 – HSN Summary (B2C)',
  docs: '13 – Documents Issued',
  b2ba: '9A – Amended B2B invoices',
  b2cla: '9A – Amended B2C Large invoices',
  expa: '9A – Amended Export invoices',
  cdnra: '9C – Amended Credit/Debit Notes (Registered)',
  cdnura: '9C – Amended Credit/Debit Notes (Unregistered)',
  b2csa: '10 – Amended B2C Others',
  ata: '11A – Amended Advances Received',
  txpda: '11B – Amended Advances Adjusted',
};

export type YN = 'Y' | 'N';
export type InvType = 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW';

export interface TaxAmounts {
  iamt: number | null;
  camt: number | null;
  samt: number | null;
  csamt: number | null;
}

export interface Item extends TaxAmounts {
  rt: number | null;
  txval: number | null;
}

export interface AdvanceItem extends TaxAmounts {
  rt: number | null;
  adAmt: number | null;
}

export interface B2bData {
  ctin: string; receiverName?: string; inum: string; idt: string; val: number | null; pos: string;
  rchrg: YN; invTyp: InvType | string; etin?: string; diffPercent?: number | null; items: Item[];
}
export interface B2clData {
  inum: string; idt: string; val: number | null; pos: string; etin?: string;
  diffPercent?: number | null; items: Item[];
}
export interface B2csData extends Item {
  typ: 'OE' | 'E' | string; pos: string; etin?: string; diffPercent?: number | null;
}
export interface CdnrData {
  ctin: string; receiverName?: string; ntNum: string; ntDt: string; ntty: 'C' | 'D' | string;
  pos: string; rchrg: YN; invTyp: InvType | string; val: number | null; diffPercent?: number | null; items: Item[];
}
export interface CdnurData {
  urType: 'B2CL' | 'EXPWP' | 'EXPWOP' | string; ntNum: string; ntDt: string; ntty: 'C' | 'D' | string;
  pos?: string; val: number | null; diffPercent?: number | null; items: Item[];
}
export interface ExpData {
  expTyp: 'WPAY' | 'WOPAY' | string; inum: string; idt: string; val: number | null;
  portCode?: string; sbNum?: string; sbDt?: string; items: Item[];
}
export interface AdvanceData {
  pos: string; diffPercent?: number | null; items: AdvanceItem[];
}
export interface NilData {
  splyTy: 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C' | string;
  nilAmt: number | null; exptAmt: number | null; ngsupAmt: number | null;
}
export interface HsnData extends TaxAmounts {
  hsn: string; desc?: string; uqc: string; qty: number | null; rt: number | null; txval: number | null;
}
export interface DocData {
  docTyp: string; from: string; to: string; totnum: number | null; cancel: number | null;
}

/** Amended invoice: the revised document plus the original number and date (ISO). */
export interface OriginalInvoice { oinum: string; oidt: string }
/** Amended note: the revised note plus the original note number and date (ISO). */
export interface OriginalNote { ontNum: string; ontDt: string }
/** Amended summary rows (B2CS, advances): the original return period MMYYYY. */
export interface OriginalMonth { omon: string }

export interface SectionDataMap {
  b2b: B2bData; b2cl: B2clData; b2cs: B2csData; cdnr: CdnrData; cdnur: CdnurData; exp: ExpData;
  at: AdvanceData; txpd: AdvanceData; nil: NilData; hsn_b2b: HsnData; hsn_b2c: HsnData; docs: DocData;
  b2ba: B2bData & OriginalInvoice; b2cla: B2clData & OriginalInvoice; expa: ExpData & OriginalInvoice;
  cdnra: CdnrData & OriginalNote; cdnura: CdnurData & OriginalNote;
  b2csa: B2csData & OriginalMonth; ata: AdvanceData & OriginalMonth; txpda: AdvanceData & OriginalMonth;
}

export interface SourceRef {
  sheet: string;
  rows: number[];
  /** Raw cell values as read from Excel, keyed by internal field name (first row of the group). */
  raw?: Record<string, unknown>;
}

export interface Gstr1Record<S extends Section = Section> {
  section: S;
  /** Stable natural key inside a return, e.g. "b2b|29ABCDE1234F1Z5|INV-001". */
  key: string;
  source: SourceRef;
  data: SectionDataMap[S];
}
export type AnyRecord = { [S in Section]: Gstr1Record<S> }[Section];

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: Severity;
  section: Section;
  recordKey: string;
  documentNo?: string;
  sheet?: string;
  row?: number;
  field: string;
  value?: unknown;
  message: string;
  suggestion?: string;
}

export interface ReturnContext {
  supplierGstin: string;
  /** Return period MMYYYY */
  fp: string;
  /** Quarterly filer: fp is the quarter-ending month and the period covers 3 months. */
  quarterly?: boolean;
  /** Aggregate annual turnover above ₹5 crore (drives HSN digits). */
  aatoAbove5Cr: boolean;
  profile: FormatProfile;
}

export interface ParseResult {
  records: AnyRecord[];
  issues: ValidationIssue[];
  sheetsParsed: { sheet: string; section: Section; rows: number; records: number }[];
  sheetsSkipped: { sheet: string; reason: string }[];
}
