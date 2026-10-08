'use client';

import { useState } from 'react';
import { Empty, Notice } from '@/components/ui';
import { call } from '@/lib/client';
import { DOC_KIND_LABEL, DOC_KINDS } from '@/engine/docs';
import { monthLabel, STATUS_LABEL, STATUS_TONE, type DocView } from './types';

/** Uploaded documents: what each was taken for, its period and status, with correct-type, read-again and delete. */
export function DocsList({ docs, companies, canEdit, onShowRecords, onChanged, unassigned = false }: {
  docs: DocView[]; companies: { _id: string; name: string; gstin: string }[]; canEdit: boolean; unassigned?: boolean;
  onShowRecords: (d: DocView) => void; onChanged: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  async function act(d: DocView, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setErr(null);
    try { await call(`/api/docs/${d._id}`, { method: 'POST', json: body }); onChanged(); } catch (e) { setErr((e as Error).message); }
  }
  if (!docs.length) return <Empty title={unassigned ? 'No documents waiting for a client' : 'No documents for this period'} />;
  return (
    <div className="space-y-2">
      {err && <Notice tone="error">{err}</Notice>}
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead><tr><th>File</th><th>Taken as</th><th>Period</th><th>Status</th><th className="text-right">Records</th><th /></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d._id}>
                <td className="max-w-72">
                  <a href={`/api/docs/${d._id}/file`} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline" title={d.fileName}>{d.fileName}</a>
                  <div className="text-[11.5px] text-ink-soft">{new Date(d.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}{d.uploadedBy ? ` · ${d.uploadedBy}` : ''}</div>
                </td>
                <td className="min-w-48">
                  {canEdit && d.kind && !['queued', 'processing', 'duplicate'].includes(d.status) ? (
                    <select value={d.kind} onChange={(e) => act(d, { action: 'set_kind', kind: e.target.value })} aria-label="Document type" className="text-[13px]">
                      {DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
                    </select>
                  ) : d.kind ? DOC_KIND_LABEL[d.kind] : '—'}
                  {d.kindReason && <div className="max-w-64 text-[11.5px] text-ink-soft">{d.method === 'ai' ? 'AI: ' : ''}{d.kindReason}</div>}
                </td>
                <td className="whitespace-nowrap">{d.fp ? monthLabel(d.fp) : '—'}</td>
                <td className="max-w-80">
                  <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${STATUS_TONE[d.status] ?? ''}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
                  {d.error && <div className="mt-1 text-[12px] text-red-ink">{d.error}</div>}
                  {d.notes.map((n) => <div key={n} className="mt-1 text-[12px] text-ink-soft">{n}</div>)}
                  {unassigned && canEdit && (
                    <select defaultValue="" onChange={(e) => e.target.value && act(d, { action: 'assign', companyId: e.target.value })} className="mt-1 text-[13px]" aria-label="Client">
                      <option value="">Assign to client…</option>
                      {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
                    </select>
                  )}
                </td>
                <td className="num text-right">
                  {d.counts ? (
                    <button type="button" className="text-ledger underline disabled:no-underline disabled:text-ink-soft" disabled={!d.counts.records || unassigned} onClick={() => onShowRecords(d)}>
                      {d.counts.records}{d.counts.review ? ` (${d.counts.review} to review)` : ''}
                    </button>
                  ) : '—'}
                </td>
                <td className="whitespace-nowrap text-right text-[12.5px]">
                  {canEdit && ['failed', 'needs_review', 'processed'].includes(d.status) && (
                    <button type="button" className="mr-3 text-ledger hover:underline" onClick={() => act(d, { action: 'reprocess' }, d.method === 'ai' ? 'Read this document again with AI? (charged again)' : undefined)}>Read again</button>
                  )}
                  {canEdit && <button type="button" className="text-red-ink hover:underline" onClick={() => act(d, { action: 'delete' }, `Delete ${d.fileName} and the records read from it?`)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
