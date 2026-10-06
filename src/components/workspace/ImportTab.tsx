'use client';

import { useRef, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';
import { DATA_LOCKED, STATUS_LABELS, type ReturnStatus } from '@/server/gst/gst-status/statuses';
import { MarketplaceImport } from './MarketplaceImport';
import { SECTION_LABELS, type ReturnDetail } from './types';

export function ImportTab({ d, onDone }: { d: ReturnDetail; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; details?: unknown } | null>(null);
  const [drag, setDrag] = useState(false);
  const info = d.return.importInfo;
  const locked = DATA_LOCKED.has(d.return.status as ReturnStatus);

  async function upload() {
    if (!file) return;
    if (info && !confirm(`Replace the records imported from ${info.fileName}? Changes made to those records in the app will be lost. Manual entries and marketplace imports are kept.`)) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    try { await call(`/api/returns/${d.return._id}/import`, { method: 'POST', body: fd }); setFile(null); onDone(); }
    catch (e) { setErr({ msg: (e as Error).message, details: (e as { details?: unknown }).details }); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <Panel title={info ? 'Re-import Excel' : 'Import GSTR-1 Excel'}>
        {locked ? <Notice tone="warn">This return is “{STATUS_LABELS[d.return.status as ReturnStatus]}”. Import is locked to protect the file that went to the GST portal.</Notice> : (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); setFile(e.dataTransfer.files[0] ?? null); }}
              className={`grid place-items-center rounded-lg border-2 border-dashed px-6 py-12 text-center ${drag ? 'border-ledger bg-ledger-tint' : 'border-rule'}`}
            >
              <p className="font-semibold">{file ? file.name : 'Drop the offline-tool Excel file here'}</p>
              <p className="mt-1 text-ink-soft">{file ? `${(file.size / 1024).toFixed(0)} KB` : 'GSTR-1 Excel workbook template (.xlsx), any number of sheets'}</p>
              <input ref={input} type="file" accept=".xlsx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <div className="mt-4 flex gap-2">
                <Button variant="secondary" onClick={() => input.current?.click()}>Choose file</Button>
                <Button onClick={upload} busy={busy} disabled={!file}>Import and validate</Button>
              </div>
            </div>
            {err && <div className="mt-4"><Notice tone="error">{err.msg}{Array.isArray(err.details) && <ul className="mt-2 list-disc pl-5">{(err.details as { sheet: string; reason: string }[]).map((s) => <li key={s.sheet}>{s.sheet}: {s.reason}</li>)}</ul>}</Notice></div>}
            <p className="mt-4 text-ink-soft">
              Sheets read: b2b,sez,de · b2cl · b2cs · cdnr · cdnur · exp · at · atadj · exemp · hsn(b2b) · hsn(b2c) · docs.
              Column order doesn’t matter; the header row is detected automatically. Taxes are computed from rate × taxable value unless your file has tax-amount columns.
            </p>
          </>
        )}
      </Panel>

      <Panel title="Last import">
        {!info ? <p className="text-ink-soft">Nothing imported yet.</p> : (
          <div className="space-y-4">
            <p><span className="font-medium">{info.fileName}</span><br /><span className="text-ink-soft">{new Date(info.importedAt).toLocaleString('en-IN')}</span></p>
            <table className="ledger">
              <thead><tr><th>Sheet</th><th>Section</th><th className="text-right">Rows</th><th className="text-right">Records</th></tr></thead>
              <tbody>{info.sheetsParsed.map((s) => <tr key={s.sheet}><td className="num">{s.sheet}</td><td>{SECTION_LABELS[s.section]}</td><td className="num text-right">{s.rows}</td><td className="num text-right">{s.records}</td></tr>)}</tbody>
            </table>
            {info.sheetsSkipped.length > 0 && (
              <Notice tone="warn">
                <p className="font-medium">Not imported</p>
                <ul className="mt-1 space-y-1">{info.sheetsSkipped.map((s) => <li key={s.sheet}><span className="num">{s.sheet}</span>: {s.reason}</li>)}</ul>
              </Notice>
            )}
            {info.importIssueCount > 0 && <p className="text-amber">{info.importIssueCount} import notes are listed on the Errors tab.</p>}
          </div>
        )}
      </Panel>
    </div>
    <MarketplaceImport d={d} locked={locked} onDone={onDone} />
    <p className="text-ink-soft">No Excel file? Open the <b>Records</b> tab and use <b>Add entry</b> to type invoices, B2C totals, HSN lines and documents in by hand – like the GST offline tool.</p>
    </div>
  );
}
