'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Notice, Panel, StatusBadge } from '@/components/ui';
import { call, periodLabel } from '@/lib/client';

interface Company { _id: string; name: string; gstin: string; filingFrequency: string }
interface Ret { _id: string; fp: string; fy: string; status: string; updatedAt: string; summary?: { total: number; errorCount: number; valid: number }; company?: { name: string; gstin: string } }

function periodOptions(quarterly: boolean) {
  const out: { fp: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < 18; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const mm = m.getMonth() + 1;
    if (quarterly && mm % 3 !== 0) continue;
    const fp = `${String(mm).padStart(2, '0')}${m.getFullYear()}`;
    out.push({ fp, label: quarterly ? `Quarter ending ${periodLabel(fp)}` : periodLabel(fp) });
  }
  return out;
}

export default function ReturnsPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [returns, setReturns] = useState<Ret[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fp, setFp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => { setCompanies(r.companies); if (r.companies[0]) setCompanyId(r.companies[0]._id); }).catch((e) => setErr(e.message));
    call<{ returns: Ret[] }>('/api/returns').then((r) => setReturns(r.returns)).catch(() => {});
  }, []);

  const company = companies?.find((c) => c._id === companyId);
  const periods = useMemo(() => periodOptions(company?.filingFrequency === 'quarterly'), [company]);
  const period = periods.some((p) => p.fp === fp) ? fp : periods[1]?.fp ?? '';

  async function open() {
    setBusy(true); setErr(null);
    try {
      const r = await call<{ return: { _id: string } }>('/api/returns', { method: 'POST', json: { companyId, fp: period } });
      router.push(`/returns/${r.return._id}`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">GSTR-1 returns</h1>

      {companies && companies.length === 0 ? (
        <Empty title="Add a company to start">Each GSTIN you file for is a company. <Link href="/companies" className="text-ledger underline">Add a company</Link></Empty>
      ) : (
        <Panel title="Open a return">
          <div className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <label>Company / GSTIN
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companies?.map((c) => <option key={c._id} value={c._id}>{c.name} — {c.gstin}</option>)}
              </select>
            </label>
            <label>Return period
              <select value={period} onChange={(e) => setFp(e.target.value)}>
                {periods.map((p) => <option key={p.fp} value={p.fp}>{p.label}</option>)}
              </select>
            </label>
            <Button onClick={open} busy={busy} disabled={!companyId || !period}>Open return</Button>
          </div>
          {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
        </Panel>
      )}

      <Panel title="Recent returns">
        {returns.length === 0 ? <p className="text-ink-soft">No returns yet. Open one above to import your GSTR-1 Excel.</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Company</th><th>GSTIN</th><th>Period</th><th>Status</th><th className="text-right">Records</th><th className="text-right">Errors</th><th>Updated</th></tr></thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r._id} className={r.summary?.errorCount ? 'row-error' : ''}>
                    <td><Link className="font-medium text-ledger hover:underline" href={`/returns/${r._id}`}>{r.company?.name}</Link></td>
                    <td className="num">{r.company?.gstin}</td>
                    <td>{periodLabel(r.fp)}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="num text-right">{r.summary?.total ?? '—'}</td>
                    <td className={`num text-right ${r.summary?.errorCount ? 'text-red-ink' : ''}`}>{r.summary?.errorCount ?? '—'}</td>
                    <td className="text-ink-soft">{new Date(r.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
