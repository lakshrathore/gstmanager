'use client';

import { Fragment, useMemo, type ReactNode } from 'react';
import { Num } from '@/components/gstr3b/Gstr3bTables';
import { inr } from '@/lib/client';
import { UQC_CODES } from '@/engine/masters';
import { resolve, type AnnualForm, type Issue, type ListDef, type ListRow, type TableDef } from '@/server/gst/annual/common';

/**
 * Any annual form (GSTR-9, GSTR-9C) laid out table by table as on the GST portal. Computed rows are
 * shaded and update as you type; rows with errors or warnings are marked. Read-only without `onChange`.
 */

const UQCS = Object.keys(UQC_CODES);

function Badge({ n, tone }: { n: number; tone: 'error' | 'warn' }) {
  if (!n) return null;
  return <span className={`rounded px-1.5 py-0.5 text-[11.5px] font-medium ${tone === 'error' ? 'bg-red-tint text-red-ink' : 'bg-amber-tint text-amber'}`}>{n} {tone === 'error' ? (n === 1 ? 'error' : 'errors') : (n === 1 ? 'warning' : 'warnings')}</span>;
}

/** One editable list cell. */
function ListCell({ c, x, rates, set }: { c: ListDef['cols'][number]; x: ListRow; rates: number[]; set?: (v: string | number) => void }) {
  const v = x[c.key];
  if (!set) return c.type === 'num' ? <span className="num block text-right">{inr(Number(v))}</span> : <span>{c.type === 'rate' ? `${v}%` : String(v ?? '')}</span>;
  switch (c.type) {
    case 'num': return <Num value={Number(v) || 0} onChange={set} />;
    case 'rate': return (
      <select value={String(v)} onChange={(e) => set(Number(e.target.value))} aria-label={c.label}>
        {!rates.includes(Number(v)) && <option value={String(v)}>{String(v)}%</option>}
        {rates.map((r) => <option key={r} value={r}>{r}%</option>)}
      </select>
    );
    case 'yn': return (
      <select value={String(v)} onChange={(e) => set(e.target.value)} aria-label={c.label}>
        <option value="N">No</option><option value="Y">Yes</option>
      </select>
    );
    case 'uqc': return (
      <select value={String(v)} onChange={(e) => set(e.target.value)} aria-label={c.label}>
        <option value="">—</option>
        {!UQCS.includes(String(v)) && v && <option value={String(v)}>{String(v)}</option>}
        {UQCS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    );
    case 'hsn': return <input value={String(v ?? '')} onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" className="num w-24" aria-label={c.label} />;
    default: return <input value={String(v ?? '')} onChange={(e) => set(e.target.value)} className="w-full min-w-56" aria-label={c.label} />;
  }
}

interface Props {
  defs: TableDef[];
  form: AnnualForm;
  onChange?: (f: AnnualForm) => void;
  issues: Issue[];
  /** GST rates offered in rate pickers. */
  rates: number[];
}

export function AnnualTables({ defs, form, onChange, issues, rates }: Props) {
  const r = useMemo(() => resolve(defs, form), [defs, form]);
  const rowTone = useMemo(() => {
    const m = new Map<string, 'row-error' | 'row-warn'>();
    for (const i of issues) if (i.code && m.get(i.code) !== 'row-error') m.set(i.code, i.severity === 'error' ? 'row-error' : 'row-warn');
    return m;
  }, [issues]);
  const count = (t: string, s: Issue['severity']) => issues.filter((i) => i.table === t && i.severity === s).length;

  const setVal = onChange && ((code: string, key: string, n: number) => onChange({ ...form, v: { ...form.v, [code]: { ...form.v[code], [key]: n } } }));
  const setList = onChange && ((code: string, rows: ListRow[]) => onChange({ ...form, lists: { ...form.lists, [code]: rows } }));
  const setText = onChange && ((id: string, s: string) => onChange({ ...form, text: { ...form.text, [id]: s } }));

  /** List rows rendered inside a table: code, description (or rate / RC pickers), then the table's columns. */
  function inlineList(l: ListDef, cols: { key: string }[]): ReactNode {
    const items = form.lists[l.code] ?? [];
    const lead = l.cols.filter((c) => !cols.some((x) => x.key === c.key));
    const upd = setList && ((i: number, key: string, v: string | number) => setList(l.code, items.map((x, j) => (j === i ? { ...x, [key]: v } : x))));
    return (
      <>
        {items.map((x, i) => (
          <tr key={`${l.code}-${i}`}>
            <td className="whitespace-nowrap text-ink-soft">{l.code}</td>
            <td><div className="flex flex-wrap items-center gap-2">
              {lead.map((c) => (
                <label key={c.key} className="flex items-center gap-1.5 text-[12.5px]">
                  {c.key !== 'desc' && <span className="text-ink-soft">{c.label}</span>}
                  <ListCell c={c} x={x} rates={rates} set={upd && ((v) => upd(i, c.key, v))} />
                </label>
              ))}
              {setList && <button type="button" className="text-[12.5px] text-red-ink hover:underline" onClick={() => setList(l.code, items.filter((_, j) => j !== i))}>Remove</button>}
            </div></td>
            {cols.map((c) => {
              const lc = l.cols.find((k) => k.key === c.key);
              return <td key={c.key}>{lc ? <ListCell c={lc} x={x} rates={rates} set={upd && ((v) => upd(i, c.key, v))} /> : null}</td>;
            })}
          </tr>
        ))}
        {!items.length && <tr><td className="text-ink-soft">{l.code}</td><td colSpan={cols.length + 1} className="text-ink-soft">None</td></tr>}
        {setList && <tr><td /><td colSpan={cols.length + 1}><button type="button" className="text-[13px] text-ledger hover:underline" onClick={() => setList(l.code, [...items, l.blank()])}>+ Add {l.code} row</button></td></tr>}
      </>
    );
  }

  function hsnList(l: ListDef): ReactNode {
    const items = form.lists[l.code] ?? [];
    const upd = setList && ((i: number, key: string, v: string | number) => setList(l.code, items.map((x, j) => (j === i ? { ...x, [key]: v } : x))));
    const sum = (k: string) => items.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    return (
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead><tr>{l.cols.map((c) => <th key={c.key} className={c.type === 'num' ? 'text-right' : ''}>{c.label}</th>)}{setList && <th />}</tr></thead>
          <tbody>
            {items.map((x, i) => (
              <tr key={i}>
                {l.cols.map((c) => <td key={c.key}><ListCell c={c} x={x} rates={rates} set={upd && ((v) => upd(i, c.key, v))} /></td>)}
                {setList && <td><button type="button" className="text-red-ink hover:underline" onClick={() => setList(l.code, items.filter((_, j) => j !== i))}>Remove</button></td>}
              </tr>
            ))}
            {!items.length && <tr><td colSpan={l.cols.length + 1} className="text-ink-soft">None</td></tr>}
            {items.length > 1 && (
              <tr className="row-calc"><td>Total ({items.length} rows)</td>{l.cols.slice(1).map((c) => <td key={c.key} className="num text-right">{c.type === 'num' && c.key !== 'qty' ? inr(sum(c.key)) : ''}</td>)}{setList && <td />}</tr>
            )}
          </tbody>
        </table>
        {setList && <button type="button" className="mx-5 mt-2 text-[13px] text-ledger hover:underline" onClick={() => setList(l.code, [...items, l.blank()])}>+ Add HSN row</button>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-[13.5px]">
      {defs.map((t) => {
        const errors = count(t.id, 'error');
        const warnings = count(t.id, 'warning');
        const cols = t.cols;
        return (
          <details key={t.id} id={`table-${t.id}`} open={errors > 0 || undefined} className="rounded-md border border-rule bg-white">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5 font-semibold">
              <span className="mr-auto">{t.title}</span>
              <Badge n={errors} tone="error" /><Badge n={warnings} tone="warn" />
            </summary>
            <div className="space-y-2 border-t border-rule px-5 py-4">
              {t.note && <p className="text-[12.5px] text-ink-soft">{t.note}</p>}
              {t.text ? (
                setText
                  ? <textarea value={form.text[t.id] ?? ''} onChange={(e) => setText(t.id, e.target.value)} rows={4} maxLength={4000} className="w-full" placeholder="Reasons (one per line)" />
                  : <p className="whitespace-pre-wrap">{form.text[t.id] || <span className="text-ink-soft">None given</span>}</p>
              ) : !t.rows.length && t.lists?.length === 1 ? hsnList(t.lists[0]) : (
                <div className="-mx-5 overflow-x-auto">
                  <table className="ledger">
                    <thead><tr><th>Code</th><th>Description</th>{cols.map((c) => <th key={c.key} className="text-right">{c.label}</th>)}</tr></thead>
                    <tbody>
                      {t.rows.map((def) => {
                        if (def.list) return <Fragment key={def.code}>{inlineList(t.lists!.find((l) => l.code === def.list)!, cols)}</Fragment>;
                        const v = r[def.code] ?? {};
                        return (
                          <tr key={def.code} className={`${def.calc ? 'row-calc' : ''} ${rowTone.get(def.code) ?? ''}`}>
                            <td className="whitespace-nowrap">{def.code}</td>
                            <td className={`min-w-72 ${def.sub ? 'pl-6' : ''}`}>{def.label}{def.ref && <span className="ml-1 text-[11.5px] font-normal text-ink-soft">(filled by the portal)</span>}</td>
                            {cols.map((c) => (
                              <td key={c.key}>
                                {!def.cols.includes(c.key) ? <span className="block text-center text-ink-soft">—</span>
                                  : def.calc ? <span className={`num block text-right ${(v[c.key] ?? 0) < 0 ? 'text-red-ink' : ''}`}>{inr(v[c.key] ?? 0)}</span>
                                    : <Num value={v[c.key] ?? 0} onChange={setVal && ((n) => setVal(def.code, c.key, n))} />}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

