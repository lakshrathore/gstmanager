'use client';

import { useMemo, useState } from 'react';
import { checkHsn, HSN_CHAPTERS, SAC_HEADINGS, type HsnCheck } from '@/engine/hsn';
import { Button, Panel, Severity } from '@/components/ui';
import { downloadCsv } from './csv';

const split = (t: string) => [...new Set(t.split(/[\n,;\t]+/).map((s) => s.trim()).filter(Boolean))];

export function HsnValidator() {
  const [text, setText] = useState('');
  const [aato, setAato] = useState(false);
  const [b2b, setB2b] = useState(true);
  const [results, setResults] = useState<HsnCheck[] | null>(null);
  const list = split(text);

  const run = () => setResults(list.slice(0, 1000).map((c) => checkHsn(c, { aatoAbove5Cr: aato, b2b })));
  const exportCsv = () => results && downloadCsv('hsn-check.csv', ['Input', 'Code', 'Result', 'Type', 'Chapter / heading', 'Description', 'Min digits', 'Issues'],
    results.map((r) => [r.input, r.code, r.ok ? 'Valid' : 'Invalid', r.kind ?? '', r.heading ?? r.chapter ?? '', r.headingName ?? r.chapterName ?? '', r.minDigits ?? '', r.issues.map((i) => `${i.severity}: ${i.message}`).join(' | ')]));

  return (
    <div className="space-y-6">
      <Panel title="Validate HSN / SAC codes">
        <label>Codes – one per line or comma-separated (dots and spaces are ignored)
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} spellCheck={false} className="num" placeholder={'8471\n847130\n998314\n7701'} />
        </label>
        <p className="mt-1 text-[12.5px] text-ink-soft">{list.length} code{list.length === 1 ? '' : 's'}{list.length > 1000 ? ' – the first 1000 are checked' : ''}</p>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-[13.5px]">
          <label className="flex items-center gap-2 text-ink"><input type="checkbox" className="w-auto" checked={aato} onChange={(e) => setAato(e.target.checked)} />Turnover above ₹5 crore</label>
          <label className="flex items-center gap-2 text-ink"><input type="radio" className="w-auto" checked={b2b} onChange={() => setB2b(true)} />B2B supplies (Table 12 B2B)</label>
          <label className="flex items-center gap-2 text-ink"><input type="radio" className="w-auto" checked={!b2b} onChange={() => setB2b(false)} />B2C supplies</label>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-soft">Minimum digits: {b2b && aato ? 6 : 4}. Above ₹5 crore, B2B rows need 6 digits; B2C rows and turnover up to ₹5 crore need 4.</p>
        <div className="mt-5"><Button onClick={run} disabled={!list.length}>Validate {list.length || ''} code{list.length === 1 ? '' : 's'}</Button></div>
      </Panel>

      {results && (
        <Panel title={`${results.filter((r) => r.ok).length} valid · ${results.filter((r) => !r.ok).length} invalid`} action={<Button variant="secondary" onClick={exportCsv}>Download CSV</Button>}>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>Code</th><th>Result</th><th>Type</th><th>Chapter / heading</th><th>Issues</th></tr></thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className={r.ok ? '' : 'row-error'}>
                    <td className="num whitespace-nowrap">{r.code || r.input}{r.code !== r.input && r.code && <span className="block text-[12px] text-ink-soft">typed {r.input}</span>}</td>
                    <td>{r.ok ? <span className="rounded bg-ledger-tint px-1.5 py-0.5 text-[12px] font-medium text-ledger">Valid</span> : <span className="rounded bg-red-tint px-1.5 py-0.5 text-[12px] font-medium text-red-ink">Invalid</span>}</td>
                    <td>{r.kind === 'service' ? 'Service (SAC)' : r.kind === 'goods' ? 'Goods (HSN)' : '—'}</td>
                    <td>{r.heading || r.chapter ? <><span className="num">{r.heading ?? r.chapter}</span> {r.headingName ?? r.chapterName ?? <span className="text-ink-soft">unknown</span>}</> : '—'}</td>
                    <td>{r.issues.length === 0 ? <span className="text-ink-soft">—</span> : r.issues.map((x, k) => (
                      <div key={k} className="mb-1 flex items-start gap-2"><Severity s={x.severity} /><span>{x.message}{x.suggestion && <span className="block text-[12.5px] text-ledger">{x.suggestion}</span>}</span></div>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12.5px] text-ink-soft">This checks structure, chapter, SAC heading and digits for your turnover. Whether a full 6- or 8-digit code exists is confirmed by the portal&apos;s HSN master on upload.</p>
        </Panel>
      )}

      <ChapterFinder />
    </div>
  );
}

function ChapterFinder() {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const all = [...Object.entries(HSN_CHAPTERS).map(([c, n]) => ({ c, n, k: 'Goods' })), ...Object.entries(SAC_HEADINGS).map(([c, n]) => ({ c, n, k: 'Service' }))];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((r) => r.c.startsWith(needle) || r.n.toLowerCase().includes(needle)) : [];
  }, [q]);
  return (
    <Panel title="Find a chapter or SAC heading">
      <label className="max-w-md">Search by number or words<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 84, furniture, transport" /></label>
      {q.trim() && (rows.length === 0 ? <p className="mt-3 text-ink-soft">No match.</p> : (
        <div className="-mx-5 mt-4 max-h-[320px] overflow-auto">
          <table className="ledger"><thead><tr><th>Code</th><th>Type</th><th>Description</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.c}><td className="num">{r.c}</td><td>{r.k}</td><td>{r.n}</td></tr>)}</tbody>
          </table>
        </div>
      ))}
    </Panel>
  );
}
