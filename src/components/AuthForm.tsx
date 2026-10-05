'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { call } from '@/lib/client';
import { Button, Notice } from './ui';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await call(`/api/auth/${mode}`, { method: 'POST', json: f });
      router.replace('/');
      router.refresh();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <p className="text-[22px] font-semibold tracking-tight">GST Return Desk</p>
        <p className="mb-6 text-ink-soft">{mode === 'login' ? 'Sign in to prepare and file GSTR-1.' : 'Create your firm’s workspace. You become its owner.'}</p>
        <form onSubmit={submit} className="grid gap-4 rounded-lg border border-rule bg-white p-6">
          {mode === 'register' && (
            <>
              <label>Firm or company name<input name="orgName" required minLength={2} /></label>
              <label>Your name<input name="name" required minLength={2} autoComplete="name" /></label>
            </>
          )}
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          <label>Password<input name="password" type="password" required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          {err && <Notice tone="error">{err}</Notice>}
          <Button busy={busy} type="submit">{mode === 'login' ? 'Sign in' : 'Create workspace'}</Button>
        </form>
        <p className="mt-4 text-center text-ink-soft">
          {mode === 'login' ? <>New firm? <Link className="text-ledger underline" href="/register">Create a workspace</Link></> : <>Already set up? <Link className="text-ledger underline" href="/login">Sign in</Link></>}
        </p>
      </div>
    </main>
  );
}
