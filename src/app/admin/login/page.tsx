'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { call } from '@/lib/client';

export default function AdminLoginPage() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await call('/api/admin/auth/login', { method: 'POST', json: Object.fromEntries(new FormData(e.currentTarget)) });
      router.replace('/admin');
      router.refresh();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-ink px-4">
      <div className="w-full max-w-sm">
        <p className="text-[22px] font-semibold tracking-tight text-white">GST Return Desk</p>
        <p className="mb-6 text-white/60">Super admin console – packages, licenses and customers.</p>
        <form onSubmit={submit} className="grid gap-4 rounded-lg border border-rule bg-white p-6">
          <label>Email<input name="email" type="email" required autoComplete="username" /></label>
          <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
          {err && <Notice tone="error">{err}</Notice>}
          <Button busy={busy} type="submit">Sign in</Button>
        </form>
      </div>
    </main>
  );
}
