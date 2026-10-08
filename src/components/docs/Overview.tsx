'use client';

import { useState } from 'react';
import { Empty } from '@/components/ui';
import type { Analysis, Exception } from '@/engine/docs';
import type { ReconRow } from '@/engine/recon/types';
import { money, rupees } from './types';

/** Period summary, the exceptions that need the CA (everything else is fine), and findings. */
export function Overview({ a, label, onShow, reportUrl }: { a: Analysis; label: string; onShow: (e: Exception) => void; reportUrl: string }) {
  const cards: [string, number | null, string?][] = [
    [`Sales${a.sales.basis === 'none' ? '' : ` (${a.sales.basis})`}`, a.sales.books.count ? a.sales.books.taxable : null],
    ['Sales as per GSTR-1', a.sales.gstr1?.taxable ?? null],
    [`Purchases${a.purchases.basis === 'none' ? '' : ` (${a.purchases.basis})`}`, a.purchases.books.count ? a.purchases.books.taxable : null],
    [`Purchases as per ${a.purchases.portalSource === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B'}`, a.purchases.gstr2b?.taxable ?? null],
    ['ITC difference', a.recon ? a.recon.summary.itc.difference : null, a.recon && Math.abs(a.recon.summary.itc.difference) > 1 ? 'text-red-ink' : ''],
  ];
  const counts: [string, number][] = [
    ['Records', a.counts.records], ['Duplicates', a.counts.duplicates], ['GSTIN errors', a.counts.gstinErrors],
    ['Missing in GSTR-2B', a.counts.missingIn2b], ['Waiting for review', a.counts.needsReview], ['Other issues', a.counts.otherIssues],
  ];
  if (!a.counts.records) return <Empty title={`Nothing read for ${label} yet`}>Upload this client’s documents above. The summary, reconciliation and exceptions appear here as they are read.</Empty>;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(([l, v, cls]) => (
          <div key={l} className="rounded-lg border border-rule bg-white px-4 py-3">
            <p className="text-[12.5px] text-ink-soft">{l}</p>
            <p className={`num mt-1 text-[18px] font-semibold ${cls ?? ''}`}>{v == null ? '—' : rupees(v)}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
        {counts.map(([l, n]) => <span key={l}><span className="text-ink-soft">{l}</span> <span className={`num font-semibold ${n && l !== 'Records' ? 'text-red-ink' : ''}`}>{n}</span></span>)}
        <a className="ml-auto text-ledger underline" href={reportUrl}>Download the full report (Excel)</a>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <h3 className="mb-2 font-semibold">Needs your attention</h3>
          {a.exceptions.length ? (
            <ul className="space-y-1.5">
              {a.exceptions.map((e) => (
                <li key={e.code}>
                  <button type="button" disabled={!e.ids.length} onClick={() => onShow(e)}
                    className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-[13.5px] ${e.tone === 'ok' ? 'border-ledger/30 bg-ledger-tint text-ledger' : e.tone === 'error' ? 'border-red-ink/30 bg-red-tint text-red-ink' : 'border-amber/30 bg-amber-tint text-amber'} ${e.ids.length ? 'hover:brightness-95' : 'cursor-default'}`}>
                    <span aria-hidden>{e.tone === 'ok' ? '✓' : '⚠'}</span>
                    <span className="flex-1">{e.title}</span>
                    {e.ids.length > 0 && <span className="text-[12px] underline">Show</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-ink-soft">Nothing to check.</p>}
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Important findings</h3>
          {a.insights.length ? <ol className="list-decimal space-y-1.5 pl-5 text-[13.5px]">{a.insights.map((x) => <li key={x}>{x}</li>)}</ol> : <p className="text-ink-soft">No unusual findings.</p>}
          {a.bank && <p className="mt-4 text-[13px] text-ink-soft">Bank: {a.bank.count} transactions · received {rupees(a.bank.credit)} · paid {rupees(a.bank.debit)}</p>}
        </section>
      </div>
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  matched: ['Matched', 'bg-ledger-tint text-ledger'], mismatch: ['Mismatch', 'bg-red-tint text-red-ink'], probable: ['Probable', 'bg-amber-tint text-amber'],
  not_in_portal: ['Missing in 2B', 'bg-red-tint text-red-ink'], not_in_books: ['Not in books', 'bg-amber-tint text-amber'], ignored: ['Ignored', 'bg-black/5 text-ink-soft'],
};
const DIFF: Record<string, string> = { taxable: 'Taxable', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', cess: 'Cess', totalTax: 'Tax', taxHead: 'Tax head', docDate: 'Date', docNo: 'Invoice no', rcm: 'RCM', pos: 'POS', gstin: 'GSTIN' };

/** Purchase register ↔ GSTR-2B, with the invoices behind every rupee of difference. */
export function Recon({ a, onOpen }: { a: Analysis; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('problems');
  if (!a.recon) {
    return <Empty title="Nothing to reconcile yet">Upload the purchase register (or purchase invoices) and the GSTR-2B for the period – they are matched automatically.</Empty>;
  }
  const { rows, summary } = a.recon;
  const tax = (d?: { igst: number; cgst: number; sgst: number; cess: number }) => (d ? d.igst + d.cgst + d.sgst + d.cess : 0);
  const shown = rows.filter((r) => (status === 'problems' ? r.status !== 'matched' && r.status !== 'ignored' : status === 'all' || r.status === status));
  const src = a.purchases.portalSource === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B';
  const open = (r: ReconRow) => { const id = r.books?.origin?.file ?? r.portal?.origin?.file; if (id) onOpen(id); };
  return (
    <div className="space-y-4">
      <table className="ledger max-w-xl">
        <tbody>
          <tr><td>Purchase register – taxable</td><td className="num text-right">{rupees(summary.books.taxable)}</td><td className="text-ink-soft">ITC {rupees(summary.itc.books)}</td></tr>
          <tr><td>{src} – taxable</td><td className="num text-right">{rupees(summary.portal.taxable)}</td><td className="text-ink-soft">ITC {rupees(summary.itc.portal)}</td></tr>
          <tr className="font-semibold"><td>Difference</td><td className="num text-right">{rupees(summary.books.taxable - summary.portal.taxable)}</td><td className={Math.abs(summary.itc.difference) > 1 ? 'text-red-ink' : ''}>ITC {rupees(summary.itc.difference)}</td></tr>
        </tbody>
      </table>
      <div className="flex flex-wrap gap-2">
        {[['problems', 'Differences'], ['all', 'All'], ...Object.entries(STATUS).map(([k, [l]]) => [k, l])].map(([k, l]) => {
          const n = k === 'problems' ? rows.filter((r) => r.status !== 'matched' && r.status !== 'ignored').length : k === 'all' ? rows.length : summary.byStatus[k as keyof typeof summary.byStatus]?.count ?? 0;
          return <button key={k} type="button" onClick={() => setStatus(k)} className={`rounded-full border px-3 py-1 text-[12.5px] ${status === k ? 'border-ink bg-ink text-white' : 'border-rule bg-white'}`}>{l} ({n})</button>;
        })}
      </div>
      {!shown.length ? <p className="text-ink-soft">Nothing in this group.</p> : (
        <div className="-mx-5 overflow-x-auto">
          <table className="ledger">
            <thead><tr><th>Status</th><th>Supplier</th><th>Books</th><th className="text-right">Books tax</th><th>{src}</th><th className="text-right">{src} tax</th><th className="text-right">Difference</th><th>What differs</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const d = (r.books ?? r.portal)!;
                const diff = tax(r.books) - tax(r.portal);
                return (
                  <tr key={r.id} className="cursor-pointer" onClick={() => open(r)}>
                    <td><span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span></td>
                    <td className="max-w-56"><div className="truncate">{d.supplierName ?? '—'}</div><div className="num text-[11.5px] text-ink-soft">{d.supplierGstin}</div></td>
                    <td className="whitespace-nowrap">{r.books ? <>{r.books.docNo}<div className="text-[11.5px] text-ink-soft">{r.books.docDate}</div></> : '—'}</td>
                    <td className="num text-right">{r.books ? money(tax(r.books)) : '—'}</td>
                    <td className="whitespace-nowrap">{r.portal ? <>{r.portal.docNo}<div className="text-[11.5px] text-ink-soft">{r.portal.docDate}</div></> : '—'}</td>
                    <td className="num text-right">{r.portal ? money(tax(r.portal)) : '—'}</td>
                    <td className={`num text-right ${Math.abs(diff) > 1 ? 'text-red-ink' : ''}`}>{money(diff)}</td>
                    <td className="max-w-72 text-[12.5px]">{[...r.diffs.map((x) => `${DIFF[x.field] ?? x.field}: ${x.books} vs ${x.portal}`), ...r.notes].join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
