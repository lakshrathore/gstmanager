'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface Settings { upiId: string; payeeName: string; paymentNote: string }

export default function AdminSettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [previewImg, setPreviewImg] = useState<{ link: string; url: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { call<Settings>('/api/admin/settings').then(setS).catch((e) => setMsg({ tone: 'error', text: e.message })); }, []);
  const testLink = s?.upiId ? `upi://pay?pa=${encodeURIComponent(s.upiId)}&pn=${encodeURIComponent(s.payeeName || s.upiId)}&am=1.00&cu=INR&tn=${encodeURIComponent('GST Desk test')}` : null;
  useEffect(() => {
    if (testLink) QRCode.toDataURL(testLink, { width: 180, margin: 1 }).then((url) => setPreviewImg({ link: testLink, url })).catch(() => {});
  }, [testLink]);
  const preview = testLink && previewImg?.link === testLink ? previewImg.url : null;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setMsg(null);
    try {
      setS(await call<Settings>('/api/admin/settings', { method: 'PUT', json: s }));
      setMsg({ tone: 'ok', text: 'Saved. Customers now see QR codes for this UPI ID.' });
    } catch (x) { setMsg({ tone: 'error', text: (x as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Settings</h1>
      <Panel title="UPI payments">
        {s && (
          <div className="grid gap-6 sm:grid-cols-[1fr_200px]">
            <form onSubmit={save} className="grid content-start gap-4">
              <label>Your UPI ID<input value={s.upiId} onChange={(e) => setS({ ...s, upiId: e.target.value.trim() })} placeholder="yourname@okhdfcbank" className="num" /></label>
              <label>Payee name (shown in the customer&apos;s UPI app)<input value={s.payeeName} onChange={(e) => setS({ ...s, payeeName: e.target.value })} maxLength={80} placeholder="Your business name" /></label>
              <label>Note for customers (optional)<input value={s.paymentNote} onChange={(e) => setS({ ...s, paymentNote: e.target.value })} maxLength={300} placeholder="Plans are activated within 2 working hours after verification." /></label>
              <p className="text-[12.5px] text-ink-soft">Each package&apos;s QR code includes its price, so customers pay the exact amount. Leave the UPI ID empty to hide online payment.</p>
              {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
              <div><Button busy={busy} type="submit">Save</Button></div>
            </form>
            <div className="text-center">
              <p className="mb-2 text-[12.5px] text-ink-soft">Test QR (₹1)</p>
              <div className="mx-auto grid h-[180px] w-[180px] place-items-center rounded-md border border-rule bg-white">
                {preview ? <img src={preview} alt="Test UPI QR code for ₹1" width={180} height={180} /> : <span className="text-[12.5px] text-ink-soft">Enter a UPI ID</span>}
              </div>
              <p className="mt-2 text-[12px] text-ink-soft">Scan it with your phone to check the name and UPI ID are right (you don&apos;t have to pay).</p>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
