'use client';

import { useEffect, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface Company { _id: string; name: string; gstin: string; stateCode: string; aatoAbove5Cr: boolean; filingFrequency: string }

export default function CompaniesPage() {
  const [list, setList] = useState<Company[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => call<{ companies: Company[] }>('/api/companies').then((r) => setList(r.companies));
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setErr(null);
    try {
      await call('/api/companies', { method: 'POST', json: { name: f.get('name'), gstin: f.get('gstin'), filingFrequency: f.get('filingFrequency'), aatoAbove5Cr: f.get('aato') === 'on' } });
      form.reset(); await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Companies</h1>
      <Panel title="Add a company">
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-2">
          <label>Legal name<input name="name" required /></label>
          <label>GSTIN<input name="gstin" required maxLength={15} className="num uppercase" placeholder="29ABCDE1234F1Z5" /></label>
          <label>Filing frequency
            <select name="filingFrequency"><option value="monthly">Monthly</option><option value="quarterly">Quarterly (QRMP)</option></select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-ink"><input type="checkbox" name="aato" className="w-auto" />Turnover above ₹5 crore (6-digit HSN)</label>
          {err && <div className="sm:col-span-2"><Notice tone="error">{err}</Notice></div>}
          <div><Button busy={busy} type="submit">Add company</Button></div>
        </form>
      </Panel>
      <Panel title={`${list.length} ${list.length === 1 ? 'company' : 'companies'}`}>
        <div className="-mx-5 overflow-x-auto">
          <table className="ledger">
            <thead><tr><th>Name</th><th>GSTIN</th><th>State</th><th>Filing</th><th>HSN digits</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c._id}><td className="font-medium">{c.name}</td><td className="num">{c.gstin}</td><td className="num">{c.stateCode}</td><td className="capitalize">{c.filingFrequency}</td><td>{c.aatoAbove5Cr ? 6 : 4}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
