'use client';

import { useEffect, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { call } from '@/lib/client';
import { DOC_KIND_LABEL, FIELD_LABEL, NOTE_LABEL, type BankTxn, type Flag, type InvoiceData } from '@/engine/docs';
import { STATE_CODES } from '@/engine/masters';
import { money, REVIEW_LABEL, SOURCE_LABEL, type DocView, type RecordView } from './types';

/**
 * One extracted record next to the document it came from: the fields (problem fields marked), what
 * is wrong and why, and Save / Approve / Reject. The original opens at the page the record is on.
 */

interface Detail { record: RecordView; doc: DocView | null; related: RecordView[] }

const INV_FIELDS: { key: keyof InvoiceData; type: 'text' | 'num' | 'date' | 'gstin' | 'doctype' | 'pos' }[] = [
  { key: 'docType', type: 'doctype' }, { key: 'invoiceNo', type: 'text' }, { key: 'invoiceDate', type: 'date' },
  { key: 'supplierName', type: 'text' }, { key: 'supplierGstin', type: 'gstin' }, { key: 'customerName', type: 'text' }, { key: 'customerGstin', type: 'gstin' },
  { key: 'pos', type: 'pos' }, { key: 'taxable', type: 'num' }, { key: 'igst', type: 'num' }, { key: 'cgst', type: 'num' }, { key: 'sgst', type: 'num' },
  { key: 'cess', type: 'num' }, { key: 'total', type: 'num' },
];
const BANK_FIELDS: { key: keyof BankTxn; type: 'text' | 'num' | 'date' }[] = [
  { key: 'date', type: 'date' }, { key: 'narration', type: 'text' }, { key: 'ref', type: 'text' }, { key: 'debit', type: 'num' }, { key: 'credit', type: 'num' }, { key: 'balance', type: 'num' },
];

function Viewer({ doc, page, loc }: { doc: DocView; page?: number; loc: RecordView['loc'] }) {
  const url = `/api/docs/${doc._id}/file`;
  const ct = doc.contentType ?? '';
  if (ct === 'application/pdf') return <iframe key={`${doc._id}-${page}`} src={`${url}#page=${page ?? 1}&view=FitH`} title={doc.fileName} className="h-full min-h-[70vh] w-full rounded border border-rule bg-white" />;
  if (ct.startsWith('image/')) {
    return (
      <div className="h-full min-h-[70vh] overflow-auto rounded border border-rule bg-white">
        {/* The original scan at full size (an authenticated API file, not an optimisable static image). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={doc.fileName} className="max-w-none" />
      </div>
    );
  }
  return (
    <div className="grid h-full min-h-[40vh] place-items-center rounded border border-dashed border-rule bg-white p-6 text-center text-ink-soft">
      <div>
        <p className="font-medium text-ink">{doc.fileName}</p>
        {loc?.sheet && <p className="mt-1">Sheet “{loc.sheet}”, row {loc.row}</p>}
        <a href={`${url}?download=1`} className="mt-3 inline-block text-ledger underline">Download the original</a>
      </div>
    </div>
  );
}

export function RecordDrawer({ id, canEdit, onClose, onChanged, onOpen }: { id: string; canEdit: boolean; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call<Detail>(`/api/docs/records/${id}`).then((r) => { if (live) { setD(r); setDraft({}); setErr(null); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  async function act(action: 'save' | 'approve' | 'reject' | 'reopen', extra: Record<string, unknown> = {}) {
    setBusy(action); setErr(null);
    try {
      const body = { action, ...(Object.keys(draft).length ? { data: draft } : {}), ...extra };
      const r = await call<Detail>(`/api/docs/records/${id}`, { method: 'PATCH', json: body });
      setD(r); setDraft({}); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  const r = d?.record;
  const data = r ? { ...(r.data as unknown as Record<string, unknown>), ...draft } : {};
  const flagFor = (k: string) => r?.flags.filter((f) => f.field === k) ?? [];
  const tone = (fs: Flag[]) => (fs.some((f) => f.severity === 'error') ? 'border-red-ink ring-1 ring-red-ink/30' : fs.length ? 'border-amber ring-1 ring-amber/30' : '');
  const set = (k: string, v: unknown) => setDraft((x) => ({ ...x, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  const editable = canEdit && r && r.review !== 'rejected';

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-[1400px] flex-col bg-paper shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Review record">
        <header className="flex flex-wrap items-center gap-3 border-b border-rule bg-sheet px-5 py-3">
          <div className="mr-auto min-w-0">
            <p className="font-semibold">{r ? (r.kind === 'invoice' ? `${NOTE_LABEL[(r.data as InvoiceData).docType]} ${(r.data as InvoiceData).invoiceNo || '(no number)'}` : `Bank transaction ${(r.data as BankTxn).date}`) : 'Loading…'}</p>
            {r && d?.doc && (
              <p className="truncate text-[12.5px] text-ink-soft">
                {d.doc.fileName}{r.loc?.page ? ` · page ${r.loc.page}` : r.loc?.sheet ? ` · ${r.loc.sheet} row ${r.loc.row}` : ''} · {d.doc.kind ? DOC_KIND_LABEL[d.doc.kind] : ''}{r.source ? ` · ${SOURCE_LABEL[r.source] ?? r.source}` : ''}{r.direction ? ` · ${r.direction}` : ''} · {REVIEW_LABEL[r.review]}{r.reviewedBy ? ` by ${r.reviewedBy}` : ''}
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>

        {err && <div className="px-5 pt-3"><Notice tone="error">{err}</Notice></div>}
        {r && d && (
          <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-5 lg:grid-cols-[minmax(360px,440px)_1fr]">
            <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
              {r.flags.length > 0 ? (
                <ul className="space-y-1.5 text-[13px]">
                  {r.flags.map((f, i) => (
                    <li key={i} className={`rounded-md border px-3 py-2 ${f.severity === 'error' ? 'border-red-ink/30 bg-red-tint text-red-ink' : 'border-amber/30 bg-amber-tint text-amber'}`}>
                      {f.message}
                      {f.relatedId && <button type="button" className="ml-2 underline" onClick={() => onOpen(f.relatedId!)}>Open the other record</button>}
                    </li>
                  ))}
                </ul>
              ) : <Notice tone="ok">No problems found.</Notice>}

              {r.kind === 'invoice' && !r.direction && editable && (
                <label className="block">Is this a sale or a purchase of this client?
                  <select defaultValue="" onChange={(e) => e.target.value && act('save', { direction: e.target.value })}>
                    <option value="">Choose…</option><option value="sales">Sale (client is the supplier)</option><option value="purchase">Purchase (client is the customer)</option>
                  </select>
                </label>
              )}

              <div className="grid grid-cols-2 gap-3">
                {(r.kind === 'invoice' ? INV_FIELDS : BANK_FIELDS).map(({ key, type }) => {
                  const fs = flagFor(key);
                  const v = data[key];
                  const cls = `w-full ${type === 'num' || type === 'gstin' ? 'num' : ''} ${tone(fs)}`;
                  const wide = key === 'narration' || key === 'supplierName' || key === 'customerName';
                  return (
                    <label key={key} className={wide ? 'col-span-2' : ''}>
                      {FIELD_LABEL[key] ?? key}{r.uncertain.includes(key) && <span className="ml-1 text-amber">?</span>}
                      {type === 'doctype' ? (
                        <select value={String(v ?? 'INV')} disabled={!editable} onChange={(e) => set(key, e.target.value)} className={cls}>
                          <option value="INV">Invoice</option><option value="CN">Credit note</option><option value="DN">Debit note</option>
                        </select>
                      ) : type === 'pos' ? (
                        <select value={String(v ?? '')} disabled={!editable} onChange={(e) => set(key, e.target.value || undefined)} className={cls}>
                          <option value="">—</option>
                          {Object.entries(STATE_CODES).map(([c, n]) => <option key={c} value={c}>{c} – {n}</option>)}
                        </select>
                      ) : (
                        <input
                          value={v == null ? '' : String(v)} disabled={!editable} className={cls}
                          type={type === 'date' ? 'date' : 'text'} inputMode={type === 'num' ? 'decimal' : undefined}
                          onChange={(e) => set(key, type === 'num' ? (e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.-]/g, ''))) : type === 'gstin' ? e.target.value.toUpperCase() : e.target.value)}
                        />
                      )}
                      {r.original && (r.original as unknown as Record<string, unknown>)[key] !== (r.data as unknown as Record<string, unknown>)[key] && (
                        <span className="block text-[11.5px] text-ink-soft">Read as: {String((r.original as unknown as Record<string, unknown>)[key] ?? '—')}</span>
                      )}
                    </label>
                  );
                })}
              </div>

              {r.kind === 'invoice' && ((r.data as InvoiceData).items?.length ?? 0) > 0 && (
                <details className="rounded-md border border-rule bg-white">
                  <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Items ({(r.data as InvoiceData).items!.length})</summary>
                  <div className="overflow-x-auto">
                    <table className="ledger">
                      <thead><tr><th>Description</th><th>HSN</th><th className="text-right">Qty</th><th className="text-right">Taxable</th><th className="text-right">Rate</th><th className="text-right">Tax</th></tr></thead>
                      <tbody>
                        {(r.data as InvoiceData).items!.map((it, i) => (
                          <tr key={i}><td>{it.description}</td><td className="num">{it.hsn}</td><td className="num text-right">{it.quantity ?? ''} {it.unit ?? ''}</td><td className="num text-right">{money(it.taxable)}</td><td className="num text-right">{it.gstRate != null ? `${it.gstRate}%` : ''}</td><td className="num text-right">{money((it.igst ?? 0) + (it.cgst ?? 0) + (it.sgst ?? 0))}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              {r.kind === 'invoice' && (r.data as InvoiceData).pos && <p className="text-[12px] text-ink-soft">Place of supply {(r.data as InvoiceData).pos} – {STATE_CODES[(r.data as InvoiceData).pos!]}</p>}

              {editable && (
                <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-rule bg-paper py-3">
                  <Button onClick={() => act('approve')} busy={busy === 'approve'} disabled={busy !== null}>{dirty ? 'Save and approve' : 'Approve'}</Button>
                  {dirty && <Button variant="secondary" onClick={() => act('save')} busy={busy === 'save'} disabled={busy !== null}>Save</Button>}
                  {r.review === 'approved' ? <Button variant="ghost" onClick={() => act('reopen')} disabled={busy !== null}>Reopen</Button>
                    : <Button variant="danger" onClick={() => act('reject')} busy={busy === 'reject'} disabled={busy !== null}>Reject (not a valid record)</Button>}
                </div>
              )}
              {r.review === 'rejected' && canEdit && <Button variant="secondary" onClick={() => act('reopen')}>Restore</Button>}
              {d.related.length > 0 && (
                <div className="text-[12.5px] text-ink-soft">Related: {d.related.map((x) => <button key={x._id} type="button" className="mr-2 text-ledger underline" onClick={() => onOpen(x._id)}>{x.kind === 'invoice' ? (x.data as InvoiceData).invoiceNo : (x.data as BankTxn).date}</button>)}</div>
              )}
            </div>
            <div className="min-h-0">{d.doc && <Viewer doc={d.doc} page={r.loc?.page} loc={r.loc} />}</div>
          </div>
        )}
      </div>
    </div>
  );
}
