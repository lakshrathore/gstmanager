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
  empty: 'bg-black/[0.03] text-ink-soft', ok: 'bg-ledger-tint text-ledger', attention: 'bg-amber-tint text-amber', error: 'bg-red-tint text-red-ink',
};
const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function tip(c: Cell) {
  if (!c.records) return 'Nothing uploaded';
  return [
    `${c.records} records`, c.salesTaxable != null ? `Sales ${rs(c.salesTaxable)}` : '', c.purchaseTaxable != null ? `Purchases ${rs(c.purchaseTaxable)}` : '',
    c.itcBooks != null ? `ITC books ${rs(c.itcBooks)}` : '', c.itcPortal != null ? `ITC GSTR-2B ${rs(c.itcPortal)}` : '', c.bank ? `${c.bank} bank lines` : '', ...c.notes,
  ].filter(Boolean).join('\n');
}

export default function FirmPage() {
  const [fy, setFy] = useState(fyChoices()[0]);
  const [d, setD] = useState<Firm | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call<Firm>(`/api/docs/firm?fy=${fy}`).then((r) => { if (live) { setD(r); setErr(null); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [fy]);

  const attention = d?.clients.filter((c) => c.totals.errors || c.totals.review || c.totals.failed || Math.abs(c.totals.itcDiff) > 1 || c.cells.some((x) => x.missing2b)).length ?? 0;
  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Firm dashboard</h1>
          {d && <p className="text-ink-soft">{d.clients.length} client(s) · {attention} need attention · FY {fy}</p>}
        </div>
        <label>Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)}>{fyChoices().map((y) => <option key={y} value={y}>{y}</option>)}</select>
        </label>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {d && d.unassigned > 0 && <Notice tone="warn">{d.unassigned} uploaded document(s) are not assigned to a client yet – open <Link href="/documents" className="underline">Client documents</Link> to assign them.</Notice>}
      {d && !d.clients.length && <Empty title="No clients yet">Add clients on the Companies page, then upload their documents.</Empty>}
      {d && d.clients.length > 0 && (
        <>
          <div className="flex flex-wrap gap-3 text-[12px]">
            {([['ok', 'All fine'], ['attention', 'Review, ITC difference or GSTR-2B missing'], ['error', 'Errors'], ['empty', 'Nothing uploaded']] as const).map(([s, l]) => (
              <span key={s} className="flex items-center gap-1.5"><span className={`inline-block h-3 w-3 rounded ${TONE[s]}`} />{l}</span>
            ))}
          </div>
          <div className="-mx-4 overflow-x-auto md:mx-0">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Client</th>
                  {d.months.map((m) => <th key={m} className="text-center">{monthLabel(m).split(' ')[0]}</th>)}
                  <th className="text-right">To review</th><th className="text-right">Errors</th><th className="text-right">ITC difference</th><th>Files</th>
                </tr>
              </thead>
              <tbody>
                {d.clients.map((c) => (
                  <tr key={c._id}>
                    <td className="min-w-48"><Link href={`/documents?companyId=${c._id}&fy=${fy}`} className="font-medium hover:underline">{c.name}</Link><div className="num text-[11.5px] text-ink-soft">{c.gstin}</div></td>
                    {c.cells.map((x) => (
                      <td key={x.fp} className="p-1 text-center">
                        <Link href={`/documents?companyId=${c._id}&fy=${fy}&fp=${x.fp}`} title={tip(x)}
                          className={`block min-w-11 rounded px-1.5 py-1.5 text-[11.5px] font-medium ${TONE[x.state]}`}>
                          {x.state === 'empty' ? '·' : x.errors ? `${x.errors}✕` : x.review ? `${x.review}?` : x.missing2b ? '2B' : x.itcDiff != null && Math.abs(x.itcDiff) > 1 ? '₹≠' : '✓'}
                        </Link>
                      </td>
                    ))}
                    <td className="num text-right">{c.totals.review || ''}</td>
                    <td className={`num text-right ${c.totals.errors ? 'text-red-ink' : ''}`}>{c.totals.errors || ''}</td>
                    <td className={`num text-right ${Math.abs(c.totals.itcDiff) > 1 ? 'text-red-ink' : ''}`}>{Math.abs(c.totals.itcDiff) > 1 ? rs(c.totals.itcDiff) : ''}</td>
                    <td className="whitespace-nowrap text-[12px]">
                      {c.totals.processing > 0 && <span className="mr-2 text-ink-soft">{c.totals.processing} reading</span>}
                      {c.totals.failed > 0 && <span className="mr-2 text-red-ink">{c.totals.failed} failed</span>}
                      {c.totals.needsReview > 0 && <span className="text-amber">{c.totals.needsReview} to check</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-ink-soft">Cell: ✓ fine · n? records to review · n✕ records with errors · 2B GSTR-2B not uploaded · ₹≠ ITC difference. Hover for the figures; click to open the month.</p>
        </>
      )}
    </div>
  );
}
