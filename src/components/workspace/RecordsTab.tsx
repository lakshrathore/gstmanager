'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Panel } from '@/components/ui';
import { call, inr } from '@/lib/client';
import type { Section } from '@/engine/types';
import { RecordEditor } from './RecordEditor';
import { SECTION_LABELS, type ReturnDetail } from './types';

type Data = Record<string, unknown> & { items?: Record<string, number | null>[] };
export interface Rec { _id: string; section: string; key: string; data: Data; hasErrors: boolean; hasWarnings: boolean; edited: boolean; source?: { sheet: string; rows: number[] } }

function describe(r: Rec) {
  const d = r.data;
  const items = d.items ?? [];
  const tx = items.length ? items.reduce((a, i) => a + (i.txval ?? i.adAmt ?? 0), 0) : ((d.txval as number) ?? ((d.nilAmt as number) ?? 0) + ((d.exptAmt as number) ?? 0) + ((d.ngsupAmt as number) ?? 0));
  const tax = items.length ? items.reduce((a, i) => a + (i.iamt ?? 0) + (i.camt ?? 0) + (i.samt ?? 0) + (i.csamt ?? 0), 0) : ((d.iamt as number) ?? 0) + ((d.camt as number) ?? 0) + ((d.samt as number) ?? 0) + ((d.csamt as number) ?? 0);
  return {
    doc: (d.inum ?? d.ntNum ?? d.hsn ?? (r.section === 'docs' ? `${d.from}–${d.to}` : r.section === 'nil' ? d.splyTy : `POS ${d.pos}`)) as string,
    party: (d.ctin ?? (d.pos ? `POS ${d.pos}` : d.uqc ?? d.docTyp ?? '')) as string,
    date: (d.idt ?? d.ntDt ?? '') as string,
    val: (d.val ?? null) as number | null,
    rates: items.length ? items.map((i) => `${i.rt}%`).join(', ') : d.rt != null ? `${d.rt}%` : '',
    tx, tax,
  };
}

export function RecordsTab({ d, focusKey, onFocusHandled, onChanged }: { d: ReturnDetail; focusKey: string | null; onFocusHandled: () => void; onChanged: () => void }) {
  const [section, setSection] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState(focusKey ?? '');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<{ records: Rec[]; total: number; size: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<Section | null>(null);
  const [addSection, setAddSection] = useState<Section>('b2b');
  const locked = ['uploading', 'uploaded', 'processing', 'processed', 'filed'].includes(d.return.status);

  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries({ section, status, q, page: String(page) }).filter(([, v]) => v)).toString();
    return call<{ records: Rec[]; total: number; size: number }>(`/api/returns/${d.return._id}/records?${qs}`).then((r) => {
      setRes(r);
      return r;
    });
  }, [d.return._id, section, status, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // A "Fix" link from the Errors tab is used once, so coming back to this tab doesn't reopen a fixed record.
    if (focusKey) load().then((r) => { const hit = r.records.find((x) => x.key === focusKey); if (hit) setOpen(hit._id); onFocusHandled(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const pages = res ? Math.max(1, Math.ceil(res.total / res.size)) : 1;
  return (
    <>
      <Panel title="Records" action={!locked && (
        <div className="flex items-center gap-2">
          <select aria-label="Section for the new entry" className="w-56" value={addSection} onChange={(e) => setAddSection(e.target.value as Section)}>
            {Object.entries(SECTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Button onClick={() => { setOpen(null); setAdding(addSection); }}>Add entry</Button>
        </div>
      )}>
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
          <label>Section<select value={section} onChange={(e) => { setSection(e.target.value); setPage(1); }}><option value="">All sections</option>{Object.entries(SECTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v} {d.return.summary?.bySection[k] ? `(${d.return.summary.bySection[k].total})` : ''}</option>)}</select></label>
          <label>Show<select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All records</option><option value="errors">With errors</option><option value="warnings">With warnings</option></select></label>
          <label>Search document number or GSTIN<input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="INV/001, 27AAAC…" /></label>
        </div>
        {!res ? <p className="text-ink-soft">Loading…</p> : res.records.length === 0 ? <Empty title="No records match">Import a file, add entries manually with “Add entry”, or clear the filters.</Empty> : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="ledger">
                <thead><tr><th>Section</th><th>Document</th><th>Recipient / POS</th><th>Date</th><th className="text-right">Value</th><th>Rates</th><th className="text-right">Taxable</th><th className="text-right">Tax</th><th>Source</th><th></th></tr></thead>
                <tbody>
                  {res.records.map((r) => {
                    const x = describe(r);
                    return (
                      <tr key={r._id} className={r.hasErrors ? 'row-error' : ''}>
                        <td>{SECTION_LABELS[r.section]}</td>
                        <td className="num font-medium">{x.doc}</td>
                        <td className="num">{x.party}</td>
                        <td className="num">{x.date}</td>
                        <td className="num text-right">{x.val == null ? '—' : inr(x.val)}</td>
                        <td className="num">{x.rates}</td>
                        <td className="num text-right">{inr(x.tx)}</td>
                        <td className="num text-right">{inr(x.tax)}</td>
                        <td className="num text-[12px] text-ink-soft">{r.source?.sheet}:{r.source?.rows?.join(',')}{r.edited && <span className="ml-1 text-ledger">edited</span>}</td>
                        <td><Button variant={r.hasErrors ? 'danger' : 'ghost'} onClick={() => setOpen(r._id)}>{r.hasErrors ? 'Fix' : 'Edit'}</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-between text-ink-soft">
              <span className="num">{res.total.toLocaleString('en-IN')} {res.total === 1 ? 'record' : 'records'}</span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span className="num">{page} / {pages}</span>
                <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Panel>
      {adding && (
        <RecordEditor returnId={d.return._id} recordId={null} create={{ section: adding, supplierState: d.company.gstin.slice(0, 2) }}
          onClose={() => setAdding(null)} onSaved={() => { load(); onChanged(); }} onResolved={() => setAdding(null)}
          onCreated={(id) => { setAdding(null); setOpen(id); }} />
      )}
      {open && <RecordEditor returnId={d.return._id} recordId={open} onClose={() => setOpen(null)} onSaved={() => { load(); onChanged(); }}
        onResolved={() => { setOpen(null); if (q.includes('|')) { setQ(''); setPage(1); } /* a Fix link's record key */ }} />}
    </>
  );
}
