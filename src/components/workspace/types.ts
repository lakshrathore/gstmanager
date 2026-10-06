export interface Summary {
  total: number; valid: number; withErrors: number; withWarnings: number; errorCount: number; warningCount: number;
  bySection: Record<string, { total: number; errors: number }>;
}
export interface ReturnDetail {
  return: {
    _id: string; fp: string; fy: string; status: string; gstin: string; quarterly: boolean; jsonStale: boolean; currentJsonId?: string;
    summary?: Summary; lastValidatedAt?: string;
    portal?: { uploadReference?: string; processingReference?: string; arn?: string; filedOn?: string };
    importInfo?: { fileName: string; importedAt: string; sheetsParsed: { sheet: string; section: string; rows: number; records: number }[]; sheetsSkipped: { sheet: string; reason: string }[]; importIssueCount: number };
  };
  company: { _id: string; name: string; gstin: string; aatoAbove5Cr: boolean };
  profile: { id: string; jsonVersion: string; hsnSplit: boolean; b2clThreshold: number };
  json?: { _id: string; sha256: string; sizeBytes: number; createdAt: string; log: { sections: Record<string, { documents: number; taxableValue: number; tax: number }> } } | null;
  upload?: { _id: string; status: string; mode: string; referenceId?: string; history: { at: string; status: string; note?: string }[] } | null;
  counts: { importIssues: number; portalErrors: number };
}
export interface Issue {
  _id: string; origin: string; severity: string; section: string; documentNo?: string; sheet?: string; row?: number;
  field: string; value?: unknown; message: string; suggestion?: string; recordKey?: string; code?: string;
}
export const SECTION_LABELS: Record<string, string> = {
  b2b: 'B2B / SEZ / Deemed', b2cl: 'B2C Large', b2cs: 'B2C Others', cdnr: 'CDN Registered', cdnur: 'CDN Unregistered',
  exp: 'Exports', at: 'Advances received', txpd: 'Advances adjusted', nil: 'Nil / Exempt', hsn_b2b: 'HSN B2B', hsn_b2c: 'HSN B2C', docs: 'Documents',
  b2ba: 'B2B amended (9A)', b2cla: 'B2C Large amended (9A)', expa: 'Exports amended (9A)', cdnra: 'CDN Registered amended (9C)',
  cdnura: 'CDN Unregistered amended (9C)', b2csa: 'B2C Others amended (10)', ata: 'Advances received amended (11A)', txpda: 'Advances adjusted amended (11B)',
};
export const fmtValue = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
