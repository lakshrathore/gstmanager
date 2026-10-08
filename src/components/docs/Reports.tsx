'use client';

import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui';
import { call } from '@/lib/client';
import { REPORTS, type ReportTable } from '@/engine/docs';
import { money } from './types';

/** Any report on screen (rows open their record) and as Excel. */
export function Reports({ companyId, fy, fp, onOpen, refresh }: { companyId: string; fy: string; fp: string | null; onOpen: (id: string) => void; refresh: number }) {
  const [id, setId] = useState('sales_summary');
  const [data, setData] = useState<{ table: ReportTable; totals: Record<string, number | null> | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = `report=${id}&companyId=${companyId}&fy=${fy}${fp ? `&fp=${fp}` : ''}`;

  useEffect(() => {
    let live = true;
    call<{ table: ReportTable; totals: Record<string, number | null> | null }>(`/api/docs/reports?${q}`)
      .then((r) => { if (live) { setData(r); setErr(null); } })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [q, refresh]);

  const groups = [...new Set(REPORTS.map((r) => r.group))];
  const t = data?.table;
  const cell = (v: string | number | null | undefined, type?: string) => (v == null || v === '' ? '' : type === 'money' ? money(Number(v)) : type === 'num' ? Number(v).toLocaleString('en-IN') : String(v));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-72">Report
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {groups.map((g) => <optgroup key={g} label={g}>{REPORTS.filter((r) => r.group === g).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</optgroup>)}
          </select>
        </label>
        <a className="pb-2 text-[13px] text-ledger underline" href={`/api/docs/reports?${q}&format=xlsx`}>Download Excel</a>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {t && (
        <>
          <div>
            <h3 className="font-semibold">{t.title}</h3>
            {t.note && <p className="text-[12.5px] text-ink-soft">{t.note}</p>}
          </div>
          {!t.rows.length ? <p className="text-ink-soft">Nothing to show for this period.</p> : (
            <div className="-mx-5 max-h-[70vh] overflow-auto">
              <table className="ledger">
                <thead className="sticky top-0 bg-sheet"><tr>{t.columns.map((c) => <th key={c.key} className={c.type ? 'text-right' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {t.rows.map((r, i) => {
                    const rid = t.recordIds?.[i];
                    return (
                      <tr key={i} className={rid ? 'cursor-pointer' : ''} onClick={rid ? () => onOpen(rid) : undefined}>
                        {t.columns.map((c) => <td key={c.key} className={c.type ? `num text-right ${c.type === 'money' && Number(r[c.key]) < 0 ? 'text-red-ink' : ''}` : c.key === 'missing' || c.key === 'why' || c.key === 'issue' ? 'max-w-md text-[12.5px]' : ''}>{cell(r[c.key], c.type)}</td>)}
                      </tr>
                    );
                  })}
                  {data.totals && (
                    <tr className="row-calc">{t.columns.map((c, j) => <td key={c.key} className={c.type ? 'num text-right' : ''}>{j === 0 ? 'Total' : c.key in data.totals! ? cell(data.totals![c.key], c.type) : ''}</td>)}</tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
