'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Notice, Panel } from '@/components/ui';
import { money, monthLabel, SOURCE_LABEL } from '@/components/docs/types';
import { call } from '@/lib/client';
import { DOC_KIND_LABEL, NOTE_LABEL, type BankTxn, type DocKind, type InvoiceData } from '@/engine/docs';

/**
 * Search everything – every client's documents and the invoices and bank lines read from them – in
 * plain English, Hindi or Hinglish. The query is read by rules and said back, so the CA can see
 * exactly what was searched.
 */

interface Result {
  query: string; understood: string[]; total: number;
  totals: { invoices: { count: number; taxable: number; amount: number } | null; bank: { count: number; credit: number; debit: number } | null };
  clients: { _id: string; name: string; gstin: string }[];
  records: { _id: string; kind: 'invoice' | 'bank'; source: string | null; direction: string | null; fp: string | null; fy: string | null; data: InvoiceData | BankTxn; flags: number; review: string; companyId: string; companyName: string; gstin: string; fileName: string }[];
  documents: { _id: string; fileName: string; kind: DocKind | null; fp: string | null; fy: string | null; status: string; companyId: string; companyName: string }[];
}

const EXAMPLES = ['INV-1023', '₹50,000 से ज्यादा के invoices', 'September 2026 की purchases', 'cash deposits above 2 lakh', 'UPI receipts', 'Rao Industries ki saari invoices'];

const link = (r: { companyId: string; fy: string | null; fp: string | null }, extra = '') => `/documents?companyId=${r.companyId}${r.fy ? `&fy=${r.fy}` : ''}${r.fp ? `&fp=${r.fp}` : ''}${extra}`;

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  async function run(text = q) {
    if (text.trim().length < 2) return;
    setQ(text); setBusy(true); setErr(null);
    try { setRes(await call<Result>(`/api/docs/search?q=${encodeURIComponent(text)}`)); } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Search everything</h1>
      <form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice number, GSTIN, party, amount, month… in English or Hindi" className="min-w-72 flex-1 text-[15px]" aria-label="Search" />
        <Button type="submit" busy={busy}>Search</Button>
      </form>
      <div className="flex flex-wrap gap-2 text-[12.5px]">
        <span className="text-ink-soft">Try:</span>
        {EXAMPLES.map((x) => <button key={x} type="button" className="rounded-full border border-rule bg-white px-2.5 py-0.5 hover:border-ink-soft" onClick={() => run(x)}>{x}</button>)}
      </div>
      {err && <Notice tone="error">{err}</Notice>}

      {res && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-ink-soft">Searched for:</span>
            {res.understood.length ? res.understood.map((u) => <span key={u} className="rounded bg-ledger-tint px-2 py-0.5 text-ledger">{u}</span>) : <span>everything</span>}
            <span className="ml-auto text-ink-soft">
              {res.total} record(s)
              {res.totals.invoices && ` · invoices: taxable ₹${Math.round(res.totals.invoices.taxable).toLocaleString('en-IN')}`}
              {res.totals.bank && ` · bank: in ₹${Math.round(res.totals.bank.credit).toLocaleString('en-IN')}, out ₹${Math.round(res.totals.bank.debit).toLocaleString('en-IN')}`}
            </span>
          </div>

          {res.clients.length > 0 && (
            <Panel title="Clients">
              <ul className="space-y-1">{res.clients.map((c) => <li key={c._id}><Link className="text-ledger underline" href={`/documents?companyId=${c._id}`}>{c.name}</Link> <span className="num text-[12px] text-ink-soft">{c.gstin}</span></li>)}</ul>
            </Panel>
          )}

          {res.documents.length > 0 && (
            <Panel title="Documents">
              <ul className="space-y-1 text-[13.5px]">
                {res.documents.map((d) => (
                  <li key={d._id}>
                    <a className="text-ledger underline" href={`/api/docs/${d._id}/file`} target="_blank" rel="noreferrer">{d.fileName}</a>
                    <span className="text-ink-soft"> · {d.companyName}{d.kind ? ` · ${DOC_KIND_LABEL[d.kind]}` : ''}{d.fp ? ` · ${monthLabel(d.fp)}` : ''}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={`Invoices and transactions${res.total > res.records.length ? ` (first ${res.records.length} of ${res.total})` : ''}`}>
            {!res.records.length ? <Empty title="Nothing found">Try fewer words, another month, or a part of the invoice number.</Empty> : (
              <div className="-mx-5 overflow-x-auto">
                <table className="ledger">
                  <thead><tr><th>Client</th><th>Date</th><th>What</th><th>Party / narration</th><th className="text-right">Amount</th><th>Source</th></tr></thead>
                  <tbody>
                    {res.records.map((r) => {
                      const href = link(r, `&record=${r._id}`);
                      if (r.kind === 'invoice') {
                        const d = r.data as InvoiceData;
                        const sales = r.direction === 'sales';
                        return (
                          <tr key={r._id}>
                            <td className="max-w-48 truncate">{r.companyName}</td>
                            <td className="whitespace-nowrap">{d.invoiceDate || '—'}</td>
                            <td><Link href={href} className="font-medium text-ledger underline">{NOTE_LABEL[d.docType]} {d.invoiceNo || '—'}</Link> <span className="text-[12px] text-ink-soft">{r.direction ?? ''}</span>{r.flags > 0 && <span className="ml-1 rounded bg-amber-tint px-1 text-[11px] text-amber">{r.flags} issue(s)</span>}</td>
                            <td className="max-w-64"><div className="truncate">{(sales ? d.customerName : d.supplierName) ?? '—'}</div><div className="num text-[11.5px] text-ink-soft">{sales ? d.customerGstin : d.supplierGstin}</div></td>
                            <td className="num text-right">{money(d.total ?? d.taxable)}</td>
                            <td className="text-[12.5px] text-ink-soft">{SOURCE_LABEL[r.source ?? ''] ?? ''}<div className="max-w-48 truncate">{r.fileName}</div></td>
                          </tr>
                        );
                      }
                      const t = r.data as BankTxn;
                      return (
                        <tr key={r._id}>
                          <td className="max-w-48 truncate">{r.companyName}</td>
                          <td className="whitespace-nowrap">{t.date}</td>
                          <td><Link href={link(r, `&record=${r._id}&tab=bank`)} className="font-medium text-ledger underline">{t.mode} {t.credit ? 'receipt' : 'payment'}</Link></td>
                          <td className="max-w-80 truncate">{t.narration}</td>
                          <td className={`num text-right ${t.credit ? 'text-ledger' : ''}`}>{t.credit ? `+${money(t.credit)}` : `−${money(t.debit)}`}</td>
                          <td className="text-[12.5px] text-ink-soft">Bank<div className="max-w-48 truncate">{r.fileName}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
