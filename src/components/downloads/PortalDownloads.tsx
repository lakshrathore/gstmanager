'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { GstLoginPanel, type Act, type ApiSession } from '@/components/workspace/GstApiFlow';
import { ApiError, call, periodLabel } from '@/lib/client';
import { fyChoices } from '@/server/gst/annual/common';

/**
 * Download from the GST portal: pick a client, log in to GST with the OTP, pick returns and a period
 * range. Each return/period is fetched from GSTN in its own request (progress shown, can be stopped);
 * what was fetched is kept, so it can be downloaded again – JSON or Excel, or all as a ZIP – without
 * another API call. Periods already downloaded are skipped unless "fetch again" is ticked.
 */

type Type = 'gstr1' | 'gstr3b' | 'gstr2a' | 'gstr2b' | 'gstr9' | 'cash_ledger' | 'itc_ledger' | 'filed';
type Format = 'json' | 'xlsx' | 'both';
interface Company { _id: string; name: string; gstin: string }
interface Item { id: string; type: Type; typeName: string; period: string; count: number; notes: string[]; fetchedAt: string; fetchedBy: string | null; inDocuments: boolean }
interface Status {
  available: boolean; reason: string | null; session: ApiSession; login: { steps: string[] }; items: Item[];
  canOperate: boolean; canFetch: boolean;
}
interface Job { type: Type; period: string }
interface Outcome extends Job { state: 'ok' | 'skipped' | 'error'; message?: string; count?: number }

const TYPES: { key: Type; label: string; hint: string; yearly?: boolean; noLogin?: boolean; docs?: boolean }[] = [
  { key: 'gstr1', label: 'GSTR-1', hint: 'all sections, as filed/saved', docs: true },
  { key: 'gstr3b', label: 'GSTR-3B', hint: 'as filed/saved', docs: true },
  { key: 'gstr2b', label: 'GSTR-2B', hint: 'ITC statement', docs: true },
  { key: 'gstr2a', label: 'GSTR-2A', hint: 'supplier-reported purchases', docs: true },
  { key: 'gstr9', label: 'GSTR-9', hint: 'per financial year', yearly: true },
  { key: 'cash_ledger', label: 'Cash ledger', hint: 'per financial year', yearly: true },
  { key: 'itc_ledger', label: 'Credit (ITC) ledger', hint: 'per financial year', yearly: true },
  { key: 'filed', label: 'Filed returns list', hint: 'ARN and dates, no login needed', yearly: true, noLogin: true },
];
const NAME = Object.fromEntries(TYPES.map((t) => [t.key, t.label])) as Record<Type, string>;
const FORMAT_LABEL: Record<Format, string> = { json: 'JSON', xlsx: 'Excel', both: 'JSON and Excel' };

const key = (fp: string) => Number(fp.slice(2)) * 12 + Number(fp.slice(0, 2));
const fpOf = (k: number) => { const y = Math.floor((k - 1) / 12); return `${String(k - y * 12).padStart(2, '0')}${y}`; };
const fyOf = (fp: string) => { const m = Number(fp.slice(0, 2)); const y = Number(fp.slice(2)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const nowFp = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`; };
const label = (p: string) => (p.includes('-') ? `FY ${p}` : periodLabel(p));
const toMonth = (fp: string) => `${fp.slice(2)}-${fp.slice(0, 2)}`;
const fromMonth = (m: string) => { const [y, mm] = m.split('-'); return y && mm ? `${mm}${y}` : ''; };
const fyRange = (fy: string) => ({ from: `04${fy.slice(0, 4)}`, to: `03${Number(fy.slice(0, 4)) + 1}` });
const when = (s: string) => new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Every return/period to fetch: monthly returns for each month up to now, yearly ones for each financial year touched. */
function jobsFor(types: Type[], from: string, to: string): Job[] {
  const last = Math.min(key(to), key(nowFp()));
  const months: string[] = [];
  for (let k = key(from); k <= last; k++) months.push(fpOf(k));
  const fys = [...new Set(months.map(fyOf))];
  const out: Job[] = [];
  for (const t of TYPES.filter((x) => types.includes(x.key))) for (const p of t.yearly ? fys : months) out.push({ type: t.key, period: p });
  return out;
}

export function PortalDownloads({ companies }: { companies: Company[] }) {
  const years = useMemo(() => fyChoices(), []);
  const [companyId, setCompanyId] = useState('');
  const [fy, setFy] = useState(years[0]);
  const [range, setRange] = useState(fyRange(years[0]));
  const [st, setSt] = useState<Status | null>(null);
  const [types, setTypes] = useState<Type[]>(['gstr1', 'gstr3b', 'gstr2b']);
  const [toDocuments, setToDocuments] = useState(true);
  const [force, setForce] = useState(false);
  const [format, setFormat] = useState<Format>('xlsx');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [zipping, setZipping] = useState(false);
  const stop = useRef(false);

  const cid = companyId || companies[0]?._id || '';
  const load = useCallback(async () => {
    if (!cid) return;
    try { setSt(await call<Status>(`/api/downloads/portal?companyId=${cid}`)); } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
  }, [cid]);
  useEffect(() => {
    if (!cid) return;
    let live = true;
    call<Status>(`/api/downloads/portal?companyId=${cid}`).then((r) => { if (live) setSt(r); }).catch((e) => { if (live) setMsg({ tone: 'error', text: e.message }); });
    return () => { live = false; };
  }, [cid]);

  const act: Act = async (k, body, ok) => {
    setBusy(k); setMsg(null);
    try {
      const r = await call<Record<string, unknown>>('/api/downloads/portal', { method: 'POST', json: { ...body, companyId: cid } });
      const m = typeof ok === 'function' ? ok(r) : { tone: 'ok' as const, text: ok };
      setMsg(m);
      await load();
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      await load();
      return false;
    } finally { setBusy(null); }
  };

  const validRange = !!range.from && !!range.to && key(range.from) <= key(range.to);
  const jobs = useMemo(() => (validRange ? jobsFor(types, range.from, range.to) : []), [types, range, validRange]);
  const loggedIn = st?.session.state === 'active';
  const needsLogin = types.some((t) => !TYPES.find((x) => x.key === t)?.noLogin);
  const have = new Set((st?.items ?? []).map((i) => `${i.type}|${i.period}`));
  const toFetch = force ? jobs.length : jobs.filter((j) => !have.has(`${j.type}|${j.period}`)).length;

  async function run() {
    stop.current = false;
    setMsg(null); setOutcomes([]);
    const list = jobs;
    const out: Outcome[] = [];
    for (let i = 0; i < list.length; i++) {
      if (stop.current) { setMsg({ tone: 'warn', text: `Stopped after ${i} of ${list.length}.` }); break; }
      const j = list[i];
      setProgress({ done: i, total: list.length, current: `${NAME[j.type]} ${label(j.period)}` });
      try {
        const r = await call<{ item: Item; skipped: boolean }>('/api/downloads/portal', { method: 'POST', json: { action: 'fetch', companyId: cid, ...j, toDocuments, force } });
        out.push({ ...j, state: r.skipped ? 'skipped' : 'ok', count: r.item.count });
      } catch (e) {
        out.push({ ...j, state: 'error', message: (e as Error).message });
        // Login, permission or plan problems stop the run: every further request would fail the same way.
        if (e instanceof ApiError && [401, 402, 403, 409].includes(e.status)) {
          setMsg({ tone: 'error', text: (e as Error).message });
          setOutcomes([...out]);
          break;
        }
      }
      setOutcomes([...out]);
    }
    setProgress(null);
    const ok = out.filter((o) => o.state === 'ok').length, skipped = out.filter((o) => o.state === 'skipped').length, failed = out.filter((o) => o.state === 'error').length;
    setMsg((m) => m ?? { tone: failed ? 'warn' : 'ok', text: `${ok} downloaded from GSTN${skipped ? `, ${skipped} already downloaded (skipped)` : ''}${failed ? `, ${failed} failed – see below` : ''}.` });
    await load();
  }

  // Newest period first (a financial year sorts as its March), then in the order of the return list.
  const order = (p: string) => (p.includes('-') ? key(`03${Number(p.slice(0, 4)) + 1}`) : key(p));
  const shown = (st?.items ?? [])
    .filter((i) => types.includes(i.type) && jobs.some((j) => j.type === i.type && j.period === i.period))
    .sort((a, b) => order(b.period) - order(a.period) || TYPES.findIndex((t) => t.key === a.type) - TYPES.findIndex((t) => t.key === b.type));
  const fileUrl = (it: Item, f: 'json' | 'xlsx') => `/api/downloads/portal/file?id=${it.id}&format=${f}`;
  async function zip() {
    setZipping(true); setMsg(null);
    try {
      const res = await fetch(`/api/downloads/portal/zip?companyId=${cid}&ids=${shown.map((i) => i.id).join(',')}&format=${format}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Download failed (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'GST-portal.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setZipping(false); }
  }
  async function remove(it: Item) {
    if (!confirm(`Remove the downloaded ${it.typeName} ${label(it.period)}? It can be downloaded from GSTN again.`)) return;
    await act(`del-${it.id}`, { action: 'delete', id: it.id }, 'Removed.');
  }

  if (!companies.length) return <Empty title="Add a client first" />;
  const failed = outcomes.filter((o) => o.state === 'error');
  return (
    <div className="space-y-6">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {st && !st.available && <Notice tone="warn">{st.reason}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Panel title="What to download">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <label>Client
                <select value={cid} onChange={(e) => { setCompanyId(e.target.value); setSt(null); setOutcomes([]); setMsg(null); }}>
                  {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
                </select>
              </label>
              <label>Financial year
                <select value={fy} onChange={(e) => { setFy(e.target.value); if (e.target.value) setRange(fyRange(e.target.value)); }}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  <option value="">Custom range</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label>From<input type="month" value={toMonth(range.from)} onChange={(e) => { setFy(''); setRange({ ...range, from: fromMonth(e.target.value) }); }} /></label>
                <label>To<input type="month" value={toMonth(range.to)} onChange={(e) => { setFy(''); setRange({ ...range, to: fromMonth(e.target.value) }); }} /></label>
              </div>
              <p className="text-[12px] text-ink-soft">Monthly returns are fetched for each month up to this month; GSTR-9, ledgers and the filed list for each financial year in the range.</p>
              <label className="flex items-start gap-2 font-normal text-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4 w-auto" checked={toDocuments} onChange={(e) => setToDocuments(e.target.checked)} />
                <span>Also add GSTR-1, GSTR-3B, GSTR-2A and GSTR-2B to <span className="font-medium">Client documents</span> <span className="text-[12.5px] text-ink-soft">(for checks, search, reports and Purchase vs GSTR-2B)</span></span>
              </label>
              <label className="flex items-start gap-2 font-normal text-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4 w-auto" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>Fetch again periods already downloaded <span className="text-[12.5px] text-ink-soft">(each fetch is a paid API call; GSTR-1 makes about 19 per month)</span></span>
              </label>
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[13px] font-semibold">Returns</legend>
              {TYPES.map((t) => (
                <label key={t.key} className="flex items-start gap-2 font-normal">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={types.includes(t.key)} onChange={() => setTypes(types.includes(t.key) ? types.filter((x) => x !== t.key) : [...types, t.key])} />
                  <span><span className="font-medium text-ink">{t.label}</span> <span className="text-[12.5px] text-ink-soft">– {t.hint}</span></span>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rule pt-4">
            {progress
              ? <Button variant="secondary" onClick={() => { stop.current = true; }}>Stop</Button>
              : <Button onClick={run} disabled={!st?.available || !st.canFetch || !jobs.length || !toFetch || (needsLogin && !loggedIn)}>Download from GST portal</Button>}
            <span className="text-[13px] text-ink-soft">
              {progress ? `Fetching ${progress.current}… (${progress.done + 1} of ${progress.total})`
                : !validRange ? 'Pick a valid period range.' : !jobs.length ? 'Pick at least one return.'
                  : needsLogin && !loggedIn ? 'Log in to GST for this client first (right).'
                    : `${jobs.length} return-period(s) in the range, ${toFetch} to fetch from GSTN.`}
            </span>
            {st && !st.canFetch && <span className="text-[13px] text-ink-soft">Your role can download files already fetched, not fetch new ones.</span>}
          </div>
          {progress && <div className="mt-3 h-1.5 rounded bg-black/5"><div className="h-1.5 rounded bg-ledger transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>}
          {failed.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12.5px] text-red-ink">
              {failed.map((o) => <li key={`${o.type}${o.period}`}>{NAME[o.type]} {label(o.period)}: {o.message}</li>)}
            </ul>
          )}
        </Panel>

        <Panel title="GST login">
          {st ? (st.available
            ? <GstLoginPanel session={st.session} steps={st.login.steps} canOperate={st.canOperate} busy={busy} act={act} />
            : <p className="text-[13px] text-ink-soft">Not available on this installation.</p>)
            : <p className="text-[13px] text-ink-soft">Loading…</p>}
        </Panel>
      </div>

      <Panel
        title={`Downloaded from the portal${shown.length ? ` (${shown.length})` : ''}`}
        action={shown.length > 0 && (
          <div className="flex items-center gap-2">
            <select value={format} onChange={(e) => setFormat(e.target.value as Format)} className="w-auto" aria-label="ZIP format">
              {(['xlsx', 'json', 'both'] as const).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
            </select>
            <Button onClick={zip} busy={zipping}>Download all as ZIP</Button>
          </div>
        )}
      >
        {!shown.length ? <Empty title="Nothing downloaded for these returns and periods yet">Pick the returns, log in to GST and press “Download from GST portal”.</Empty> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th className="pl-5">Return</th><th>Period</th><th className="text-right">Rows</th><th>Downloaded</th><th>Files</th><th /></tr></thead>
              <tbody>
                {shown.map((it) => (
                  <tr key={it.id}>
                    <td className="pl-5 font-medium">{it.typeName}{it.inDocuments && <div className="text-[11.5px] font-normal text-ledger">In client documents</div>}</td>
                    <td className="whitespace-nowrap">{label(it.period)}</td>
                    <td className="num text-right">{it.count || <span className="text-ink-soft">none</span>}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-ink-soft">{when(it.fetchedAt)}{it.fetchedBy ? <div>{it.fetchedBy}</div> : null}</td>
                    <td className="whitespace-nowrap text-[13px]">
                      <a href={fileUrl(it, 'xlsx')} className="text-ledger underline">Excel</a>{' · '}<a href={fileUrl(it, 'json')} className="text-ledger underline">JSON</a>
                      {it.notes.length > 0 && <div className="max-w-72 whitespace-normal text-[11.5px] text-amber">{it.notes.join(' ')}</div>}
                    </td>
                    <td className="text-right">{st?.canFetch && <button type="button" className="text-[12px] text-ink-soft hover:text-red-ink" onClick={() => remove(it)} disabled={busy !== null}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
