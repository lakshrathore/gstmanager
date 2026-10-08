'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { AnnualTables } from '@/components/annual/AnnualTables';
import { call, inr } from '@/lib/client';
import { profileForPeriod } from '@/engine/config/versions';
import { fyChoices, fyInfo, isBlank, resolve, type AnnualForm, type Issue } from '@/server/gst/annual/common';
import { GSTR9_TABLES, normalizeGstr9, validateGstr9 } from '@/server/gst/annual/gstr9';
import { GSTR9C_TABLES, normalizeGstr9c, validateGstr9c, type Gstr9Figures } from '@/server/gst/annual/gstr9c';

/**
 * GSTR-9 / GSTR-9C for a company and financial year: fill (from the app's data, Excel/JSON, or by
 * hand) → check → download for the GST portal → record the ARN. Validation runs as you type, with
 * the same rules the server applies before a portal JSON is downloaded.
 */

type Kind = 'gstr9' | 'gstr9c';
interface Company { _id: string; name: string; gstin: string }
interface Overview {
  kind: Kind; fy: string;
  company: Company & { aatoAbove5Cr: boolean };
  status: 'draft' | 'filed';
  form: AnnualForm | null; formSource: string | null; formUpdatedAt: string | null; formUpdatedBy: string | null;
  notes: string[];
  filed: { arn: string; filedOn: string; recordedBy?: string } | null;
  history: { at: string; from: string; to: string; note?: string; byEmail?: string }[];
  canEdit: boolean; canFile: boolean;
  gstr9: (Gstr9Figures & { status: string }) | null;
  sources: { gstr1: string[]; gstr3b: string[] } | null;
}

const CFG = {
  gstr9: {
    name: 'GSTR-9', defs: GSTR9_TABLES, normalize: normalizeGstr9,
    intro: 'Annual return for regular taxpayers. Fill it from the GSTR-1 and GSTR-3B data in this app, import the Excel template or GSTN’s GSTR-9 JSON, or enter the tables.',
    fill: 'Fill from GSTR-1 & GSTR-3B',
  },
  gstr9c: {
    name: 'GSTR-9C', defs: GSTR9C_TABLES, normalize: normalizeGstr9c,
    intro: 'Self-certified reconciliation of the audited financial statements with GSTR-9 (required when aggregate turnover is above ₹5 crore). The “as per annual return” figures come from this year’s GSTR-9.',
    fill: 'Fill from GSTR-9',
  },
} as const;
const SOURCE_LABEL: Record<string, string> = { auto: 'auto-fill', manual: 'your edits', excel: 'an Excel import', json: 'a JSON import' };
const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Annual returns are due after the year ends: default to the last completed year. */
const defaultFy = () => fyChoices()[1] ?? fyChoices()[0];

function Summary({ kind, form }: { kind: Kind; form: AnnualForm }) {
  const r = resolve(CFG[kind].defs, form);
  const tax = (code: string) => (r[code] ? ['iamt', 'camt', 'samt', 'csamt'].reduce((a, k) => a + (r[code][k] ?? 0), 0) : 0);
  const lines: [string, number][] = kind === 'gstr9'
    ? [['Total turnover (5N)', r['5N'].txval], ['Taxable value on which tax is payable (4N)', r['4N'].txval], ['Tax on 4N', tax('4N')],
      ['ITC availed (6O)', tax('6O')], ['ITC reversed (7I)', tax('7I')], ['Net ITC (7J)', tax('7J')], ['ITC to lapse (8K)', tax('8K')]]
    : [['Turnover after adjustments (5P)', r['5P'].amt], ['Un-reconciled turnover (5R)', r['5R'].amt], ['Un-reconciled taxable turnover (7G)', r['7G'].amt],
      ['Un-reconciled payment (9R)', tax('9R')], ['Un-reconciled ITC (12F)', r['12F'].amt]];
  return (
    <table className="ledger">
      <tbody>{lines.map(([l, v]) => <tr key={l}><td>{l}</td><td className={`num text-right ${kind === 'gstr9c' && l.startsWith('Un-') && Math.abs(v) > 1 ? 'text-red-ink' : ''}`}>{inr(v)}</td></tr>)}</tbody>
    </table>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? issues : issues.slice(0, 12);
  return (
    <div className="space-y-1">
      <ul className="space-y-1">
        {shown.map((i, n) => (
          <li key={n} className="flex gap-2">
            <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[11.5px] font-medium ${i.severity === 'error' ? 'bg-red-tint text-red-ink' : 'bg-amber-tint text-amber'}`}>{i.severity === 'error' ? 'Error' : 'Warning'}</span>
            <a href={`#table-${i.table}`} onClick={() => { const d = document.getElementById(`table-${i.table}`) as HTMLDetailsElement | null; if (d) d.open = true; }} className="hover:underline">{i.message}</a>
          </li>
        ))}
      </ul>
      {issues.length > 12 && <button type="button" className="text-[13px] text-ledger hover:underline" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${issues.length}`}</button>}
    </div>
  );
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

export function AnnualPage({ kind }: { kind: Kind }) {
  const cfg = CFG[kind];
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fy, setFy] = useState(defaultFy());
  const [o, setO] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<AnnualForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [arn, setArn] = useState('');
  const [filedOn, setFiledOn] = useState(new Date().toISOString().slice(0, 10));
  const [showHistory, setShowHistory] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => { setCompanies(r.companies); if (r.companies[0]) setCompanyId(r.companies[0]._id); }).catch((e) => setMsg({ tone: 'error', text: e.message }));
  }, []);

  const q = `kind=${kind}&companyId=${companyId}&fy=${fy}`;
  const load = useCallback(() => (companyId
    ? call<Overview>(`/api/annual?${q}`).then((r) => { setO(r); setDraft(r.form); setDirty(false); }).catch((e) => setMsg({ tone: 'error', text: e.message }))
    : Promise.resolve()), [companyId, q]);
  useEffect(() => { load(); }, [load]);
  const pick = (c: string, y: string) => {
    if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
    setO(null); setMsg(null); setImportIssues([]); setCompanyId(c); setFy(y);
  };

  const act = useCallback(async (key: string, body: Record<string, unknown>, ok: string | ((r: Record<string, unknown>) => string)) => {
    setBusy(key); setMsg(null);
    try {
      const r = await call<Record<string, unknown>>('/api/annual', { method: 'POST', json: { kind, companyId, fy, ...body } });
      setMsg({ tone: 'ok', text: typeof ok === 'string' ? ok : ok(r ?? {}) });
      await load();
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }, [kind, companyId, fy, load]);

  const issues = useMemo(() => {
    if (!draft || !o) return [];
    return kind === 'gstr9' ? validateGstr9(draft, { fy, aatoAbove5Cr: o.company.aatoAbove5Cr }) : validateGstr9c(draft, { fy, gstr9: o.gstr9 });
  }, [draft, o, kind, fy]);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const rates = useMemo(() => profileForPeriod(fyInfo(fy)?.fp ?? '032026').allowedRates, [fy]);

  const editable = !!o && o.canEdit && o.status === 'draft';
  const blank = !draft || isBlank(draft);

  async function importFile(file: File) {
    if (fileInput.current) fileInput.current.value = '';
    if ((!blank && !confirm(`Replace the prepared ${cfg.name} with ${file.name}?`)) || (dirty && !confirm('You have unsaved changes. Discard them?'))) return;
    const fd = new FormData();
    fd.append('kind', kind); fd.append('companyId', companyId); fd.append('fy', fy); fd.append('file', file);
    setBusy('import'); setMsg(null); setImportIssues([]);
    try {
      const r = await call<{ read: Record<string, number>; issues: string[] }>('/api/annual/file', { method: 'POST', body: fd });
      const parts = Object.entries(r.read).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'rows' ? 'table row(s)' : k === 'listRows' ? 'list row(s)' : k === 'text' ? 'reason(s)' : 'table part(s)'}`);
      setMsg({ tone: 'ok', text: `Imported ${file.name}: ${parts.join(', ')}. Review the tables below.` });
      setImportIssues(r.issues);
      await load();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function autofill() {
    if (!blank && !confirm(kind === 'gstr9' ? 'Replace the prepared GSTR-9 with figures from GSTR-1 and GSTR-3B?' : 'Replace the “as per annual return” figures with those of GSTR-9?')) return;
    if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
    await act('fill', { action: 'autofill' }, 'Filled. Check the notes and complete the tables the data could not fill.');
    setImportIssues([]);
  }

  const file = (format: 'json' | 'xlsx') => `/api/annual/file?${q}&format=${format}`;
  const fileButtons = o && (
    <div className="flex flex-wrap items-center gap-3">
      {editable && (
        <>
          <Button onClick={autofill} busy={busy === 'fill'} disabled={busy !== null || (kind === 'gstr9c' && !o.gstr9)}>{cfg.fill}</Button>
          <input ref={fileInput} type="file" accept=".xlsx,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <Button variant="secondary" onClick={() => fileInput.current?.click()} busy={busy === 'import'} disabled={busy !== null}>Import Excel or JSON</Button>
          {blank && <Button variant="ghost" onClick={() => { setDraft(cfg.normalize({})); setDirty(true); }}>Start with blank tables</Button>}
        </>
      )}
      <a className="text-[13px] text-ledger underline" href={file('xlsx')}>{blank ? 'Download Excel template' : 'Download these tables as Excel'}</a>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">{cfg.name}</h1>
          {o && <p className="text-ink-soft">{o.company.name} · {o.company.gstin} · FY {fy} · <span className="font-medium text-ink">{o.status === 'filed' ? 'Filed' : 'Draft'}</span></p>}
        </div>
        <div className="flex flex-wrap gap-3">
          <label>Company
            <select value={companyId} onChange={(e) => pick(e.target.value, fy)} className="min-w-56">
              {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
            </select>
          </label>
          <label>Financial year
            <select value={fy} onChange={(e) => pick(companyId, e.target.value)}>
              {fyChoices().map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        </div>
      </div>

      {msg && <Notice tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Notice>}
      {!companies.length && <Empty title="Add a company first">{cfg.name} is prepared per company (GSTIN) and financial year.</Empty>}

      {o && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Panel title={`Prepare ${cfg.name}`}>
            <ol className="space-y-6">
              <Step n={1} title="Fill the return" done={!blank && !dirty}>
                <p className="text-ink-soft">{cfg.intro}</p>
                {kind === 'gstr9' && o.sources && (
                  <p className="text-[12.5px] text-ink-soft">
                    In this app for FY {fy}: GSTR-1 for {o.sources.gstr1.length} period(s), GSTR-3B for {o.sources.gstr3b.length} month(s).
                  </p>
                )}
                {kind === 'gstr9c' && !o.gstr9 && <Notice tone="warn">There is no GSTR-9 for FY {fy} here yet. Prepare GSTR-9 first to fill and check the “as per annual return” figures, or enter them yourself.</Notice>}
                {fileButtons}
                {o.notes.length > 0 && <Notice tone="warn"><ul className="list-disc space-y-1 pl-4">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul></Notice>}
                {importIssues.length > 0 && <Notice tone="warn">Check these lines of the file:<ul className="list-disc space-y-1 pl-4">{importIssues.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
                {draft && (
                  <p className="text-[12.5px] text-ink-soft">
                    {o.formSource ? `From ${SOURCE_LABEL[o.formSource] ?? o.formSource}` : 'Blank tables'}{o.formUpdatedAt ? `, last changed ${when(o.formUpdatedAt)}${o.formUpdatedBy ? ` by ${o.formUpdatedBy}` : ''}` : ''}.
                    {o.status === 'filed' && ' Locked: marked as filed.'}
                  </p>
                )}
              </Step>

              <Step n={2} title="Check and complete the tables" done={!blank && !errors.length && !dirty}>
                {!draft ? <p className="text-ink-soft">Fill the return first.</p> : (
                  <>
                    {issues.length > 0
                      ? <IssueList issues={[...errors, ...warnings]} />
                      : <Notice tone="ok">No errors or warnings.</Notice>}
                    <AnnualTables defs={cfg.defs} form={draft} issues={issues} rates={rates} onChange={editable ? (f) => { setDraft(f); setDirty(true); } : undefined} />
                    {editable && (
                      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 border-t border-rule bg-sheet px-5 py-3">
                        <Button onClick={async () => { if (await act('save', { action: 'save_draft', form: draft }, (r) => `Draft saved. ${Number(r.errors) ? `${String(r.errors)} error(s) to fix.` : 'No errors.'}`)) setDirty(false); }} busy={busy === 'save'} disabled={!dirty}>Save draft</Button>
                        {dirty && <span className="text-[12.5px] text-amber">Unsaved changes</span>}
                        <span className="ml-auto text-[12.5px] text-ink-soft">{errors.length} error(s), {warnings.length} warning(s)</span>
                      </div>
                    )}
                  </>
                )}
              </Step>

              <Step n={3} title="Download for the GST portal">
                {kind === 'gstr9' ? (
                  <>
                    <p className="text-ink-soft">The JSON is GSTN’s GSTR-9 format: upload it on the portal under Annual Return → GSTR-9 → Prepare offline → Upload, then preview and file with DSC or EVC.</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={file('json')} aria-disabled={blank || errors.length > 0 || dirty} className={`inline-flex rounded-md px-3.5 py-2 text-[13.5px] font-medium ${blank || errors.length || dirty ? 'pointer-events-none bg-ledger/50 text-white' : 'bg-ledger text-white hover:bg-[#0a5a4d]'}`}>Download GSTR-9 JSON</a>
                      <a href={file('xlsx')} className="text-[13px] text-ledger underline">Download Excel</a>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-ink-soft">GSTN accepts GSTR-9C only as JSON made by its GSTR-9C offline tool. Download the Excel (laid out like the form) to key the figures into the tool, generate the JSON there and upload it on the portal. The JSON here is a backup you can import into this app again.</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={file('xlsx')} aria-disabled={blank || dirty} className={`inline-flex rounded-md px-3.5 py-2 text-[13.5px] font-medium ${blank || dirty ? 'pointer-events-none bg-ledger/50 text-white' : 'bg-ledger text-white hover:bg-[#0a5a4d]'}`}>Download GSTR-9C Excel</a>
                      <a href={file('json')} className="text-[13px] text-ledger underline">Download JSON backup</a>
                    </div>
                  </>
                )}
                {dirty && <p className="text-[12.5px] text-ink-soft">Save the draft first – downloads use the saved return.</p>}
                {kind === 'gstr9' && errors.length > 0 && !dirty && <p className="text-[12.5px] text-red-ink">Fix the {errors.length} error(s) above to download the JSON.</p>}
              </Step>

              <Step n={4} title="Record the filing" done={o.status === 'filed'}>
                {o.status === 'filed' && o.filed ? (
                  <div className="space-y-2">
                    <Notice tone="ok">{cfg.name} filed on {new Date(o.filed.filedOn).toLocaleDateString('en-IN')}, ARN <span className="num">{o.filed.arn}</span>{o.filed.recordedBy ? ` (recorded by ${o.filed.recordedBy})` : ''}.</Notice>
                    {o.canFile && (
                      <Button variant="ghost" onClick={() => { const reason = prompt('Why reopen this return? (e.g. ARN entered wrongly)'); if (reason && reason.trim().length >= 3) act('reopen', { action: 'reopen', reason: reason.trim() }, 'Reopened as a draft.'); }} disabled={busy !== null}>Reopen</Button>
                    )}
                  </div>
                ) : !o.canFile ? <p className="text-ink-soft">An owner or admin records the ARN once the return is filed on the portal.</p> : (
                  <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]" onSubmit={(e) => { e.preventDefault(); act('filed', { action: 'mark_filed', arn, filedOn }, `${cfg.name} marked as filed.`).then((ok) => ok && setArn('')); }}>
                    <label>ARN from the GST portal
                      <input value={arn} onChange={(e) => setArn(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} required minLength={10} maxLength={20} className="num" spellCheck={false} />
                    </label>
                    <label>Filed on
                      <input type="date" value={filedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setFiledOn(e.target.value)} required />
                    </label>
                    <div className="flex items-end"><Button type="submit" busy={busy === 'filed'} disabled={blank || dirty || arn.length < 10}>Mark as filed</Button></div>
                  </form>
                )}
              </Step>
            </ol>

            {o.history.length > 0 && (
              <div className="mt-4">
                <button type="button" className="text-[13px] text-ink-soft hover:text-ink" onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide' : 'Show'} status history ({o.history.length})</button>
                {showHistory && (
                  <ul className="mt-2 space-y-1 text-[12.5px] text-ink-soft">
                    {[...o.history].reverse().map((h, i) => <li key={i}>{when(h.at)} · {h.from} → {h.to}{h.note ? ` · ${h.note}` : ''}{h.byEmail ? ` · ${h.byEmail}` : ''}</li>)}
                  </ul>
                )}
              </div>
            )}
          </Panel>

          <div className="space-y-6">
            {draft && <Panel title="Key figures"><div className="-mx-5 -my-5"><Summary kind={kind} form={draft} /></div></Panel>}
            {kind === 'gstr9c' && o.gstr9 && (
              <Panel title={`GSTR-9 for ${fy}`}>
                <dl className="space-y-1 text-[13px]">
                  <div className="flex justify-between gap-2"><dt className="text-ink-soft">Status</dt><dd>{o.gstr9.status === 'filed' ? 'Filed' : 'Draft'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-soft">Total turnover (5N)</dt><dd className="num">{inr(o.gstr9.turnover)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-soft">Taxable turnover</dt><dd className="num">{inr(o.gstr9.taxableTurnover)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-soft">Net ITC (7J)</dt><dd className="num">{inr(o.gstr9.netItc)}</dd></div>
                </dl>
                {o.gstr9.status !== 'filed' && <p className="mt-2 text-[12.5px] text-ink-soft">GSTR-9C is filed after GSTR-9.</p>}
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
