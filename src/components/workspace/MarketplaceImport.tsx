'use client';

import { useRef, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { MARKETPLACES } from '@/engine/marketplace/formats';
import { UQC_CODES } from '@/engine/masters';
import { call, inr } from '@/lib/client';
import { SECTION_LABELS, type ReturnDetail } from './types';

export interface MarketplaceImportInfo {
  marketplace: string; label: string; importedAt: string; etin?: string; uqc?: string;
  summary: {
    files: string[]; lines: number; sales: number; returns: number; skipped: { reason: string; count: number }[];
    otherGstinLines: number; outsidePeriod: number; salesTaxable: number; returnsTaxable: number; netTaxable: number;
    computedTax: number; reportedTax: number | null; records: Record<string, number>; cancelledInvoices?: number;
    etinFromReport?: boolean;
    table14?: { etin: string; netValue: number; igst: number; cgst: number; sgst: number; cess: number } | null;
  };
}

const HELP: Record<string, string> = {
  auto: 'The file type is recognised from its columns.',
  amazon: 'Seller Central → Reports → Tax Document Library → MTR (B2C and B2B). Upload both CSVs together.',
  flipkart: 'Seller Hub → Reports → Tax reports → Sales report (.xlsx).',
  meesho: 'Supplier Panel → Payments → GST report (ZIP). Extract it and upload tcs_sales.xlsx and tcs_sales_return.xlsx together.',
  generic: 'Any sales register with columns for invoice no., date, state, HSN, rate and taxable value (optional: customer GSTIN, type Sale/Return).',
};

export function MarketplaceImport({ d, locked, onDone }: { d: ReturnDetail; locked: boolean; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [mp, setMp] = useState('auto');
  const [files, setFiles] = useState<File[]>([]);
  const [etin, setEtin] = useState('');
  const [uqc, setUqc] = useState('NOS');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; details?: unknown } | null>(null);
  const imports = ((d.return as { marketplaceImports?: MarketplaceImportInfo[] }).marketplaceImports ?? []);

  async function upload() {
    if (!files.length) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append('marketplace', mp);
    if (etin.trim()) fd.append('etin', etin.trim());
    fd.append('uqc', uqc);
    for (const f of files) fd.append('files', f);
    try {
      await call(`/api/returns/${d.return._id}/marketplace`, { method: 'POST', body: fd });
      setFiles([]);
      if (input.current) input.current.value = '';
      onDone();
    } catch (e) { setErr({ msg: (e as Error).message, details: (e as { details?: unknown }).details }); } finally { setBusy(false); }
  }

  async function remove(m: MarketplaceImportInfo) {
    if (!confirm(`Remove everything imported from ${m.label} in this return?`)) return;
    try { await call(`/api/returns/${d.return._id}/marketplace?marketplace=${m.marketplace}`, { method: 'DELETE' }); onDone(); }
    catch (e) { setErr({ msg: (e as Error).message }); }
  }

  return (
    <Panel title="Marketplace sales reports – Amazon, Flipkart, Meesho & others">
      {locked ? <p className="text-ink-soft">Import is locked for this return.</p> : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label>Marketplace
              <select value={mp} onChange={(e) => setMp(e.target.value)}>
                <option value="auto">Detect automatically</option>
                {Object.entries(MARKETPLACES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="lg:col-span-2">Marketplace TCS GSTIN for your state (recommended)
              <input value={etin} onChange={(e) => setEtin(e.target.value.toUpperCase())} maxLength={15} className="num uppercase" placeholder="e.g. 27AAxxxxxxxx1ZC – on the TCS credit in GSTR-2A" />
            </label>
            <label>Unit for HSN summary
              <select value={uqc} onChange={(e) => setUqc(e.target.value)}>
                {Object.entries(UQC_CODES).map(([k, v]) => <option key={k} value={k}>{k} – {v}</option>)}
              </select>
            </label>
          </div>
          <p className="text-[12.5px] text-ink-soft">{HELP[mp]}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" multiple accept=".xlsx,.csv,.txt" className="hidden" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <Button variant="secondary" onClick={() => input.current?.click()}>Choose report files</Button>
            <span className="text-ink-soft">{files.length ? files.map((f) => f.name).join(', ') : 'No files chosen'}</span>
            <Button onClick={upload} busy={busy} disabled={!files.length}>Import and validate</Button>
          </div>
          {err && (
            <Notice tone="error">{err.msg}
              {Array.isArray(err.details) && <ul className="mt-2 list-disc pl-5">{(err.details as { sheet: string; reason: string }[]).map((s, i) => <li key={i}>{s.sheet}: {s.reason}</li>)}</ul>}
            </Notice>
          )}
        </div>
      )}

      {imports.length > 0 && (
        <div className="mt-6 space-y-4">
          {imports.map((m) => {
            const s = m.summary;
            const taxDiff = s.reportedTax == null ? null : Math.round((s.reportedTax - s.computedTax) * 100) / 100;
            return (
              <div key={m.marketplace} className="rounded-md border border-rule bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{m.label}</p>
                    <p className="text-[12.5px] text-ink-soft">{new Date(m.importedAt).toLocaleString('en-IN')} · {s.files.join(', ')}{m.etin ? ` · ECO ${m.etin}` : ''}</p>
                  </div>
                  {!locked && <Button variant="ghost" onClick={() => remove(m)}>Remove</Button>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
                  <div><dt className="text-ink-soft">Sale lines</dt><dd className="num">{s.sales.toLocaleString('en-IN')}</dd></div>
                  <div><dt className="text-ink-soft">Return lines</dt><dd className="num">{s.returns.toLocaleString('en-IN')}</dd></div>
                  <div><dt className="text-ink-soft">Sales (taxable)</dt><dd className="num">₹{inr(s.salesTaxable)}</dd></div>
                  <div><dt className="text-ink-soft">Returns (taxable)</dt><dd className="num">₹{inr(s.returnsTaxable)}</dd></div>
                  <div><dt className="text-ink-soft">Net taxable</dt><dd className="num font-semibold">₹{inr(s.netTaxable)}</dd></div>
                  <div><dt className="text-ink-soft">Tax (rate × value)</dt><dd className="num">₹{inr(s.computedTax)}</dd></div>
                  <div><dt className="text-ink-soft">Tax in report</dt><dd className={`num ${taxDiff && Math.abs(taxDiff) > 10 ? 'text-amber' : ''}`}>{s.reportedTax == null ? '—' : `₹${inr(s.reportedTax)}`}</dd></div>
                  <div><dt className="text-ink-soft">Records created</dt><dd>{Object.entries(s.records).map(([k, v]) => `${SECTION_LABELS[k] ?? k}: ${v}`).join(' · ')}</dd></div>
                </dl>
                {s.table14 && (
                  <div className="mt-3 rounded-md bg-paper px-3 py-2 text-[12.5px]">
                    <p className="font-semibold">Table 14(a) – supplies through e-commerce operator (enter on the GST portal)</p>
                    <p className="num mt-1">
                      GSTIN {s.table14.etin}{s.etinFromReport ? ' (from report)' : ''} · Net value ₹{inr(s.table14.netValue)} · IGST ₹{inr(s.table14.igst)} · CGST ₹{inr(s.table14.cgst)} · SGST/UTGST ₹{inr(s.table14.sgst)} · Cess ₹{inr(s.table14.cess)}
                    </p>
                    <p className="mt-1 text-ink-soft">The JSON from this app does not contain Table 14. After uploading it, open Table 14 on the portal and add this line.</p>
                  </div>
                )}
                {(s.skipped.length > 0 || s.otherGstinLines > 0 || s.outsidePeriod > 0 || !!s.cancelledInvoices) && (
                  <ul className="mt-3 space-y-0.5 text-[12.5px] text-ink-soft">
                    {!!s.cancelledInvoices && <li>{s.cancelledInvoices} invoice(s) cancelled in full – left out of the values, counted as cancelled in Table 13</li>}
                    {s.skipped.map((x) => <li key={x.reason}>Not counted: {x.count} × {x.reason}</li>)}
                    {s.otherGstinLines > 0 && <li>{s.otherGstinLines} line(s) for another GSTIN left out</li>}
                    {s.outsidePeriod > 0 && <li className="text-amber">{s.outsidePeriod} line(s) dated outside this return period</li>}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
