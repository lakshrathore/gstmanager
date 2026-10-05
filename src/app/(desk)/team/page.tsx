'use client';

import { useEffect, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface U { _id: string; name: string; email: string; role: string; active: boolean }
const ROLE_HELP: Record<string, string> = {
  admin: 'Everything except ownership', preparer: 'Import, edit, validate, generate JSON',
  reviewer: 'Review, sign in to the portal, upload', viewer: 'Read only',
};

export default function TeamPage() {
  const [users, setUsers] = useState<U[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () => call<{ users: U[] }>('/api/users').then((r) => setUsers(r.users)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setErr(null);
    try { await call('/api/users', { method: 'POST', json: Object.fromEntries(new FormData(form)) }); form.reset(); load(); }
    catch (x) { setErr((x as Error).message); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Team</h1>
      <Panel title="Add a team member">
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-2">
          <label>Name<input name="name" required /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>Temporary password<input name="password" type="password" minLength={10} required autoComplete="new-password" /></label>
          <label>Role
            <select name="role">{Object.entries(ROLE_HELP).map(([r, h]) => <option key={r} value={r}>{r} — {h}</option>)}</select>
          </label>
          {err && <div className="sm:col-span-2"><Notice tone="error">{err}</Notice></div>}
          <div><Button type="submit">Add member</Button></div>
        </form>
      </Panel>
      <Panel title="Members">
        <div className="-mx-5 overflow-x-auto">
          <table className="ledger"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>{users.map((u) => <tr key={u._id}><td>{u.name}</td><td>{u.email}</td><td className="capitalize">{u.role}</td><td>{u.active ? 'Active' : 'Disabled'}</td></tr>)}</tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
