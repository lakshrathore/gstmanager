'use client';

import { useRef, useState } from 'react';
import type { GstinParts } from '@/engine';
import type { TaxpayerProfile } from '@/server/gst/gstin-lookup/profile';
import { Button, Notice } from '@/components/ui';
import { call } from '@/lib/client';

/**
 * Add companies from their GSTIN: GSTN's taxpayer record (legal and trade name, status, constitution,
 * address, registration date) and the filing frequency come from the Sandbox API – several GSTINs at
 * once – or, without it, from the GST portal's public search with the CAPTCHA the user types. Every
 * value can be checked and changed before the company is added.
 */

interface Result { input: string; offline: GstinParts; profile?: TaxpayerProfile; lookupError?: string; filingFrequency?: 'monthly' | 'quarterly' }
interface Lookup { mode: 'sandbox' | 'portal'; results: Result[]; existing: string[] }
interface Draft { gstin: string; profile?: TaxpayerProfile; name: string; filingFrequency: 'monthly' | 'quarterly'; aato: boolean; pick: boolean; frequencyKnown: boolean }
interface Captcha { sessionId: string; image: string }

const draftOf = (r: Result): Draft => ({
  gstin: r.input, profile: r.profile, name: r.profile?.tradeName || r.profile?.legalName || '',
  filingFrequency: r.filingFrequency ?? 'monthly', frequencyKnown: !!r.filingFrequency, aato: false, pick: !!r.profile && !/cancel/i.test(r.profile.status ?? ''),
});

export function AddFromGstin({ onAdded, onManual }: { onAdded: () => void; onManual: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [problems, setProblems] = useState<{ gstin: string; message: string }[]>([]);
  const [captcha, setCaptcha] = useState<{ gstin: string; c: Captcha } | null>(null);
  const [answer, setAnswer] = useState('');
  const field = useRef<HTMLInputElement>(null);

  async function fetchDetails(e: React.FormEvent) {
    e.preventDefault();
    setBusy('fetch'); setErr(null); setDone(null); setDrafts([]); setProblems([]); setCaptcha(null);
    try {
      const r = await call<Lookup>('/api/companies/lookup', { method: 'POST', json: { text } });
      const bad: { gstin: string; message: string }[] = [];
      const good: Result[] = [];
      for (const x of r.results) {
        if (!x.offline.ok) bad.push({ gstin: x.input, message: `Not a valid GSTIN – ${x.offline.reason ?? 'check the characters'}` });
        else if (r.existing.includes(x.input)) bad.push({ gstin: x.input, message: 'Already added' });
        else good.push(x);
      }
      if (r.mode === 'portal') {
        // No Sandbox API: the GST portal search, one GSTIN at a time with its CAPTCHA.
        if (good.length > 1) bad.push(...good.slice(1).map((x) => ({ gstin: x.input, message: 'Without the Sandbox API, GSTINs are looked up one at a time – add this one next' })));
        setProblems(bad);
        if (good[0]) await loadCaptcha(good[0].input);
        return;
      }
      for (const x of good) if (!x.profile) bad.push({ gstin: x.input, message: x.lookupError ?? 'GSTN returned no details' });
      setProblems(bad);
      setDrafts(good.filter((x) => x.profile).map(draftOf));
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  async function loadCaptcha(gstin: string) {
    setBusy('captcha'); setAnswer('');
    try {
      setCaptcha({ gstin, c: await call<Captcha>('/api/companies/lookup/captcha', { method: 'POST' }) });
      setTimeout(() => field.current?.focus(), 0);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  async function searchPortal(e: React.FormEvent) {
    e.preventDefault();
    if (!captcha) return;
    setBusy('portal'); setErr(null);
    try {
      const r = await call<{ result: Result }>('/api/companies/lookup/portal', { method: 'POST', json: { sessionId: captcha.c.sessionId, gstin: captcha.gstin, captcha: answer } });
      if (!r.result.profile) throw new Error(r.result.lookupError ?? 'The GST portal returned no details');
      setDrafts([draftOf(r.result)]);
      setCaptcha(null);
    } catch (x) {
      setErr((x as Error).message);
      await loadCaptcha(captcha.gstin); // each CAPTCHA works once
    } finally { setBusy(null); }
  }

  const set = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const picked = drafts.filter((d) => d.pick);

  async function addAll() {
    setBusy('add'); setErr(null);
    const failed: { gstin: string; message: string }[] = [];
    let added = 0;
    for (const d of picked) {
      try {
        const p = d.profile ?? ({} as TaxpayerProfile);
        await call('/api/companies', {
          method: 'POST',
          json: {
            name: d.name.trim(), gstin: d.gstin, filingFrequency: d.filingFrequency, aatoAbove5Cr: d.aato,
            profile: { legalName: p.legalName, tradeName: p.tradeName, status: p.status, constitution: p.constitution, taxpayerType: p.taxpayerType, registrationDate: p.registrationDate, address: p.address?.slice(0, 500) },
          },
        });
        added++;
      } catch (x) { failed.push({ gstin: d.gstin, message: (x as Error).message }); }
    }
    setBusy(null);
    if (added) { onAdded(); setDone(`${added} compan${added === 1 ? 'y' : 'ies'} added.`); }
    setDrafts((ds) => ds.filter((d) => failed.some((f) => f.gstin === d.gstin)));
    setProblems(failed);
    if (!failed.length) setText('');
  }

  return (
    <div className="space-y-4">
      <form onSubmit={fetchDetails} className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">GSTIN <span className="font-normal">(paste several, one per line, to add many at once)</span>
          <textarea value={text} onChange={(e) => setText(e.target.value.toUpperCase())} rows={text.includes('\n') ? 4 : 1} required
            className="num resize-y uppercase" placeholder="29ABCDE1234F1Z5" spellCheck={false} autoComplete="off" />
        </label>
        <Button type="submit" busy={busy === 'fetch'}>Fetch details from GSTN</Button>
        <button type="button" className="pb-2 text-[13px] text-ink-soft underline" onClick={onManual}>Enter details manually</button>
      </form>

      {err && <Notice tone="error">{err}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      {problems.length > 0 && (
        <Notice tone="warn"><ul className="space-y-0.5">{problems.map((p) => <li key={p.gstin}><span className="num">{p.gstin}</span>: {p.message}</li>)}</ul></Notice>
      )}

      {captcha && (
        <form onSubmit={searchPortal} className="flex flex-wrap items-end gap-3 rounded-md border border-rule bg-white p-3">
          <div className="h-12 w-40 overflow-hidden rounded border border-rule bg-white">
            {/* A data: URL from the portal – nothing for next/image to optimise. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={captcha.c.image} alt="CAPTCHA from the GST portal – type the characters shown" className="h-full w-full object-contain" />
          </div>
          <label className="w-40">CAPTCHA for <span className="num">{captcha.gstin}</span>
            <input ref={field} value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={12} autoComplete="off" className="num" />
          </label>
          <Button type="submit" busy={busy === 'portal'} disabled={!answer.trim()}>Search GST portal</Button>
          <button type="button" className="pb-2 text-[13px] text-ink-soft underline" onClick={() => loadCaptcha(captcha.gstin)} disabled={busy !== null}>New image</button>
          <p className="w-full text-[12px] text-ink-soft">The Sandbox API is not set up, so the GST portal’s free public search is used. You read and type the CAPTCHA; the app never reads it.</p>
        </form>
      )}

      {drafts.length > 0 && (
        <div className="space-y-3">
          {drafts.map((d, i) => {
            const p = d.profile;
            const cancelled = /cancel|suspend/i.test(p?.status ?? '');
            return (
              <div key={d.gstin} className={`rounded-md border bg-white p-4 ${d.pick ? 'border-ledger/40' : 'border-rule opacity-70'}`}>
                <div className="flex flex-wrap items-start gap-3">
                  {drafts.length > 1 && <input type="checkbox" className="mt-1 h-4 w-4 w-auto" checked={d.pick} onChange={(e) => set(i, { pick: e.target.checked })} aria-label={`Add ${d.gstin}`} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num font-semibold">{d.gstin}</span>
                      {p?.status && <span className={`rounded px-2 py-0.5 text-[11.5px] font-semibold ${cancelled ? 'bg-red-tint text-red-ink' : 'bg-ledger-tint text-ledger'}`}>{p.status}</span>}
                    </div>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
                      {p?.legalName && <><dt className="text-ink-soft">Legal name</dt><dd>{p.legalName}</dd></>}
                      {p?.tradeName && <><dt className="text-ink-soft">Trade name</dt><dd>{p.tradeName}</dd></>}
                      {p?.constitution && <><dt className="text-ink-soft">Constitution</dt><dd>{p.constitution}{p.taxpayerType ? ` · ${p.taxpayerType}` : ''}</dd></>}
                      {p?.registrationDate && <><dt className="text-ink-soft">Registered on</dt><dd>{p.registrationDate}{p.cancellationDate ? ` · cancelled ${p.cancellationDate}` : ''}</dd></>}
                      {p?.address && <><dt className="text-ink-soft">Address</dt><dd>{p.address}</dd></>}
                    </dl>
                    {cancelled && <p className="mt-2 text-[12.5px] text-red-ink">GSTN shows this registration as {p?.status?.toLowerCase()}. You can still add it, for example to file pending returns.</p>}
                    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                      <label>Name in this app
                        <input value={d.name} onChange={(e) => set(i, { name: e.target.value })} required minLength={2} maxLength={150} />
                        {p?.legalName && p.tradeName && p.legalName !== p.tradeName && (
                          <span className="flex gap-3 text-[12px]">
                            <button type="button" className="underline" onClick={() => set(i, { name: p.tradeName! })}>Use trade name</button>
                            <button type="button" className="underline" onClick={() => set(i, { name: p.legalName! })}>Use legal name</button>
                          </span>
                        )}
                      </label>
                      <label>Filing frequency
                        <select value={d.filingFrequency} onChange={(e) => set(i, { filingFrequency: e.target.value as Draft['filingFrequency'] })}>
                          <option value="monthly">Monthly</option><option value="quarterly">Quarterly (QRMP)</option>
                        </select>
                        <span className="text-[11.5px]">{d.frequencyKnown ? 'As per GSTN' : 'Not given by GSTN – check'}</span>
                      </label>
                      <label className="flex items-center gap-2 self-center pt-3 text-ink"><input type="checkbox" className="w-auto" checked={d.aato} onChange={(e) => set(i, { aato: e.target.checked })} />Turnover above ₹5 crore</label>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={addAll} busy={busy === 'add'} disabled={!picked.length || picked.some((d) => d.name.trim().length < 2)}>
              {picked.length > 1 ? `Add ${picked.length} companies` : 'Add company'}
            </Button>
            <button type="button" className="text-[13px] text-ink-soft underline" onClick={() => { setDrafts([]); setProblems([]); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
