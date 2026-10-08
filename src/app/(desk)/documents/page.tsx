'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Notice, Panel } from '@/components/ui';
import { DocsList } from '@/components/docs/DocsList';
import { Overview, Recon } from '@/components/docs/Overview';
import { RecordDrawer } from '@/components/docs/RecordDrawer';
import { RecordsTable, type Filters } from '@/components/docs/RecordsTable';
import { Reports } from '@/components/docs/Reports';
import { RecentUploads } from '@/components/docs/RecentUploads';
import { Uploader } from '@/components/docs/Uploader';
import { monthLabel, type Workspace } from '@/components/docs/types';
import { call } from '@/lib/client';
import type { Exception } from '@/engine/docs';
import { fyChoices } from '@/server/gst/annual/common';

/**
 * Client documents: upload anything → the app works out what each file is, whose it is and for
 * which month, reads it, checks it, reconciles purchases with GSTR-2B – and shows only what needs
 * the CA. Organised client → financial year → month.
 */

type Tab = 'overview' | 'documents' | 'invoices' | 'review' | 'recon' | 'bank' | 'reports';
interface Company { _id: string; name: string; gstin: string }

const currentFy = () => fyChoices()[0];

export default function DocumentsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fy, setFy] = useState(currentFy());
  const [fp, setFp] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [ws, setWs] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [preset, setPreset] = useState<Filters>({ kind: 'invoice' });
  const [batch, setBatch] = useState<string | null>(null);

  useEffect(() => {
    // Links from Search: /documents?companyId=…&fy=…&fp=…&record=…
    const u = new URLSearchParams(window.location.search);
    call<{ companies: Company[] }>('/api/companies').then((r) => {
      setCompanies(r.companies);
      const want = u.get('companyId');
      setCompanyId(want && r.companies.some((c) => c._id === want) ? want : r.companies[0]?._id ?? '');
      if (u.get('fy')) setFy(u.get('fy')!);
      if (u.get('fp')) setFp(u.get('fp'));
      if (u.get('record')) setOpen(u.get('record'));
      if (u.get('tab')) setTab(u.get('tab') as Tab);
    }).catch((e) => setErr(e.message));
  }, []);

  const load = useCallback(() => {
    if (!companyId) return Promise.resolve();
    return call<Workspace>(`/api/docs?companyId=${companyId}&fy=${fy}${fp ? `&fp=${fp}` : ''}`)
      .then((r) => { setWs(r); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [companyId, fy, fp]);
  useEffect(() => { load(); }, [load]);
  const changed = useCallback(() => { load(); setRefresh((n) => n + 1); }, [load]);

  // While documents are being read, refresh every few seconds.
  const pending = ws?.pending ?? 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(changed, 4000);
    return () => clearInterval(t);
  }, [pending, changed]);

  const pick = (c: string, y: string, m: string | null) => { setWs(null); setCompanyId(c); setFy(y); setFp(m); };
  const show = (e: Exception) => { const bank = e.code.startsWith('bank'); setPreset({ kind: bank ? 'bank' : 'invoice', ids: e.ids }); setTab(bank ? 'bank' : 'invoices'); };
  const label = fp ? monthLabel(fp) : `FY ${fy}`;
  const reviewCount = useMemo(() => (ws ? (fp ? ws.months.find((m) => m.fp === fp)?.review ?? 0 : ws.months.reduce((a, m) => a + m.review, 0)) : 0), [ws, fp]);
  const TABS: [Tab, string][] = [
    ['overview', 'Overview'], ['documents', `Documents${ws ? ` (${ws.docs.length})` : ''}`], ['invoices', 'Invoices'],
    ['review', `Review${reviewCount ? ` (${reviewCount})` : ''}`], ['recon', 'Purchase vs GSTR-2B'], ['bank', 'Bank'], ['reports', 'Reports'],
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Client documents</h1>
          {ws && <p className="text-ink-soft">{ws.company.name} · {ws.company.gstin} · {label}{pending ? ` · reading ${pending} document(s)…` : ''}</p>}
        </div>
        <div className="flex flex-wrap gap-3">
          <label>Client
            <select value={companyId} onChange={(e) => pick(e.target.value, fy, fp)} className="min-w-56">
              {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
            </select>
          </label>
          <label>Financial year
            <select value={fy} onChange={(e) => pick(companyId, e.target.value, null)}>{fyChoices().map((y) => <option key={y} value={y}>{y}</option>)}</select>
          </label>
        </div>
      </div>

      {err && <Notice tone="error">{err}</Notice>}
      {!companies.length && <Empty title="Add a client first">Each client (GSTIN) is a company. Add one on the Companies page.</Empty>}

      {ws && (
        <>
          <nav className="flex flex-wrap gap-1.5" aria-label="Month">
            <button type="button" onClick={() => setFp(null)} className={`rounded-md border px-3 py-1.5 text-[13px] ${!fp ? 'border-ink bg-ink text-white' : 'border-rule bg-white'}`}>Whole year</button>
            {ws.months.map((m) => (
              <button key={m.fp} type="button" onClick={() => setFp(m.fp)}
                className={`rounded-md border px-3 py-1.5 text-[13px] ${fp === m.fp ? 'border-ink bg-ink text-white' : m.records ? 'border-rule bg-white' : 'border-rule bg-white text-ink-soft'}`}>
                {monthLabel(m.fp).split(' ')[0]}
                {m.records > 0 && <span className="num ml-1 text-[11px] opacity-70">{m.records}</span>}
                {m.review > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber align-middle" aria-label={`${m.review} to review`} />}
              </button>
            ))}
          </nav>

          {ws.canEdit && (
            <Panel title="Upload">
              <div className="space-y-4">
                <Uploader companyId={companyId} companyName={ws.company.name} canAuto={companies.length > 1} ai={ws.ai.allowed} aiReason={ws.ai.reason} onUploaded={changed} />
                <RecentUploads batches={ws.batches} onShow={(b) => { setBatch(b); setFp(null); setTab('documents'); }} />
              </div>
            </Panel>
          )}

          {ws.unassigned.length > 0 && (
            <Panel title={`Documents waiting for a client (${ws.unassigned.length})`}>
              <DocsList docs={ws.unassigned} companies={companies} canEdit={ws.canEdit} unassigned onShowRecords={() => undefined} onChanged={changed} />
            </Panel>
          )}

          <div className="flex flex-wrap gap-1 border-b border-rule">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => { setTab(k); if (k === 'invoices') setPreset({ kind: 'invoice' }); if (k === 'bank') setPreset({ kind: 'bank' }); if (k === 'review') setPreset({ kind: 'invoice', review: 'open' }); }}
                className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] ${tab === k ? 'border-ledger font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>{l}</button>
            ))}
          </div>

          <Panel>
            {tab === 'overview' && <Overview a={ws.analysis} label={label} onShow={show} reportUrl={`/api/docs/export?what=report&companyId=${companyId}&fy=${fy}${fp ? `&fp=${fp}` : ''}`} />}
            {tab === 'documents' && (
              <>
              {batch && <p className="mb-3 text-[12.5px] text-ink-soft">Files of one upload (this client). <button type="button" className="text-ledger underline" onClick={() => setBatch(null)}>Show all</button></p>}
              <DocsList docs={batch ? ws.docs.filter((d) => d.batchId === batch) : ws.docs} companies={companies} canEdit={ws.canEdit} onChanged={changed}
                onShowRecords={(d) => { setPreset({ kind: d.kind === 'bank_statement' ? 'bank' : 'invoice', docId: d._id }); setTab(d.kind === 'bank_statement' ? 'bank' : 'invoices'); }} />
              </>
            )}
            {(tab === 'invoices' || tab === 'review' || tab === 'bank') && (
              <RecordsTable companyId={companyId} fy={fy} fp={fp} preset={preset} canEdit={ws.canEdit} onOpen={setOpen} refresh={refresh} onChanged={changed} bankMatches={tab === 'bank' ? ws.analysis.bank?.matches : undefined} />
            )}
            {tab === 'recon' && <Recon a={ws.analysis} onOpen={setOpen} />}
            {tab === 'reports' && <Reports companyId={companyId} fy={fy} fp={fp} onOpen={setOpen} refresh={refresh} />}
          </Panel>
          {ws.noPeriod > 0 && !fp && <p className="text-[12.5px] text-ink-soft">{ws.noPeriod} document(s) have no period yet (shown under every month in Documents).</p>}
        </>
      )}

      {open && ws && <RecordDrawer id={open} canEdit={ws.canEdit} onClose={() => setOpen(null)} onChanged={changed} onOpen={setOpen} />}
    </div>
  );
}
