'use client';

import { useEffect, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

type Limits = { companies: number; users: number; returnsPerMonth: number };
interface Pkg {
  _id: string; name: string; description?: string; priceInr: number; durationDays: number; limits: Limits;
  features: string[]; aiBudgetInr?: number; isTrial: boolean; active: boolean; licenses: number; activeLicenses: number;
}

const BLANK: Omit<Pkg, '_id' | 'licenses' | 'activeLicenses'> = {
  name: '', description: '', priceInr: 0, durationDays: 365, limits: { companies: 5, users: 3, returnsPerMonth: 0 }, features: ['validators'], aiBudgetInr: 0, isTrial: false, active: true,
};

export default function PackagesPage() {
  const [list, setList] = useState<Pkg[] | null>(null);
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({});
  const [limitLabels, setLimitLabels] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => call<{ packages: Pkg[]; featureLabels: Record<string, string>; limitLabels: Record<string, string> }>('/api/admin/packages')
    .then((r) => { setList(r.packages); setFeatureLabels(r.featureLabels); setLimitLabels(r.limitLabels); })
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await load(); } catch (x) { setErr((x as Error).message); }
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: f.get('name'), description: f.get('description'), priceInr: f.get('priceInr'), durationDays: f.get('durationDays'),
      limits: { companies: f.get('companies'), users: f.get('users'), returnsPerMonth: f.get('returnsPerMonth') },
      features: f.getAll('features'), aiBudgetInr: f.get('aiBudgetInr') || 0, isTrial: f.get('isTrial') === 'on', active: f.get('active') === 'on',
    };
    setBusy(true);
    setErr(null);
    try {
      await call(editing === 'new' ? '/api/admin/packages' : `/api/admin/packages/${editing}`, { method: editing === 'new' ? 'POST' : 'PATCH', json: body });
      setEditing(null);
      await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  const current = editing && editing !== 'new' ? list?.find((p) => p._id === editing) : BLANK;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-tight">Packages</h1>
        {!editing && <Button onClick={() => setEditing('new')}>New package</Button>}
      </div>
      {err && <Notice tone="error">{err}</Notice>}

      {editing && current && (
        <Panel title={editing === 'new' ? 'New package' : `Edit ${current.name}`}>
          <form key={editing} onSubmit={save} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="sm:col-span-2">Name<input name="name" required minLength={2} defaultValue={current.name} placeholder="e.g. Professional" /></label>
            <label>Price (₹)<input name="priceInr" type="number" min={0} step="1" required defaultValue={current.priceInr} /></label>
            <label>Validity (days)<input name="durationDays" type="number" min={1} required defaultValue={current.durationDays} /></label>
            <label className="sm:col-span-2 lg:col-span-4">Description<input name="description" defaultValue={current.description ?? ''} placeholder="Shown to you only" /></label>
            {(['companies', 'users', 'returnsPerMonth'] as const).map((k) => (
              <label key={k}>{limitLabels[k] ?? k}<input name={k} type="number" min={0} required defaultValue={current.limits[k]} /></label>
            ))}
            <p className="self-end pb-2 text-[12.5px] text-ink-soft">0 = unlimited</p>
            <label>Document AI per month (₹)<input name="aiBudgetInr" type="number" min={0} step="1" defaultValue={current.aiBudgetInr ?? 0} /></label>
            <p className="self-end pb-2 text-[12.5px] text-ink-soft sm:col-span-3">AI API spend (Claude or Groq) allowed per calendar month when “Document AI” is ticked below (0 = no limit). Calls are refused once it is used up.</p>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-[12.5px] text-ink-soft">Features</legend>
              {Object.entries(featureLabels).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-[13.5px] text-ink">
                  <input type="checkbox" name="features" value={k} defaultChecked={current.features.includes(k)} className="w-auto" />{label}
                </label>
              ))}
            </fieldset>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-[12.5px] text-ink-soft">Options</legend>
              <label className="flex items-center gap-2 text-[13.5px] text-ink"><input type="checkbox" name="isTrial" defaultChecked={current.isTrial} className="w-auto" />Trial package – given automatically to new sign-ups</label>
              <label className="flex items-center gap-2 text-[13.5px] text-ink"><input type="checkbox" name="active" defaultChecked={current.active} className="w-auto" />Available for new licenses</label>
            </fieldset>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
              <Button busy={busy} type="submit">Save package</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      {list && !list.length && !editing && <Empty title="No packages yet">Create packages like Basic, Professional and Enterprise with their limits and price, then issue license keys for them.</Empty>}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {list?.map((p) => (
          <section key={p._id} className={`rounded-lg border border-rule bg-sheet p-5 ${p.active ? '' : 'opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-[16px] font-semibold">{p.name}</h2>
                <p className="num text-[20px] font-semibold">₹{p.priceInr.toLocaleString('en-IN')} <span className="text-[12.5px] font-normal text-ink-soft">/ {p.durationDays} days</span></p>
              </div>
              <div className="flex flex-col items-end gap-1">
                {p.isTrial && <span className="rounded bg-amber-tint px-2 py-0.5 text-[12px] font-medium text-amber">Trial</span>}
                {!p.active && <span className="rounded bg-black/5 px-2 py-0.5 text-[12px] text-ink-soft">Archived</span>}
              </div>
            </div>
            {p.description && <p className="mt-1 text-ink-soft">{p.description}</p>}
            <ul className="mt-3 space-y-0.5 text-[13px]">
              {(['companies', 'users', 'returnsPerMonth'] as const).map((k) => <li key={k}>{limitLabels[k]}: <b className="num">{p.limits[k] || 'Unlimited'}</b></li>)}
              {p.features.map((f) => <li key={f}>✓ {featureLabels[f] ?? f}{f === 'documentAI' ? ` (${p.aiBudgetInr ? `₹${p.aiBudgetInr.toLocaleString('en-IN')}/month` : 'no monthly limit'})` : ''}</li>)}
            </ul>
            <p className="mt-3 text-[12.5px] text-ink-soft">{p.activeLicenses} active · {p.licenses} keys issued</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing(p._id)}>Edit</Button>
              <Button variant="ghost" onClick={() => act(() => call(`/api/admin/packages/${p._id}`, { method: 'PATCH', json: { active: !p.active } }))}>{p.active ? 'Archive' : 'Restore'}</Button>
              {!p.licenses && <Button variant="danger" onClick={() => confirm(`Delete package ${p.name}?`) && act(() => call(`/api/admin/packages/${p._id}`, { method: 'DELETE' }))}>Delete</Button>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
