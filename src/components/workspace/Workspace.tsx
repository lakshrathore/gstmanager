'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Notice, StatusBadge } from '@/components/ui';
import { call, periodLabel } from '@/lib/client';
import { AuditTab } from './AuditTab';
import { ErrorsTab } from './ErrorsTab';
import { ImportTab } from './ImportTab';
import { JsonTab } from './JsonTab';
import { GstPortalTab } from './GstPortalTab';
import { RecordsTab } from './RecordsTab';
import type { ReturnDetail } from './types';

const TABS = [
  { id: 'import', label: 'Import' },
  { id: 'records', label: 'Records' },
  { id: 'errors', label: 'Errors' },
  { id: 'json', label: 'JSON' },
  { id: 'portal', label: 'GST portal' },
  { id: 'audit', label: 'Audit trail' },
] as const;
export type Tab = (typeof TABS)[number]['id'];

const ORDER = ['draft', 'imported', 'validation_error', 'validated', 'json_generated', 'ready_for_upload', 'uploading', 'uploaded', 'processing', 'error', 'processed', 'filed'];

interface Stage { label: string; done: boolean; bad?: boolean; note: string }

/** The return's journey, split by where each step happens. Derived from status – never stored separately. */
function stages(d: ReturnDetail): { app: Stage[]; portal: Stage[] } {
  const s = d.return.status;
  const sum = d.return.summary;
  const at = (x: string) => ORDER.indexOf(s) >= ORDER.indexOf(x);
  const portal = d.return.portal ?? {};
  return {
    app: [
      { label: 'Add data', done: !!sum?.total, note: sum?.total ? `${sum.total.toLocaleString('en-IN')} records` : 'Import or enter manually' },
      { label: 'Validate & fix', done: !!sum?.total && !sum.errorCount, bad: !!sum?.errorCount, note: sum?.total ? (sum.errorCount ? `${sum.errorCount} errors` : 'No errors') : '—' },
      { label: 'Generate JSON', done: !!d.json && !d.return.jsonStale, bad: d.return.jsonStale, note: d.json ? (d.return.jsonStale ? 'Out of date' : `${(d.json.sizeBytes / 1024).toFixed(1)} KB`) : '—' },
      { label: 'Approve for upload', done: at('ready_for_upload') && s !== 'error', note: at('ready_for_upload') && s !== 'error' ? 'Approved' : '—' },
    ],
    portal: [
      { label: 'Upload JSON', done: at('uploaded'), note: s === 'uploading' ? 'Waiting for you' : portal.uploadReference ? `Ref ${portal.uploadReference}` : at('uploaded') ? 'Uploaded' : '—' },
      { label: 'Portal result', done: s === 'processed' || s === 'filed', bad: s === 'error', note: s === 'error' ? `${d.counts.portalErrors} portal errors` : s === 'processed' || s === 'filed' ? 'Processed' : s === 'processing' ? 'Processing' : '—' },
      { label: 'File return', done: s === 'filed', note: portal.arn ? `ARN ${portal.arn}` : '—' },
    ],
  };
}

function StageRow({ title, items, offset, current }: { title: string; items: Stage[]; offset: number; current: number }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[12.5px] font-semibold text-ink-soft">{title}</p>
      <ol className={`grid gap-px overflow-hidden rounded-lg border border-rule bg-rule ${items.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
        {items.map((x, j) => {
          const i = offset + j;
          return (
            <li key={x.label} aria-current={i === current ? 'step' : undefined} className={`px-4 py-3 ${i === current ? 'bg-ledger-tint' : 'bg-white'}`}>
              <div className="flex items-center gap-2">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${x.bad ? 'bg-red-ink text-white' : x.done ? 'bg-ledger text-white' : i === current ? 'border-2 border-ledger text-ledger' : 'border border-rule text-ink-soft'}`}>
                  {x.done && !x.bad ? '✓' : i + 1}
                </span>
                <span className="font-semibold">{x.label}</span>
              </div>
              <p className={`mt-1 truncate pl-8 text-[12.5px] ${x.bad ? 'text-red-ink' : 'text-ink-soft'}`}>{x.note}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const [d, setD] = useState<ReturnDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('import');
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const reload = useCallback(() => call<ReturnDetail>(`/api/returns/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    // first load: land on the most useful tab
    call<ReturnDetail>(`/api/returns/${id}`)
      .then((r) => {
        setD(r);
        if (r.return.summary?.total) setTab(r.return.summary.errorCount || r.return.status === 'error' ? 'errors' : ['json_generated', 'validated'].includes(r.return.status) ? 'json' : 'portal');
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  if (err) return <Notice tone="error">{err}</Notice>;
  if (!d) return <p className="text-ink-soft">Loading return…</p>;
  const sum = d.return.summary;
  const st = stages(d);
  const all = [...st.app, ...st.portal];
  const current = all.findIndex((x) => !x.done || x.bad);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-ink-soft hover:text-ink">Returns</Link>
          <h1 className="mt-1 text-[24px] font-semibold tracking-tight">GSTR-1 for {d.return.quarterly ? 'quarter ending ' : ''}{periodLabel(d.return.fp)}</h1>
          <p className="flex flex-wrap gap-x-4 text-ink-soft"><span>{d.company.name}</span><span className="num">{d.company.gstin}</span><span>FY {d.return.fy}</span></p>
        </div>
        <StatusBadge status={d.return.status} />
      </header>

      <div className="grid gap-4 lg:grid-cols-[4fr_3fr]">
        <StageRow title="In this app" items={st.app} offset={0} current={current} />
        <StageRow title="On the GST portal (you do these steps there)" items={st.portal} offset={st.app.length} current={current} />
      </div>

      {sum && sum.total > 0 && (
        <dl className="flex flex-wrap gap-x-10 gap-y-3 border-y border-rule py-4">
          {[
            ['Total records', sum.total, ''],
            ['Valid', sum.valid, 'text-ledger'],
            ['With errors', sum.withErrors, sum.withErrors ? 'text-red-ink' : ''],
            ['Error lines', sum.errorCount, sum.errorCount ? 'text-red-ink' : ''],
            ['Warnings', sum.warningCount, sum.warningCount ? 'text-amber' : ''],
          ].map(([k, v, c]) => (
            <div key={k as string}>
              <dt className="text-[12.5px] text-ink-soft">{k}</dt>
              <dd className={`num text-[26px] leading-tight ${c}`}>{(v as number).toLocaleString('en-IN')}</dd>
            </div>
          ))}
        </dl>
      )}

      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-rule">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setFocusKey(null); setTab(t.id); }}
            className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-[13.5px] ${tab === t.id ? 'border-ledger font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>
            {t.label}
            {t.id === 'errors' && sum?.errorCount ? <span className="num ml-1.5 rounded bg-red-tint px-1.5 text-red-ink">{sum.errorCount}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'import' && <ImportTab d={d} onDone={() => { reload(); setTab('errors'); }} />}
        {tab === 'records' && <RecordsTab d={d} focusKey={focusKey} onFocusHandled={() => setFocusKey(null)} onChanged={reload} />}
        {tab === 'errors' && <ErrorsTab d={d} onOpenRecord={(k) => { setFocusKey(k); setTab('records'); }} onChanged={reload} />}
        {tab === 'json' && <JsonTab d={d} onChanged={reload} />}
        {tab === 'portal' && <GstPortalTab d={d} onChanged={reload} onGoto={(t) => setTab(t)} />}
        {tab === 'audit' && <AuditTab id={d.return._id} />}
      </div>
    </div>
  );
}
