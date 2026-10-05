'use client';

import { useEffect, useState } from 'react';
import { Button, Empty, Panel, Severity } from '@/components/ui';
import { call } from '@/lib/client';
import { fmtValue, SECTION_LABELS, type Issue, type ReturnDetail } from './types';

export function ErrorsTab({ d, onOpenRecord, onChanged }: { d: ReturnDetail; onOpenRecord: (key: string) => void; onChanged: () => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [severity, setSeverity] = useState('error');
  const [origin, setOrigin] = useState('');
  const [section, setSection] = useState('');
  const [busy, setBusy] = useState(false);
  const qs = new URLSearchParams(Object.entries({ severity, origin, section }).filter(([, v]) => v)).toString();

  useEffect(() => {
    call<{ errors: Issue[] }>(`/api/returns/${d.return._id}/errors?${qs}`).then((r) => setIssues(r.errors));
  }, [d.return._id, qs, d.return.lastValidatedAt]);

  async function revalidate() {
    setBusy(true);
    try { await call(`/api/returns/${d.return._id}/validate`, { method: 'POST' }); onChanged(); } finally { setBusy(false); }
  }

  return (
    <Panel
      title="Validation report"
      action={
        <div className="flex gap-2">
          <a className="rounded-md border border-rule bg-white px-3 py-1.5 text-[13px] hover:border-ink-soft" href={`/api/returns/${d.return._id}/errors?${qs}&format=csv`}>Download CSV</a>
          <Button variant="secondary" onClick={revalidate} busy={busy}>Revalidate</Button>
        </div>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <label>Severity<select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="error">Errors</option><option value="warning">Warnings</option><option value="">All</option></select></label>
        <label>Source<select value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="">All</option><option value="validation">Validation</option><option value="import">Import</option><option value="portal">GST portal</option></select></label>
        <label>Section<select value={section} onChange={(e) => setSection(e.target.value)}><option value="">All sections</option>{Object.entries(SECTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {!issues ? <p className="text-ink-soft">Loading…</p> : issues.length === 0 ? (
        <Empty title={severity === 'error' ? 'No errors' : 'Nothing to show'}>{severity === 'error' && d.return.summary?.total ? 'All records pass validation. Generate the JSON next.' : 'Change the filters to see other items.'}</Empty>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="ledger">
            <thead><tr><th></th><th>Section</th><th>Document</th><th>Row</th><th>Field</th><th>Current value</th><th>Problem</th><th>Suggested fix</th><th></th></tr></thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i._id}>
                  <td><Severity s={i.severity} />{i.origin === 'portal' && <span className="mt-1 block text-[11.5px] text-ink-soft">portal</span>}</td>
                  <td>{SECTION_LABELS[i.section] ?? i.section}</td>
                  <td className="num">{i.documentNo ?? '—'}</td>
                  <td className="num">{i.row ? `${i.sheet ? `${i.sheet}:` : ''}${i.row}` : '—'}</td>
                  <td className="num text-[12.5px]">{i.field}</td>
                  <td className="num max-w-40 truncate" title={fmtValue(i.value)}>{fmtValue(i.value)}</td>
                  <td className="min-w-56">{i.message}</td>
                  <td className="min-w-48 text-ink-soft">{i.suggestion ?? '—'}</td>
                  <td>{i.recordKey && <Button variant="ghost" onClick={() => onOpenRecord(i.recordKey!)}>Fix</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {issues.length >= 2000 && <p className="px-5 pt-3 text-ink-soft">Showing the first 2,000. Download the CSV for the full list.</p>}
        </div>
      )}
    </Panel>
  );
}
