'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { call } from '@/lib/client';
import { Button, fmtDate, Notice, Panel } from './ui';

type Limits = { companies: number; users: number; returnsPerMonth: number };
interface Pkg { _id: string; name: string; description: string; priceInr: number; durationDays: number; limits: Limits; features: string[]; upiLink: string | null }
interface Payment { _id: string; packageName: string; amountInr: number; utr: string; status: string; reviewNote?: string; createdAt: string }
interface Options { upiId: string; payeeName: string; paymentNote: string; packages: Pkg[]; payments: Payment[] }

const PAY_TONE: Record<string, string> = { pending: 'bg-amber-tint text-amber', approved: 'bg-ledger-tint text-ledger', rejected: 'bg-red-tint text-red-ink' };
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** Choose a package → scan the UPI QR → submit UTR + screenshot for the super admin to approve. */
export function PayByUpi({ canPay, limitLabels, featureLabels }: { canPay: boolean; limitLabels: Record<string, string>; featureLabels: Record<string, string> }) {
  const [opt, setOpt] = useState<Options | null>(null);
  const [pick, setPick] = useState<Pkg | null>(null);
  /** QR image for a UPI link (kept with its link so a stale image is never shown). */
  const [qrImg, setQrImg] = useState<{ link: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = () => call<Options>('/api/payments').then(setOpt).catch((e) => setMsg({ tone: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const link = pick?.upiLink;
    if (link) QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((url) => setQrImg({ link, url })).catch(() => {});
  }, [pick]);
  const qr = pick?.upiLink && qrImg?.link === pick.upiLink ? qrImg.url : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pick) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set('packageId', pick._id);
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/payments', { method: 'POST', body: fd });
      form.reset();
      setPick(null);
      setMsg({ tone: 'ok', text: 'Payment submitted. Your plan is activated as soon as the payment is verified.' });
      await load();
    } catch (x) { setMsg({ tone: 'error', text: (x as Error).message }); } finally { setBusy(false); }
  }

  if (!opt) return null;
  const pending = opt.payments.find((p) => p.status === 'pending');
  return (
    <Panel title="Buy or renew a plan">
      {!opt.upiId ? <p className="text-ink-soft">Online payment is not available yet. Contact the software provider for a license key.</p>
        : !opt.packages.length ? <p className="text-ink-soft">No paid plans are available right now.</p> : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {opt.packages.map((p) => (
                <button key={p._id} type="button" onClick={() => setPick(p)} disabled={!canPay || !!pending}
                  className={`rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${pick?._id === p._id ? 'border-ledger bg-ledger-tint' : 'border-rule bg-white hover:border-ink-soft'}`}>
                  <p className="font-semibold">{p.name}</p>
                  <p className="num text-[20px] font-semibold">{rupees(p.priceInr)} <span className="text-[12.5px] font-normal text-ink-soft">/ {p.durationDays} days</span></p>
                  {p.description && <p className="text-[12.5px] text-ink-soft">{p.description}</p>}
                  <ul className="mt-2 space-y-0.5 text-[12.5px]">
                    {(['companies', 'users', 'returnsPerMonth'] as const).map((k) => <li key={k}>{limitLabels[k]}: <b>{p.limits[k] || 'Unlimited'}</b></li>)}
                    {p.features.map((f) => <li key={f}>✓ {featureLabels[f] ?? f}</li>)}
                  </ul>
                </button>
              ))}
            </div>

            {pending && <Notice tone="warn">Your payment of {rupees(pending.amountInr)} (UTR <span className="num">{pending.utr}</span>) is waiting for verification. You can buy again after it is reviewed.</Notice>}
            {!canPay && <p className="text-ink-soft">Only the workspace owner or an admin can pay for a plan.</p>}

            {pick && canPay && !pending && (
              <div className="grid gap-6 rounded-lg border border-rule bg-paper p-5 md:grid-cols-[260px_1fr]">
                <div className="text-center">
                  <p className="mb-2 font-semibold">Scan with any UPI app</p>
                  <div className="mx-auto grid h-[240px] w-[240px] place-items-center rounded-md bg-white">
                    {qr ? <img src={qr} alt={`UPI QR code to pay ${rupees(pick.priceInr)} to ${opt.upiId}`} width={240} height={240} /> : <span className="text-ink-soft">Generating…</span>}
                  </div>
                  <p className="num mt-2 text-[18px] font-semibold">{rupees(pick.priceInr)}</p>
                  <p className="text-[12.5px] text-ink-soft">to <span className="num">{opt.upiId}</span>{opt.payeeName ? ` (${opt.payeeName})` : ''}</p>
                  {pick.upiLink && <a href={pick.upiLink} className="mt-2 inline-block text-ledger underline md:hidden">Open UPI app</a>}
                </div>
                <form onSubmit={submit} className="grid content-start gap-4">
                  <ol className="list-decimal space-y-1 pl-5 text-[13px]">
                    <li>Pay exactly <b>{rupees(pick.priceInr)}</b> for the <b>{pick.name}</b> plan using the QR code.</li>
                    <li>Copy the <b>UPI transaction ID / UTR</b> (12 digits) from your UPI app.</li>
                    <li>Upload a screenshot of the successful payment and submit.</li>
                  </ol>
                  {opt.paymentNote && <Notice>{opt.paymentNote}</Notice>}
                  <label>UPI transaction ID / UTR<input name="utr" required minLength={6} maxLength={30} pattern="[A-Za-z0-9]{6,30}" className="num uppercase" autoComplete="off" placeholder="e.g. 412345678901" /></label>
                  <label>Payment screenshot (PNG/JPG, max 5 MB)<input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" required /></label>
                  <label>Note (optional)<input name="note" maxLength={500} placeholder="Paid from …" /></label>
                  <div className="flex gap-2">
                    <Button busy={busy} type="submit">Submit payment</Button>
                    <Button type="button" variant="ghost" onClick={() => setPick(null)}>Cancel</Button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      {msg && <div className="mt-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {opt.payments.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 font-semibold">Your payments</p>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Date</th><th>Plan</th><th className="text-right">Amount</th><th>UTR</th><th>Status</th></tr></thead>
              <tbody>{opt.payments.map((p) => (
                <tr key={p._id}>
                  <td className="whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                  <td>{p.packageName}</td>
                  <td className="num text-right">{rupees(p.amountInr)}</td>
                  <td className="num">{p.utr}</td>
                  <td><span className={`rounded px-2 py-0.5 text-[12px] font-medium capitalize ${PAY_TONE[p.status] ?? ''}`}>{p.status}</span>{p.reviewNote && <p className="text-[12px] text-ink-soft">{p.reviewNote}</p>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
