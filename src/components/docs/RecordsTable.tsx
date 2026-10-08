'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Notice } from '@/components/ui';
import { call } from '@/lib/client';
import { NOTE_LABEL, type BankMatch, type BankTxn, type InvoiceData } from '@/engine/docs';
import { money, REVIEW_LABEL, SOURCE_LABEL, type RecordView } from './types';

/**
 * Extracted records with filters: side, source, issue type, review state, amount, free-text search
 * (invoice number, GSTIN, party, narration…). Click a row to review it next to its document.
 */

export interface Filters {
  kind: 'invoice' | 'bank';
  direction?: string; source?: string; flag?: string; review?: string; min?: string; max?: string; q?: string; mode?: string; docId?: string; ids?: string[];
}

const ISSUES: [string, string][] = [
  ['', 'Any'], ['any', 'With issues'], ['duplicate,possible_duplicate,duplicate_txn', 'Duplicates'], ['invalid_gstin', 'Invalid GSTIN'],
  ['tax_calc,total_mismatch,cgst_sgst,items_total,tax_high,pos_tax,mixed_tax', 'Tax / total errors'], ['missing_invoice_no,missing_date,missing_gstin', 'Missing details'],
  ['low_confidence', 'Low confidence'], ['direction_unknown', 'Sale or purchase?'], ['cash_large', 'Large cash'], ['balance_break', 'Balance breaks'],
];
/** Ids of bank lines with a match status (a never-matching id when there are none, so the list shows empty). */
const matchIds = (m: Record<string, BankMatch>, status: string) => { const ids = Object.entries(m).filter(([, x]) => x.status === status).map(([id]) => id); return ids.length ? ids : ['000000000000000000000000']; };
const MODES = ['', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CASH', 'CHEQUE', 'ATM', 'CARD', 'NACH', 'INTEREST', 'CHARGES', 'TRANSFER', 'OTHER'];

function Badges({ r }: { r: RecordView }) {
  const errors = r.flags.filter((f) => f.severity === 'error').length;
  const warnings = r.flags.length - errors;
  return (
    <span className="flex flex-wrap gap-1">
      {errors > 0 && <span className="rounded bg-red-tint px-1.5 text-[11.5px] font-medium text-red-ink" title={r.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('\n')}>{errors} error{errors > 1 ? 's' : ''}</span>}
      {warnings > 0 && <span className="rounded bg-amber-tint px-1.5 text-[11.5px] font-medium text-amber" title={r.flags.filter((f) => f.severity !== 'error').map((f) => f.message).join('\n')}>{warnings} warning{warnings > 1 ? 's' : ''}</span>}
      {r.review !== 'ok' && <span className={`rounded px-1.5 text-[11.5px] ${r.review === 'approved' ? 'bg-ledger-tint text-ledger' : r.review === 'rejected' ? 'bg-black/5 text-ink-soft line-through' : 'bg-black/5 text-ink'}`}>{REVIEW_LABEL[r.review]}</span>}
    </span>
  );
}

export function RecordsTable({ companyId, fy, fp, preset, canEdit, onOpen, refresh, onChanged, bankMatches }: {
  companyId: string; fy: string; fp: string | null; preset: Filters; canEdit: boolean; onOpen: (id: string) => void; refresh: number; onChanged: () => void;
  /** Bank line → invoice match (from the period analysis). */
  bankMatches?: Record<string, BankMatch>;
}) {
  const [f, setF] = useState<Filters>(preset);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; records: RecordView[]; limit: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [matchFilter, setMatchFilter] = useState('');
  const presetKey = JSON.stringify(preset);
  const [lastPreset, setLastPreset] = useState(presetKey);
  if (presetKey !== lastPreset) { setLastPreset(presetKey); setF(preset); setPage(0); }

  const qs = useMemo(() => {
    const p = new URLSearchParams({ companyId, fy, kind: f.kind, page: String(page), limit: '100' });
    if (fp) p.set('fp', fp);
    for (const k of ['direction', 'source', 'flag', 'review', 'min', 'max', 'q', 'mode', 'docId'] as const) if (f[k]) p.set(k, f[k]!);
    if (f.ids?.length) p.set('ids', f.ids.join(','));
    return p.toString();
  }, [companyId, fy, fp, f, page]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      call<{ total: number; records: RecordView[]; limit: number }>(`/api/docs/records?${qs}`)
        .then((r) => { if (live) { setData(r); setErr(null); } })
        .catch((e) => live && setErr(e.message));
    }, f.q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [qs, refresh, f.q]);

  const upd = (k: keyof Filters, v: string) => { setF({ ...f, [k]: v || undefined, ids: k === 'ids' ? undefined : f.ids }); setPage(0); };
  const reviewable = data?.records.filter((r) => r.review === 'review' && !r.flags.some((x) => x.severity === 'error')) ?? [];

  async function approveClean() {
    setBusy(true); setMsg(null);
    try {
      const r = await call<{ approved: number; skipped: number }>('/api/docs/records', { method: 'POST', json: { action: 'approve_clean', ids: reviewable.map((x) => x._id) } });
      setMsg(`Approved ${r.approved} record(s).`);
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const inv = f.kind === 'invoice';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1">Search
          <input value={f.q ?? ''} onChange={(e) => upd('q', e.target.value)} placeholder={inv ? 'Invoice no, GSTIN, party, HSN…' : 'Narration, reference, party…'} />
        </label>
        {inv && (
          <>
            <label>Side
              <select value={f.direction ?? ''} onChange={(e) => upd('direction', e.target.value)}><option value="">All</option><option value="sales">Sales</option><option value="purchase">Purchases</option></select>
            </label>
            <label>Source
              <select value={f.source ?? ''} onChange={(e) => upd('source', e.target.value)}>
                <option value="">All</option><option value="books">Books (invoices + registers)</option><option value="document">Invoice documents</option><option value="register">Registers</option>
                <option value="gstr1">GSTR-1</option><option value="gstr2b">GSTR-2B</option><option value="gstr2a">GSTR-2A</option>
              </select>
            </label>
          </>
        )}
        {!inv && (
          <label>Mode
            <select value={f.mode ?? ''} onChange={(e) => upd('mode', e.target.value)}>{MODES.map((m) => <option key={m} value={m}>{m || 'All'}</option>)}</select>
          </label>
        )}
        {!inv && bankMatches && (
          <label>Books
            <select value={matchFilter} onChange={(e) => { setMatchFilter(e.target.value); setF({ ...f, ids: e.target.value ? matchIds(bankMatches, e.target.value) : undefined }); setPage(0); }}>
              <option value="">All</option><option value="unmatched">No matching invoice</option><option value="party">Party found, amount differs</option><option value="matched">Matched to an invoice</option><option value="not_applicable">Charges / interest</option>
            </select>
          </label>
        )}
        <label>Issues
          <select value={f.flag ?? ''} onChange={(e) => upd('flag', e.target.value)}>{ISSUES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Review
          <select value={f.review ?? ''} onChange={(e) => upd('review', e.target.value)}>
            <option value="">All (not rejected)</option><option value="open">Waiting for review</option><option value="approved">Approved</option><option value="ok">OK</option><option value="rejected">Rejected</option>
          </select>
        </label>
        <label className="w-32">Amount from ₹
          <input value={f.min ?? ''} onChange={(e) => upd('min', e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className="num" />
        </label>
        <a className="pb-2 text-[13px] text-ledger underline" href={`/api/docs/export?what=records&${qs}`}>Export to Excel</a>
      </div>
      {f.ids?.length ? <p className="text-[12.5px] text-ink-soft">Showing {f.ids.length} record(s) from the summary. <button type="button" className="text-ledger underline" onClick={() => upd('ids', '')}>Show all</button></p> : null}
      {f.docId && <p className="text-[12.5px] text-ink-soft">Records of one document. <button type="button" className="text-ledger underline" onClick={() => upd('docId', '')}>Show all</button></p>}
      {err && <Notice tone="error">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      {canEdit && reviewable.length > 0 && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={approveClean} busy={busy}>Approve {reviewable.length} without errors on this page</Button>
          <span className="text-[12.5px] text-ink-soft">Records with errors stay for you to open and fix.</span>
        </div>
      )}
      {data && !data.records.length ? <Empty title="Nothing here">No records match these filters.</Empty> : data && (
        <>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead>
                {inv ? (
                  <tr><th>Date</th><th>Document</th><th>Party</th><th>Side</th><th>Source</th><th className="text-right">Taxable</th><th className="text-right">Tax</th><th className="text-right">Total</th><th>Status</th></tr>
                ) : (
                  <tr><th>Date</th><th>Narration</th><th>Mode</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th>{bankMatches && <th>Books</th>}<th>Status</th></tr>
                )}
              </thead>
              <tbody>
                {data.records.map((r) => {
                  const rowCls = `cursor-pointer ${r.flags.some((x) => x.severity === 'error') && r.review !== 'approved' ? 'row-error' : r.flags.length && r.review !== 'approved' ? 'row-warn' : ''} ${r.review === 'rejected' ? 'opacity-50' : ''}`;
                  if (r.kind === 'invoice') {
                    const d = r.data as InvoiceData;
                    const party = r.direction === 'sales' ? { n: d.customerName, g: d.customerGstin } : { n: d.supplierName, g: d.supplierGstin };
                    return (
                      <tr key={r._id} className={rowCls} onClick={() => onOpen(r._id)}>
                        <td className="whitespace-nowrap">{d.invoiceDate || '—'}</td>
                        <td><span className="font-medium">{d.invoiceNo || (d.summary ? 'Summary' : '—')}</span> <span className="text-[12px] text-ink-soft">{d.docType !== 'INV' ? NOTE_LABEL[d.docType] : ''}</span><div className="max-w-56 truncate text-[11.5px] text-ink-soft">{r.fileName}</div></td>
                        <td className="max-w-64"><div className="truncate">{party.n ?? '—'}</div><div className="num text-[11.5px] text-ink-soft">{party.g}</div></td>
                        <td className="capitalize">{r.direction ?? '?'}</td>
                        <td className="whitespace-nowrap">{SOURCE_LABEL[r.source ?? ''] ?? r.source}</td>
                        <td className="num text-right">{money(d.taxable)}</td>
                        <td className="num text-right">{money(d.igst + d.cgst + d.sgst + d.cess)}</td>
                        <td className="num text-right">{money(d.total ?? null)}</td>
                        <td><Badges r={r} /></td>
                      </tr>
                    );
                  }
                  const t = r.data as BankTxn;
                  return (
                    <tr key={r._id} className={rowCls} onClick={() => onOpen(r._id)}>
                      <td className="whitespace-nowrap">{t.date}</td>
                      <td className="max-w-md"><div className="truncate">{t.narration}</div>{t.ref && <div className="num text-[11.5px] text-ink-soft">{t.ref}</div>}</td>
                      <td>{t.mode}</td>
                      <td className="num text-right">{t.debit ? money(t.debit) : ''}</td>
                      <td className="num text-right">{t.credit ? money(t.credit) : ''}</td>
                      <td className="num text-right">{money(t.balance ?? null)}</td>
                      {bankMatches && <td className="max-w-56 text-[12px]">{bankMatches[r._id] ? <span className={bankMatches[r._id].status === 'unmatched' ? 'text-amber' : bankMatches[r._id].status === 'matched' ? 'text-ledger' : 'text-ink-soft'}>{bankMatches[r._id].note}</span> : <span className="text-ink-soft">—</span>}</td>}
                      <td><Badges r={r} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-ink-soft">
            <span>{data.total} record(s){data.total > data.limit ? ` · page ${page + 1} of ${Math.ceil(data.total / data.limit)}` : ''}</span>
            {page > 0 && <button type="button" className="text-ledger underline" onClick={() => setPage(page - 1)}>Previous</button>}
            {(page + 1) * data.limit < data.total && <button type="button" className="text-ledger underline" onClick={() => setPage(page + 1)}>Next</button>}
          </div>
        </>
      )}
    </div>
  );
}
