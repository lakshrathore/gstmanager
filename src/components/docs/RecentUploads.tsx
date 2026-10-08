'use client';

import type { Batch } from './types';

/** Your last uploads: "125 files – processed 121 · needs review 3 · duplicate 1", with a progress bar while reading. */
export function RecentUploads({ batches, onShow }: { batches: Batch[]; onShow: (batchId: string) => void }) {
  if (!batches.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-[12.5px] font-semibold text-ink-soft">Recent uploads</p>
      <ul className="space-y-2">
        {batches.map((b) => {
          const done = b.total - b.pending;
          const pct = Math.round((done / b.total) * 100);
          const parts: [number, string, string][] = [
            [b.processed, 'processed', 'text-ledger'], [b.needsReview, 'needs review', 'text-amber'], [b.duplicate, 'duplicate', 'text-ink-soft'],
            [b.failed, 'failed', 'text-red-ink'], [b.pending, 'reading…', 'text-ink-soft'],
          ];
          return (
            <li key={b.batchId} className="rounded-md border border-rule bg-white px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{b.total} file{b.total > 1 ? 's' : ''}</span>
                <span className="text-[12px] text-ink-soft">{new Date(b.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}{b.clients > 1 ? ` · ${b.clients} clients` : ''}</span>
                {parts.filter(([n]) => n).map(([n, l, c]) => <span key={l} className={c}>{n} {l}</span>)}
                <button type="button" className="ml-auto text-ledger underline" onClick={() => onShow(b.batchId)}>Show files</button>
              </div>
              {b.pending > 0 && <div className="mt-1.5 h-1.5 rounded bg-black/5"><div className="h-1.5 rounded bg-ledger transition-all" style={{ width: `${pct}%` }} /></div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
