'use client';

import { useMemo, useRef, useState } from 'react';
import type { AppliedFix, JsonCheckReport, JsonIssue } from '@/engine';
import { FIX_LABELS, type FixCode } from '@/engine/json/fixLabels';
import { Button, Notice, Panel, Severity } from '@/components/ui';
import { call, inr, periodLabel } from '@/lib/client';
import { downloadCsv } from './csv';
import { describeJsonGstins, gstinsFromJson, type JsonGstins } from './gstinsFromJson';
import { FixField } from './FixField';
import { coerce, isEditable, locate } from './jsonPath';

const MAX_BYTES = 25 * 1024 * 1024;
const STAGE_TONE = {
  pass: 'bg-ledger-tint text-ledger', warn: 'bg-amber-tint text-amber', fail: 'bg-red-tint text-red-ink', skipped: 'bg-black/5 text-ink-soft',
} as const;
const STAGE_TEXT = { pass: 'Passed', warn: 'Warnings', fail: 'Failed', skipped: 'Not run' } as const;

interface Change { code: FixCode | 'EDIT'; path: string; message: string }
interface CheckResult { report: JsonCheckReport; company: { name: string; gstin: string } | null }
type Edit = (path: string, raw: string | null) => Promise<void>;

const parse = (t: string): unknown => { try { return JSON.parse(t.trim()); } catch { return undefined; } };

export function JsonValidator({ onCheckGstins }: { onCheckGstins: (gstins: string[]) => void }) {
  /** The file as loaded or pasted, and the working copy that fixes and edits change. */
  const [original, setOriginal] = useState('');
  const [text, setText] = useState('');
  const [changes, setChanges] = useState<Change[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [settings, setSettings] = useState<'auto' | 'manual'>('auto');
  const [aato, setAato] = useState(false);
  const [quarterly, setQuarterly] = useState(false);
  const [recomputeTax, setRecomputeTax] = useState(true);
  const [busy, setBusy] = useState<'validate' | 'fix' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [res, setRes] = useState<CheckResult | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opts = () => (settings === 'manual' ? { aatoAbove5Cr: aato, quarterly } : {});
  const doc = useMemo(() => parse(text), [text]);

  const reset = (t: string) => { setOriginal(t); setText(t); setChanges([]); setRes(null); };

  async function load(f: File | undefined) {
    if (!f) return;
    setErr(null);
    if (input.current) input.current.value = '';
    if (f.size > MAX_BYTES) { setErr('The file is larger than 25 MB.'); return; }
    setFileName(f.name);
    reset(await f.text());
  }

  async function validate(t = text, tax = recomputeTax) {
    setBusy('validate'); setErr(null); setNote(null);
    try { setRes(await call<CheckResult>('/api/tools/validate-json', { method: 'POST', json: { text: t, recomputeTax: tax, ...opts() } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  async function autoFix() {
    setBusy('fix'); setErr(null); setNote(null);
    try {
      const r = await call<CheckResult & { text: string; fixes: AppliedFix[] }>('/api/tools/fix-json', { method: 'POST', json: { text, recomputeTax, ...opts() } });
      setText(r.text);
      setChanges((c) => [...c, ...r.fixes]);
      setRes({ report: r.report, company: r.company });
      setNote(r.fixes.length
        ? `${r.fixes.length} change${r.fixes.length === 1 ? '' : 's'} made and the file checked again.${r.report.issues.length ? ' What is left needs your decision – use Fix on each finding below.' : ''}`
        : 'Nothing could be changed automatically. The remaining findings need your decision – use Fix on each one below.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /** A value typed in a finding's Fix box; raw === null removes the field. Re-checks the file afterwards. */
  const edit: Edit = async (path, raw) => {
    const d = parse(text);
    const at = d !== undefined ? locate(d, path) : null;
    if (!at || Array.isArray(at.parent)) { setErr(`Cannot edit ${path}`); return; }
    const parent = at.parent as Record<string, unknown>;
    const key = String(at.key);
    const before = at.value;
    if (raw === null) delete parent[key];
    else parent[key] = coerce(key, before, raw);
    const next = JSON.stringify(d);
    setText(next);
    setChanges((c) => [...c, { code: 'EDIT', path, message: raw === null ? `Removed (was ${JSON.stringify(before)})` : `${JSON.stringify(before ?? null)} → ${JSON.stringify(parent[key])}` }]);
    await validate(next);
  };

  function undo() { setText(original); setChanges([]); validate(original); }

  function download() {
    const h = res?.report.header;
    const name = fileName ? `${fileName.replace(/(-fixed)?\.json$/i, '')}-fixed.json` : `GSTR1_${h?.gstin ?? 'file'}_${h?.fp ?? ''}-fixed.json`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  }

  const changed = text !== original;
  const errors = res ? res.report.stages.reduce((a, s) => a + s.errors, 0) : 0;
  const fixable = res?.report.autoFixable ?? 0;
  const needYou = res ? res.report.issues.filter((i) => !i.autoFix).length : 0;

  return (
    <div className="space-y-6">
      <Panel title="Validate a GSTR-1 JSON" action={<span className="hidden text-ink-soft sm:inline">From this app, the offline tool, Tally or any ERP</span>}>
        <div className="mb-4 flex gap-2 text-[13px]">
          {(['file', 'paste'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
              className={`rounded-md border px-3 py-1.5 ${mode === m ? 'border-ledger bg-ledger-tint font-medium text-ledger' : 'border-rule bg-white text-ink-soft hover:text-ink'}`}>
              {m === 'file' ? 'Upload file' : 'Paste JSON'}
            </button>
          ))}
        </div>

        {mode === 'file' ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]); }}
            className={`rounded-lg border-2 border-dashed px-6 py-8 text-center ${drag ? 'border-ledger bg-ledger-tint' : 'border-rule bg-white/60'}`}
          >
            <p className="font-medium">{fileName ?? 'Drop the .json file here'}</p>
            <p className="mt-1 text-ink-soft">{fileName ? `${(text.length / 1024).toFixed(1)} KB loaded${changed ? ' · changed' : ''}` : 'or'}</p>
            <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => load(e.target.files?.[0])} />
            <Button variant="secondary" className="mt-3" onClick={() => input.current?.click()}>{fileName ? 'Choose another file' : 'Choose file'}</Button>
          </div>
        ) : (
          <textarea value={text} onChange={(e) => { setFileName(null); reset(e.target.value); }} rows={10} spellCheck={false}
            placeholder='{"gstin": "29ABCDE1234F1Z5", "fp": "062025", "version": "GST3.2.2", "hash": "hash", "b2b": [...]}' className="num text-[12.5px]" />
        )}

        <fieldset className="mt-5 grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
          <legend className="mb-2 text-[12.5px] font-semibold text-ink-soft">Turnover band and filing frequency</legend>
          <div className="flex flex-col gap-2 text-[13.5px]">
            <label className="flex items-center gap-2 text-ink"><input type="radio" className="w-auto" checked={settings === 'auto'} onChange={() => setSettings('auto')} />From the company with this GSTIN</label>
            <label className="flex items-center gap-2 text-ink"><input type="radio" className="w-auto" checked={settings === 'manual'} onChange={() => setSettings('manual')} />Set manually</label>
          </div>
          {settings === 'manual' ? (
            <div className="flex flex-col gap-2 text-[13.5px] sm:pl-6">
              <label className="flex items-center gap-2 text-ink"><input type="checkbox" className="w-auto" checked={aato} onChange={(e) => setAato(e.target.checked)} />Turnover above ₹5 crore (6-digit HSN for B2B)</label>
              <label className="flex items-center gap-2 text-ink"><input type="checkbox" className="w-auto" checked={quarterly} onChange={(e) => setQuarterly(e.target.checked)} />Quarterly filer (QRMP)</label>
            </div>
          ) : (
            <p className="text-[13px] text-ink-soft sm:pl-6">If the GSTIN isn&apos;t one of your companies, the check assumes turnover up to ₹5 crore and monthly filing.</p>
          )}
        </fieldset>

        {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
        <div className="mt-5"><Button onClick={() => validate()} busy={busy === 'validate'} disabled={!text.trim() || !!busy}>Validate JSON</Button></div>
      </Panel>

      {res && (res.report.issues.length > 0 || changed) && (
        <Panel title="Fix and download" action={changed && <span className="text-ink-soft">{changes.length} change{changes.length === 1 ? '' : 's'} made</span>}>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={autoFix} busy={busy === 'fix'} disabled={!!busy || doc === undefined || fixable === 0}>
              {fixable ? `Fix automatically (${fixable} change${fixable === 1 ? '' : 's'})` : 'Fix automatically'}
            </Button>
            <Button variant={errors ? 'secondary' : 'primary'} onClick={download} disabled={!changed || !!busy}>
              {errors ? `Download fixed JSON (${errors} error${errors === 1 ? '' : 's'} left)` : 'Download fixed JSON'}
            </Button>
            {changed && <Button variant="ghost" onClick={undo} disabled={!!busy}>Undo all changes</Button>}
          </div>
          <label className="mt-3 flex items-center gap-2 text-[13.5px] text-ink"><input type="checkbox" className="w-auto" checked={recomputeTax} onChange={(e) => { setRecomputeTax(e.target.checked); validate(text, e.target.checked); }} disabled={!!busy} />Recalculate IGST/CGST/SGST where the tax head is wrong or the amount is off by more than ₹1</label>
          <p className="mt-2 text-[12.5px] text-ink-soft">
            Fixed automatically: formats (case, dates, POS, numbers stored as text), rounding, format version, sply_ty, tax heads and amounts,
            items with the same rate, repeated GSTIN/POS groups, duplicate B2CS/advance lines, item and row numbers, SAC UQC, net issued and unknown fields.
            Anything that needs your judgement (a wrong GSTIN, invoice number, date or rate) has a <strong>Fix</strong> button in the findings below. The file is checked again after every change.
          </p>
          {note && <div className="mt-4"><Notice tone="info">{note}</Notice></div>}
          {!note && fixable === 0 && needYou > 0 && (
            <div className="mt-4"><Notice tone="warn">
              None of the {needYou} finding{needYou === 1 ? '' : 's'} can be fixed automatically – {needYou === 1 ? 'it needs' : 'they need'} your decision
              (for example the correct HSN, unit or GSTIN). Click <strong>Fix</strong> on each finding below, then download.
            </Notice></div>
          )}
          {changes.length > 0 && <ChangeList changes={changes} />}
        </Panel>
      )}

      {res && <Report report={res.report} company={res.company} name={fileName} gstins={doc === undefined ? null : gstinsFromJson(doc)}
        onCheckGstins={onCheckGstins} doc={doc} onEdit={edit} busy={!!busy} />}
    </div>
  );
}

function ChangeList({ changes }: { changes: Change[] }) {
  const [open, setOpen] = useState(false);
  const groups = Object.entries(changes.reduce<Record<string, number>>((a, c) => ({ ...a, [c.code]: (a[c.code] ?? 0) + 1 }), {}));
  return (
    <div className="mt-4 rounded-md border border-rule bg-white">
      <ul className="divide-y divide-rule">
        {groups.map(([code, n]) => (
          <li key={code} className="flex justify-between gap-3 px-4 py-2"><span>{code === 'EDIT' ? 'Edited by you' : FIX_LABELS[code as FixCode]}</span><span className="num text-ink-soft">{n}</span></li>
        ))}
      </ul>
      <button className="w-full border-t border-rule px-4 py-2 text-left text-[12.5px] text-ledger underline" onClick={() => setOpen(!open)}>{open ? 'Hide each change' : 'Show each change'}</button>
      {open && (
        <div className="max-h-[360px] overflow-auto border-t border-rule">
          <table className="ledger">
            <thead><tr><th>Where in the JSON</th><th>Change</th></tr></thead>
            <tbody>{changes.slice(0, 2000).map((c, i) => <tr key={i}><td className="num max-w-[320px] break-all text-[12px]">{c.path}</td><td>{c.message}</td></tr>)}</tbody>
          </table>
          {changes.length > 2000 && <p className="px-4 py-2 text-ink-soft">Showing 2000 of {changes.length}.</p>}
        </div>
      )}
    </div>
  );
}

function Report({ report: r, company, name, gstins, onCheckGstins, doc, onEdit, busy }: {
  report: JsonCheckReport; company: { name: string; gstin: string } | null; name: string | null;
  gstins: JsonGstins | null; onCheckGstins: (gstins: string[]) => void; doc: unknown; onEdit: Edit; busy: boolean;
}) {
  const [sev, setSev] = useState<'' | 'error' | 'warning'>('');
  const [stage, setStage] = useState('');
  const [q, setQ] = useState('');
  const errors = r.stages.reduce((a, s) => a + s.errors, 0);
  const warnings = r.stages.reduce((a, s) => a + s.warnings, 0);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return r.issues.filter((i) => (!sev || i.severity === sev) && (!stage || i.stage === stage)
      && (!needle || `${i.path} ${i.message} ${i.documentNo ?? ''} ${i.code}`.toLowerCase().includes(needle)));
  }, [r.issues, sev, stage, q]);
  const h = r.header;
  const totals = Object.entries(r.sections).filter(([k]) => k !== 'hsn');

  const exportCsv = () => downloadCsv(`gstr1-json-check${h.gstin ? `-${h.gstin}` : ''}${h.fp ? `-${h.fp}` : ''}.csv`,
    ['Severity', 'Check', 'Code', 'Section', 'Document', 'JSON path', 'Message', 'Suggestion', 'Value'],
    r.issues.map((i) => [i.severity, i.stage, i.code, i.section ?? '', i.documentNo ?? '', i.path, i.message, i.suggestion ?? '', i.value]));

  return (
    <div className="space-y-6">
      <Notice tone={r.ok ? (warnings ? 'warn' : 'ok') : 'error'}>
        <p className="font-semibold">
          {r.ok ? (warnings ? `No errors – ${warnings} warning${warnings === 1 ? '' : 's'} to review before upload` : 'No errors or warnings – the file is ready to upload')
            : `${errors} error${errors === 1 ? '' : 's'} must be fixed before upload${warnings ? `, plus ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`}
        </p>
        {name && <p className="mt-0.5 opacity-80">{name}</p>}
      </Notice>

      {gstins && gstins.all.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule bg-sheet px-5 py-3">
          <p>This file has <strong>{gstins.all.length}</strong> GSTIN{gstins.all.length === 1 ? '' : 's'} ({describeJsonGstins(gstins)}). The format checks above can&apos;t tell whether they are active on GSTN.</p>
          <Button variant="secondary" onClick={() => onCheckGstins(gstins.all)}>Verify these GSTINs</Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="File">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <div><dt className="text-ink-soft">Supplier GSTIN</dt><dd className="num">{h.gstin ?? '—'}</dd></div>
            <div><dt className="text-ink-soft">Return period</dt><dd>{h.fp && /^\d{6}$/.test(h.fp) ? `${periodLabel(h.fp)} (${h.fp})` : h.fp ?? '—'}</dd></div>
            <div><dt className="text-ink-soft">Format version</dt><dd className="num">{h.version ?? '—'}{h.expectedVersion && h.version !== h.expectedVersion && <span className="block text-[12px] text-amber">expected {h.expectedVersion}</span>}</dd></div>
            <div><dt className="text-ink-soft">Checked as</dt><dd>{h.aatoAbove5Cr ? 'Turnover > ₹5 cr' : 'Turnover ≤ ₹5 cr'} · {h.quarterly ? 'Quarterly' : 'Monthly'}</dd></div>
            <div className="col-span-2"><dt className="text-ink-soft">Company</dt><dd>{company ? `${company.name} – settings taken from this company` : 'Not one of your companies'}</dd></div>
          </dl>
        </Panel>
        <Panel title="Checks">
          <ol className="space-y-2">
            {r.stages.map((s, i) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="num mr-2 text-ink-soft">{i + 1}.</span>{s.label}{s.note && <span className="block pl-6 text-[12px] text-ink-soft">{s.note}</span>}</span>
                <span className={`rounded px-2 py-0.5 text-[12px] font-medium ${STAGE_TONE[s.status]}`}>
                  {STAGE_TEXT[s.status]}{s.errors ? ` · ${s.errors} err` : ''}{s.warnings ? ` · ${s.warnings} warn` : ''}
                </span>
              </li>
            ))}
          </ol>
          {r.unsupported.length > 0 && <p className="mt-3 text-[12.5px] text-amber">Present but not checked here: {r.unsupported.join(', ')}. The portal still validates them.</p>}
        </Panel>
      </div>

      {totals.length > 0 && (
        <Panel title="Section totals (as read from the JSON)">
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Section</th><th className="text-right">Documents / lines</th><th className="text-right">Taxable value</th><th className="text-right">Tax incl. cess</th></tr></thead>
              <tbody>
                {Object.entries(r.sections).map(([k, s]) => <tr key={k}><td className="num">{k}</td><td className="num text-right">{s.documents}</td><td className="num text-right">{inr(s.taxableValue)}</td><td className="num text-right">{inr(s.tax)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title={`${r.issues.length + r.truncated} finding${r.issues.length + r.truncated === 1 ? '' : 's'}`} action={r.issues.length > 0 && <Button variant="secondary" onClick={exportCsv}>Download CSV</Button>}>
        {r.issues.length === 0 ? <p className="text-ink-soft">Nothing to report.</p> : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <label>Severity<select value={sev} onChange={(e) => setSev(e.target.value as typeof sev)}><option value="">All</option><option value="error">Errors</option><option value="warning">Warnings</option></select></label>
              <label>Check<select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All checks</option>{r.stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
              <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice no., path, message…" /></label>
            </div>
            {r.truncated > 0 && <div className="mb-3"><Notice tone="warn">Showing the first {r.issues.length}; {r.truncated} more were found. Fix these and validate again.</Notice></div>}
            <div className="-mx-5 overflow-x-auto">
              <table className="ledger">
                <thead><tr><th>Severity</th><th>Document</th><th>Where in the JSON</th><th>Problem</th><th /></tr></thead>
                <tbody>
                  {shown.slice(0, 500).map((i, k) => <IssueRow key={`${i.code}|${i.path}|${k}`} i={i} fp={h.fp} doc={doc} onEdit={onEdit} busy={busy} />)}
                </tbody>
              </table>
            </div>
            {shown.length > 500 && <p className="mt-3 text-ink-soft">Showing 500 of {shown.length}. Narrow the filter or download the CSV.</p>}
          </>
        )}
      </Panel>
    </div>
  );
}

function IssueRow({ i, fp, doc, onEdit, busy }: { i: JsonIssue; fp?: string; doc: unknown; onEdit: Edit; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const editable = doc !== undefined && i.stage !== 'parse' && isEditable(doc, i.path);
  const current = editable ? locate(doc, i.path)?.value : undefined;
  const [value, setValue] = useState('');
  const open = () => { setValue(current == null ? '' : String(current)); setEditing(true); };
  const apply = async (raw: string | null) => { await onEdit(i.path, raw); setEditing(false); };

  return (
    <>
      <tr className={i.severity === 'error' ? 'row-error' : ''}>
        <td><Severity s={i.severity} />{i.autoFix && <span className="mt-1 block w-fit rounded bg-ledger-tint px-1.5 py-0.5 text-[11.5px] font-medium text-ledger" title="Fix automatically will correct this">Auto-fix</span>}</td>
        <td className="num whitespace-nowrap">{i.documentNo ?? '—'}{i.section && <span className="block text-[12px] text-ink-soft">{i.section}</span>}</td>
        <td className="num max-w-[280px] break-all text-[12px]">{i.path}</td>
        <td>
          {i.message}
          {i.value !== undefined && i.value !== null && i.value !== '' && <span className="num ml-1 text-[12px] text-ink-soft">({typeof i.value === 'object' ? JSON.stringify(i.value) : String(i.value)})</span>}
          {i.suggestion && <span className="block text-[12.5px] text-ledger">{i.suggestion}</span>}
        </td>
        <td>{editable && !editing && <Button variant="ghost" onClick={open} disabled={busy}>Fix</Button>}</td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5} className="bg-paper">
            <form className="flex flex-wrap items-end gap-3 py-1" onSubmit={(e) => { e.preventDefault(); apply(value); }}>
              <label className="min-w-[220px] flex-1">New value for <span className="num">{i.path.split('.').pop()}</span>
                <FixField field={i.path.split('.').pop() ?? ''} section={i.section} fp={fp} value={value} onChange={setValue} />
              </label>
              <Button type="submit" busy={busy}>Apply and re-check</Button>
              {current !== undefined && <Button type="button" variant="danger" onClick={() => apply(null)} disabled={busy}>Remove field</Button>}
              <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
