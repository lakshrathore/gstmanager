'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { call } from '@/lib/client';

interface Count { key: string; label: string; count: number }
interface Counts { counts: Count[]; otherUsers: number; phrase: string }

/** Settings → Danger zone: delete all of the organisation's data (owner only). */
export function ResetData() {
  const [info, setInfo] = useState<Counts | null>(null);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [removeTeam, setRemoveTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Count[] | null>(null);

  useEffect(() => { call<Counts>('/api/org/reset').then(setInfo).catch((e) => setErr(e.message)); }, []);

  const total = info ? info.counts.reduce((a, c) => a + c.count, 0) : 0;
  const ready = !!info && confirm.trim() === info.phrase && password.length > 0;

  async function reset(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !window.confirm('Last check: permanently delete all data? This cannot be undone.')) return;
    setBusy(true); setErr(null);
    try {
      const r = await call<{ deleted: Count[] }>('/api/org/reset', { method: 'POST', json: { confirm, password, removeTeam } });
      setDone(r.deleted); setPassword(''); setConfirm('');
      setInfo(await call<Counts>('/api/org/reset'));
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  if (done) {
    return (
      <section className="rounded-lg border border-ledger/30 bg-sheet p-5">
        <h2 className="text-[15px] font-semibold">All data deleted – you are starting fresh</h2>
        <ul className="mt-3 grid gap-1 text-[13.5px] sm:grid-cols-2">
          {done.map((d) => <li key={d.key} className="flex justify-between gap-4 border-b border-rule py-1"><span>{d.label}</span><span className="num">{d.count.toLocaleString('en-IN')}</span></li>)}
        </ul>
        <p className="mt-4 text-ink-soft">Your login and the workspace are kept. The audit trail starts again with this reset as its first entry.</p>
        <Link href="/companies" className="mt-4 inline-block rounded-md bg-ledger px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-[#0a5a4d]">Add your first company</Link>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-red-ink/40 bg-sheet">
      <header className="border-b border-red-ink/20 px-5 py-3">
        <h2 className="text-[15px] font-semibold text-red-ink">Danger zone – delete all data</h2>
      </header>
      <div className="space-y-5 p-5">
        <p>Permanently deletes everything in this workspace so you can start fresh. <strong>This cannot be undone.</strong> Download any JSON, evidence or audit records you need first.</p>
        {!info ? <p className="text-ink-soft">{err ? '' : 'Counting…'}</p> : (
          <table className="ledger">
            <thead><tr><th>Will be deleted</th><th className="text-right">Count</th></tr></thead>
            <tbody>
              {info.counts.map((c) => <tr key={c.key}><td>{c.label}</td><td className="num text-right">{c.count.toLocaleString('en-IN')}</td></tr>)}
              {removeTeam && <tr><td>Other team members</td><td className="num text-right">{info.otherUsers}</td></tr>}
            </tbody>
          </table>
        )}
        <p className="text-[13px] text-ink-soft">Kept: the workspace and your own login{removeTeam ? '' : ', and your team members'}.</p>

        <form onSubmit={reset} className="space-y-4">
          {info && info.otherUsers > 0 && (
            <label className="flex items-center gap-2 text-[13.5px] text-ink">
              <input type="checkbox" className="w-auto" checked={removeTeam} onChange={(e) => setRemoveTeam(e.target.checked)} />
              Also remove the other {info.otherUsers} team member{info.otherUsers === 1 ? '' : 's'}
            </label>
          )}
          <label>Type <span className="num font-semibold text-ink">{info?.phrase ?? 'DELETE ALL DATA'}</span> to confirm
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} className="num" />
          </label>
          <label>Your password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {err && <Notice tone="error">{err}</Notice>}
          <Button type="submit" variant="danger" busy={busy} disabled={!ready || total + (removeTeam ? info?.otherUsers ?? 0 : 0) === 0}>
            Delete all data permanently
          </Button>
          {info && total === 0 && !removeTeam && <p className="text-[13px] text-ink-soft">There is no data to delete.</p>}
        </form>
      </div>
    </section>
  );
}
