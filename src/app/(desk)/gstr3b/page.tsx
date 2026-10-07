'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { Gstr3bTables } from '@/components/gstr3b/Gstr3bTables';
import { OffsetPanel } from '@/components/gstr3b/OffsetPanel';
import { GstLoginPanel, type Act, type ApiSession } from '@/components/workspace/GstApiFlow';
import { call, inr, periodLabel } from '@/lib/client';
import {
  HEAD_LABEL, HEADS, liabilityPreview, MAJOR_LABEL, MAJORS, normalizeForm,
  type AutoLiability, type Gstr3bForm, type Head, type LedgerBalance, type LiabilityRow, type Major,
} from '@/server/gst/gstr3b/protocol';

/**
 * GSTR-3B through the GST API integration: get from GSTN → prepare → save → offset liability → file
 * with EVC. Every figure in the payment and filing steps comes from GSTN; OTPs and PAN are typed by
 * the user and sent straight to the server.
 */

type Status = 'draft' | 'saving' | 'saved' | 'offset' | 'filed';
interface Company { _id: string; name: string; gstin: string }
interface Overview {
  company: Company; fp: string; status: Status; api: boolean; canEdit: boolean; canOperate: boolean; canFile: boolean;
  session: ApiSession; login: { steps: string[] };
  form: Gstr3bForm | null; formSource: string | null; formUpdatedAt: string | null; formUpdatedBy: string | null;
  auto: AutoLiability | null; autoFetchedAt: string | null;
  portalForm: Gstr3bForm | null; portalFetchedAt: string | null;
  ledger: LedgerBalance | null; ledgerFetchedAt: string | null;
  notes: string[]; liability: LiabilityRow[]; currentItc: Record<Head, number> | null;
  payment: { pdcash: Record<string, number>[]; pditc: Record<string, number> | null; offset: boolean } | null;
  nilEligible: boolean;
  portal: { saveReference?: string; savedAt?: string; saveErrors?: string[]; detailsEvidenceId?: string; offsetAt?: string; evcRequestedAt?: string; fileSubmittedAt?: string; ackNum?: string; arn?: string; filedOn?: string };
  history: { at: string; from: string; to: string; note?: string; byEmail?: string }[];
}

const STATUS_LABEL: Record<Status, string> = { draft: 'Draft', saving: 'Saving to GSTN', saved: 'Saved on GSTN', offset: 'Liability offset', filed: 'Filed' };
const SOURCE_LABEL: Record<string, string> = { auto: 'GSTN’s auto-calculated values', portal: 'values saved on the GST portal', manual: 'your edits' };
const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const POLL_MS = 10_000;
const MAX_POLLS = 30;

function lastMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_1fr] gap-3">
      <span className={`grid h-7 w-7 place-items-center rounded-full border text-[13px] font-semibold ${done ? 'border-ledger bg-ledger text-white' : 'border-ledger text-ledger'}`}>{done ? '✓' : n}</span>
      <div className="min-w-0 pb-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1.5 space-y-3 text-[13.5px]">{children}</div>}
      </div>
    </li>
  );
}

/** Headline figures of a prepared/auto/saved return, for comparing the three side by side. */
function Totals({ forms }: { forms: [string, Gstr3bForm | null, ReactNode?][] }) {
  const shown = forms.filter(([, f]) => f);
  if (!shown.length) return null;
  const lines: [string, (f: Gstr3bForm) => number][] = [
    ['3.1(a) Taxable value', (f) => f.sup_details.osup_det.txval ?? 0],
    ...HEADS.map((h): [string, (f: Gstr3bForm) => number] => [`Tax payable – ${HEAD_LABEL[h]}`, (f) => { const p = liabilityPreview(f); return p.forward[h] + p.reverse[h]; }]),
    ...HEADS.map((h): [string, (f: Gstr3bForm) => number] => [`Net ITC 4(C) – ${HEAD_LABEL[h]}`, (f) => liabilityPreview(f).itc[h]]),
  ];
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="ledger">
        <thead><tr><th />{shown.map(([l]) => <th key={l} className="text-right">{l}</th>)}</tr></thead>
        <tbody>
          {lines.map(([l, v]) => {
            const vals = shown.map(([, f]) => v(f!));
            const differs = vals.some((x) => Math.abs(x - vals[0]) > 1);
            return <tr key={l} className={differs ? 'row-error' : ''}><td>{l}</td>{vals.map((x, i) => <td key={i} className="num text-right">{inr(x)}</td>)}</tr>;
          })}
          {shown.some(([, , a]) => a) && <tr><td />{shown.map(([l, , a]) => <td key={l} className="text-right">{a}</td>)}</tr>}
        </tbody>
      </table>
    </div>
  );
}

/** What GSTN shows as paid after the set-off. */
function Payment({ p }: { p: NonNullable<Overview['payment']> }) {
  const i = p.pditc ?? {};
  const byItc: Record<Major, number> = {
    igst: (i.i_pdi ?? 0) + (i.c_pdi ?? 0) + (i.s_pdi ?? 0), cgst: (i.i_pdc ?? 0) + (i.c_pdc ?? 0), sgst: (i.i_pds ?? 0) + (i.s_pds ?? 0), cess: i.cs_pdcs ?? 0,
  };
  const sum = (keys: string[]) => p.pdcash.reduce((a, r) => a + keys.reduce((b, k) => b + (r[k] ?? 0), 0), 0);
  const byCash: Record<Major, number> = {
    igst: sum(['ipd', 'i_intrpd', 'i_lfeepd']), cgst: sum(['cpd', 'c_intrpd', 'c_lfeepd']), sgst: sum(['spd', 's_intrpd', 's_lfeepd']), cess: sum(['cspd', 'cs_intrpd', 'cs_lfeepd']),
  };
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="ledger">
        <thead><tr><th>Paid (GSTN)</th>{MAJORS.map((k) => <th key={k} className="text-right">{MAJOR_LABEL[k]}</th>)}</tr></thead>
        <tbody>
          <tr><td>Through ITC</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(byItc[k])}</td>)}</tr>
          <tr><td>In cash (tax, interest, late fee)</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(byCash[k])}</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

export default function Gstr3bPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fp, setFp] = useState(lastMonth());
  const [o, setO] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Gstr3bForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [verifiedFor, setVerifiedFor] = useState<string | null>(null);
  const [pan, setPan] = useState('');
  const [evcOtp, setEvcOtp] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => { setCompanies(r.companies); if (r.companies[0]) setCompanyId(r.companies[0]._id); }).catch((e) => setMsg({ tone: 'error', text: e.message }));
  }, []);

  const load = useCallback(() => (companyId && /^\d{6}$/.test(fp)
    ? call<Overview>(`/api/gstr3b?companyId=${companyId}&fp=${fp}`)
      .then((r) => { setO(r); setDraft(r.form ? normalizeForm(r.form) : null); setDirty(false); })
      .catch((e) => setMsg({ tone: 'error', text: e.message }))
    : Promise.resolve()), [companyId, fp]);
  useEffect(() => { load(); }, [load]);
  const pick = (c: string, p: string) => { setO(null); setMsg(null); setCompanyId(c); setFp(p); };

  const act: Act = useCallback(async (key, body, ok) => {
    setBusy(key); setMsg(null);
    try {
      const r = await call<Record<string, unknown>>('/api/gstr3b', { method: 'POST', json: { companyId, fp, ...body } });
      setMsg(typeof ok === 'string' ? { tone: 'ok', text: ok } : ok(r ?? {}));
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      return false;
    } finally {
      await load();
      setBusy(null);
    }
  }, [companyId, fp, load]);

  // Poll GSTN while the save is being processed.
  const polls = useRef(0);
  const [auto, setAuto] = useState(true);
  const loggedIn = o?.session.state === 'active';
  const waiting = o?.status === 'saving' && loggedIn && auto && o.canOperate;
  useEffect(() => {
    if (!waiting) return;
    polls.current = 0;
    const t = setInterval(() => {
      if (busy !== null) return;
      if (++polls.current > MAX_POLLS) { setAuto(false); return; }
      act('check', { action: 'check_save' }, saveMsg);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, busy, act]);

  const s = o?.status;
  const editable = !!o && o.canEdit && (s === 'draft' || s === 'saved');
  const needLogin = o && o.api && !loggedIn && <Notice tone="warn">Log in to GST (right) to continue. GSTN sends the OTP; you type it here.</Notice>;
  const verified = !!o?.portal.detailsEvidenceId && verifiedFor === o.portal.detailsEvidenceId;
  const nilMode = !!o?.nilEligible && (s === 'draft' || s === 'saved');

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">GSTR-3B</h1>
          {o && <p className="text-ink-soft">{o.company.name} · {o.company.gstin} · {periodLabel(fp)} · <span className="font-medium text-ink">{STATUS_LABEL[o.status]}</span></p>}
        </div>
        <div className="flex flex-wrap gap-3">
          <label>Company
            <select value={companyId} onChange={(e) => pick(e.target.value, fp)} className="min-w-56">
              {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
            </select>
          </label>
          <label>Period
            <input type="month" value={`${fp.slice(2)}-${fp.slice(0, 2)}`} onChange={(e) => { const [y, m] = e.target.value.split('-'); if (y && m) pick(companyId, `${m}${y}`); }} />
          </label>
        </div>
      </div>

      {msg && <Notice tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Notice>}
      {!companies.length && <Empty title="Add a company first">GSTR-3B is prepared per company (GSTIN) and month.</Empty>}
      {o && !o.api && <Notice tone="warn">GSTR-3B is fetched, saved, offset and filed through the GST API integration. Set GST_INTEGRATION=sandbox with your Sandbox API keys to use it.</Notice>}

      {o && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Panel title="File GSTR-3B">
            <div className="space-y-4">
              {needLogin}
              <ol className="space-y-6">
                <Step n={1} title="Get from the GST portal" done={!!o.portalFetchedAt}>
                  <p className="text-ink-soft">Fetches the GSTR-3B saved on the portal, GSTN’s auto-calculated liability and ITC (from your GSTR-1/IFF and GSTR-2B), the cash and credit ledger balance, and the filing status.</p>
                  {s !== 'filed' && (
                    <Button variant={o.portalFetchedAt ? 'secondary' : 'primary'} onClick={() => act('fetch', { action: 'fetch' }, (r) => ({ tone: 'ok', text: (r.notes as string[] | undefined)?.length ? 'Fetched from GSTN – see the notes below.' : 'Fetched from GSTN.' }))}
                      busy={busy === 'fetch'} disabled={!o.api || !loggedIn || !o.canEdit}>
                      {o.portalFetchedAt ? 'Fetch again' : 'Fetch from GST portal'}
                    </Button>
                  )}
                  {o.notes.length > 0 && <Notice tone="warn"><ul className="list-disc space-y-1 pl-4">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul></Notice>}
                  {(o.auto || o.portalForm) && (
                    <>
                      <Totals forms={[
                        ['Auto-calculated by GSTN', o.auto?.form ?? null, editable && o.auto && <Button variant="ghost" onClick={() => act('use-auto', { action: 'use_values', source: 'auto' }, 'Tables filled with GSTN’s auto-calculated values.')} disabled={busy !== null}>Use these</Button>],
                        ['Saved on GST portal', o.portalForm, editable && o.portalForm && <Button variant="ghost" onClick={() => act('use-portal', { action: 'use_values', source: 'portal' }, 'Tables filled with the values saved on the GST portal.')} disabled={busy !== null}>Use these</Button>],
                        ['Prepared here', draft],
                      ]} />
                      <p className="text-[12px] text-ink-soft">
                        {o.auto?.gstr1FiledOn && `GSTR-1 filed ${o.auto.gstr1FiledOn}. `}{o.auto?.gstr2bGeneratedOn && `GSTR-2B generated ${o.auto.gstr2bGeneratedOn}. `}
                        Fetched {when(o.portalFetchedAt ?? o.autoFetchedAt)}. Rows that differ by more than ₹1 are highlighted.
                      </p>
                    </>
                  )}
                </Step>

                <Step n={2} title="Prepare the return" done={!!draft && s !== 'draft'}>
                  {!draft ? (
                    <div className="space-y-2">
                      <p className="text-ink-soft">Fetch from the GST portal to start from GSTN’s figures, or start with blank tables.</p>
                      {editable && <Button variant="secondary" onClick={() => { setDraft(normalizeForm({})); setDirty(true); }}>Start with blank tables</Button>}
                    </div>
                  ) : (
                    <>
                      <p className="text-ink-soft">
                        {o.formSource ? `Started from ${SOURCE_LABEL[o.formSource] ?? o.formSource}` : 'Blank tables'}{o.formUpdatedAt ? `, last changed ${when(o.formUpdatedAt)}${o.formUpdatedBy ? ` by ${o.formUpdatedBy}` : ''}` : ''}.
                        {!editable && s !== 'draft' && s !== 'saved' && ' Locked: GSTN does not allow changes after the liability is set off.'}
                      </p>
                      <Gstr3bTables form={draft} onChange={editable ? (f) => { setDraft(f); setDirty(true); } : undefined} />
                      {editable && (
                        <div className="flex flex-wrap items-center gap-3">
                          <Button onClick={() => act('draft', { action: 'save_draft', form: draft }, s === 'saved' ? 'Draft saved. Save to GSTN again to update the portal.' : 'Draft saved.')} busy={busy === 'draft'} disabled={!dirty}>Save draft</Button>
                          {dirty && <span className="text-[12.5px] text-amber">Unsaved changes</span>}
                        </div>
                      )}
                    </>
                  )}
                </Step>

                {nilMode ? (
                  <Step n={3} title="File Nil GSTR-3B" done={!!o.portal.fileSubmittedAt}>
                    <p>Every table is zero here and on the GST portal, so this period can be filed as a Nil return – no save or set-off is needed.</p>
                    <FileForm o={o} nil busy={busy} act={act} pan={pan} setPan={setPan} otp={evcOtp} setOtp={setEvcOtp} verified={verifiedFor === 'nil'} setVerified={(v) => setVerifiedFor(v ? 'nil' : null)} loggedIn={!!loggedIn} />
                  </Step>
                ) : (
                  <>
                    <Step n={3} title="Save to GSTN" done={s === 'saved' || s === 'offset' || s === 'filed'}>
                      {s === 'draft' && (
                        <>
                          {(o.portal.saveErrors?.length ?? 0) > 0 && <Notice tone="error">GSTN rejected the last save: <ul className="list-disc pl-4">{o.portal.saveErrors!.map((e) => <li key={e}>{e}</li>)}</ul></Notice>}
                          <p>Saves the prepared tables to GSTN (Save GSTR-3B). GSTN then works out the tax payable.</p>
                          <Button onClick={() => act('save', { action: 'save' }, (r) => ({ tone: 'ok', text: r.reference ? `Saved to GSTN. Reference ${String(r.reference)}. Checking processing status…` : 'Saved to GSTN.' }))}
                            busy={busy === 'save'} disabled={!o.api || !loggedIn || !o.canOperate || !draft || dirty}>Save to GSTN</Button>
                          {dirty && <p className="text-[12.5px] text-ink-soft">Save the draft first.</p>}
                          {!o.canOperate && <p className="text-[12.5px] text-ink-soft">A reviewer, admin or owner saves to GSTN.</p>}
                        </>
                      )}
                      {s === 'saving' && (
                        <>
                          <p>GSTN is processing the save. Reference <span className="num">{o.portal.saveReference}</span>.</p>
                          <div className="flex flex-wrap items-center gap-3">
                            <Button onClick={() => act('check', { action: 'check_save' }, saveMsg)} busy={busy === 'check'} disabled={!loggedIn || !o.canOperate}>Check status now</Button>
                            {loggedIn && (
                              <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                                <input type="checkbox" className="h-4 w-4" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                                Check automatically every 10 s
                              </label>
                            )}
                          </div>
                        </>
                      )}
                      {(s === 'saved' || s === 'offset' || s === 'filed') && <p className="text-ink-soft">Saved on GSTN{o.portal.savedAt ? ` ${when(o.portal.savedAt)}` : ''}{o.portal.saveReference ? `, reference ${o.portal.saveReference}` : ''}.</p>}
                    </Step>

                    <Step n={4} title="Offset liability" done={s === 'offset' || s === 'filed'}>
                      {s === 'saved' && (
                        <OffsetPanel
                          rows={o.liability} ledger={o.ledger} ledgerFetchedAt={o.ledgerFetchedAt} currentItc={o.currentItc}
                          canOffset={o.canFile} disabled={!loggedIn || busy !== null} busy={busy}
                          onRefresh={() => act('refresh', { action: 'refresh_payment' }, 'Tax payable and ledger balance fetched from GSTN.')}
                          onOffset={(b) => act('offset', { action: 'offset', ...b }, (r) => ({ tone: 'ok', text: r.already ? 'GSTN shows the liability already set off.' : `${String(r.message ?? 'Liability set off.')} Review GSTN’s details and file.` }))}
                        />
                      )}
                      {(s === 'offset' || s === 'filed') && (
                        <>
                          <p className="text-ink-soft">Liability set off{o.portal.offsetAt ? ` ${when(o.portal.offsetAt)}` : ''}.</p>
                          {o.payment && <Payment p={o.payment} />}
                        </>
                      )}
                      {(s === 'draft' || s === 'saving') && <p className="text-ink-soft">Available once GSTN has saved the return.</p>}
                    </Step>

                    <Step n={5} title="File with EVC" done={s === 'filed'}>
                      {s === 'offset' && (
                        <>
                          <div className="flex flex-wrap items-center gap-3">
                            <Button variant="secondary" onClick={() => act('details', { action: 'fetch_details' }, 'Latest return details fetched from GSTN.')} busy={busy === 'details'} disabled={!loggedIn || !o.canOperate || !!o.portal.fileSubmittedAt}>Fetch GSTN details again</Button>
                            {o.portalFetchedAt && <span className="text-[12.5px] text-ink-soft">Details fetched {when(o.portalFetchedAt)}</span>}
                          </div>
                          {o.portalForm && (
                            <details className="rounded-md border border-rule bg-white p-3">
                              <summary className="cursor-pointer font-medium">GSTR-3B as GSTN will file it</summary>
                              <div className="mt-3"><Gstr3bTables form={o.portalForm} /></div>
                            </details>
                          )}
                          <FileForm o={o} nil={false} busy={busy} act={act} pan={pan} setPan={setPan} otp={evcOtp} setOtp={setEvcOtp} verified={verified} setVerified={(v) => setVerifiedFor(v ? o.portal.detailsEvidenceId ?? null : null)} loggedIn={!!loggedIn} />
                        </>
                      )}
                      {s !== 'offset' && s !== 'filed' && <p className="text-ink-soft">Available after the liability is set off.</p>}
                    </Step>
                  </>
                )}
              </ol>

              {s === 'filed' && <Notice tone="ok">GSTR-3B filed. ARN <span className="num">{o.portal.arn}</span>{o.portal.filedOn ? ` on ${new Date(o.portal.filedOn).toLocaleDateString('en-IN')}` : ''}.</Notice>}

              {o.history.length > 0 && (
                <div>
                  <button type="button" className="text-[13px] text-ink-soft hover:text-ink" onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide' : 'Show'} status history ({o.history.length})</button>
                  {showHistory && (
                    <ul className="mt-2 space-y-1 text-[12.5px] text-ink-soft">
                      {[...o.history].reverse().map((h, i) => <li key={i}>{when(h.at)} · {STATUS_LABEL[h.from as Status] ?? h.from} → {STATUS_LABEL[h.to as Status] ?? h.to}{h.note ? ` · ${h.note}` : ''}{h.byEmail ? ` · ${h.byEmail}` : ''}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Panel>

          {o.api && (
            <Panel title="GST login">
              <GstLoginPanel session={o.session} steps={o.login.steps} canOperate={o.canOperate} busy={busy} act={act} />
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

interface FileFormProps {
  o: Overview; nil: boolean; busy: string | null; act: Act; loggedIn: boolean;
  pan: string; setPan: (s: string) => void; otp: string; setOtp: (s: string) => void;
  verified: boolean; setVerified: (v: boolean) => void;
}

function FileForm({ o, nil, busy, act, loggedIn, pan, setPan, otp, setOtp, verified, setVerified }: FileFormProps) {
  if (o.portal.fileSubmittedAt) {
    return (
      <div className="space-y-2">
        <Notice tone="ok">Filing submitted to GSTN {when(o.portal.fileSubmittedAt)}{o.portal.ackNum ? `, acknowledgement ${o.portal.ackNum}` : ''}. Waiting for GSTN to list the ARN.</Notice>
        <Button onClick={() => act('arn', { action: 'fetch_arn' }, arnMsg)} busy={busy === 'arn'} disabled={!loggedIn || !o.canOperate}>Fetch ARN</Button>
      </div>
    );
  }
  if (!o.canFile) return <p className="text-ink-soft">Only an owner or admin can file the return.</p>;
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
      e.preventDefault();
      act('file', { action: 'file', pan, otp, detailsEvidenceId: o.portal.detailsEvidenceId, verified, nil }, (r) => r.found
        ? { tone: 'ok', text: `GSTR-3B filed. ARN ${String(r.arn)}.` }
        : { tone: 'ok', text: `Filing submitted to GSTN${r.ackNum ? ` (acknowledgement ${String(r.ackNum)})` : ''}. ${String(r.message ?? 'Fetch the ARN in a few minutes.')}` });
      setOtp('');
    }}>
      <label className="flex items-start gap-2 sm:col-span-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
        <span>{nil
          ? 'I confirm there are no outward or inward supplies, ITC or liability for this period and want to file a Nil GSTR-3B. Filing cannot be undone.'
          : 'I have reviewed GSTN’s GSTR-3B and payment details above and want to file GSTR-3B for this period. Filing cannot be undone.'}</span>
      </label>
      <label>Authorised signatory PAN
        <input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} required pattern="[A-Z]{5}[0-9]{4}[A-Z]" maxLength={10} autoComplete="off" spellCheck={false} className="num uppercase" />
      </label>
      <div className="flex items-end">
        <Button type="button" variant="secondary" onClick={() => act('evc', { action: 'request_evc_otp', pan, nil }, 'GSTN sent the EVC OTP to the signatory’s registered mobile and email.')} busy={busy === 'evc'} disabled={!loggedIn || pan.length !== 10 || !verified}>
          {o.portal.evcRequestedAt ? 'Send EVC OTP again' : 'Send EVC OTP'}
        </Button>
      </div>
      <label>EVC OTP
        <input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required inputMode="numeric" pattern="\d{4,8}" maxLength={8} autoComplete="one-time-code" className="num" disabled={!o.portal.evcRequestedAt} />
      </label>
      <div className="flex items-end">
        <Button type="submit" busy={busy === 'file'} disabled={!loggedIn || !verified || !o.portal.evcRequestedAt || otp.length < 4 || pan.length !== 10}>{nil ? 'File Nil GSTR-3B' : 'File GSTR-3B'}</Button>
      </div>
      {o.portal.evcRequestedAt && <p className="text-[12.5px] text-ink-soft sm:col-span-2">EVC OTP requested {when(o.portal.evcRequestedAt)}.</p>}
    </form>
  );
}

function saveMsg(r: Record<string, unknown>): { tone: 'ok' | 'error'; text: string } {
  if (r.state === 'processed') return { tone: 'ok', text: `GSTN: ${String(r.label)}. Offset the liability next.` };
  if (r.state === 'error') return { tone: 'error', text: `GSTN: ${String(r.label)}. ${((r.messages as string[] | undefined) ?? []).join(' · ')}` };
  return { tone: 'ok', text: `GSTN: ${String(r.label)}. Still processing.` };
}

function arnMsg(r: Record<string, unknown>): { tone: 'ok' | 'error'; text: string } {
  return r.found ? { tone: 'ok', text: `GSTR-3B filed. ARN ${String(r.arn)}.` } : { tone: 'ok', text: String(r.message ?? 'ARN not available yet.') };
}
