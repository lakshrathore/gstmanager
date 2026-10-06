'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, fmtDate, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface Payment {
  _id: string; orgName: string; userEmail: string; packageName: string; amountInr: number; durationDays: number;
  utr: string; note?: string; status: string; reviewNote?: string; reviewedBy?: string; reviewedAt?: string; createdAt: string; screenshotSize?: number;
}

const TONE: Record<string, string> = { pending: 'bg-amber-tint text-amber', approved: 'bg-ledger-tint text-ledger', rejected: 'bg-red-tint text-red-ink' };

export default function PaymentsPage() {
  const [list, setList] = useState<Payment[] | null>(null);
  const [status, setStatus] = useState('pending');
  const [view, setView] = useState<Payment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => call<{ payments: Payment[] }>(`/api/admin/payments${status ? `?status=${status}` : ''}`).then((r) => setList(r.payments)).catch((e) => setErr(e.message)), [status]);
  useEffect(() => { load(); }, [load]);

  async function review(p: Payment, action: 'approve' | 'reject') {
    const note = action === 'reject' ? prompt('Reason for rejecting (the customer will see this):', 'Payment not received – please check the UTR') : undefined;
    if (action === 'reject' && !note) return;
    if (action === 'approve' && !confirm(`Approve ₹${p.amountInr.toLocaleString('en-IN')} from ${p.orgName}? A ${p.packageName} license (${p.durationDays} days) will be activated for them.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await call(`/api/admin/payments/${p._id}`, { method: 'PATCH', json: { action, note: note ?? undefined } });
      setView(null);
      await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Payments</h1>
      <p className="text-ink-soft">Check each payment in your bank or UPI app (match the UTR and amount) before approving. Approving activates the plan immediately.</p>
      {err && <Notice tone="error">{err}</Notice>}
      <Panel title="UPI payments" action={
        <select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
        </select>
      }>
        {list && !list.length ? <Empty title={status === 'pending' ? 'No payments waiting' : 'No payments'} /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Submitted</th><th>Customer</th><th>Plan</th><th className="text-right">Amount</th><th>UTR</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list?.map((p) => (
                  <tr key={p._id}>
                    <td className="whitespace-nowrap">{fmtDate(p.createdAt)}<p className="text-[12px] text-ink-soft">{new Date(p.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p></td>
                    <td><p className="font-medium">{p.orgName}</p><p className="text-[12px] text-ink-soft">{p.userEmail}</p></td>
                    <td>{p.packageName}<p className="text-[12px] text-ink-soft">{p.durationDays} days</p></td>
                    <td className="num text-right font-semibold">₹{p.amountInr.toLocaleString('en-IN')}</td>
                    <td className="num">{p.utr}{p.note && <p className="text-[12px] text-ink-soft">{p.note}</p>}</td>
                    <td>
                      <span className={`rounded px-2 py-0.5 text-[12px] font-medium capitalize ${TONE[p.status] ?? ''}`}>{p.status}</span>
                      {p.reviewNote && <p className="text-[12px] text-ink-soft">{p.reviewNote}</p>}
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button variant="secondary" onClick={() => setView(p)}>Screenshot</Button>
                        {p.status === 'pending' && <>
                          <Button busy={busy} onClick={() => review(p, 'approve')}>Approve</Button>
                          <Button variant="danger" disabled={busy} onClick={() => review(p, 'reject')}>Reject</Button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {view && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-4" onClick={() => setView(null)}>
          <div role="dialog" aria-modal="true" aria-label="Payment screenshot" className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{view.orgName} · ₹{view.amountInr.toLocaleString('en-IN')}</p>
                <p className="num text-[12.5px] text-ink-soft">UTR {view.utr}</p>
              </div>
              <Button variant="ghost" onClick={() => setView(null)}>Close</Button>
            </div>
            <img src={`/api/admin/payments/${view._id}/screenshot`} alt={`Payment screenshot from ${view.orgName}`} className="mx-auto max-h-[70vh] rounded border border-rule" />
            {view.status === 'pending' && (
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="danger" disabled={busy} onClick={() => review(view, 'reject')}>Reject</Button>
                <Button busy={busy} onClick={() => review(view, 'approve')}>Approve and activate</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
