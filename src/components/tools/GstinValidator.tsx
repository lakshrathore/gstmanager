'use client';

import { useEffect, useRef, useState } from 'react';
import type { GstinParts } from '@/engine';
import type { TaxpayerProfile } from '@/server/gst/gstin-lookup/profile';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';
import { downloadCsv } from './csv';
import { describeJsonGstins, gstinsFromJson } from './gstinsFromJson';

interface Result { input: string; offline: GstinParts; profile?: TaxpayerProfile; lookupError?: string }
type Mode = 'offline' | 'sandbox' | 'portal';
interface Captcha { sessionId: string; image: string }

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'offline', label: 'Offline check', hint: 'Checksum, state code, PAN and registration type. Instant and free, but it cannot tell whether the GSTIN is active.' },
  { id: 'sandbox', label: 'Sandbox API', hint: 'Live GSTN details (name, status, registration date, address) for many GSTINs at once through the Sandbox.co.in Search GSTIN API.' },
  { id: 'portal', label: 'GST portal (CAPTCHA)', hint: 'Free. Uses the public Search Taxpayer on the GST portal. You type the CAPTCHA the portal shows, once per GSTIN.' },
];

const newCaptcha = () => call<Captcha>('/api/tools/gstin/captcha', { method: 'POST' });
const split = (t: string) => [...new Set(t.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

export function GstinValidator({ sandbox, initialText = '' }: { sandbox: boolean; initialText?: string }) {
  const [text, setText] = useState(initialText);
  const [loaded, setLoaded] = useState<{ tone: 'ok' | 'error'; msg: string } | null>(null);
  const jsonInput = useRef<HTMLInputElement>(null);

  /** Fills the box with the supplier, recipient (ctin) and e-commerce (etin) GSTINs of a GSTR-1 JSON. */
  async function loadJson(f: File | undefined) {
    if (!f) return;
    if (jsonInput.current) jsonInput.current.value = '';
    try {
      const g = gstinsFromJson(JSON.parse((await f.text()).trim()));
      if (!g.all.length) { setLoaded({ tone: 'error', msg: `No GSTINs found in ${f.name}.` }); return; }
      setText(g.all.join('\n'));
      setResults(null); setQueue([]);
      setLoaded({ tone: 'ok', msg: `Loaded ${g.all.length} GSTIN${g.all.length === 1 ? '' : 's'} from ${f.name} (${describeJsonGstins(g)}).${g.all.length > 100 ? ' Only 100 can be checked at a time – remove some before validating.' : ''}` });
    } catch {
      setLoaded({ tone: 'error', msg: `${f.name} is not valid JSON.` });
    }
  }
  const [mode, setMode] = useState<Mode>('offline');
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Portal mode: GSTINs still waiting for a CAPTCHA search. */
  const [queue, setQueue] = useState<string[]>([]);
  const list = split(text);

  async function run() {
    setBusy(true); setErr(null); setQueue([]);
    try {
      const r = await call<{ results: Result[] }>('/api/tools/gstin', { method: 'POST', json: { text, mode: mode === 'sandbox' ? 'sandbox' : 'offline' } });
      setResults(r.results);
      if (mode === 'portal') setQueue(r.results.filter((x) => x.offline.ok).map((x) => x.input));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const update = (r: Result) => setResults((prev) => prev?.map((x) => (x.input === r.input ? r : x)) ?? [r]);

  const exportCsv = () => results && downloadCsv('gstin-check.csv',
    ['GSTIN', 'Format', 'Reason', 'State', 'PAN', 'PAN holder', 'Registration type', 'Legal name', 'Trade name', 'Status', 'Registered', 'Cancelled', 'Taxpayer type', 'Constitution', 'Address', 'Lookup error'],
    results.map((r) => [r.input, r.offline.ok ? 'Valid' : 'Invalid', r.offline.reason ?? '', r.offline.stateName ?? '', r.offline.pan ?? '', r.offline.panHolder ?? '', r.offline.registrationType ?? '',
      r.profile?.legalName ?? '', r.profile?.tradeName ?? '', r.profile?.status ?? '', r.profile?.registrationDate ?? '', r.profile?.cancellationDate ?? '',
      r.profile?.taxpayerType ?? '', r.profile?.constitution ?? '', r.profile?.address ?? '', r.lookupError ?? '']));

  const counts = results && {
    valid: results.filter((r) => r.offline.ok).length,
    invalid: results.filter((r) => !r.offline.ok).length,
    active: results.filter((r) => /^active$/i.test(r.profile?.status ?? '')).length,
    inactive: results.filter((r) => r.profile?.status && !/^active$/i.test(r.profile.status)).length,
  };

  return (
    <div className="space-y-6">
      <Panel title="Validate GSTINs">
        <label>GSTINs – one per line, or separated by commas or spaces (up to 100)
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} spellCheck={false} className="num uppercase" placeholder={'33ABKCS2033B1ZW\n29AAACR5055K1Z5'} />
        </label>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] text-ink-soft">{list.length} unique GSTIN{list.length === 1 ? '' : 's'}</p>
          <div className="flex gap-2">
            <input ref={jsonInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => loadJson(e.target.files?.[0])} />
            <Button variant="secondary" onClick={() => jsonInput.current?.click()}>Load from GSTR-1 JSON</Button>
            {text && <Button variant="ghost" onClick={() => { setText(''); setLoaded(null); setResults(null); setQueue([]); }}>Clear</Button>}
          </div>
        </div>
        {loaded && <div className="mt-3"><Notice tone={loaded.tone}>{loaded.msg}</Notice></div>}

        <div role="radiogroup" aria-label="How to validate" className="mt-4 grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => {
            const off = m.id === 'sandbox' && !sandbox;
            return (
              <button key={m.id} role="radio" aria-checked={mode === m.id} disabled={off} onClick={() => setMode(m.id)}
                className={`rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-55 ${mode === m.id ? 'border-ledger bg-ledger-tint' : 'border-rule bg-white hover:border-ink-soft'}`}>
                <span className="font-semibold">{m.label}</span>
                <span className="mt-1 block text-[12.5px] text-ink-soft">{off ? 'Not configured. Set SANDBOX_API_KEY and SANDBOX_API_SECRET in .env.local and restart.' : m.hint}</span>
              </button>
            );
          })}
        </div>

        {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={run} busy={busy} disabled={!list.length || list.length > 100 || (mode === 'sandbox' && list.length > 50)}>
            {mode === 'portal' ? 'Check and start portal search' : `Validate ${list.length || ''} GSTIN${list.length === 1 ? '' : 's'}`}
          </Button>
          {mode === 'sandbox' && list.length > 50 && <span className="text-[12.5px] text-red-ink">The API run takes up to 50 GSTINs at a time.</span>}
          {mode === 'sandbox' && <span className="text-[12.5px] text-ink-soft">Each lookup is a billable Sandbox API call.</span>}
        </div>
      </Panel>

      {mode === 'portal' && queue.length > 0 && (
        <PortalSearch key={queue[0]} gstin={queue[0]} remaining={queue.length}
          onDone={(r) => { if (r) update(r); setQueue((q) => q.slice(1)); }} onStop={() => setQueue([])} />
      )}

      {results && counts && (
        <Panel title="Results" action={<Button variant="secondary" onClick={exportCsv}>Download CSV</Button>}>
          <p className="mb-4 text-ink-soft">
            {counts.valid} valid format · {counts.invalid} invalid
            {(counts.active + counts.inactive) > 0 && ` · ${counts.active} active · ${counts.inactive} not active`}
          </p>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>GSTIN</th><th>Format</th><th>State · PAN</th><th>Legal / trade name</th><th>GSTN status</th>{mode === 'portal' && <th />}</tr></thead>
              <tbody>
                {results.map((r) => (
                  <ResultRow key={r.input} r={r}
                    action={mode === 'portal' && r.offline.ok && !r.profile && !queue.includes(r.input)
                      ? <Button variant="ghost" onClick={() => setQueue((q) => [r.input, ...q])}>Search</Button> : null}
                    portal={mode === 'portal'} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function StatusPill({ s }: { s?: string }) {
  if (!s) return <span className="text-ink-soft">—</span>;
  const tone = /^active$/i.test(s) ? 'bg-ledger-tint text-ledger' : /cancel/i.test(s) ? 'bg-red-tint text-red-ink' : 'bg-amber-tint text-amber';
  return <span className={`rounded px-2 py-0.5 text-[12px] font-medium ${tone}`}>{s}</span>;
}

function ResultRow({ r, action, portal }: { r: Result; action: React.ReactNode; portal: boolean }) {
  const [open, setOpen] = useState(false);
  const p = r.profile;
  return (
    <>
      <tr className={r.offline.ok ? '' : 'row-error'}>
        <td className="num whitespace-nowrap">{r.input}</td>
        <td>{r.offline.ok
          ? <span className="rounded bg-ledger-tint px-1.5 py-0.5 text-[12px] font-medium text-ledger">Valid</span>
          : <><span className="rounded bg-red-tint px-1.5 py-0.5 text-[12px] font-medium text-red-ink">Invalid</span><span className="block text-[12.5px] text-red-ink">{r.offline.reason}</span></>}
        </td>
        <td>{r.offline.stateName ?? '—'}{r.offline.pan && <span className="num block text-[12px] text-ink-soft">{r.offline.pan} · {r.offline.panHolder}</span>}{r.offline.registrationType && <span className="block text-[12px] text-ink-soft">{r.offline.registrationType}</span>}</td>
        <td>
          {p ? <>{p.legalName ?? '—'}{p.tradeName && p.tradeName !== p.legalName && <span className="block text-[12.5px] text-ink-soft">{p.tradeName}</span>}
            <button className="mt-1 block text-[12.5px] text-ledger underline" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button></>
            : r.lookupError ? <span className="text-[12.5px] text-red-ink">{r.lookupError}</span> : <span className="text-ink-soft">{r.offline.ok && portal ? 'Not searched yet' : '—'}</span>}
        </td>
        <td><StatusPill s={p?.status} />{p?.registrationDate && <span className="block text-[12px] text-ink-soft">Since {p.registrationDate}</span>}{p?.cancellationDate && <span className="block text-[12px] text-red-ink">Cancelled {p.cancellationDate}</span>}</td>
        {portal && <td>{action}</td>}
      </tr>
      {open && p && (
        <tr>
          <td colSpan={portal ? 6 : 5} className="bg-paper">
            <dl className="grid gap-x-6 gap-y-2 py-1 sm:grid-cols-3">
              {([['Taxpayer type', p.taxpayerType], ['Constitution', p.constitution], ['E-invoice', p.einvoice], ['Nature of business', p.natureOfBusiness?.join(', ')],
                ['State jurisdiction', p.stateJurisdiction], ['Centre jurisdiction', p.centreJurisdiction], ['Last updated', p.lastUpdated]] as const)
                .filter(([, v]) => v).map(([k, v]) => <div key={k}><dt className="text-[12px] text-ink-soft">{k}</dt><dd>{v}</dd></div>)}
              {p.address && <div className="sm:col-span-3"><dt className="text-[12px] text-ink-soft">Principal place of business</dt><dd>{p.address}</dd></div>}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/** One portal search: shows the CAPTCHA for one GSTIN, the user types it, then the queue moves on. */
function PortalSearch({ gstin, remaining, onDone, onStop }: { gstin: string; remaining: number; onDone: (r: Result | null) => void; onStop: () => void }) {
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const show = (c: Captcha) => { setCaptcha(c); setTimeout(() => field.current?.focus(), 0); };
  const fail = (e: unknown) => { setErr((e as Error).message); setCaptcha(null); };
  useEffect(() => {
    let live = true;
    newCaptcha().then((c) => live && show(c), (e) => live && fail(e)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);
  async function fresh() {
    setLoading(true); setAnswer('');
    try { show(await newCaptcha()); } catch (e) { fail(e); } finally { setLoading(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!captcha) return;
    setBusy(true); setErr(null);
    try {
      const r = await call<{ result: Result }>('/api/tools/gstin/portal', { method: 'POST', json: { sessionId: captcha.sessionId, gstin, captcha: answer } });
      onDone(r.result);
    } catch (x) {
      setErr((x as Error).message);
      await fresh(); // each CAPTCHA works once; the error stays visible
    } finally { setBusy(false); }
  }

  return (
    <Panel title={<>Search on GST portal: <span className="num">{gstin}</span></>} action={<span className="text-ink-soft">{remaining} left</span>}>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
        <div className="grid h-[60px] w-[180px] place-items-center overflow-hidden rounded-md border border-rule bg-white">
          {loading ? <span className="text-[12.5px] text-ink-soft">Loading CAPTCHA…</span>
            // eslint-disable-next-line @next/next/no-img-element
            : captcha ? <img src={captcha.image} alt="CAPTCHA from the GST portal – type the characters shown" className="h-full w-full object-contain" />
            : <span className="text-[12.5px] text-red-ink">No CAPTCHA</span>}
        </div>
        <label className="w-[180px]">Characters in the image
          <input ref={field} value={answer} onChange={(e) => setAnswer(e.target.value)} autoComplete="off" spellCheck={false} maxLength={12} className="num" required />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy} disabled={!captcha || !answer.trim()}>Search</Button>
          <Button type="button" variant="secondary" onClick={fresh} disabled={loading || busy}>New image</Button>
          <Button type="button" variant="ghost" onClick={() => onDone(null)} disabled={busy}>Skip</Button>
          <Button type="button" variant="ghost" onClick={onStop} disabled={busy}>Stop</Button>
        </div>
      </form>
      {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
      <p className="mt-3 text-[12.5px] text-ink-soft">The app shows the GST portal&apos;s CAPTCHA as it is and sends what you type. It never reads or solves the CAPTCHA.</p>
    </Panel>
  );
}
