'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { STATUS_LABEL } from '@/lib/client';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ledger text-white hover:bg-[#0a5a4d] disabled:bg-ledger/50',
  secondary: 'bg-white text-ink border border-rule hover:border-ink-soft disabled:opacity-50',
  danger: 'bg-white text-red-ink border border-red-ink/40 hover:bg-red-tint disabled:opacity-50',
  ghost: 'text-ink-soft hover:text-ink hover:bg-black/5 disabled:opacity-50',
};

export function Button({ variant = 'primary', busy, className = '', children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...p}
      disabled={p.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-[13.5px] font-medium transition-colors ${VARIANTS[variant]} ${className}`}
    >
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Panel({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-rule bg-sheet ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const STATUS_TONE: Record<string, string> = {
  validation_error: 'bg-red-tint text-red-ink', error: 'bg-red-tint text-red-ink',
  validated: 'bg-ledger-tint text-ledger', json_generated: 'bg-ledger-tint text-ledger', ready_for_upload: 'bg-ledger-tint text-ledger',
  uploading: 'bg-amber-tint text-amber', uploaded: 'bg-amber-tint text-amber', processing: 'bg-amber-tint text-amber',
  processed: 'bg-ledger text-white', filed: 'bg-ink text-white',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-[12px] font-medium ${STATUS_TONE[status] ?? 'bg-black/5 text-ink-soft'}`}>{(STATUS_LABEL as Record<string, string>)[status] ?? status}</span>;
}

export function Severity({ s }: { s: string }) {
  return s === 'error'
    ? <span className="rounded bg-red-tint px-1.5 py-0.5 text-[12px] font-medium text-red-ink">Error</span>
    : <span className="rounded bg-amber-tint px-1.5 py-0.5 text-[12px] font-medium text-amber">Warning</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok' | 'warn'; children: ReactNode }) {
  const t = { info: 'border-rule bg-white', error: 'border-red-ink/30 bg-red-tint text-red-ink', ok: 'border-ledger/30 bg-ledger-tint text-ledger', warn: 'border-amber/30 bg-amber-tint text-amber' }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-4 py-3 text-[13.5px] ${t}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule bg-white/60 px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-ink-soft">{children}</div>}
    </div>
  );
}
