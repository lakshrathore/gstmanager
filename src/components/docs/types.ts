import type { Analysis, BankTxn, DocKind, Flag, InvoiceData, Loc } from '@/engine/docs';

/** Shapes the /api/docs routes return (see src/server/docs). */

export interface DocView {
  _id: string; fileName: string; contentType?: string; sizeBytes?: number; status: string; kind: DocKind | null; kindReason: string | null;
  method: 'rules' | 'ai' | null; confidence: number | null; fp: string | null; fy: string | null; gstins: string[]; notes: string[]; error: string | null;
  counts: { records: number; review: number; errors: number } | null; companyId: string | null; createdAt: string; uploadedBy?: string;
  ai: { model: string; inputTokens: number; outputTokens: number; costInr?: number } | null; batchId: string | null;
}

export interface Workspace {
  company: { _id: string; name: string; gstin: string };
  fy: string; fp: string | null;
  months: { fp: string; docs: number; records: number; review: number }[];
  noPeriod: number;
  docs: DocView[];
  unassigned: DocView[];
  pending: number;
  batches: Batch[];
  ai: { configured: boolean; allowed: boolean; reason: string | null; model: string };
  analysis: Analysis;
  canEdit: boolean;
}

export interface Batch { batchId: string; at: string; total: number; processed: number; needsReview: number; duplicate: number; failed: number; pending: number; clients: number }

export interface RecordView {
  _id: string; docId: string; kind: 'invoice' | 'bank'; source: string | null; direction: 'sales' | 'purchase' | null; fp: string | null;
  data: InvoiceData | BankTxn; original: InvoiceData | BankTxn | null; loc: Loc | null; uncertain: string[]; flags: Flag[];
  review: 'ok' | 'review' | 'approved' | 'rejected'; reviewedBy: string | null; reviewedAt: string | null; fileName?: string;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting', processing: 'Reading…', processed: 'Done', needs_review: 'Needs review', failed: 'Failed', duplicate: 'Duplicate file',
};
export const STATUS_TONE: Record<string, string> = {
  queued: 'bg-black/5 text-ink-soft', processing: 'bg-amber-tint text-amber', processed: 'bg-ledger-tint text-ledger',
  needs_review: 'bg-amber-tint text-amber', failed: 'bg-red-tint text-red-ink', duplicate: 'bg-black/5 text-ink-soft',
};
export const SOURCE_LABEL: Record<string, string> = { document: 'Invoice', register: 'Register', gstr1: 'GSTR-1', gstr2a: 'GSTR-2A', gstr2b: 'GSTR-2B' };
export const REVIEW_LABEL: Record<string, string> = { ok: 'OK', review: 'Review', approved: 'Approved', rejected: 'Rejected' };

export const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
export const monthLabel = (fp: string) => new Date(Number(fp.slice(2)), Number(fp.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
