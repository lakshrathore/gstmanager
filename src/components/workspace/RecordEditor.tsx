'use client';

import { useEffect, useState } from 'react';
import { Button, Notice, Severity } from '@/components/ui';
import { call } from '@/lib/client';
import { fmtValue, SECTION_LABELS, type Issue } from './types';
import type { Rec } from './RecordsTab';

const NUMERIC = new Set(['val', 'rt', 'txval', 'iamt', 'camt', 'samt', 'csamt', 'adAmt', 'qty', 'totnum', 'cancel', 'nilAmt', 'exptAmt', 'ngsupAmt', 'diffPercent']);
const DATES = new Set(['idt', 'ntDt', 'sbDt']);
const LABELS: Record<string, string> = {
  ctin: 'Recipient GSTIN', receiverName: 'Receiver name', inum: 'Invoice number', idt: 'Invoice date', val: 'Invoice value', pos: 'Place of supply (code)',
  rchrg: 'Reverse charge (Y/N)', invTyp: 'Invoice type (R/SEWP/SEWOP/DE/CBW)', etin: 'E-commerce GSTIN', diffPercent: 'Applicable % (65 or blank)',
  ntNum: 'Note number', ntDt: 'Note date', ntty: 'Note type (C/D)', urType: 'UR type (B2CL/EXPWP/EXPWOP)', expTyp: 'Export type (WPAY/WOPAY)',
  portCode: 'Port code', sbNum: 'Shipping bill no.', sbDt: 'Shipping bill date', typ: 'Type (OE/E)', splyTy: 'Supply type', nilAmt: 'Nil rated', exptAmt: 'Exempted',
  ngsupAmt: 'Non-GST', hsn: 'HSN/SAC', desc: 'Description', uqc: 'UQC', qty: 'Quantity', rt: 'Rate %', txval: 'Taxable value', iamt: 'IGST', camt: 'CGST',
  samt: 'SGST/UTGST', csamt: 'Cess', docTyp: 'Nature of document', from: 'Sr. no. from', to: 'Sr. no. to', totnum: 'Total number', cancel: 'Cancelled', adAmt: 'Advance amount',
};
const ITEM_COLS = ['rt', 'txval', 'adAmt', 'iamt', 'camt', 'samt', 'csamt'];

const coerce = (k: string, v: string) => (NUMERIC.has(k) ? (v.trim() === '' ? null : Number(v)) : v);

/** onResolved: the save left the record with no errors or warnings – the editor should close. */
export function RecordEditor({ returnId, recordId, onClose, onSaved, onResolved }: { returnId: string; recordId: string; onClose: () => void; onSaved: () => void; onResolved: () => void }) {
  const [rec, setRec] = useState<Rec | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [recompute, setRecompute] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => call<{ record: Rec; issues: Issue[] }>(`/api/returns/${returnId}/records/${recordId}`).then((r) => { setRec(r.record); setData(structuredClone(r.record.data)); setIssues(r.issues); return r.issues; });
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [recordId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const fieldIssues = (f: string) => issues.filter((i) => i.field === f);
  const hasIssue = (f: string) => issues.some((i) => i.field === f && i.severity === 'error');
  const items = (data.items as Record<string, unknown>[] | undefined) ?? null;
  const itemCols = items ? ITEM_COLS.filter((c) => items.some((i) => c in i)) : [];

  async function save() {
    setBusy(true); setErr(null);
    try {
      await call(`/api/returns/${returnId}/records/${recordId}`, { method: 'PATCH', json: { data, recomputeTax: recompute } });
      const left = await load();
      onSaved();
      if (left.length === 0) onResolved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('Delete this record from the return? It will not be included in the JSON.')) return;
    setBusy(true);
    try { await call(`/api/returns/${returnId}/records/${recordId}`, { method: 'DELETE' }); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Edit record" className="h-full w-full max-w-2xl overflow-y-auto bg-paper shadow-xl" onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-white px-6 py-4">
          <div>
            <p className="text-ink-soft">{rec ? SECTION_LABELS[rec.section] : ''}</p>
            <h2 className="num text-[17px] font-semibold">{String(data.inum ?? data.ntNum ?? data.hsn ?? data.pos ?? '')}</h2>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
        </header>
        {!rec ? <p className="p-6 text-ink-soft">Loading…</p> : (
          <div className="space-y-6 p-6">
            {issues.length > 0 && (
              <ul className="space-y-2">
                {issues.map((i) => (
                  <li key={i._id} className="rounded-md border border-rule bg-white px-3 py-2">
                    <div className="flex items-start gap-2"><Severity s={i.severity} /><span><span className="num text-[12.5px] text-ink-soft">{i.field}</span> {i.message}</span></div>
                    {i.suggestion && <p className="mt-1 pl-14 text-ink-soft">{i.suggestion}</p>}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {Object.keys(data).filter((k) => k !== 'items').map((k) => (
                <label key={k}>
                  {LABELS[k] ?? k}
                  <input
                    className={`num ${hasIssue(k) ? 'border-red-ink bg-red-tint' : ''}`}
                    type={DATES.has(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(data[k] ?? '')) ? 'date' : NUMERIC.has(k) ? 'number' : 'text'}
                    step="any"
                    value={data[k] == null ? '' : String(data[k])}
                    onChange={(e) => setData({ ...data, [k]: coerce(k, e.target.value) })}
                    aria-invalid={hasIssue(k)}
                  />
                  {fieldIssues(k).length > 0 && <span className="text-red-ink">{fieldIssues(k)[0].message}</span>}
                </label>
              ))}
            </div>

            {items && (
              <div>
                <p className="mb-2 font-semibold">Rate-wise lines</p>
                <div className="overflow-x-auto rounded-md border border-rule bg-white">
                  <table className="ledger">
                    <thead><tr>{itemCols.map((c) => <th key={c}>{LABELS[c]}</th>)}<th></th></tr></thead>
                    <tbody>
                      {items.map((it, idx) => (
                        <tr key={idx}>
                          {itemCols.map((c) => {
                            const bad = hasIssue(`items[${idx}].${c}`);
                            return (
                              <td key={c} className="min-w-24">
                                <input type="number" step="any" className={`num ${bad ? 'border-red-ink bg-red-tint' : ''}`} aria-invalid={bad}
                                  value={it[c] == null ? '' : String(it[c])}
                                  onChange={(e) => { const next = items.map((x) => ({ ...x })); next[idx][c] = coerce(c, e.target.value); setData({ ...data, items: next }); }} />
                              </td>
                            );
                          })}
                          <td><Button variant="ghost" disabled={items.length < 2} onClick={() => setData({ ...data, items: items.filter((_, j) => j !== idx) })}>Remove</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button variant="ghost" className="mt-2" onClick={() => setData({ ...data, items: [...items, Object.fromEntries(itemCols.map((c) => [c, c === 'csamt' ? 0 : null]))] })}>Add rate line</Button>
              </div>
            )}

            <label className="flex items-center gap-2 text-ink"><input type="checkbox" className="w-auto" checked={recompute} onChange={(e) => setRecompute(e.target.checked)} />Recalculate IGST/CGST/SGST from rate × taxable value</label>
            {err && <Notice tone="error">{err}</Notice>}
            <div className="flex flex-wrap justify-between gap-3 border-t border-rule pt-4">
              <Button variant="danger" onClick={remove} disabled={busy}>Delete record</Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setData(structuredClone(rec.data))} disabled={busy}>Discard changes</Button>
                <Button onClick={save} busy={busy}>Save and revalidate</Button>
              </div>
            </div>
            <p className="text-[12.5px] text-ink-soft">Raw Excel values: <span className="num">{fmtValue((rec as unknown as { source?: { raw?: unknown } }).source?.raw)}</span></p>
          </div>
        )}
      </div>
    </div>
  );
}
