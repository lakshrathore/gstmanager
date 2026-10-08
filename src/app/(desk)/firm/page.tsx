'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Empty, Notice } from '@/components/ui';
import { monthLabel } from '@/components/docs/types';
import { call } from '@/lib/client';
import { fyChoices } from '@/server/gst/annual/common';

/**
 * Firm dashboard: all clients × the months of a year. Green is fine, amber needs a look (review,
 * ITC difference, GSTR-2B missing), red has errors – clients that need the CA come first.
 */

type State = 'empty' | 'ok' | 'attention' | 'error';
interface Cell {
  fp: string; state: State; records: number; review: number; errors: number; salesTaxable: number | null; purchaseTaxable: number | null;
  itcBooks: number | null; itcPortal: number | null; itcDiff: number | null; missing2b: boolean; bank: number; notes: string[];
}
interface Client {
  _id: string; name: string; gstin: string; cells: Cell[];
  totals: { review: number; errors: number; itcDiff: number; failed: number; processing: number; needsReview: number; monthsWithData: number };
}
interface Firm { fy: string; months: string[]; clients: Client[]; unassigned: number }

const TONE: Record<State, string> = {
  empty: 'border border-dashed border-rule', ok: 'bg-ledger-tint text-ledger', attention: 'bg-amber-tint text-amber', error: 'bg-red-tint text-red-ink',
};
const LEGEND: [State, string, string][] = [
  ['ok', '✓', 'All fine'], ['attention', 'n?', 'To review'], ['attention', '2B', 'GSTR-2B missing'], ['attention', '₹≠', 'ITC difference'],
  ['error', 'n✕', 'Errors'], ['empty', '', 'Nothing uploaded'],
];
const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function tip(c: Cell) {
  if (!c.records) return 'Nothing uploaded';
  return [
    `${c.records} records`, c.salesTaxable != null ? `Sales ${rs(c.salesTaxable)}` : '', c.purchaseTaxable != null ? `Purchases ${rs(c.purchaseTaxable)}` : '',
    c.itcBooks != null ? `ITC books ${rs(c.itcBooks)}` : '', c.itcPortal != null ? `ITC GSTR-2B ${rs(c.itcPortal)}` : '', c.bank ? `${c.bank} bank lines` : '', ...c.notes,
  ].filter(Boolean).join('\n');
}
const mark = (x: Cell) => (x.state === 'empty' ? '' : x.errors ? `${x.errors}✕` : x.review ? `${x.review}?` : x.missing2b ? '2B' : x.itcDiff != null && Math.abs(x.itcDiff) > 1 ? '₹≠' : '✓');
const needsAttention = (c: Client) => !!(c.totals.errors || c.totals.review || c.totals.failed || Math.abs(c.totals.itcDiff) > 1 || c.cells.some((x) => x.missing2b));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What needs doing for a client, as short coloured notes under its name. */
function Summary({ c }: { c: Client }) {
  const t = c.totals;
  const parts: [string, string][] = [];
  if (t.errors) parts.push([plural(t.errors, 'error'), 'text-red-ink']);
  if (t.review) parts.push([`${t.review} to review`, 'text-amber']);
  if (Math.abs(t.itcDiff) > 1) parts.push([`ITC diff ${rs(t.itcDiff)}`, 'text-red-ink']);
  if (t.failed) parts.push([`${plural(t.failed, 'file')} failed`, 'text-red-ink']);
  if (t.needsReview) parts.push([`${plural(t.needsReview, 'file')} to check`, 'text-amber']);
  if (t.processing) parts.push([`${t.processing} reading…`, 'text-ink-soft']);
  if (!parts.length) parts.push([t.monthsWithData ? `${plural(t.monthsWithData, 'month')} · all fine` : 'Nothing uploaded', 'text-ink-soft']);
  return <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px]">{parts.map(([s, cls]) => <span key={s} className={cls}>{s}</span>)}</div>;
}

export default function FirmPage() {
  const [fy, setFy] = useState(fyChoices()[0]);
  const [d, setD] = useState<Firm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);

  useEffect(() => {
    let live = true;
    call<Firm>(`/api/docs/firm?fy=${fy}`).then((r) => { if (live) { setD(r); setErr(null); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [fy]);

  const attention = d?.clients.filter(needsAttention).length ?? 0;
  const term = q.trim().toLowerCase();
  const shown = (d?.clients ?? []).filter((c) => (!onlyAttention || needsAttention(c)) && (!term || c.name.toLowerCase().includes(term) || c.gstin.toLowerCase().includes(term)));
  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Firm dashboard</h1>
          {d && <p className="text-ink-soft">{plural(d.clients.length, 'client')} · <span className={attention ? 'font-medium text-amber' : ''}>{attention} need attention</span> · FY {fy}</p>}
        </div>
        <label className="w-36">Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)}>{fyChoices().map((y) => <option key={y} value={y}>{y}</option>)}</select>
        </label>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {d && d.unassigned > 0 && <Notice tone="warn">{d.unassigned} uploaded document(s) are not assigned to a client yet – open <Link href="/documents" className="underline">Client documents</Link> to assign them.</Notice>}
      {d && !d.clients.length && <Empty title="No clients yet">Add clients on the Companies page, then upload their documents.</Empty>}
      {d && d.clients.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-rule bg-white">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-rule px-4 py-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or GSTIN" className="max-w-60" aria-label="Search clients" />
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} className="w-auto" />Needs attention only
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-soft lg:ml-auto">
              {LEGEND.map(([s, m, l]) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={`inline-flex h-5 min-w-7 items-center justify-center rounded px-1 text-[10.5px] font-semibold ${TONE[s]}`}>{m}</span>{l}
                </span>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="ledger min-w-[720px] table-fixed">
              <colgroup><col className="w-48 xl:w-60" />{d.months.map((m) => <col key={m} />)}</colgroup>
              <thead>
                <tr>
                  <th className="pl-4">Client</th>
                  {d.months.map((m) => <th key={m} className="px-1 text-center">{monthLabel(m).split(' ')[0]}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c._id}>
                    <td className="pl-4">
                      <Link href={`/documents?companyId=${c._id}&fy=${fy}`} className="block truncate font-medium hover:underline" title={c.name}>{c.name}</Link>
                      <div className="num text-[11.5px] text-ink-soft">{c.gstin}</div>
                      <Summary c={c} />
                    </td>
                    {c.cells.map((x) => (
                      <td key={x.fp} className="px-1 align-middle">
                        <Link href={`/documents?companyId=${c._id}&fy=${fy}&fp=${x.fp}`} title={tip(x)} aria-label={`${monthLabel(x.fp)}: ${tip(x)}`}
                          className={`flex h-8 items-center justify-center rounded text-[11.5px] font-semibold transition-opacity hover:opacity-75 ${TONE[x.state]}`}>
                          {mark(x)}
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={d.months.length + 1} className="py-8 text-center text-ink-soft">No clients match.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-rule px-4 py-2.5 text-[12px] text-ink-soft">Hover a month for its figures, click it to open that month. Clients that need attention are listed first.</p>
        </div>
      )}
    </div>
  );
}
