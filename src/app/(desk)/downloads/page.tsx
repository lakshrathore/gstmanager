'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { PortalDownloads } from '@/components/downloads/PortalDownloads';
import { fyChoices } from '@/server/gst/annual/common';
import { call, periodLabel } from '@/lib/client';

/**
 * Download center. "Prepared in this app": pick return types, companies, a period range and filing
 * status; download each return as JSON or Excel, or everything that matches as one ZIP. "From the GST
 * portal": returns, ledgers and the filing list as GSTN holds them (PortalDownloads).
 */

type Type = 'gstr1' | 'gstr3b' | 'gstr9' | 'gstr9c';
type Format = 'json' | 'xlsx';
interface Company { _id: string; name: string; gstin: string }
interface Item {
  type: Type; typeName: string; companyId: string; companyName: string; gstin: string; period: string;
  statusLabel: string; filed: boolean; updatedAt: string | null;
  formats: Record<Format, { ok: boolean; note?: string }>;
}

const TYPES: { key: Type; label: string; hint: string }[] = [
  { key: 'gstr1', label: 'GSTR-1', hint: 'JSON for the portal, Excel of the records' },
  { key: 'gstr3b', label: 'GSTR-3B', hint: 'GSTN JSON, Excel tables' },
  { key: 'gstr9', label: 'GSTR-9', hint: 'JSON for the portal, Excel' },
  { key: 'gstr9c', label: 'GSTR-9C', hint: 'Excel for the offline tool, JSON backup' },
];
const FORMAT_LABEL: Record<Format | 'both', string> = { json: 'JSON', xlsx: 'Excel', both: 'JSON and Excel' };

const toMonth = (fp: string) => `${fp.slice(2)}-${fp.slice(0, 2)}`;
const fromMonth = (m: string) => { const [y, mm] = m.split('-'); return y && mm ? `${mm}${y}` : ''; };
const fyRange = (fy: string) => ({ from: `04${fy.slice(0, 4)}`, to: `03${Number(fy.slice(0, 4)) + 1}` });

export default function DownloadsPage() {
  const years = useMemo(() => fyChoices(), []);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [types, setTypes] = useState<Type[]>(['gstr1', 'gstr3b', 'gstr9', 'gstr9c']);
  const [fy, setFy] = useState(years[0]);
  const [range, setRange] = useState(fyRange(years[0]));
  const [status, setStatus] = useState<'all' | 'filed' | 'unfiled'>('all');
  const [format, setFormat] = useState<Format | 'both'>('both');
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [zipping, setZipping] = useState(false);
  const [tab, setTab] = useState<'app' | 'portal'>('app');

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => setCompanies(r.companies)).catch((e) => setErr(e.message));
  }, []);

  const query = useMemo(() => new URLSearchParams({
    types: types.join(','), companyIds: picked.join(','), from: range.from, to: range.to, status,
  }).toString(), [types, picked, range, status]);

  const valid = types.length > 0 && !!range.from && !!range.to;
  useEffect(() => {
    if (!valid) return;
    let live = true;
    call<{ items: Item[] }>(`/api/downloads?${query}`)
      .then((r) => { if (live) { setItems(r.items); setErr(null); } })
      .catch((e) => { if (live) { setErr(e.message); setItems(null); } })
      .finally(() => { if (live) setLoadedQuery(query); });
    return () => { live = false; };
  }, [query, valid]);
  const loading = valid && loadedQuery !== query;

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const formats: Format[] = format === 'both' ? ['json', 'xlsx'] : [format];
  const ready = (items ?? []).filter((it) => formats.some((f) => it.formats[f].ok)).length;
  /** The ZIP is fetched rather than linked so a refusal (too many returns, nothing ready) shows here. */
  async function downloadZip() {
    setZipping(true); setErr(null);
    try {
      const res = await fetch(`/api/downloads/zip?${query}&format=${format}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Download failed (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'GST-returns.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setZipping(false);
    }
  }
  const fileUrl = (it: Item, f: Format) => `/api/downloads/file?${new URLSearchParams({ type: it.type, companyId: it.companyId, period: it.period, format: f })}`;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Download returns</h1>
        <p className="text-ink-soft">{tab === 'app'
          ? 'GSTR-1, GSTR-3B, GSTR-9 and GSTR-9C prepared here, filtered by company, period and status – one at a time or all as a ZIP.'
          : 'Returns, ledgers and the filing list as the GST portal holds them – fetched with your GST login, then downloaded as JSON or Excel.'}</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-rule">
        {([['app', 'Prepared in this app'], ['portal', 'From the GST portal']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-4 py-2 text-[14px] ${tab === k ? 'border-ink font-semibold' : 'border-transparent text-ink-soft hover:text-ink'}`}>{l}</button>
        ))}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {tab === 'portal' ? <PortalDownloads companies={companies} /> : (<>

      <Panel title="Filters">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr_1fr]">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-semibold">Returns</legend>
            {TYPES.map((t) => (
              <label key={t.key} className="flex items-start gap-2 font-normal">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={types.includes(t.key)} onChange={() => setTypes(toggle(types, t.key))} />
                <span><span className="font-medium">{t.label}</span> <span className="text-[12.5px] text-ink-soft">– {t.hint}</span></span>
              </label>
            ))}
          </fieldset>

          <div className="space-y-3">
            <label>Financial year
              <select value={fy} onChange={(e) => { setFy(e.target.value); if (e.target.value) setRange(fyRange(e.target.value)); }}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
                <option value="">Custom range</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>From
                <input type="month" value={toMonth(range.from)} onChange={(e) => { setFy(''); setRange({ ...range, from: fromMonth(e.target.value) }); }} />
              </label>
              <label>To
                <input type="month" value={toMonth(range.to)} onChange={(e) => { setFy(''); setRange({ ...range, to: fromMonth(e.target.value) }); }} />
              </label>
            </div>
            <p className="text-[12px] text-ink-soft">GSTR-9 and GSTR-9C are included for every financial year the range touches.</p>
            <label>Status
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="all">All</option><option value="filed">Filed only</option><option value="unfiled">Not filed yet</option>
              </select>
            </label>
            <label>Format
              <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                {(['both', 'json', 'xlsx'] as const).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
              </select>
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-semibold">Companies</legend>
            <label className="flex items-center gap-2 font-normal">
              <input type="checkbox" className="h-4 w-4" checked={!picked.length} onChange={() => setPicked([])} />
              All companies ({companies.length})
            </label>
            <div className="max-h-52 space-y-1.5 overflow-y-auto pr-2">
              {companies.map((c) => (
                <label key={c._id} className="flex items-start gap-2 font-normal">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={picked.includes(c._id)} onChange={() => setPicked(toggle(picked, c._id))} />
                  <span>{c.name} <span className="num text-[12px] text-ink-soft">{c.gstin}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Panel>

      <Panel
        title={items ? `${items.length} return${items.length === 1 ? '' : 's'}${loading ? ' …' : ''}` : 'Returns'}
        action={items && ready > 0 && (
          <Button onClick={downloadZip} busy={zipping}>Download all as ZIP ({FORMAT_LABEL[format]})</Button>
        )}
      >
        {!valid ? <Empty title={types.length ? 'Pick both months of the range' : 'Pick at least one return type'} />
          : items && !items.length ? <Empty title="No returns match these filters">Returns appear here once they are created on the GSTR-1, GSTR-3B, GSTR-9 or GSTR-9C pages.</Empty>
            : items && (
              <div className="-mx-5 overflow-x-auto">
                <table className="ledger">
                  <thead><tr><th>Company</th><th>Return</th><th>Period</th><th>Status</th><th>Updated</th>{formats.map((f) => <th key={f}>{FORMAT_LABEL[f]}</th>)}</tr></thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={`${it.type}-${it.companyId}-${it.period}`}>
                        <td>{it.companyName}<div className="num text-[12px] text-ink-soft">{it.gstin}</div></td>
                        <td className="whitespace-nowrap font-medium">{it.typeName}</td>
                        <td className="whitespace-nowrap">{it.period.includes('-') ? `FY ${it.period}` : periodLabel(it.period)}</td>
                        <td><span className={`rounded px-2 py-0.5 text-[12px] font-medium ${it.filed ? 'bg-ink text-white' : 'bg-black/5 text-ink-soft'}`}>{it.statusLabel}</span></td>
                        <td className="whitespace-nowrap text-[12.5px] text-ink-soft">{it.updatedAt ? new Date(it.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                        {formats.map((f) => (
                          <td key={f} className="text-[13px]">
                            {it.formats[f].ok
                              ? <><a href={fileUrl(it, f)} className="text-ledger underline">Download</a>{it.formats[f].note && <div className="text-[12px] text-amber">{it.formats[f].note}</div>}</>
                              : <span className="text-[12.5px] text-ink-soft">{it.formats[f].note ?? 'Not available'}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        {items && items.length > 0 && !ready && <p className="mt-3 text-[13px] text-ink-soft">None of these returns has a {FORMAT_LABEL[format]} file yet.</p>}
      </Panel>
      </>)}
    </div>
  );
}
