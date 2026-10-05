'use client';

import { useState } from 'react';
import { GstinValidator } from './GstinValidator';
import { HsnValidator } from './HsnValidator';
import { JsonValidator } from './JsonValidator';

const TABS = [
  { id: 'json', label: 'GSTR-1 JSON' },
  { id: 'gstin', label: 'GSTIN' },
  { id: 'hsn', label: 'HSN / SAC' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function Validators({ sandbox, initialTab }: { sandbox: boolean; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'json');
  /** GSTINs handed over from the JSON validator; the key remounts the GSTIN tab with them. */
  const [handoff, setHandoff] = useState<{ text: string; n: number }>({ text: '', n: 0 });
  const pick = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, '', `?tab=${t}`);
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Validators</h1>
        <p className="mt-1 text-ink-soft">Check a GSTR-1 JSON from any source before upload, verify GSTINs, and check HSN/SAC codes.</p>
      </div>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-rule">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => pick(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-[13.5px] ${tab === t.id ? 'border-ledger font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Kept mounted so a report survives a trip to the GSTIN tab and back. */}
      <div hidden={tab !== 'json'}><JsonValidator onCheckGstins={(g) => { setHandoff((h) => ({ text: g.join('\n'), n: h.n + 1 })); pick('gstin'); }} /></div>
      {tab === 'gstin' && <GstinValidator key={handoff.n} sandbox={sandbox} initialText={handoff.text} />}
      {tab === 'hsn' && <HsnValidator />}
    </div>
  );
}
