'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';
import { STATUS_LABELS, type ReturnStatus } from '@/server/gst/gst-status/statuses';
import { GstApiFlow, GstLoginPanel, type Act, type ApiPortal, type ApiSession, type ApiSummary } from './GstApiFlow';
import type { ReturnDetail } from './types';
import type { Tab } from './Workspace';

interface Evidence { _id: string; kind: string; reference?: string; note?: string; fileName?: string; sizeBytes?: number; recordedByEmail: string; createdAt: string }
interface History { from: string; to: string; at: string; byEmail: string; note?: string; evidenceId?: string }
interface Job { _id: string; client: string; status: string; reference?: string; jsonSha256?: string; createdAt: string; history: { at: string; status: string; note?: string; by?: string }[] }
interface Overview {
  status: ReturnStatus;
  actions: string[];
  canOperate: boolean;
  canFile: boolean;
  client: { id: string; label: string; capabilities: { authenticate: boolean; upload: boolean; uploadStatus: boolean; fileReturn: boolean } };
  login: { mode: string; portalUrl: string; steps: string[] };
  session: ApiSession;
  summary: ApiSummary | null;
  json: { sha256: string; version: string; fileName: string } | null;
  portal: ApiPortal;
  statusHistory: History[];
  evidence: Evidence[];
  jobs: Job[];
}

/** Statuses handled by the in-app GSTN flow when an API client is configured. */
const API_STEPS: ReadonlySet<ReturnStatus> = new Set(['ready_for_upload', 'uploading', 'uploaded', 'processing', 'error', 'processed', 'filed']);

const KIND_LABEL: Record<string, string> = {
  upload_reference: 'Upload confirmation', error_report: 'Portal error report', processing_result: 'Processing result',
  summary: 'GSTN GSTR-1 summary', acknowledgement: 'Filing acknowledgement', note: 'Note',
};
const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_1fr] gap-3">
      <span className="grid h-7 w-7 place-items-center rounded-full border border-ledger text-[13px] font-semibold text-ledger">{n}</span>
      <div className="min-w-0 pb-1">
        <p className="font-semibold">{title}</p>
        <div className="mt-1.5 space-y-2 text-[13.5px]">{children}</div>
      </div>
    </li>
  );
}

export function GstPortalTab({ d, onChanged, onGoto }: { d: ReturnDetail; onChanged: () => void; onGoto: (t: Tab) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const reportRef = useRef<HTMLInputElement>(null);
  const base = `/api/returns/${d.return._id}`;

  const load = useCallback(() => call<Overview>(`${base}/gst`).then(setO).catch((e) => setMsg({ tone: 'error', text: e.message })), [base]);
  useEffect(() => { load(); }, [load, d.return.status]);

  const act = useCallback(async (key: string, body: Record<string, unknown> | FormData, ok: Parameters<Act>[2]) => {
    setBusy(key); setMsg(null);
    try {
      const r = await call<Record<string, unknown>>(`${base}/gst`, body instanceof FormData ? { method: 'POST', body } : { method: 'POST', json: body });
      setMsg(typeof ok === 'string' ? { tone: 'ok', text: ok } : ok(r ?? {}));
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      return false;
    } finally {
      await load();
      onChanged();
      setBusy(null);
    }
  }, [base, load, onChanged]);
  const formAct = (key: string, action: string, ok: string) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set('action', action);
    act(key, fd, ok);
  };

  async function importReport(f: File) {
    const fd = new FormData();
    fd.append('file', f);
    setBusy('report'); setMsg(null);
    try {
      const r = await call<{ count: number; matched: number }>(`${base}/portal-errors`, { method: 'POST', body: fd });
      setMsg({
        tone: r.count ? 'error' : 'ok',
        text: r.count
          ? `${r.count} portal error(s) recorded, ${r.matched} linked to invoices. Fix them on the Errors tab, regenerate the JSON and upload again.`
          : 'The report contains no errors. That alone does not confirm processing; record the portal’s processed status below.',
      });
      await load();
      onChanged();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      if (reportRef.current) reportRef.current.value = '';
    }
  }

  if (!o) return <p className="text-ink-soft">{msg?.text ?? 'Loading…'}</p>;
  const can = (a: string) => o.canOperate && o.actions.includes(a);
  const s = o.status;
  const reportInput = <input ref={reportRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importReport(e.target.files[0])} />;

  const apiMode = o.client.capabilities.upload;
  let body: ReactNode;
  if (apiMode && API_STEPS.has(s)) {
    body = (
      <GstApiFlow
        status={s} actions={o.actions} canOperate={o.canOperate} canFile={o.canFile} session={o.session} portal={o.portal}
        summary={o.summary} jsonFile={o.json} portalErrors={d.counts.portalErrors} busy={busy} act={act} onGoto={onGoto}
      />
    );
  } else if (['draft', 'imported', 'validated', 'validation_error'].includes(s)) {
    body = (
      <Notice>
        Finish the application steps first: import, fix validation errors and generate the JSON. The GST portal step opens once the JSON is ready.
        <div className="mt-2"><Button variant="secondary" onClick={() => onGoto(s === 'validation_error' ? 'errors' : 'json')}>{s === 'validation_error' ? 'Go to errors' : 'Go to JSON'}</Button></div>
      </Notice>
    );
  } else if (s === 'json_generated') {
    body = (
      <form onSubmit={formAct('ready', 'mark_ready', 'Approved. The return is ready for upload.')} className="space-y-3">
        <p>Review the JSON (sections, totals, SHA-256 on the JSON tab), then approve it. The approved file is the one recorded against the upload.</p>
        <label>Review note (optional)<input name="note" maxLength={500} /></label>
        <Button type="submit" busy={busy === 'ready'} disabled={!o.canOperate}>Approve for upload</Button>
        {!o.canOperate && <p className="text-ink-soft">A reviewer, admin or owner approves uploads.</p>}
      </form>
    );
  } else if (s === 'ready_for_upload') {
    body = (
      <div className="space-y-3">
        <p>Starting the upload records the attempt (time, user, file checksum) and locks the data until the portal result is recorded.</p>
        <Button onClick={() => act('start', { action: 'start_upload' }, 'Upload started. Follow the steps below on the GST portal.')} busy={busy === 'start'} disabled={!can('start_upload')}>Start upload</Button>
      </div>
    );
  } else if (s === 'uploading') {
    body = (
      <ol className="space-y-5">
        <Step n={1} title="Download the JSON">
          <a className="inline-block rounded-md border border-rule bg-white px-3.5 py-2 font-medium hover:border-ink-soft" href={`${base}/json?download=1`}>Download {o.json?.fileName ?? 'JSON'}</a>
          {o.json && <p className="num break-all text-[12px] text-ink-soft">SHA-256 {o.json.sha256}</p>}
        </Step>
        <Step n={2} title="Upload it on the GST portal">
          <a className="inline-block rounded-md bg-ledger px-3.5 py-2 font-medium text-white hover:bg-[#0a5a4d]" href={o.login.portalUrl} target="_blank" rel="noopener noreferrer">Open GST portal</a>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">{o.login.steps.map((x) => <li key={x}>{x}</li>)}</ul>
        </Step>
        <Step n={3} title="Record the upload">
          <form onSubmit={formAct('uploaded', 'confirm_uploaded', 'Upload recorded.')} className="grid gap-3">
            <label>Reference shown by the portal (optional)<input name="reference" maxLength={64} className="num" /></label>
            <label>Note (optional)<input name="note" maxLength={1000} /></label>
            <label>Screenshot or PDF (optional)<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" /></label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={busy === 'uploaded'} disabled={!can('confirm_uploaded')}>I uploaded the file</Button>
              <Button type="button" variant="ghost" onClick={() => act('cancel', { action: 'cancel_upload' }, 'Upload cancelled. Data is editable again.')} disabled={!can('cancel_upload') || busy !== null}>Cancel upload</Button>
            </div>
          </form>
        </Step>
      </ol>
    );
  } else if (s === 'uploaded' || s === 'processing') {
    body = (
      <div className="space-y-6">
        <p>Check the upload status on the GST portal (GSTR-1 → Prepare Offline → upload history) and record what it shows.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-rule p-4">
            <p className="font-semibold">The portal reported errors</p>
            <p className="mt-1 text-ink-soft">Download the error report from the portal and import it here. Errors are matched to invoices.</p>
            {reportInput}
            <Button className="mt-3" variant="danger" onClick={() => reportRef.current?.click()} busy={busy === 'report'} disabled={!can('import_error_report')}>Import error report</Button>
          </div>
          <form onSubmit={formAct('processed', 'record_processed', 'Processing result recorded.')} className="grid gap-3 rounded-md border border-rule p-4">
            <p className="font-semibold">The portal processed it</p>
            <label>Status / reference shown by the portal<input name="reference" maxLength={64} className="num" placeholder="e.g. Processed + reference ID" /></label>
            <label>Screenshot or PDF of the portal status<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" /></label>
            <p className="text-[12.5px] text-ink-soft">Provide at least one. The app won’t mark the return processed without it.</p>
            <div><Button type="submit" busy={busy === 'processed'} disabled={!can('record_processed')}>Record processed</Button></div>
          </form>
        </div>
        {s === 'uploaded' && can('mark_processing') && (
          <Button variant="ghost" onClick={() => act('processing', { action: 'mark_processing' }, 'Marked as processing on the portal.')} disabled={busy !== null}>Portal still shows “in progress”</Button>
        )}
      </div>
    );
  } else if (s === 'error') {
    body = (
      <div className="space-y-3">
        <Notice tone="error">The GST portal rejected some records ({d.counts.portalErrors}). Fix them, regenerate the JSON, approve it and upload again.</Notice>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onGoto('errors')}>Review portal errors</Button>
          {reportInput}
          <Button variant="secondary" onClick={() => reportRef.current?.click()} busy={busy === 'report'} disabled={!can('import_error_report')}>Import a newer error report</Button>
        </div>
      </div>
    );
  } else if (s === 'processed') {
    body = (
      <form onSubmit={formAct('filed', 'record_filed', 'Filing recorded.')} className="grid gap-3 sm:grid-cols-2">
        <p className="sm:col-span-2">After you file GSTR-1 on the portal (EVC or DSC), record the acknowledgement here.</p>
        <label>ARN from the acknowledgement<input name="arn" required maxLength={15} minLength={15} className="num uppercase" /></label>
        <label>Filing date<input name="filedOn" type="date" required /></label>
        <label className="sm:col-span-2">Acknowledgement PDF or screenshot (recommended)<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" /></label>
        <div><Button type="submit" busy={busy === 'filed'} disabled={!can('record_filed')}>Record filing</Button></div>
      </form>
    );
  } else if (s === 'filed') {
    body = (
      <Notice tone="ok">
        Filed{o.portal.filedVia === 'gstn-download' ? ' on the GST portal (outside this app)' : ''}. ARN <span className="num">{o.portal.arn}</span>{o.portal.filedOn ? ` on ${new Date(o.portal.filedOn).toLocaleDateString('en-IN')}` : ''}.
        {o.portal.filedVia === 'gstn-download' && ' The records are the filed data downloaded from GSTN; the return is locked.'}
      </Notice>
    );
  }

  return (
    <div className="space-y-6">
      {o.portal.filedVia === 'gstn-download' ? (
        <Notice>
          <span className="font-semibold">Filed outside this app.</span> GSTN listed this return as filed when it was downloaded from the GST portal (Downloads → From the GST portal); the ARN and GSTN’s filing record are kept as evidence.
        </Notice>
      ) : apiMode ? (
        <Notice>
          <span className="font-semibold">Filed from inside this app through {o.client.label}, an authorised GSP route.</span> You log in with the OTP GSTN sends you; every reference, status, summary and ARN shown here is GSTN’s own response, stored as evidence.
        </Notice>
      ) : (
        <Notice>
          <span className="font-semibold">You do this part on the official GST portal.</span> {o.session.message} This app does not log in or upload for you; it records what you did and what the portal returned.
        </Notice>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Panel title={`Current step: ${STATUS_LABELS[s]}`}>{body}</Panel>

        <div className="space-y-6">
          {apiMode && (
            <Panel title="GST login">
              <GstLoginPanel session={o.session} steps={o.login.steps} canOperate={o.canOperate} busy={busy} act={act} />
            </Panel>
          )}

          <Panel title={apiMode ? 'GSTN references' : 'Portal references'}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-ink-soft">Upload reference</dt><dd className="num break-all">{o.portal.uploadReference || '—'}</dd>
              <dt className="text-ink-soft">Processing result</dt><dd className="num break-all">{o.portal.processingReference || (s === 'processed' || s === 'filed' ? 'Attachment' : '—')}</dd>
              {apiMode && <><dt className="text-ink-soft">Proceed to file</dt><dd className="num break-all">{o.portal.proceedReference || '—'}</dd></>}
              {apiMode && <><dt className="text-ink-soft">Acknowledgement</dt><dd className="num break-all">{o.portal.ackNum || (o.portal.fileSubmittedAt ? 'Submitted' : '—')}</dd></>}
              <dt className="text-ink-soft">ARN</dt><dd className="num">{o.portal.arn || '—'}</dd>
              <dt className="text-ink-soft">Filed on</dt><dd>{o.portal.filedOn ? new Date(o.portal.filedOn).toLocaleDateString('en-IN') : '—'}</dd>
            </dl>
            <p className="mt-3 text-[12.5px] text-ink-soft">{apiMode ? 'Only values returned by GSTN appear here.' : 'Only values you copied from the GST portal appear here.'}</p>
          </Panel>

          <Panel title="Evidence">
            {o.evidence.length === 0 ? <p className="text-ink-soft">Nothing recorded yet.</p> : (
              <ul className="space-y-3">
                {o.evidence.map((e) => (
                  <li key={e._id} className="border-b border-rule pb-3 last:border-0 last:pb-0">
                    <p className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}{e.reference && <span className="num ml-2 font-normal">{e.reference}</span>}</p>
                    {e.note && <p className="text-ink-soft">{e.note}</p>}
                    <p className="text-[12.5px] text-ink-soft">{when(e.createdAt)}, {e.recordedByEmail}
                      {e.fileName && <> · <a className="text-ledger underline" href={`${base}/evidence/${e._id}`}>{e.fileName}</a></>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Status history">
        {o.statusHistory.length === 0 ? <p className="text-ink-soft">No changes yet.</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>When</th><th>From</th><th>To</th><th>By</th><th>Note</th></tr></thead>
              <tbody>
                {o.statusHistory.map((h, i) => (
                  <tr key={i}><td className="whitespace-nowrap">{when(h.at)}</td><td>{STATUS_LABELS[h.from as ReturnStatus] ?? h.from}</td><td className="font-medium">{STATUS_LABELS[h.to as ReturnStatus] ?? h.to}</td><td>{h.byEmail}</td><td className="text-ink-soft">{h.note ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {o.jobs.length > 0 && (
        <Panel title="Upload attempts">
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Started</th><th>Method</th><th>Result</th><th>Reference</th><th>File checksum</th><th>Timeline</th></tr></thead>
              <tbody>
                {o.jobs.map((j) => (
                  <tr key={j._id}>
                    <td className="whitespace-nowrap">{when(j.createdAt)}</td>
                    <td>{j.client === 'manual' ? 'Manual on portal' : j.client === o.client.id ? o.client.label : j.client}</td>
                    <td className="capitalize">{j.status}</td>
                    <td className="num">{j.reference ?? '—'}</td>
                    <td className="num text-[12px]">{j.jsonSha256 ? `${j.jsonSha256.slice(0, 12)}…` : '—'}</td>
                    <td className="text-[12.5px] text-ink-soft">{j.history.map((h, k) => <div key={k}>{new Date(h.at).toLocaleTimeString('en-IN')}, {h.status}{h.note ? `: ${h.note}` : ''}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
