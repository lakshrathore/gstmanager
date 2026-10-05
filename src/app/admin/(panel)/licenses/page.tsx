'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, fmtDate, LicenseBadge, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface Lic {
  _id: string; key: string; status: string; expired: boolean; packageName: string; orgName: string | null;
  issuedTo?: string; note?: string; durationDays: number; activatedAt?: string; expiresAt?: string; createdAt: string;
}
interface Pkg { _id: string; name: string; durationDays: number; active: boolean }

const STATUSES = ['unused', 'active', 'suspended', 'revoked', 'replaced'];

export default function LicensesPage() {
  const [list, setList] = useState<Lic[] | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    return call<{ licenses: Lic[] }>(`/api/admin/licenses?${p}`).then((r) => setList(r.licenses)).catch((e) => setErr(e.message));
  }, [status, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { call<{ packages: Pkg[] }>('/api/admin/packages').then((r) => setPkgs(r.packages.filter((p) => p.active))).catch(() => {}); }, []);

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await load(); } catch (x) { setErr((x as Error).message); }
  }

  async function generate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ licenses: Lic[] }>('/api/admin/licenses', {
        method: 'POST', json: { packageId: f.packageId, count: f.count, durationDays: f.durationDays || undefined, issuedTo: f.issuedTo || undefined, note: f.note || undefined },
      });
      setFresh(r.licenses.map((l) => l.key));
      form.reset();
      await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  async function copy(text: string, id: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ }
  }

  const statusOf = (l: Lic) => (l.expired ? 'expired' : l.status);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Licenses</h1>
      {err && <Notice tone="error">{err}</Notice>}

      <Panel title="Generate license keys">
        {!pkgs.length ? <p className="text-ink-soft">Create a package first.</p> : (
          <form onSubmit={generate} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <label className="lg:col-span-2">Package
              <select name="packageId" required>{pkgs.map((p) => <option key={p._id} value={p._id}>{p.name} ({p.durationDays} days)</option>)}</select>
            </label>
            <label>How many<input name="count" type="number" min={1} max={100} defaultValue={1} required /></label>
            <label>Validity days<input name="durationDays" type="number" min={1} placeholder="from package" /></label>
            <label>Issued to<input name="issuedTo" maxLength={120} placeholder="Customer name" /></label>
            <label className="sm:col-span-2 lg:col-span-4">Note<input name="note" maxLength={500} placeholder="Invoice no., payment ref…" /></label>
            <div className="self-end"><Button busy={busy} type="submit">Generate</Button></div>
          </form>
        )}
        {fresh.length > 0 && (
          <div className="mt-4 rounded-md border border-ledger/30 bg-ledger-tint p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-ledger">{fresh.length} new key{fresh.length > 1 ? 's' : ''} – send to the customer; they activate it on their License page.</p>
              <Button variant="secondary" onClick={() => copy(fresh.join('\n'), 'fresh')}>{copied === 'fresh' ? 'Copied' : 'Copy all'}</Button>
            </div>
            <pre className="num mt-2 whitespace-pre-wrap text-[13px]">{fresh.join('\n')}</pre>
          </div>
        )}
      </Panel>

      <Panel title="All licenses" action={
        <div className="flex gap-2">
          <select className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
          <input className="w-48" placeholder="Search key or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      }>
        {list && !list.length ? <Empty title="No licenses found" /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Key</th><th>Package</th><th>Status</th><th>Customer</th><th>Validity</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {list?.map((l) => (
                  <tr key={l._id}>
                    <td>
                      <button className="num whitespace-nowrap text-left hover:text-ledger" title="Copy" onClick={() => copy(l.key, l._id)}>{l.key}</button>
                      {copied === l._id && <span className="ml-2 text-[12px] text-ledger">Copied</span>}
                    </td>
                    <td>{l.packageName}</td>
                    <td><LicenseBadge status={statusOf(l)} /></td>
                    <td>
                      {l.orgName ? <p className="font-medium">{l.orgName}</p> : null}
                      <p className="text-[12px] text-ink-soft">{l.issuedTo ?? ''}{l.note ? ` · ${l.note}` : ''}</p>
                    </td>
                    <td className="num whitespace-nowrap">{l.durationDays} d</td>
                    <td className="whitespace-nowrap">{l.status === 'unused' ? 'On activation' : fmtDate(l.expiresAt)}</td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-1">
                        {l.status !== 'revoked' && l.status !== 'replaced' && (
                          <Button variant="ghost" onClick={() => { const d = prompt('Extend by how many days? (negative to shorten)', '30'); if (d && Number(d)) act(() => call(`/api/admin/licenses/${l._id}`, { method: 'PATCH', json: { action: 'extend', days: Number(d) } })); }}>Extend</Button>
                        )}
                        {l.status === 'active' && <Button variant="ghost" onClick={() => act(() => call(`/api/admin/licenses/${l._id}`, { method: 'PATCH', json: { action: 'suspend' } }))}>Suspend</Button>}
                        {l.status === 'suspended' && <Button variant="ghost" onClick={() => act(() => call(`/api/admin/licenses/${l._id}`, { method: 'PATCH', json: { action: 'resume' } }))}>Resume</Button>}
                        {(l.status === 'active' || l.status === 'suspended' || l.status === 'unused') && (
                          <Button variant="ghost" onClick={() => confirm(`Revoke ${l.key}? This cannot be undone.`) && act(() => call(`/api/admin/licenses/${l._id}`, { method: 'PATCH', json: { action: 'revoke' } }))}>Revoke</Button>
                        )}
                        {l.status === 'unused' && <Button variant="danger" onClick={() => confirm(`Delete ${l.key}?`) && act(() => call(`/api/admin/licenses/${l._id}`, { method: 'DELETE' }))}>Delete</Button>}
                      </div>
                    </td>
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
