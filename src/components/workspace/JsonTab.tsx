'use client';

import { useEffect, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { call, inr } from '@/lib/client';
import type { ReturnDetail } from './types';

interface Sec { documents: number; taxableValue: number; tax: number; igst?: number; cgst?: number; sgst?: number; cess?: number }
interface Preview { meta: { sha256: string; sizeBytes: number; version: string; createdAt: string; stale: boolean; log: { sections: Record<string, Sec>; detail?: { hsnB2b?: Sec; hsnB2c?: Sec; docs?: { series: number; issued: number; cancelled: number; net: number } } } }; preview: unknown }

/** The return's own tables, always listed (as in the billing software's GSTR-1 summary). */
const MAIN: [string, string][] = [
  ['b2b', 'B2B (B2B invoices)'], ['b2cl', 'B2CL (B2C invoices – large)'], ['b2cs', 'B2CS (B2C invoices – small)'],
  ['cdnr', 'CDNR (credit / debit notes to registered persons)'], ['cdnur', 'CDNUR (credit / debit notes to unregistered persons)'],
  ['exp', 'EXP (export invoices)'], ['nil', 'Nil rated / exempted / non-GST'],
];
/** Summaries of the same supplies – shown below the total, not added to it. */
const MEMO: Record<string, string> = { hsn: 'HSN summary (Table 12)', doc_issue: 'Documents issued (Table 13)' };
const ZERO: Sec = { documents: 0, taxableValue: 0, tax: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

type Detail = NonNullable<Preview['meta']['log']['detail']>;
/** The same figures read from the JSON itself – for a JSON generated before they were logged. */
function detailFromJson(json: unknown): Detail {
  const j = (json ?? {}) as { hsn?: Record<string, unknown>; doc_issue?: { doc_det?: { docs?: { totnum?: number; cancel?: number }[] }[] } };
  const side = (rows: unknown): Sec | undefined => {
    if (!Array.isArray(rows) || !rows.length) return undefined;
    const sum = (k: string) => Math.round(rows.reduce((a: number, r: Record<string, number>) => a + (Number(r[k]) || 0), 0) * 100) / 100;
    const s = { documents: rows.length, taxableValue: sum('txval'), igst: sum('iamt'), cgst: sum('camt'), sgst: sum('samt'), cess: sum('csamt') };
    return { ...s, tax: s.igst + s.cgst + s.sgst + s.cess };
  };
  const series = (j.doc_issue?.doc_det ?? []).flatMap((d) => d.docs ?? []);
  const issued = series.reduce((a, d) => a + (d.totnum ?? 0), 0), cancelled = series.reduce((a, d) => a + (d.cancel ?? 0), 0);
  return {
    hsnB2b: side(j.hsn?.hsn_b2b), hsnB2c: side(j.hsn?.hsn_b2c),
    docs: series.length ? { series: series.length, issued, cancelled, net: issued - cancelled } : undefined,
  };
}

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
  const secs = p?.meta.log.sections ?? {};
  // JSON generated before the tax split was logged has only the tax total.
  const split = Object.values(secs).some((s) => s.igst != null);
  const rows: [string, Sec][] = [
    ...MAIN.map(([k, label]): [string, Sec] => [label, secs[k] ?? ZERO]),
    ...Object.entries(secs).filter(([k]) => !MAIN.some(([m]) => m === k) && !MEMO[k]).map(([k, s]): [string, Sec] => [k.toUpperCase(), s]),
  ];
  // Table 12 by side and Table 13 counts, when the JSON was generated with them; else one row each.
  const det = p?.meta.log.detail ?? (p ? detailFromJson(p.preview) : undefined);
  const memo: [string, Sec][] = [
    ...(det?.hsnB2b || det?.hsnB2c
      ? [...(det.hsnB2b ? [['HSN summary – B2B (Table 12)', det.hsnB2b] as [string, Sec]] : []), ...(det.hsnB2c ? [['HSN summary – B2C (Table 12)', det.hsnB2c] as [string, Sec]] : [])]
      : secs.hsn ? [[MEMO.hsn, secs.hsn] as [string, Sec]] : []),
    ...(secs.doc_issue ? [[det?.docs ? `${MEMO.doc_issue} – ${det.docs.issued} issued, ${det.docs.cancelled} cancelled, net ${det.docs.net}` : MEMO.doc_issue, secs.doc_issue] as [string, Sec]] : []),
  ];
  const total = rows.reduce((a, [, s]) => ({
    documents: a.documents + s.documents, taxableValue: a.taxableValue + s.taxableValue, tax: a.tax + s.tax,
    igst: a.igst! + (s.igst ?? 0), cgst: a.cgst! + (s.cgst ?? 0), sgst: a.sgst! + (s.sgst ?? 0), cess: a.cess! + (s.cess ?? 0),
  }), ZERO);
  const line = (label: string, s: Sec, i: number | null, cls = '') => (
    <tr key={label} className={cls}>
      <td className="num">{i ?? ''}</td><td>{label}</td><td className="num text-right">{s.documents}</td><td className="num text-right">{inr(s.taxableValue)}</td>
      {split ? <><td className="num text-right">{inr(s.igst ?? 0)}</td><td className="num text-right">{inr(s.cgst ?? 0)}</td><td className="num text-right">{inr(s.sgst ?? 0)}</td><td className="num text-right">{inr(s.cess ?? 0)}</td></>
        : <td className="num text-right">{inr(s.tax)}</td>}
    </tr>
  );

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
              <thead><tr><th>S. No.</th><th>GSTR-1 type</th><th className="text-right">Number of records</th><th className="text-right">Taxable value (₹)</th>
                {split ? <><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST/UTGST</th><th className="text-right">Cess</th></> : <th className="text-right">Tax incl. cess</th>}</tr></thead>
              <tbody>
                {rows.map(([label, s], i) => line(label, s, i + 1))}
                {line('Total', total, null, 'font-semibold')}
                {memo.map(([label, s]) => line(label, s, null, 'text-ink-soft'))}
              </tbody>
            </table>
          </div>
          {((secs.cdnr?.documents ?? 0) + (secs.cdnur?.documents ?? 0) > 0) && <p className="mt-3 text-[12.5px] text-ink-soft">The total adds the credit / debit note rows as they are – credit notes are not deducted from it.</p>}
          {showRaw && <pre className="num mt-4 max-h-[480px] overflow-auto rounded-md bg-ink p-4 text-[12px] text-white/90">{raw.length > 300_000 ? raw.slice(0, 300_000) + '\n… (truncated – download for the full file)' : raw}</pre>}
        </Panel>
      )}
    </div>
  );
}
