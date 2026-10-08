'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PayByUpi } from '@/components/PayByUpi';
import { Button, fmtDate, LicenseBadge, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

type Limits = { companies: number; users: number; returnsPerMonth: number };
interface Info {
  license: { status: string; key: string | null; expiresAt: string | null; daysLeft: number | null; plan: { name: string; limits: Limits; extras?: Limits; features: string[] } | null };
  usage: Limits;
  limitLabels: Record<string, string>;
  featureLabels: Record<string, string>;
  ai: {
    enabled: boolean; budgetInr: number; month: string; spentInr: number;
    months: { month: string; documents: { calls: number; costInr: number }; assistant: { calls: number; costInr: number }; tokens: { input: number; output: number } }[];
  };
}

const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

/** AI API (Claude or Groq) spend this month against the plan's allowance, and the last months by use. */
function AiUsagePanel({ ai }: { ai: Info['ai'] }) {
  const pct = ai.budgetInr ? Math.min(100, Math.round((ai.spentInr / ai.budgetInr) * 100)) : 0;
  return (
    <Panel title="Document AI usage">
      {!ai.enabled ? <p className="text-ink-soft">Your plan does not include Document AI (reading PDFs, scans and photos, and the Ask-the-documents assistant).</p> : (
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-[13px]"><span>{monthName(ai.month)}</span><span className="num">{rupee(ai.spentInr)} / {ai.budgetInr ? rupee(ai.budgetInr) : 'no limit'}</span></div>
            {ai.budgetInr > 0 && <div className="mt-1 h-2 rounded bg-black/5"><div className={`h-2 rounded ${pct >= 100 ? 'bg-red-ink' : pct >= 80 ? 'bg-amber' : 'bg-ledger'}`} style={{ width: `${pct}%` }} /></div>}
            {ai.budgetInr > 0 && pct >= 100 && <p className="mt-1 text-[12.5px] text-red-ink">The allowance is used up – documents that need AI wait until it renews on the 1st.</p>}
          </div>
          {ai.months.length > 0 && (
            <div className="-mx-5 overflow-x-auto">
              <table className="ledger">
                <thead><tr><th>Month</th><th className="text-right">Documents read</th><th className="text-right">Cost</th><th className="text-right">Assistant answers</th><th className="text-right">Cost</th><th className="text-right">Total</th></tr></thead>
                <tbody>
                  {ai.months.map((m) => (
                    <tr key={m.month}>
                      <td>{monthName(m.month)}</td>
                      <td className="num text-right">{m.documents.calls}</td><td className="num text-right">{rupee(m.documents.costInr)}</td>
                      <td className="num text-right">{m.assistant.calls}</td><td className="num text-right">{rupee(m.assistant.costInr)}</td>
                      <td className="num text-right font-semibold">{rupee(m.documents.costInr + m.assistant.costInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[12px] text-ink-soft">Worked out from the tokens of each AI API call (Claude or Groq) at list prices. “Assistant answers” counts API calls – one question can take several.</p>
        </div>
      )}
    </Panel>
  );
}

export default function LicensePage() {
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => call<Info>('/api/license').then(setInfo).catch((e) => setMsg({ tone: 'error', text: e.message }));
  useEffect(() => {
    load();
    call<{ permissions: string[] }>('/api/auth/me').then((r) => setCanManage(r.permissions.includes('org:manage'))).catch(() => {});
  }, []);

  async function activate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/license', { method: 'POST', json: { key: new FormData(form).get('key') } });
      form.reset();
      setMsg({ tone: 'ok', text: 'License activated.' });
      await load();
      router.refresh();
    } catch (x) { setMsg({ tone: 'error', text: (x as Error).message }); } finally { setBusy(false); }
  }

  const L = info?.license;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">License</h1>
      {L && (
        <Panel title="Your plan" action={<LicenseBadge status={L.status} />}>
          {L.plan ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-[20px] font-semibold">{L.plan.name}</p>
                <p>Valid until <b>{fmtDate(L.expiresAt)}</b>{L.status === 'active' && L.daysLeft != null && <span className="text-ink-soft"> · {L.daysLeft} days left</span>}</p>
                {L.key && <p className="num text-[12.5px] text-ink-soft">{L.key}</p>}
                <ul className="mt-3 space-y-0.5">
                  {Object.entries(info.featureLabels).map(([k, label]) => (
                    <li key={k} className={L.plan!.features.includes(k) ? '' : 'text-ink-soft line-through'}>{L.plan!.features.includes(k) ? '✓' : '✗'} {label}</li>
                  ))}
                </ul>
              </div>
              <div className="space-y-3">
                {(['companies', 'users', 'returnsPerMonth'] as const).map((k) => {
                  const max = L.plan!.limits[k];
                  const used = info.usage[k];
                  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
                  return (
                    <div key={k}>
                      <div className="flex justify-between text-[13px]"><span>{info.limitLabels[k]}</span><span className="num">{used} / {max || '∞'}{L.plan!.extras?.[k] ? <span className="text-ink-soft"> (incl. +{L.plan!.extras[k]} add-on)</span> : null}</span></div>
                      <div className="mt-1 h-2 rounded bg-black/5">
                        <div className={`h-2 rounded ${pct >= 100 ? 'bg-red-ink' : pct >= 80 ? 'bg-amber' : 'bg-ledger'}`} style={{ width: `${max ? pct : 0}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-ink-soft">This workspace has no license yet. You can still view your data, but changes are disabled until a license is activated.</p>
          )}
        </Panel>
      )}
      {info?.ai && <AiUsagePanel ai={info.ai} />}
      {info && <PayByUpi canPay={canManage} limitLabels={info.limitLabels} featureLabels={info.featureLabels} />}
      <Panel title="Have a license key?">
        {canManage ? (
          <form onSubmit={activate} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label>License key<input name="key" required minLength={10} maxLength={40} placeholder="GSTD-XXXXX-XXXXX-XXXXX-XXXXX" className="num uppercase" autoComplete="off" /></label>
            <Button busy={busy} type="submit">Activate</Button>
            <p className="text-[12.5px] text-ink-soft sm:col-span-2">A new key replaces the current plan. If your current license is still running, the new period starts when it ends.</p>
          </form>
        ) : <p className="text-ink-soft">Ask your workspace owner or an admin to activate a license key.</p>}
        {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      </Panel>
    </div>
  );
}
