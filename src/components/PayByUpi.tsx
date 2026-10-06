'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { call } from '@/lib/client';
import { upiLink, type AddonKey } from '@/lib/upi';
import { Button, fmtDate, Notice, Panel } from './ui';

type Limits = { companies: number; users: number; returnsPerMonth: number };
interface Pkg { _id: string; name: string; description: string; priceInr: number; durationDays: number; limits: Limits; features: string[]; upiLink: string | null }
interface AddonItem { key: AddonKey; label: string; unit: number; priceInr: number; current: number }
interface Payment { _id: string; kind?: string; packageName: string; amountInr: number; utr: string; status: string; reviewNote?: string; createdAt: string }
interface Options {
  upiId: string; payeeName: string; paymentNote: string; orgName: string; packages: Pkg[]; payments: Payment[];
  addons: { expiresAt: string | null; items: AddonItem[] };
}

/** What is being paid for. */
type Checkout =
  | { kind: 'package'; pkg: Pkg; amount: number; title: string; link: string | null }
  | { kind: 'addon'; units: Partial<Record<AddonKey, number>>; amount: number; title: string; link: string | null };

const PAY_TONE: Record<string, string> = { pending: 'bg-amber-tint text-amber', approved: 'bg-ledger-tint text-ledger', rejected: 'bg-red-tint text-red-ink' };
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** Scan the UPI QR for the exact amount, then send the UTR + screenshot for approval. */
function CheckoutBox({ opt, co, onCancel, onDone }: { opt: Options; co: Checkout; onCancel: () => void; onDone: (msg: string) => void }) {
  const [qrImg, setQrImg] = useState<{ link: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const link = co.link;
    if (link) QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((url) => setQrImg({ link, url })).catch(() => {});
  }, [co.link]);
  const qr = co.link && qrImg?.link === co.link ? qrImg.url : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set('kind', co.kind);
    if (co.kind === 'package') fd.set('packageId', co.pkg._id);
    else for (const [k, v] of Object.entries(co.units)) fd.set(k, String(v ?? 0));
    setBusy(true);
    setErr(null);
    try {
      await call('/api/payments', { method: 'POST', body: fd });
      onDone('Payment submitted. It is applied as soon as the payment is verified.');
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-6 rounded-lg border border-rule bg-paper p-5 md:grid-cols-[260px_1fr]">
      <div className="text-center">
        <p className="mb-2 font-semibold">Scan with any UPI app</p>
        <div className="mx-auto grid h-[240px] w-[240px] place-items-center rounded-md bg-white">
          {qr ? <img src={qr} alt={`UPI QR code to pay ${rupees(co.amount)} to ${opt.upiId}`} width={240} height={240} /> : <span className="text-ink-soft">Generating…</span>}
        </div>
        <p className="num mt-2 text-[18px] font-semibold">{rupees(co.amount)}</p>
        <p className="text-[12.5px] text-ink-soft">to <span className="num">{opt.upiId}</span>{opt.payeeName ? ` (${opt.payeeName})` : ''}</p>
        {co.link && <a href={co.link} className="mt-2 inline-block text-ledger underline md:hidden">Open UPI app</a>}
      </div>
      <form onSubmit={submit} className="grid content-start gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-[13px]">
          <li>Pay exactly <b>{rupees(co.amount)}</b> for <b>{co.title}</b> using the QR code.</li>
          <li>Copy the <b>UPI transaction ID / UTR</b> (12 digits) from your UPI app.</li>
          <li>Upload a screenshot of the successful payment and submit.</li>
        </ol>
        {opt.paymentNote && <Notice>{opt.paymentNote}</Notice>}
        <label>UPI transaction ID / UTR<input name="utr" required minLength={6} maxLength={30} pattern="[A-Za-z0-9]{6,30}" className="num uppercase" autoComplete="off" placeholder="e.g. 412345678901" /></label>
        <label>Payment screenshot (PNG/JPG, max 5 MB)<input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" required /></label>
        <label>Note (optional)<input name="note" maxLength={500} placeholder="Paid from …" /></label>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex gap-2">
          <Button busy={busy} type="submit">Submit payment</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

/** Packages to buy/renew and add-ons for the current plan, paid by UPI QR and approved by the super admin. */
export function PayByUpi({ canPay, limitLabels, featureLabels }: { canPay: boolean; limitLabels: Record<string, string>; featureLabels: Record<string, string> }) {
  const [opt, setOpt] = useState<Options | null>(null);
  const [co, setCo] = useState<Checkout | null>(null);
  const [units, setUnits] = useState<Partial<Record<AddonKey, number>>>({});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = () => call<Options>('/api/payments').then(setOpt).catch((e) => setMsg({ tone: 'error', text: e.message }));
  useEffect(() => { load(); }, []);

  if (!opt) return null;
  const pending = opt.payments.find((p) => p.status === 'pending');
  const blocked = !canPay || !!pending;
  const addonTotal = opt.addons.items.reduce((a, i) => a + (units[i.key] ?? 0) * i.priceInr, 0);
  const done = (text: string) => { setCo(null); setUnits({}); setMsg({ tone: 'ok', text }); load(); };
  const linkFor = (amount: number, what: string) => (opt.upiId ? upiLink(opt.upiId, opt.payeeName, amount, `GST Desk ${what} ${opt.orgName}`) : null);

  function buyAddons() {
    const parts = opt!.addons.items.filter((i) => units[i.key]).map((i) => `${units[i.key]} × ${i.label.toLowerCase()}`);
    setMsg(null);
    setCo({ kind: 'addon', units, amount: addonTotal, title: parts.join(', '), link: linkFor(addonTotal, 'add-on') });
  }

  const status = (
    <>
      {pending && <Notice tone="warn">Your payment of {rupees(pending.amountInr)} (UTR <span className="num">{pending.utr}</span>) is waiting for verification. You can pay again after it is reviewed.</Notice>}
      {!canPay && <p className="text-ink-soft">Only the workspace owner or an admin can make payments.</p>}
    </>
  );

  return (
    <>
      {opt.upiId && opt.addons.items.length > 0 && (
        <Panel title="Add more to your plan">
          <div className="space-y-4">
            <p className="text-ink-soft">Need more than your plan allows? Add capacity now – it stays until your plan ends on <b>{fmtDate(opt.addons.expiresAt)}</b>.</p>
            <div className="-mx-5 overflow-x-auto">
              <table className="ledger">
                <thead><tr><th>Add-on</th><th className="text-right">Price</th><th className="text-right">Your limit now</th><th>Quantity</th><th className="text-right">Amount</th></tr></thead>
                <tbody>
                  {opt.addons.items.map((i) => {
                    const q = units[i.key] ?? 0;
                    return (
                      <tr key={i.key}>
                        <td>{i.label}</td>
                        <td className="num text-right">{rupees(i.priceInr)}</td>
                        <td className="num text-right">{i.current}{q ? <span className="text-ledger"> → {i.current + q * i.unit}</span> : null}</td>
                        <td>
                          <div className="flex items-center gap-1">
                            <Button variant="secondary" aria-label={`Fewer: ${i.label}`} disabled={blocked || q === 0} onClick={() => setUnits({ ...units, [i.key]: q - 1 })}>−</Button>
                            <span className="num w-8 text-center">{q}</span>
                            <Button variant="secondary" aria-label={`More: ${i.label}`} disabled={blocked || q >= 100} onClick={() => setUnits({ ...units, [i.key]: q + 1 })}>+</Button>
                          </div>
                        </td>
                        <td className="num text-right">{q ? rupees(q * i.priceInr) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="text-ink-soft">Total</span>
              <span className="num text-[18px] font-semibold">{rupees(addonTotal)}</span>
              <Button disabled={blocked || !addonTotal || co?.kind === 'addon'} onClick={buyAddons}>Pay for add-ons</Button>
            </div>
            {co?.kind === 'addon' && <CheckoutBox opt={opt} co={co} onCancel={() => setCo(null)} onDone={done} />}
            {status}
          </div>
        </Panel>
      )}

      <Panel title="Buy or renew a plan">
        {!opt.upiId ? <p className="text-ink-soft">Online payment is not available yet. Contact the software provider for a license key.</p>
          : !opt.packages.length ? <p className="text-ink-soft">No paid plans are available right now.</p> : (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {opt.packages.map((p) => (
                  <button key={p._id} type="button" disabled={blocked}
                    onClick={() => { setMsg(null); setCo({ kind: 'package', pkg: p, amount: p.priceInr, title: `the ${p.name} plan`, link: p.upiLink }); }}
                    className={`rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${co?.kind === 'package' && co.pkg._id === p._id ? 'border-ledger bg-ledger-tint' : 'border-rule bg-white hover:border-ink-soft'}`}>
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
              {opt.addons.items.length > 0 && <p className="text-[12.5px] text-ink-soft">Add-ons belong to your current plan and end with it; a new plan starts with its own limits.</p>}
              {co?.kind === 'package' && <CheckoutBox opt={opt} co={co} onCancel={() => setCo(null)} onDone={done} />}
              {!(opt.addons.items.length > 0) && status}
            </div>
          )}
        {msg && <div className="mt-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        {opt.payments.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 font-semibold">Your payments</p>
            <div className="-mx-5 overflow-x-auto">
              <table className="ledger">
                <thead><tr><th>Date</th><th>For</th><th className="text-right">Amount</th><th>UTR</th><th>Status</th></tr></thead>
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
    </>
  );
}
