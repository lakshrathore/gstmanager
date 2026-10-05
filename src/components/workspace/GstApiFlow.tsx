'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Notice } from '@/components/ui';
import { inr } from '@/lib/client';
import type { ReturnStatus } from '@/server/gst/gst-status/statuses';
import type { Tab } from './Workspace';

/**
 * In-app GSTR-1 filing through the GST API integration (Sandbox): login OTP → save → status →
 * proceed to file → GSTN summary → EVC OTP → file → ARN. Every value shown comes from GSTN; OTPs and
 * PAN are typed by the user and sent straight to the server, never kept in browser storage.
 */

export interface ApiSession { state: string; message: string; expiresAt?: string | null; connectedAs?: string }
export interface SummaryRow {
  section: string;
  app?: { documents: number; taxableValue: number; tax: number };
  gstn?: { records: number; taxableValue: number; tax: number; value: number };
  diff: { records: boolean; taxableValue: boolean; tax: boolean };
}
export interface ApiSummary { evidenceId: string; fetchedAt?: string; fetchedBy?: string; chksum: string; jsonSha256?: string; rows: SummaryRow[]; hasDifferences: boolean }
export interface ApiPortal {
  uploadReference?: string; processingReference?: string; arn?: string; filedOn?: string;
  proceedReference?: string; proceededAt?: string; summaryEvidenceId?: string; evcRequestedAt?: string; fileSubmittedAt?: string; ackNum?: string;
}

export type Act = (key: string, body: Record<string, unknown>, ok: string | ((r: Record<string, unknown>) => { tone: 'ok' | 'error'; text: string })) => Promise<boolean>;

const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const POLL_MS = 15_000;
const MAX_POLLS = 40;

/* ---------- login ---------- */

export function GstLoginPanel({ session, steps, canOperate, busy, act }: { session: ApiSession; steps: string[]; canOperate: boolean; busy: string | null; act: Act }) {
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const active = session.state === 'active';

  return (
    <div className="space-y-3 text-[13.5px]">
      <p className={active ? 'font-medium text-ledger' : session.state === 'expired' ? 'font-medium text-red-ink' : 'font-medium'}>{session.message}</p>
      {active && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {session.connectedAs && <><dt className="text-ink-soft">Username</dt><dd className="num">{session.connectedAs}</dd></>}
          {session.expiresAt && <><dt className="text-ink-soft">Valid until</dt><dd>{when(session.expiresAt)}</dd></>}
        </dl>
      )}

      {!active && session.state !== 'otp_sent' && (
        <form className="grid gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act('login-otp', { action: 'login_otp', username }, 'GSTN sent an OTP to the registered mobile and email.')) setOtp(''); }}>
          <label>GST portal username<input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={64} autoComplete="off" spellCheck={false} /></label>
          <div><Button type="submit" busy={busy === 'login-otp'} disabled={!canOperate}>Send OTP</Button></div>
        </form>
      )}

      {session.state === 'otp_sent' && (
        <form className="grid gap-2" onSubmit={async (e) => { e.preventDefault(); await act('login-verify', { action: 'login_verify', otp }, 'Logged in to GST.'); setOtp(''); }}>
          <label>OTP from GSTN{session.connectedAs ? ` (username ${session.connectedAs})` : ''}
            <input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required inputMode="numeric" pattern="\d{4,8}" maxLength={8} autoComplete="one-time-code" className="num" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy === 'login-verify'} disabled={!canOperate}>Verify OTP</Button>
            <Button type="button" variant="ghost" onClick={() => act('logout', { action: 'logout' }, 'Login cancelled.')} disabled={busy !== null}>Use another username</Button>
          </div>
        </form>
      )}

      {active && <Button variant="ghost" onClick={() => act('logout', { action: 'logout' }, 'GST login removed from this app.')} disabled={!canOperate || busy !== null}>Log out of GST</Button>}
      {!canOperate && <p className="text-ink-soft">A reviewer, admin or owner logs in to GST.</p>}
      {!active && <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-soft">{steps.map((x) => <li key={x}>{x}</li>)}</ul>}
    </div>
  );
}

/* ---------- summary comparison ---------- */

function Cell({ app, gstn, diff, money }: { app?: number; gstn?: number; diff: boolean; money?: boolean }) {
  const f = (n?: number) => (n == null ? '—' : money ? inr(n) : String(n));
  return (
    <td className={`num whitespace-nowrap text-right ${diff ? 'bg-red-tint font-semibold text-red-ink' : ''}`}>
      <div>{f(gstn)}</div>
      <div className="text-[11.5px] text-ink-soft">{f(app)}</div>
    </td>
  );
}

export function SummaryTable({ s }: { s: ApiSummary }) {
  return (
    <div className="space-y-2">
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr><th>Section</th><th className="text-right">Records</th><th className="text-right">Taxable value</th><th className="text-right">Tax (IGST+CGST+SGST+cess)</th><th className="text-right">Document value</th></tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.section} className={r.diff.records || r.diff.taxableValue || r.diff.tax ? 'row-error' : ''}>
                <td className="font-medium">{r.section}</td>
                <Cell gstn={r.gstn?.records} app={r.app?.documents} diff={r.diff.records} />
                <Cell gstn={r.gstn?.taxableValue} app={r.app?.taxableValue} diff={r.diff.taxableValue} money />
                <Cell gstn={r.gstn?.tax} app={r.app?.tax} diff={r.diff.tax} money />
                <td className="num whitespace-nowrap text-right">{r.gstn ? inr(r.gstn.value) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-soft">Each cell shows GSTN’s figure on top and this app’s figure (from the generated JSON) below. Differences beyond ₹1 or in record counts are highlighted. Fetched {when(s.fetchedAt)}{s.fetchedBy ? ` by ${s.fetchedBy}` : ''}. GSTN checksum <span className="num break-all">{s.chksum}</span></p>
    </div>
  );
}

/* ---------- steps ---------- */

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_1fr] gap-3">
      <span className={`grid h-7 w-7 place-items-center rounded-full border text-[13px] font-semibold ${done ? 'border-ledger bg-ledger text-white' : 'border-ledger text-ledger'}`}>{done ? '✓' : n}</span>
      <div className="min-w-0 pb-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1.5 space-y-2 text-[13.5px]">{children}</div>}
      </div>
    </li>
  );
}

interface FlowProps {
  status: ReturnStatus;
  actions: string[];
  canOperate: boolean;
  canFile: boolean;
  session: ApiSession;
  portal: ApiPortal;
  summary: ApiSummary | null;
  jsonFile?: { fileName: string; sha256: string } | null;
  portalErrors: number;
  busy: string | null;
  act: Act;
  onGoto: (t: Tab) => void;
}

export function GstApiFlow(p: FlowProps) {
  const { status: s, portal, summary, busy, act } = p;
  const can = (a: string) => p.canOperate && p.actions.includes(a);
  const loggedIn = p.session.state === 'active';
  const needLogin = !loggedIn && <Notice tone="warn">Log in to GST (right) to continue. GSTN sends the OTP; you type it here.</Notice>;

  // Poll GSTN while the upload is being processed.
  const polls = useRef(0);
  const [auto, setAuto] = useState(true);
  const waiting = (s === 'uploaded' || s === 'processing') && loggedIn && auto && can('check_status');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      if (busy !== null) return;
      if (++polls.current > MAX_POLLS) { setAuto(false); return; }
      act('status', { action: 'check_status' }, statusMsg);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, busy, act]);

  // Verification is tied to one fetched summary: a newer summary needs a fresh confirmation.
  const [verifiedFor, setVerifiedFor] = useState<string | null>(null);
  const verified = !!summary && verifiedFor === summary.evidenceId;
  const [pan, setPan] = useState('');
  const [evcOtp, setEvcOtp] = useState('');

  if (s === 'ready_for_upload') {
    return (
      <div className="space-y-3">
        {needLogin}
        <p>Sending saves the approved JSON to GSTN (Save GSTR-1). GSTN returns a reference, which is recorded with the file checksum. Data stays locked until GSTN’s result comes back.</p>
        {p.jsonFile && <p className="num break-all text-[12px] text-ink-soft">{p.jsonFile.fileName} · SHA-256 {p.jsonFile.sha256}</p>}
        <Button onClick={() => act('start', { action: 'start_upload' }, (r) => ({ tone: 'ok', text: `Saved to GSTN. Reference ${String(r.reference ?? '')}. Checking processing status…` }))} busy={busy === 'start'} disabled={!can('start_upload') || !loggedIn}>Send to GSTN</Button>
      </div>
    );
  }

  if (s === 'uploading') {
    return (
      <div className="space-y-3">
        <Notice tone="warn">A submission was started but GSTN’s reference was not recorded. If GSTN rejected it, the reason is in the status history below. Cancel to unlock the data and try again.</Notice>
        <Button variant="secondary" onClick={() => act('cancel', { action: 'cancel_upload' }, 'Upload cancelled. Data is editable again.')} disabled={!can('cancel_upload') || busy !== null}>Cancel upload</Button>
      </div>
    );
  }

  if (s === 'uploaded' || s === 'processing') {
    return (
      <div className="space-y-3">
        {needLogin}
        <p>GSTN is processing the saved data. Reference <span className="num">{portal.uploadReference}</span>.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => act('status', { action: 'check_status' }, statusMsg)} busy={busy === 'status'} disabled={!can('check_status') || !loggedIn}>Check status now</Button>
          {loggedIn && (
            <label className="flex items-center gap-2 text-[13px] text-ink-soft">
              <input type="checkbox" className="h-4 w-4" checked={auto} onChange={(e) => { polls.current = 0; setAuto(e.target.checked); }} />
              Check automatically every 15 s
            </label>
          )}
        </div>
        <p className="text-[12.5px] text-ink-soft">“Processed” moves the return on. “Processed with errors” or “Error” imports GSTN’s error report and links each error to its invoice.</p>
      </div>
    );
  }

  if (s === 'error') {
    return (
      <div className="space-y-3">
        <Notice tone="error">GSTN rejected some records ({p.portalErrors}). Fix them, regenerate the JSON, approve it and send it again.</Notice>
        <Button onClick={() => p.onGoto('errors')}>Review GSTN errors</Button>
      </div>
    );
  }

  if (s === 'processed') {
    const submitted = !!portal.fileSubmittedAt;
    const proceeded = !!portal.proceedReference;
    const haveSummary = !!summary;
    return (
      <div className="space-y-4">
        {needLogin}
        <ol className="space-y-5">
          <Step n={1} title="Saved and processed by GSTN" done>
            <p className="text-ink-soft">{portal.processingReference}</p>
          </Step>
  
          <Step n={2} title="Proceed to file" done={proceeded}>
            {proceeded
              ? <p className="text-ink-soft">GSTN reference <span className="num">{portal.proceedReference}</span>{portal.proceededAt ? `, ${when(portal.proceededAt)}` : ''}.</p>
              : <p>GSTN freezes the saved data and prepares the GSTR-1 summary.</p>}
            {!submitted && (
              <Button variant={proceeded ? 'ghost' : 'primary'} onClick={() => act('proceed', { action: 'proceed_to_file' }, 'GSTN accepted proceed to file. Fetch the summary next.')} busy={busy === 'proceed'} disabled={!can('proceed_to_file') || !loggedIn}>
                {proceeded ? 'Run proceed to file again' : 'Proceed to file'}
              </Button>
            )}
          </Step>
  
          <Step n={3} title="Review GSTN’s summary" done={haveSummary && verified}>
            {proceeded && !submitted && (
              <Button variant={haveSummary ? 'ghost' : 'primary'} onClick={() => act('summary', { action: 'fetch_summary' }, (r) => r.pending
                ? { tone: 'ok', text: `GSTN is still preparing the summary (${String(r.label)}). Try again in a few seconds.` }
                : { tone: 'ok', text: 'GSTN summary fetched. Compare it with your totals below.' })} busy={busy === 'summary'} disabled={!can('fetch_summary') || !loggedIn}>
                {haveSummary ? 'Fetch the summary again' : 'Fetch GSTN summary'}
              </Button>
            )}
            {summary && (
              <>
                {summary.hasDifferences
                  ? <Notice tone="warn">GSTN’s summary differs from this app’s totals in the highlighted cells. Check them before filing. Filing uses GSTN’s figures.</Notice>
                  : <Notice tone="ok">GSTN’s summary matches this app’s totals for every section.</Notice>}
                <SummaryTable s={summary} />
              </>
            )}
          </Step>
  
          <Step n={4} title="File with EVC" done={submitted}>
            {submitted ? (
              <div className="space-y-2">
                <Notice tone="ok">Filing submitted to GSTN {when(portal.fileSubmittedAt)}{portal.ackNum ? `, acknowledgement ${portal.ackNum}` : ''}. Waiting for GSTN to list the ARN.</Notice>
                <Button onClick={() => act('arn', { action: 'fetch_arn' }, arnMsg)} busy={busy === 'arn'} disabled={!can('fetch_arn') || !loggedIn}>Fetch ARN</Button>
              </div>
            ) : !p.canFile ? (
              <p className="text-ink-soft">Only an owner or admin can file the return.</p>
            ) : !summary ? (
              <p className="text-ink-soft">Fetch and review GSTN’s summary first.</p>
            ) : (
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
                e.preventDefault();
                act('file', { action: 'file_return', pan, otp: evcOtp, summaryEvidenceId: summary.evidenceId, verified }, (r) => r.found
                  ? { tone: 'ok', text: `GSTR-1 filed. ARN ${String(r.arn)}.` }
                  : { tone: 'ok', text: `Filing submitted to GSTN${r.ackNum ? ` (acknowledgement ${String(r.ackNum)})` : ''}. ${String(r.message ?? 'Fetch the ARN in a few minutes.')}` });
                setEvcOtp('');
              }}>
                <label className="flex items-start gap-2 sm:col-span-2">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={verified} onChange={(e) => setVerifiedFor(e.target.checked && summary ? summary.evidenceId : null)} />
                  <span>I have verified the GSTN summary above and want to file GSTR-1 for this period. Filing cannot be undone.</span>
                </label>
                <label>Authorised signatory PAN
                  <input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} required pattern="[A-Z]{5}[0-9]{4}[A-Z]" maxLength={10} autoComplete="off" spellCheck={false} className="num uppercase" />
                </label>
                <div className="flex items-end">
                  <Button type="button" variant="secondary" onClick={() => act('evc', { action: 'request_evc_otp', pan }, 'GSTN sent the EVC OTP to the signatory’s registered mobile and email.')} busy={busy === 'evc'} disabled={!can('request_evc_otp') || !loggedIn || pan.length !== 10 || !verified}>
                    {portal.evcRequestedAt ? 'Send EVC OTP again' : 'Send EVC OTP'}
                  </Button>
                </div>
                <label>EVC OTP
                  <input value={evcOtp} onChange={(e) => setEvcOtp(e.target.value.replace(/\D/g, ''))} required inputMode="numeric" pattern="\d{4,8}" maxLength={8} autoComplete="one-time-code" className="num" disabled={!portal.evcRequestedAt} />
                </label>
                <div className="flex items-end">
                  <Button type="submit" busy={busy === 'file'} disabled={!can('file_return') || !loggedIn || !verified || !portal.evcRequestedAt || evcOtp.length < 4 || pan.length !== 10}>File GSTR-1</Button>
                </div>
                {portal.evcRequestedAt && <p className="text-[12.5px] text-ink-soft sm:col-span-2">EVC OTP requested {when(portal.evcRequestedAt)}.</p>}
              </form>
            )}
          </Step>
        </ol>
      </div>
    );
  }

  if (s === 'filed') {
    return <Notice tone="ok">Filed. ARN <span className="num">{portal.arn}</span>{portal.filedOn ? ` on ${new Date(portal.filedOn).toLocaleDateString('en-IN')}` : ''}.</Notice>;
  }
  return null;
}

function statusMsg(r: Record<string, unknown>): { tone: 'ok' | 'error'; text: string } {
  if (r.state === 'processed') return { tone: 'ok', text: `GSTN: ${String(r.label)}. Proceed to file next.` };
  if (r.state === 'error') {
    const lines = (r.messages as string[] | undefined) ?? [];
    return { tone: 'error', text: `GSTN: ${String(r.label)}. ${String(r.errors)} error(s) recorded, ${String(r.matched)} linked to invoices.${lines.length ? ` ${lines.join(' · ')}` : ''}` };
  }
  return { tone: 'ok', text: `GSTN: ${String(r.label)}. Still processing.` };
}

function arnMsg(r: Record<string, unknown>): { tone: 'ok' | 'error'; text: string } {
  return r.found ? { tone: 'ok', text: `GSTR-1 filed. ARN ${String(r.arn)}.` } : { tone: 'ok', text: String(r.message ?? 'ARN not available yet.') };
}
