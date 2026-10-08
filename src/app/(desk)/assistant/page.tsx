'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, Notice } from '@/components/ui';
import { Markdown } from '@/components/assistant/Markdown';
import { call } from '@/lib/client';

/**
 * Ask the documents: questions in Hindi, Hinglish or English about one client. Answers come only
 * from the client's uploaded data – each answer shows what it looked at.
 */

interface Company { _id: string; name: string; gstin: string }
interface Turn { role: 'user' | 'assistant'; text: string; tools?: { name: string; label: string; ok: boolean }[]; at: string; error?: boolean }
interface ChatMeta { _id: string; title: string; updatedAt: string }

const EXAMPLES = [
  'September 2026 ki total sales kitni hai?',
  'GSTR-2B aur purchase register mein mismatch batao',
  'Kitne invoices GSTR-2B mein nahi aaye?',
  '₹50,000 se zyada ke purchase invoices dikhao',
  'Supplier-wise purchase summary do',
  'Is month ke unusual transactions batao',
  'इस साल की कुल ITC कितनी है?',
  'Which bank payments have no invoice?',
];

export default function AssistantPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [ai, setAi] = useState(true);
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    call<{ companies: Company[] }>('/api/companies').then((r) => { setCompanies(r.companies); if (r.companies[0]) setCompanyId(r.companies[0]._id); }).catch((e) => setErr(e.message));
  }, []);
  const loadChats = useCallback(() => (companyId ? call<{ chats: ChatMeta[]; ai: boolean; aiReason: string | null }>(`/api/assistant?companyId=${companyId}`).then((r) => { setChats(r.chats); setAi(r.ai); setAiReason(r.aiReason); }).catch((e) => setErr(e.message)) : Promise.resolve()), [companyId]);
  useEffect(() => { loadChats(); }, [loadChats]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  async function open(id: string) {
    setErr(null);
    try { const c = await call<{ turns: Turn[] }>(`/api/assistant/${id}`); setChatId(id); setTurns(c.turns); } catch (e) { setErr((e as Error).message); }
  }
  function startNew() { setChatId(null); setTurns([]); setErr(null); }

  async function send(text = q) {
    const message = text.trim();
    if (!message || busy) return;
    setQ(''); setBusy(true); setErr(null);
    setTurns((t) => [...t, { role: 'user', text: message, at: new Date().toISOString() }]);
    try {
      const r = await call<{ chatId: string; turn: Turn }>('/api/assistant', { method: 'POST', json: { companyId, message, ...(chatId ? { chatId } : {}) } });
      setChatId(r.chatId);
      setTurns((t) => [...t, r.turn]);
      loadChats();
    } catch (e) {
      setErr((e as Error).message);
      setTurns((t) => t.slice(0, -1));
      setQ(message);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this conversation?')) return;
    await call(`/api/assistant/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (id === chatId) startNew();
    loadChats();
  }

  const company = companies.find((c) => c._id === companyId);
  return (
    <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-4">
        <label>Client
          <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); startNew(); }}>
            {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </label>
        <Button variant="secondary" className="w-full" onClick={startNew}>New conversation</Button>
        <ul className="space-y-1 text-[13px]">
          {chats.map((c) => (
            <li key={c._id} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 ${c._id === chatId ? 'bg-black/5' : 'hover:bg-black/5'}`}>
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => open(c._id)} title={c.title}>{c.title}</button>
              <button type="button" className="hidden text-ink-soft hover:text-red-ink group-hover:inline" onClick={() => remove(c._id)} aria-label="Delete conversation">×</button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[75vh] flex-col rounded-lg border border-rule bg-sheet">
        <header className="border-b border-rule px-5 py-3">
          <h1 className="text-[18px] font-semibold">Ask the documents</h1>
          <p className="text-[12.5px] text-ink-soft">{company ? `${company.name} · ${company.gstin} · ` : ''}Answers come only from this client’s uploaded data – Hindi, Hinglish or English.</p>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!ai && <Notice tone="warn">The assistant is not available: {aiReason ?? 'Document AI is not set up.'}</Notice>}
          {!companies.length && <Empty title="Add a client first" />}
          {!turns.length && companies.length > 0 && (
            <div className="space-y-2">
              <p className="text-ink-soft">Try asking:</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((x) => <button key={x} type="button" disabled={!ai || busy} onClick={() => send(x)} className="rounded-full border border-rule bg-white px-3 py-1 text-[13px] hover:border-ink-soft disabled:opacity-50">{x}</button>)}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            t.role === 'user' ? (
              <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-ink px-4 py-2 text-white">{t.text}</div>
            ) : (
              <div key={i} className={`max-w-[95%] rounded-lg border px-4 py-3 text-[14px] ${t.error ? 'border-red-ink/30 bg-red-tint text-red-ink' : 'border-rule bg-white'}`}>
                <Markdown text={t.text} />
                {t.tools && t.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-rule pt-2 text-[11.5px] text-ink-soft">
                    <span>Looked at:</span>
                    {t.tools.map((x, j) => <span key={j} className={`rounded px-1.5 ${x.ok ? 'bg-black/5' : 'bg-red-tint text-red-ink'}`}>{x.label.trim()}</span>)}
                  </div>
                )}
              </div>
            )
          ))}
          {busy && <div className="flex items-center gap-2 text-[13px] text-ink-soft"><span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />Looking at the data…</div>}
          <div ref={end} />
        </div>

        {err && <div className="px-5 pb-2"><Notice tone="error">{err}</Notice></div>}
        <form className="flex gap-2 border-t border-rule p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea
            value={q} onChange={(e) => setQ(e.target.value)} rows={2} maxLength={2000} disabled={!ai || !companyId}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask about sales, purchases, ITC, GSTR-2B, duplicates, bank transactions…" className="flex-1 resize-none" aria-label="Question"
          />
          <Button type="submit" busy={busy} disabled={!q.trim() || !ai}>Ask</Button>
        </form>
      </section>
    </div>
  );
}
