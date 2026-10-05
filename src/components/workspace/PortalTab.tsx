'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';
import type { ReturnDetail } from './types';

interface Session { mode: 'http' | 'manual'; protocolConfigured: boolean; state: string; expiresAt: string | null; message: string | null; captchaImage: string | null; savedUsername?: string | null }
interface Job { _id: string; mode: string; status: string; referenceId?: string; createdAt: string; history: { at: string; status: string; note?: string }[] }

function SessionPanel({ companyId, onState }: { companyId: string; onState: (s: Session) => void }) {
  const [s, setS] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const url = `/api/portal/${companyId}/session`;

  const apply = (x: Session) => { setS((prev) => ({ ...prev, ...x })); onState(x); };
  useEffect(() => { call<Session>(url).then(apply).catch((e) => setErr(e.message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [url]);

  async function act(body: Record<string, unknown>, form?: HTMLFormElement) {
    setBusy(true); setErr(null);
    try { apply(await call<Session>(url, { method: 'POST', json: body })); form?.reset(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const submit = (fn: (f: FormData) => Record<string, unknown>) => (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); act(fn(new FormData(e.currentTarget)), e.currentTarget); };

  if (!s) return <p className="text-ink-soft">Checking portal session…</p>;
  if (s.mode !== 'http') return <Notice>Portal sign-in from the app is switched off (PORTAL_MODE=manual). Use the manual upload steps below.</Notice>;

  return (
    <div className="space-y-4">
      {!s.protocolConfigured && (
        <Notice tone="warn">
          The portal HTTP protocol isn’t configured on this server, so sign-in and direct upload are unavailable.
          A developer must implement <span className="num">src/server/portal/protocol.ts</span> with verified, permitted endpoints. Until then, use the manual upload below.
        </Notice>
      )}
      {s.state === 'active' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p><span className="font-semibold text-ledger">Signed in to the GST portal.</span> <span className="text-ink-soft">Idle timeout {s.expiresAt ? new Date(s.expiresAt).toLocaleTimeString('en-IN') : '—'}</span></p>
          <div className="flex gap-2"><Button variant="secondary" busy={busy} onClick={() => act({ action: 'check' })}>Check session</Button><Button variant="ghost" onClick={() => act({ action: 'logout' })}>Sign out</Button></div>
        </div>
      )}
      {(s.state === 'none' || s.state === 'expired' || s.state === 'failed') && (
        <form onSubmit={submit((f) => ({ action: 'start', username: f.get('username'), remember: f.get('remember') === 'on' }))} className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
          {s.state !== 'none' && s.message && <div className="sm:col-span-2"><Notice tone="warn">{s.message}</Notice></div>}
          <label>GST portal username<input name="username" required defaultValue={s.savedUsername ?? ''} autoComplete="username" /></label>
          <Button type="submit" busy={busy} disabled={!s.protocolConfigured}>Start sign-in</Button>
          <label className="flex items-center gap-2 text-ink"><input type="checkbox" name="remember" className="w-auto" defaultChecked={!!s.savedUsername} />Remember username for this company (encrypted)</label>
        </form>
      )}
      {s.state === 'captcha_required' && (
        <form onSubmit={submit((f) => ({ action: 'submit_captcha', password: f.get('password'), captcha: f.get('captcha') }))} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2 flex items-center gap-3">
            {s.captchaImage && <img src={s.captchaImage} alt="CAPTCHA from the GST portal" className="h-14 rounded border border-rule bg-white" />}
            <Button type="button" variant="ghost" onClick={() => act({ action: 'refresh_captcha' })}>New image</Button>
          </div>
          <label>Portal password<input name="password" type="password" required autoComplete="current-password" /></label>
          <label>Characters shown in the image<input name="captcha" required autoComplete="off" /></label>
          <p className="text-[12.5px] text-ink-soft sm:col-span-2">Your password goes to the portal once and is never saved. You read and type the CAPTCHA yourself.</p>
          <div><Button type="submit" busy={busy}>Sign in</Button></div>
        </form>
      )}
      {s.state === 'otp_required' && (
        <form onSubmit={submit((f) => ({ action: 'submit_otp', otp: f.get('otp') }))} className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
          {s.message && <div className="sm:col-span-2"><Notice>{s.message}</Notice></div>}
          <label>OTP sent by the portal<input name="otp" inputMode="numeric" pattern="\d{4,8}" required autoComplete="one-time-code" /></label>
          <Button type="submit" busy={busy}>Verify OTP</Button>
        </form>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

export function PortalTab({ d, onChanged }: { d: ReturnDetail; onChanged: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `/api/returns/${d.return._id}`;
  const ready = !!d.return.currentJsonId && !d.return.jsonStale && !d.return.summary?.errorCount;
  const job = jobs[0];

  const loadJobs = () => call<{ jobs: Job[] }>(`${base}/upload`).then((r) => setJobs(r.jobs));
  useEffect(() => { loadJobs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [base, d.return.status]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await loadJobs(); onChanged(); }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(null); }
  }
  const start = (mode: 'http' | 'manual') => run(mode, () => call(`${base}/upload`, { method: 'POST', json: { action: 'start', mode } }), mode === 'http' ? 'Uploaded. The portal is processing the file.' : 'Manual upload started. Download the JSON and upload it on the portal.');
  const mark = (status: 'uploaded' | 'processed' | 'filed') => run(status, () => call(`${base}/upload`, { method: 'POST', json: { action: 'mark', status } }), `Marked as ${status}.`);
  const refresh = () => run('refresh', () => call(`${base}/upload?refresh=1`), 'Status refreshed.');
  async function importErrors(f: File) {
    const fd = new FormData(); fd.append('file', f);
    await run('errors', async () => {
      const r = await call<{ count: number; matched: number }>(`${base}/portal-errors`, { method: 'POST', body: fd });
      setMsg({ tone: 'ok', text: `${r.count} portal error(s) imported, ${r.matched} linked to records. Fix them on the Errors tab and regenerate.` });
    }, '');
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="GST portal session">
        <SessionPanel companyId={d.company._id} onState={setSession} />
      </Panel>

      <Panel title="Upload">
        <div className="space-y-4">
          {!ready && <Notice tone="warn">Generate a current JSON with zero errors before uploading.</Notice>}
          {msg && msg.text && <Notice tone={msg.tone}>{msg.text}</Notice>}

          {session?.mode === 'http' && session.protocolConfigured && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => start('http')} busy={busy === 'http'} disabled={!ready || session.state !== 'active'}>Upload JSON to portal</Button>
              {job?.mode === 'http' && job.status === 'processing' && <Button variant="secondary" onClick={refresh} busy={busy === 'refresh'}>Check processing status</Button>}
              {session.state !== 'active' && <span className="text-ink-soft">Sign in first.</span>}
            </div>
          )}

          <div className="rounded-md border border-rule bg-paper/60 p-4">
            <p className="font-semibold">Manual upload</p>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-[13.5px]">
              <li>
                <Button variant="secondary" onClick={() => start('manual')} busy={busy === 'manual'} disabled={!ready}>Start manual upload</Button>{' '}
                <a className={`ml-2 text-ledger underline ${ready ? '' : 'pointer-events-none opacity-40'}`} href={`${base}/json?download=1`}>Download JSON</a>
              </li>
              <li>On the GST portal, open GSTR-1 → Prepare Offline → Upload, and choose the downloaded file.
                <div className="mt-1"><Button variant="ghost" onClick={() => mark('uploaded')} disabled={!job || busy !== null}>I’ve uploaded it</Button></div>
              </li>
              <li>If the portal reports errors, download its error report JSON and import it here.
                <input ref={fileRef} type="file" accept=".json,.zip" className="hidden" onChange={(e) => e.target.files?.[0] && importErrors(e.target.files[0])} />
                <div className="mt-1"><Button variant="ghost" onClick={() => fileRef.current?.click()} busy={busy === 'errors'}>Import portal error report</Button></div>
              </li>
              <li>When processing is clean, mark it.
                <div className="mt-1 flex gap-2"><Button variant="ghost" onClick={() => mark('processed')} disabled={!job || busy !== null}>Processed without errors</Button><Button variant="ghost" onClick={() => mark('filed')} disabled={!job || busy !== null}>Filed (after EVC/DSC)</Button></div>
              </li>
            </ol>
          </div>
        </div>
      </Panel>

      <Panel title="Upload history" className="lg:col-span-2">
        {jobs.length === 0 ? <p className="text-ink-soft">No uploads yet.</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>Portal reference</th><th>Timeline</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j._id}>
                    <td>{new Date(j.createdAt).toLocaleString('en-IN')}</td><td className="capitalize">{j.mode}</td><td>{j.status.replace(/_/g, ' ')}</td><td className="num">{j.referenceId ?? '—'}</td>
                    <td className="text-[12.5px] text-ink-soft">{j.history.map((h, i) => <div key={i}>{new Date(h.at).toLocaleTimeString('en-IN')} — {h.status.replace(/_/g, ' ')}{h.note ? ` (${h.note})` : ''}</div>)}</td>
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
