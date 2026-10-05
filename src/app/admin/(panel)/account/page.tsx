'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

export default function AdminAccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<{ admin: { name: string; email: string } }>('/api/admin/account').then((r) => setMe(r.admin)).catch(() => {}); }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setMsg(null);
    if (f.newPassword && f.newPassword !== f.confirmPassword) return setMsg({ tone: 'error', text: 'New passwords do not match' });
    setBusy(true);
    try {
      const r = await call<{ admin: { name: string; email: string } }>('/api/admin/account', {
        method: 'PATCH', json: { currentPassword: f.currentPassword, name: f.name || undefined, email: f.email || undefined, newPassword: f.newPassword || undefined },
      });
      setMe(r.admin);
      form.reset();
      setMsg({ tone: 'ok', text: 'Saved. Use the new details next time you sign in.' });
      router.refresh();
    } catch (x) { setMsg({ tone: 'error', text: (x as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">My account</h1>
      <Panel title="Sign-in details">
        {me && (
          <form key={me.email} onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <label>Name<input name="name" defaultValue={me.name} minLength={2} /></label>
            <label>Email<input name="email" type="email" defaultValue={me.email} autoComplete="username" /></label>
            <label>New password<input name="newPassword" type="password" minLength={10} autoComplete="new-password" placeholder="Leave blank to keep" /></label>
            <label>Confirm new password<input name="confirmPassword" type="password" minLength={10} autoComplete="new-password" /></label>
            <label className="sm:col-span-2">Current password (required to save)<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
            {msg && <div className="sm:col-span-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
            <div className="flex gap-2">
              <Button busy={busy} type="submit">Save changes</Button>
              <Button type="button" variant="ghost" onClick={async () => { await call('/api/admin/auth/logout', { method: 'POST' }); router.replace('/admin/login'); }}>Sign out</Button>
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}
