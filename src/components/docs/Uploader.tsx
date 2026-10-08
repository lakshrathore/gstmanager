'use client';

import { useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { call } from '@/lib/client';

/**
 * Drop or pick any number of files; they go up 10 at a time (each request well under the server
 * limits) and are then read in the background. The client is the one open, or detected from the
 * GSTINs in each document.
 */

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.csv,.tsv,.txt,.json,.docx,.doc';
const BATCH = 10;

interface Result { fileName: string; status: string; message?: string }

export function Uploader({ companyId, companyName, canAuto, ai, aiReason, onUploaded }: { companyId: string; companyName: string; canAuto: boolean; ai: boolean; aiReason?: string | null; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<'client' | 'auto'>('client');
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function send(list: File[]) {
    if (!list.length) return;
    setErr(null); setResults([]); setProgress({ done: 0, total: list.length });
    const out: Result[] = [];
    for (let i = 0; i < list.length; i += BATCH) {
      const fd = new FormData();
      fd.append('companyId', target === 'auto' ? 'auto' : companyId);
      for (const f of list.slice(i, i + BATCH)) fd.append('files', f);
      try {
        const r = await call<{ files: Result[] }>('/api/docs', { method: 'POST', body: fd });
        out.push(...r.files);
      } catch (e) {
        setErr((e as Error).message);
        out.push(...list.slice(i, i + BATCH).map((f) => ({ fileName: f.name, status: 'rejected', message: (e as Error).message })));
      }
      setProgress({ done: Math.min(list.length, i + BATCH), total: list.length });
      onUploaded();
    }
    setResults(out);
    setProgress(null);
    if (input.current) input.current.value = '';
  }

  const rejected = results.filter((r) => r.status === 'rejected');
  const dups = results.filter((r) => r.status === 'duplicate');
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); send([...e.dataTransfer.files]); }}
        className={`rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${drag ? 'border-ledger bg-ledger-tint' : 'border-rule bg-white'}`}
      >
        <p className="font-semibold">Drop client documents here</p>
        <p className="mt-1 text-[13px] text-ink-soft">Invoices, credit/debit notes, sales and purchase registers, GSTR-1/2A/2B, bank statements, e-way bills… as PDF, scans, photos, Excel, CSV, JSON or Word. Hundreds at a time is fine.</p>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => send([...(e.target.files ?? [])])} />
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => input.current?.click()} busy={!!progress}>Choose files</Button>
          <label className="flex items-center gap-2 text-[13px] font-normal">
            For
            <select value={target} onChange={(e) => setTarget(e.target.value as 'client' | 'auto')}>
              <option value="client">{companyName}</option>
              {canAuto && <option value="auto">Detect the client from each document</option>}
            </select>
          </label>
        </div>
        {progress && <p className="mt-3 text-[13px] text-ink-soft">Uploading {progress.done} of {progress.total}…</p>}
      </div>
      {!ai && <Notice tone="warn">Excel, CSV and GSTN JSON files are read now. PDFs, scans, photos and Word files need Document AI, which is not available: {aiReason ?? 'not set up.'} Until then they are marked “failed” and can be read again later.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {results.length > 0 && (
        <Notice tone={rejected.length ? 'warn' : 'ok'}>
          {results.length - rejected.length - dups.length} file(s) uploaded and being read.
          {dups.length > 0 && ` ${dups.length} already uploaded before (not read again).`}
          {rejected.length > 0 && <ul className="mt-1 list-disc pl-4">{rejected.map((r) => <li key={r.fileName}>{r.fileName}: {r.message}</li>)}</ul>}
        </Notice>
      )}
    </div>
  );
}
