'use client';

import { useEffect, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { call, inr } from '@/lib/client';
import type { ReturnDetail } from './types';

interface Preview { meta: { sha256: string; sizeBytes: number; version: string; createdAt: string; stale: boolean; log: { sections: Record<string, { documents: number; taxableValue: number; tax: number }> } }; preview: unknown }

export function JsonTab({ d, onChanged }: { d: ReturnDetail; onChanged: () => void }) {
  const [loaded, setP] = useState<Preview | null>(null);
  const p = d.return.currentJsonId ? loaded : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; details?: unknown } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const errors = d.return.summary?.errorCount ?? 0;

  useEffect(() => {
    if (d.return.currentJsonId) call<Preview>(`/api/returns/${d.return._id}/json`).then(setP).catch(() => setP(null));
  }, [d.return._id, d.return.currentJsonId]);

  async function generate() {
    setBusy(true); setErr(null);
    try { await call(`/api/returns/${d.return._id}/json`, { method: 'POST' }); onChanged(); }
    catch (e) { setErr({ msg: (e as Error).message, details: (e as { details?: unknown }).details }); }
    finally { setBusy(false); }
  }

  const raw = p ? JSON.stringify(p.preview, null, 2) : '';
  const totals = p ? Object.values(p.meta.log.sections).reduce((a, s) => ({ tx: a.tx + s.taxableValue, tax: a.tax + s.tax }), { tx: 0, tax: 0 }) : null;

  return (
    <div className="space-y-6">
      <Panel title="Generate upload JSON" action={<span className="text-ink-soft">Format {d.profile.jsonVersion} · {d.profile.hsnSplit ? 'HSN split B2B/B2C' : 'single HSN table'}</span>}>
        {errors > 0 && <div className="mb-4"><Notice tone="error">{errors} validation error(s) must be fixed first. The JSON is only generated from a clean return.</Notice></div>}
        {d.return.jsonStale && <div className="mb-4"><Notice tone="warn">Records changed after the last generation. Generate again before uploading.</Notice></div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={generate} busy={busy} disabled={errors > 0 || !d.return.summary?.total}>{p ? 'Regenerate JSON' : 'Generate JSON'}</Button>
          {p && !d.return.jsonStale && <a className="rounded-md border border-rule bg-white px-3.5 py-2 text-[13.5px] font-medium hover:border-ink-soft" href={`/api/returns/${d.return._id}/json?download=1`}>Download GSTR1_{d.company.gstin}_{d.return.fp}.json</a>}
          {!!d.return.summary?.total && <a className="text-[13px] text-ledger underline" href={`/api/downloads/file?type=gstr1&companyId=${d.company._id}&period=${d.return.fp}&format=xlsx`}>Download records as Excel</a>}
        </div>
        {err && <div className="mt-4"><Notice tone="error">{err.msg}{Array.isArray(err.details) && <ul className="num mt-2 text-[12.5px]">{(err.details as { path: string; message: string }[]).slice(0, 20).map((x, i) => <li key={i}>{x.path}: {x.message}</li>)}</ul>}</Notice></div>}
      </Panel>

      {!p ? <Empty title="No JSON yet">Once validation shows zero errors, generate the file here. It is checked against the schema before you can download it.</Empty> : (
        <Panel title="Generation log" action={<Button variant="ghost" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide JSON preview' : 'Show JSON preview'}</Button>}>
          <dl className="mb-4 grid gap-x-8 gap-y-2 sm:grid-cols-4">
            <div><dt className="text-ink-soft">Generated</dt><dd>{new Date(p.meta.createdAt).toLocaleString('en-IN')}</dd></div>
            <div><dt className="text-ink-soft">Size</dt><dd className="num">{(p.meta.sizeBytes / 1024).toFixed(1)} KB</dd></div>
            <div className="sm:col-span-2"><dt className="text-ink-soft">SHA-256 (matches the audit log)</dt><dd className="num break-all text-[12px]">{p.meta.sha256}</dd></div>
          </dl>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>JSON section</th><th className="text-right">Documents / lines</th><th className="text-right">Taxable value</th><th className="text-right">Tax incl. cess</th></tr></thead>
              <tbody>
                {Object.entries(p.meta.log.sections).map(([k, s]) => <tr key={k}><td className="num">{k}</td><td className="num text-right">{s.documents}</td><td className="num text-right">{inr(s.taxableValue)}</td><td className="num text-right">{inr(s.tax)}</td></tr>)}
                {totals && <tr className="font-semibold"><td colSpan={2}>Total (HSN rows repeat document values)</td><td className="num text-right">{inr(totals.tx)}</td><td className="num text-right">{inr(totals.tax)}</td></tr>}
              </tbody>
            </table>
          </div>
          {showRaw && <pre className="num mt-4 max-h-[480px] overflow-auto rounded-md bg-ink p-4 text-[12px] text-white/90">{raw.length > 300_000 ? raw.slice(0, 300_000) + '\n… (truncated – download for the full file)' : raw}</pre>}
        </Panel>
      )}
    </div>
  );
}
