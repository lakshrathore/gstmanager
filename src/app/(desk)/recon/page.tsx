'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { call, inr } from '@/lib/client';

type Source = 'books' | 'gstr2a' | 'gstr2b';
type Against = 'gstr2a' | 'gstr2b';
interface Company { _id: string; name: string; gstin: string }
interface Imp { source: Source; via: string; files: string[]; docs: number; taxable: number; tax: number; updatedAt: string; importedBy?: string; notes?: { file: string; message: string }[] }
interface Doc {
  key: string; source: Source; docType: 'INV' | 'CN' | 'DN'; supplierGstin: string; supplierName?: string; docNo: string; docDate: string;
  taxable: number; igst: number; cgst: number; sgst: number; cess: number; itcAvailable?: boolean | null;
}
interface Diff { field: string; books: unknown; portal: unknown; diff?: number }
interface Row { id: string; status: Status; books?: Doc; portal?: Doc; matchedBy?: string; accepted?: boolean; diffs: Diff[]; notes: string[]; ignoredReason?: string }
type Status = 'matched' | 'mismatch' | 'probable' | 'not_in_portal' | 'not_in_books' | 'ignored';
interface Totals { count: number; taxable: number; tax: number }
interface Decision { _id: string; action: string; booksKey?: string; portalKey?: string; reason?: string; byEmail?: string }
interface Result { rows: Row[]; summary: { byStatus: Record<Status, Totals>; books: Totals; portal: Totals; itc: { books: number; portal: number; matched: number; difference: number } }; decisions: Decision[]; counts: { books: number; portal: number } }

const SOURCES: { id: Source; title: string; help: string }[] = [
  { id: 'books', title: 'Books – purchase register', help: 'Excel/CSV from Tally, Busy or your own sheet. Needs supplier GSTIN, invoice no., date, taxable value and tax columns.' },
  { id: 'gstr2a', title: 'GSTR-2A', help: 'Excel or JSON downloaded from the GST portal (Returns → GSTR-2A → Download), or fetch it directly.' },
  { id: 'gstr2b', title: 'GSTR-2B', help: 'Excel or JSON downloaded from the GST portal (Returns → GSTR-2B → Download), or fetch it directly.' },
];
const STATUS: Record<Status, { label: string; tone: string; help: string }> = {
  matched: { label: 'Matched', tone: 'bg-ledger-tint text-ledger', help: 'Same invoice, amounts agree within tolerance' },
  mismatch: { label: 'Mismatch', tone: 'bg-red-tint text-red-ink', help: 'Same invoice, but amounts, tax head, date, POS or RCM differ' },
  probable: { label: 'Probable match', tone: 'bg-amber-tint text-amber', help: 'Very likely the same invoice (number typed differently or other GSTIN of same PAN) – confirm' },
  not_in_portal: { label: 'Not in portal', tone: 'bg-red-tint text-red-ink', help: 'In your books, supplier has not reported it – ITC at risk' },
  not_in_books: { label: 'Not in books', tone: 'bg-amber-tint text-amber', help: 'Supplier reported it, but it is missing from your books' },
  ignored: { label: 'Ignored', tone: 'bg-black/5 text-ink-soft', help: 'Excluded by you' },
};
const ORDER: Status[] = ['mismatch', 'probable', 'not_in_portal', 'not_in_books', 'matched', 'ignored'];
const FIELD: Record<string, string> = { taxable: 'Taxable', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', cess: 'Cess', totalTax: 'Total tax', taxHead: 'Tax head', docDate: 'Date', docNo: 'Doc no.', rcm: 'RCM', pos: 'POS', gstin: 'GSTIN' };
const tax = (d?: Doc) => (d ? d.igst + d.cgst + d.sgst + d.cess : null);
const PAGE = 100;

function thisPeriod() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}

export default function ReconPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fp, setFp] = useState(thisPeriod());
  const [imports, setImports] = useState<Imp[]>([]);
  const [against, setAgainst] = useState<Against>('gstr2b');
  const [res, setRes] = useState<Result | null>(null);
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [tolerance, setTolerance] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState<Row | null>(null);

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => { setCompanies(r.companies); if (r.companies[0]) setCompanyId(r.companies[0]._id); }).catch((e) => setErr(e.message));
  }, []);

  const base = `companyId=${companyId}&fp=${fp}`;
  const loadStatus = useCallback(() => (companyId && /^\d{6}$/.test(fp) ? call<{ imports: Imp[] }>(`/api/recon?${base}`).then((r) => { setImports(r.imports); setErr(null); }).catch((e) => setErr(e.message)) : Promise.resolve()), [companyId, fp, base]);
  const loadResult = useCallback(() => (companyId && /^\d{6}$/.test(fp) ? call<Result>(`/api/recon/result?${base}&against=${against}&tolerance=${tolerance}`).then(setRes).catch((e) => setErr(e.message)) : Promise.resolve()), [companyId, fp, against, tolerance, base]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadResult(); }, [loadResult, imports]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setErr(null);
    try { await fn(); await loadResult(); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }
  const decide = (body: Record<string, unknown>) => act('decide', () => call('/api/recon/decisions', { method: 'POST', json: { companyId, fp, against, ...body } }));
  const undo = (id: string) => act('decide', () => call(`/api/recon/decisions/${id}?${base}&against=${against}`, { method: 'DELETE' }));
  const decisionFor = (r: Row) => res?.decisions.find((d) =>
    (d.action === 'ignore' && ((r.books && d.booksKey === r.books.key) || (!r.books && r.portal && d.portalKey === r.portal.key)))
    || (d.action !== 'ignore' && r.books && r.portal && d.booksKey === r.books.key && d.portalKey === r.portal.key));

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (res?.rows ?? [])
      .filter((r) => filter === 'all' || r.status === filter)
      .filter((r) => !s || [r.books?.docNo, r.portal?.docNo, r.books?.supplierGstin, r.portal?.supplierGstin, r.books?.supplierName, r.portal?.supplierName].some((v) => v?.toLowerCase().includes(s)))
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.books ?? a.portal)!.supplierGstin.localeCompare((b.books ?? b.portal)!.supplierGstin));
  }, [res, filter, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const imp = (s: Source) => imports.find((i) => i.source === s);
  const portalLabel = against === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B';

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-[24px] font-semibold tracking-tight">Purchase reconciliation</h1>
        <div className="flex flex-wrap gap-3">
          <label>Company
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="min-w-56">
              {companies.map((c) => <option key={c._id} value={c._id}>{c.name} – {c.gstin}</option>)}
            </select>
          </label>
          <label>Period
            <input type="month" value={`${fp.slice(2)}-${fp.slice(0, 2)}`} onChange={(e) => { const [y, m] = e.target.value.split('-'); if (y && m) { setFp(`${m}${y}`); setPage(1); } }} />
          </label>
        </div>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {!companies.length && <Empty title="Add a company first">Reconciliation runs per company (GSTIN) and month.</Empty>}

      {companyId && (
        <div className="grid gap-4 lg:grid-cols-3">
          {SOURCES.map((s) => <SourceCard key={s.id} s={s} imp={imp(s.id)} companyId={companyId} fp={fp} onChange={loadStatus} setErr={setErr} />)}
        </div>
      )}

      {companyId && (
        <Panel title={
          <div role="tablist" className="flex gap-1">
            {(['gstr2b', 'gstr2a'] as Against[]).map((a) => (
              <button key={a} role="tab" aria-selected={against === a} onClick={() => { setAgainst(a); setPage(1); }}
                className={`rounded-md px-3 py-1.5 text-[14px] ${against === a ? 'bg-ink text-white' : 'text-ink-soft hover:bg-black/5'}`}>
                Books vs {a === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B'}
              </button>
            ))}
          </div>
        } action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 whitespace-nowrap">Tolerance ₹<input type="number" min={0} max={1000} step="0.5" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value) || 0)} className="w-20" /></label>
            <a className="inline-flex items-center rounded-md border border-rule bg-white px-3.5 py-2 text-[13.5px] font-medium hover:border-ink-soft" href={`/api/recon/export?${base}&against=${against}`}>Export Excel</a>
          </div>
        }>
          {!res ? <p className="text-ink-soft">Loading…</p> : !res.counts.books && !res.counts.portal ? (
            <Empty title="Nothing to reconcile yet">Upload your purchase register and the {portalLabel} for {fp.slice(0, 2)}/{fp.slice(2)} above.</Empty>
          ) : (
            <div className="space-y-4">
              {(!res.counts.books || !res.counts.portal) && <Notice tone="warn">{!res.counts.books ? 'Books are not uploaded – everything shows as "not in books".' : `${portalLabel} is not uploaded – everything shows as "not in portal".`}</Notice>}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {ORDER.map((st) => {
                  const t = res.summary.byStatus[st];
                  return (
                    <button key={st} title={STATUS[st].help} onClick={() => { setFilter(filter === st ? 'all' : st); setPage(1); }}
                      className={`rounded-lg border p-3 text-left ${filter === st ? 'border-ink' : 'border-rule'} bg-white hover:border-ink-soft`}>
                      <span className={`rounded px-1.5 py-0.5 text-[11.5px] font-medium ${STATUS[st].tone}`}>{STATUS[st].label}</span>
                      <p className="num mt-1 text-[20px] font-semibold">{t.count}</p>
                      <p className="num text-[12px] text-ink-soft">Tax ₹{inr(t.tax)}</p>
                    </button>
                  );
                })}
              </div>
              <dl className="flex flex-wrap gap-x-8 gap-y-2 rounded-md bg-paper px-4 py-3 text-[13px]">
                <div><dt className="text-ink-soft">ITC as per books</dt><dd className="num font-semibold">₹{inr(res.summary.itc.books)}</dd></div>
                <div><dt className="text-ink-soft">ITC available in {portalLabel}</dt><dd className="num font-semibold">₹{inr(res.summary.itc.portal)}</dd></div>
                <div><dt className="text-ink-soft">Matched ITC</dt><dd className="num font-semibold text-ledger">₹{inr(res.summary.itc.matched)}</dd></div>
                <div><dt className="text-ink-soft">Difference (books − portal)</dt><dd className={`num font-semibold ${Math.abs(res.summary.itc.difference) > 1 ? 'text-red-ink' : ''}`}>₹{inr(res.summary.itc.difference)}</dd></div>
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <input className="max-w-sm" placeholder="Search GSTIN, supplier or document no." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
                <span className="text-ink-soft">{rows.length} row(s){filter !== 'all' ? ` · ${STATUS[filter].label}` : ''}</span>
              </div>
              <div className="-mx-5 overflow-x-auto">
                <table className="ledger">
                  <thead>
                    <tr><th>Status</th><th>Supplier</th><th>Document (books / {portalLabel})</th><th>Date</th><th className="text-right">Taxable</th><th className="text-right">Tax</th><th>Differences &amp; notes</th><th /></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const d = r.books ?? r.portal!;
                      const dec = decisionFor(r);
                      const hasDiff = (f: string) => r.diffs.some((x) => x.field === f);
                      return (
                        <tr key={r.id} className={r.status === 'mismatch' || r.status === 'not_in_portal' ? 'row-error' : ''}>
                          <td><span className={`whitespace-nowrap rounded px-2 py-0.5 text-[12px] font-medium ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>{r.matchedBy === 'manual' && <p className="text-[11.5px] text-ink-soft">linked by you</p>}</td>
                          <td><p className="num">{d.supplierGstin}</p><p className="text-[12px] text-ink-soft">{r.books?.supplierName ?? r.portal?.supplierName ?? ''}</p></td>
                          <td className="num">
                            <p>{r.books ? r.books.docNo : <span className="text-ink-soft">—</span>} {d.docType !== 'INV' && <span className="text-[11px] text-ink-soft">{d.docType}</span>}</p>
                            <p className={hasDiff('docNo') ? 'text-amber' : 'text-ink-soft'}>{r.portal ? r.portal.docNo : '—'}</p>
                          </td>
                          <td className="num whitespace-nowrap"><p>{r.books?.docDate || '—'}</p><p className={hasDiff('docDate') ? 'text-red-ink' : 'text-ink-soft'}>{r.portal?.docDate || '—'}</p></td>
                          <td className="num text-right"><p>{r.books ? inr(r.books.taxable) : '—'}</p><p className={hasDiff('taxable') ? 'text-red-ink' : 'text-ink-soft'}>{r.portal ? inr(r.portal.taxable) : '—'}</p></td>
                          <td className="num text-right"><p>{r.books ? inr(tax(r.books)) : '—'}</p><p className={hasDiff('totalTax') || hasDiff('igst') || hasDiff('cgst') || hasDiff('sgst') || hasDiff('taxHead') ? 'text-red-ink' : 'text-ink-soft'}>{r.portal ? inr(tax(r.portal)) : '—'}</p></td>
                          <td className="max-w-80 text-[12.5px]">
                            {r.diffs.filter((x) => x.field !== 'docNo').map((x) => (
                              <p key={x.field} className="text-red-ink">{FIELD[x.field] ?? x.field}: {String(x.books ?? '—')} vs {String(x.portal ?? '—')}{x.diff != null ? ` (${x.diff > 0 ? '+' : ''}${inr(x.diff)})` : ''}</p>
                            ))}
                            {r.notes.map((n) => <p key={n} className="text-ink-soft">{n}</p>)}
                            {r.ignoredReason && <p className="text-ink-soft">Reason: {r.ignoredReason}</p>}
                          </td>
                          <td>
                            <div className="flex flex-col items-end gap-1">
                              {dec && (r.status === 'ignored' || r.accepted || r.matchedBy === 'manual') && <Button variant="ghost" disabled={!!busy} onClick={() => undo(dec._id)}>Undo</Button>}
                              {(r.status === 'probable' || r.status === 'mismatch') && !r.accepted && <Button variant="secondary" disabled={!!busy} onClick={() => decide({ action: 'accept', booksKey: r.books!.key, portalKey: r.portal!.key })}>{r.status === 'probable' ? 'Confirm match' : 'Accept'}</Button>}
                              {r.status === 'not_in_portal' && <Button variant="secondary" disabled={!!busy} onClick={() => setLinking(r)}>Link…</Button>}
                              {(r.status === 'not_in_portal' || r.status === 'not_in_books') && !r.id.includes('#dup') && (
                                <Button variant="ghost" disabled={!!busy} onClick={() => { const reason = prompt('Why ignore this document? (e.g. blocked credit, capital goods, already claimed)'); if (reason) decide({ action: 'ignore', ...(r.books ? { booksKey: r.books.key } : { portalKey: r.portal!.key }), reason }); }}>Ignore</Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <span className="num">{page} / {pages}</span>
                  <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      {linking && res && (
        <LinkDialog row={linking} candidates={res.rows.filter((r) => r.status === 'not_in_books' && r.portal)} portalLabel={portalLabel}
          onClose={() => setLinking(null)} onPick={(p) => { setLinking(null); decide({ action: 'link', booksKey: linking.books!.key, portalKey: p.key }); }} />
      )}
    </div>
  );
}

function SourceCard({ s, imp, companyId, fp, onChange, setErr }: { s: (typeof SOURCES)[number]; imp?: Imp; companyId: string; fp: string; onChange: () => void; setErr: (e: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (imp && !confirm(`Replace the ${imp.docs} document(s) already uploaded for this period?`)) { if (input.current) input.current.value = ''; return; }
    const fd = new FormData();
    fd.append('companyId', companyId); fd.append('fp', fp); fd.append('source', s.id);
    for (const f of files) fd.append('files', f);
    setBusy(true); setErr(null);
    try { await call('/api/recon/upload', { method: 'POST', body: fd }); onChange(); }
    catch (x) { const e = x as Error & { details?: { sheet: string; reason: string }[] }; setErr(`${s.title}: ${e.message}${e.details?.length ? ' – ' + e.details.slice(0, 3).map((d) => d.reason).join('; ') : ''}`); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function fetchPortal() {
    setBusy(true); setErr(null);
    try { await call('/api/recon/fetch', { method: 'POST', json: { companyId, fp, source: s.id } }); onChange(); }
    catch (x) { setErr(`${s.title}: ${(x as Error).message}`); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Remove the uploaded ${s.title} for this period?`)) return;
    try { await call(`/api/recon/upload?companyId=${companyId}&fp=${fp}&source=${s.id}`, { method: 'DELETE' }); onChange(); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <section className="rounded-lg border border-rule bg-sheet p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{s.title}</h2>
        {imp && <span className="rounded bg-ledger-tint px-2 py-0.5 text-[12px] font-medium text-ledger">{imp.docs} docs</span>}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">{s.help}</p>
      {imp ? (
        <div className="mt-3 text-[12.5px]">
          <p className="num">Taxable ₹{inr(imp.taxable)} · Tax ₹{inr(imp.tax)}</p>
          <p className="text-ink-soft">{imp.via === 'portal' ? 'Fetched from GST portal' : imp.files.join(', ')} · {new Date(imp.updatedAt).toLocaleString('en-IN')}</p>
          {!!imp.notes?.length && <details className="mt-1"><summary className="cursor-pointer text-amber">{imp.notes.length} note(s)</summary><ul className="mt-1 space-y-0.5">{imp.notes.slice(0, 20).map((n, i) => <li key={i}>{n.message}</li>)}</ul></details>}
        </div>
      ) : <p className="mt-3 text-[12.5px] text-ink-soft">Not uploaded for this period.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <input ref={input} type="file" multiple accept={s.id === 'books' ? '.xlsx,.csv' : '.xlsx,.csv,.json'} className="hidden" onChange={(e) => upload(e.target.files)} />
        <Button variant="secondary" busy={busy} onClick={() => input.current?.click()}>{imp ? 'Replace' : 'Upload'}</Button>
        {s.id !== 'books' && <Button variant="ghost" disabled={busy} onClick={fetchPortal}>Fetch from GST portal</Button>}
        {s.id === 'books' && <a className="self-center text-[12.5px] text-ledger underline" href="/api/recon/template">Template</a>}
        {imp && <Button variant="ghost" disabled={busy} onClick={remove}>Remove</Button>}
      </div>
    </section>
  );
}

function LinkDialog({ row, candidates, portalLabel, onClose, onPick }: { row: Row; candidates: Row[]; portalLabel: string; onClose: () => void; onPick: (d: Doc) => void }) {
  const b = row.books!;
  const [all, setAll] = useState(false);
  const list = candidates.filter((c) => all || c.portal!.supplierGstin === b.supplierGstin || c.portal!.supplierGstin.slice(2, 12) === b.supplierGstin.slice(2, 12));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Link to portal document" className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold">Link books invoice {b.docNo}</h2>
            <p className="text-ink-soft">{b.supplierGstin} · {b.docDate} · taxable ₹{inr(b.taxable)} · tax ₹{inr(tax(b))}</p>
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <label className="mt-3 flex items-center gap-2 text-ink"><input type="checkbox" className="w-auto" checked={all} onChange={(e) => setAll(e.target.checked)} />Show all suppliers (not only same GSTIN / PAN)</label>
        {!list.length ? <p className="mt-4 text-ink-soft">No unmatched {portalLabel} documents {all ? '' : 'for this supplier'}.</p> : (
          <table className="ledger mt-3">
            <thead><tr><th>GSTIN</th><th>Doc no.</th><th>Date</th><th className="text-right">Taxable</th><th className="text-right">Tax</th><th /></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id}>
                <td className="num">{c.portal!.supplierGstin}</td><td className="num">{c.portal!.docNo}</td><td className="num">{c.portal!.docDate}</td>
                <td className="num text-right">{inr(c.portal!.taxable)}</td><td className="num text-right">{inr(tax(c.portal))}</td>
                <td><Button variant="secondary" onClick={() => onPick(c.portal!)}>Link</Button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
