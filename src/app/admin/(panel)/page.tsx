'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Empty, fmtDate, LicenseBadge, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

type Limits = { companies: number; users: number; returnsPerMonth: number };
interface Org {
  _id: string; name: string; createdAt: string;
  owner: { name: string; email: string } | null;
  license: { status: string; id: string | null; key: string | null; expiresAt: string | null; daysLeft: number | null; plan: { name: string; limits: Limits; extras?: Limits } | null };
  usage: Limits;
}
interface Stats { orgs: number; licensed: number; expiringSoon: number; unlicensed: number; unusedKeys: number; users: number; pendingPayments: number }
interface Pkg { _id: string; name: string; durationDays: number; active: boolean }

const use = (used: number, max: number | undefined, extra?: number) => `${used}/${max ? max : '∞'}${extra ? ` (+${extra})` : ''}`;

export default function CustomersPage() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = () => call<{ orgs: Org[]; stats: Stats }>('/api/admin/orgs').then((r) => { setOrgs(r.orgs); setStats(r.stats); }).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    call<{ packages: Pkg[] }>('/api/admin/packages').then((r) => setPkgs(r.packages.filter((p) => p.active))).catch(() => {});
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await load(); } catch (x) { setErr((x as Error).message); }
  }

  /** Set add-ons by hand (e.g. a free extra company): "companies, team members, returns per month". */
  function setExtras(licenseId: string, cur?: Limits) {
    const v = prompt('Add-ons on top of the plan – companies, team members, returns per month (e.g. 1, 0, 10):', `${cur?.companies ?? 0}, ${cur?.users ?? 0}, ${cur?.returnsPerMonth ?? 0}`);
    if (v == null) return;
    const [companies, users, returnsPerMonth] = v.split(',').map((x) => Number(x.trim()));
    if ([companies, users, returnsPerMonth].some((n) => !Number.isInteger(n) || n < 0)) { setErr('Enter three whole numbers, e.g. 1, 0, 10'); return; }
    act(() => call(`/api/admin/licenses/${licenseId}`, { method: 'PATCH', json: { action: 'extras', companies, users, returnsPerMonth } }));
  }

  async function assign(e: React.FormEvent<HTMLFormElement>, orgId: string) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await act(() => call('/api/admin/licenses', { method: 'POST', json: { orgId, packageId: f.packageId, durationDays: f.durationDays || undefined } }));
    setAssigning(null);
  }

  const shown = (orgs ?? []).filter((o) => !filter || `${o.name} ${o.owner?.email ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const tiles: [string, number | undefined, string?][] = [
    ['Customers', stats?.orgs], ['Licensed', stats?.licensed], ['Expiring in 7 days', stats?.expiringSoon, 'text-amber'],
    ['Without valid license', stats?.unlicensed, 'text-red-ink'], ['Unused keys', stats?.unusedKeys], ['Active users', stats?.users],
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Customers</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, n, tone]) => (
          <div key={label} className="rounded-lg border border-rule bg-sheet px-4 py-3">
            <p className="text-[12px] text-ink-soft">{label}</p>
            <p className={`num text-[22px] font-semibold ${tone ?? ''}`}>{n ?? '–'}</p>
          </div>
        ))}
      </div>
      {!!stats?.pendingPayments && <Notice tone="warn">{stats.pendingPayments} payment{stats.pendingPayments > 1 ? 's are' : ' is'} waiting for approval. <Link href="/admin/payments" className="font-semibold underline">Review payments</Link></Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {!pkgs.length && orgs && <Notice tone="warn">Create a package first (Packages page) – then you can assign it to customers or generate license keys.</Notice>}
      <Panel title="Organisations" action={<input className="max-w-56" placeholder="Search name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        {orgs && !orgs.length ? <Empty title="No customers yet">Firms appear here when they register.</Empty> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Organisation</th><th>Plan</th><th>Status</th><th>Expires</th><th>Companies</th><th>Users</th><th>Returns (month)</th><th /></tr></thead>
              <tbody>
                {shown.map((o) => {
                  const L = o.license;
                  return (
                    <tr key={o._id}>
                      <td>
                        <p className="font-medium">{o.name}</p>
                        <p className="text-[12px] text-ink-soft">{o.owner ? `${o.owner.name} · ${o.owner.email}` : 'No owner'}</p>
                        {assigning === o._id && (
                          <form onSubmit={(e) => assign(e, o._id)} className="mt-2 flex flex-wrap items-end gap-2">
                            <label>Package
                              <select name="packageId" required>{pkgs.map((p) => <option key={p._id} value={p._id}>{p.name} ({p.durationDays} days)</option>)}</select>
                            </label>
                            <label className="w-28">Days (optional)<input name="durationDays" type="number" min={1} placeholder="package" /></label>
                            <Button type="submit">Assign</Button>
                            <Button type="button" variant="ghost" onClick={() => setAssigning(null)}>Cancel</Button>
                          </form>
                        )}
                      </td>
                      <td>{L.plan?.name ?? '—'}</td>
                      <td><LicenseBadge status={L.status} /></td>
                      <td className="whitespace-nowrap">{fmtDate(L.expiresAt)}{L.status === 'active' && L.daysLeft != null && <p className={`text-[12px] ${L.daysLeft <= 7 ? 'text-amber' : 'text-ink-soft'}`}>{L.daysLeft} days left</p>}</td>
                      <td className="num">{use(o.usage.companies, L.plan?.limits.companies, L.plan?.extras?.companies)}</td>
                      <td className="num">{use(o.usage.users, L.plan?.limits.users, L.plan?.extras?.users)}</td>
                      <td className="num">{use(o.usage.returnsPerMonth, L.plan?.limits.returnsPerMonth, L.plan?.extras?.returnsPerMonth)}</td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button variant="secondary" disabled={!pkgs.length} onClick={() => setAssigning(o._id)}>{L.status === 'none' ? 'Assign plan' : 'Change / renew'}</Button>
                          {L.id && L.status !== 'revoked' && <Button variant="ghost" onClick={() => act(() => call(`/api/admin/licenses/${L.id}`, { method: 'PATCH', json: { action: 'extend', days: 30 } }))}>+30 days</Button>}
                          {L.id && L.status !== 'revoked' && <Button variant="ghost" onClick={() => setExtras(L.id!, L.plan?.extras)}>Add-ons</Button>}
                          {L.id && L.status === 'active' && <Button variant="ghost" onClick={() => act(() => call(`/api/admin/licenses/${L.id}`, { method: 'PATCH', json: { action: 'suspend' } }))}>Suspend</Button>}
                          {L.id && L.status === 'suspended' && <Button variant="ghost" onClick={() => act(() => call(`/api/admin/licenses/${L.id}`, { method: 'PATCH', json: { action: 'resume' } }))}>Resume</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
