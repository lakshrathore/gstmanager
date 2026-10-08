/**
 * Annual returns (GSTR-9, GSTR-9C): the table model shared by the forms, Excel import/export, the
 * validators and the browser. Pure – no I/O, no server-only imports.
 *
 * A form is described by tables of rows. Each row has a code ("4A", "6B Inputs", "9 IGST"), the
 * columns it has on the GST portal, and either user-entered values or a calculation from other rows.
 * Variable-length parts (HSN summary, other reversals, rate-wise rows) are lists; reasons are text.
 */

import { UQC_CODES } from '@/engine/masters';
import { amount, r2 } from '../gstr3b/protocol';

export { r2 };

export type Vals = Record<string, number>;
export type ListRow = Record<string, string | number>;

export interface AnnualForm {
  /** Entered values by row code. */
  v: Record<string, Vals>;
  /** List rows by list code. */
  lists: Record<string, ListRow[]>;
  /** Free text (reasons) by table id. */
  text: Record<string, string>;
}

/** All rows (entered and computed) by code. */
export type Resolved = Record<string, Vals>;

export interface Col {
  key: string;
  label: string;
  /** Filled by GSTN on the portal: read on import, not sent in the JSON. */
  ref?: boolean;
}

export interface RowDef {
  code: string;
  label: string;
  cols: readonly string[];
  /** Computed from other rows; read-only. */
  calc?: (r: Resolved, f: AnnualForm) => Vals;
  /** May be negative (± adjustments, differences). */
  signed?: boolean;
  /** Filled by GSTN on the portal: read on import, not sent in the JSON. */
  ref?: boolean;
  /** Where the row sits in GSTN's JSON: [table, key] or [table, array, itc_typ]. */
  json?: readonly string[];
  /** Renders this list here instead of a row. */
  list?: string;
  sub?: boolean;
}

export type ListColType = 'text' | 'num' | 'yn' | 'rate' | 'uqc' | 'hsn';
export interface ListCol { key: string; label: string; type: ListColType }
export interface ListDef {
  code: string;
  title: string;
  cols: ListCol[];
  /** GSTN JSON array path, e.g. ['table17', 'items']. */
  json?: readonly string[];
  /** Blank list row for "Add row". */
  blank: () => ListRow;
}

export interface TableDef {
  id: string;
  title: string;
  /** Worksheet the table is written to (tables may share one). */
  sheet: string;
  cols: Col[];
  rows: RowDef[];
  lists?: ListDef[];
  /** Free-text table (reasons). */
  text?: string;
  note?: string;
}

export interface Issue {
  severity: 'error' | 'warning';
  /** Table id ("4", "17") and, when it is about one row, the row code. */
  table: string;
  code?: string;
  message: string;
}

/* ---------- arithmetic ---------- */

export const HEADS = ['iamt', 'camt', 'samt', 'csamt'] as const;
export const TAXED = ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const;
export const COL_LABEL: Record<string, string> = { txval: 'Taxable value', iamt: 'IGST', camt: 'CGST', samt: 'SGST/UTGST', csamt: 'Cess' };

export function add(...vs: (Vals | undefined)[]): Vals {
  const out: Vals = {};
  for (const v of vs) for (const [k, n] of Object.entries(v ?? {})) out[k] = r2((out[k] ?? 0) + n);
  return out;
}
export const neg = (v: Vals | undefined): Vals => Object.fromEntries(Object.entries(v ?? {}).map(([k, n]) => [k, -n]));
export const rows = (r: Resolved, codes: string[]) => add(...codes.map((c) => r[c]));
export const total = (v: Vals | undefined, keys: readonly string[] = HEADS) => r2(keys.reduce((a, k) => a + (v?.[k] ?? 0), 0));
const pick = (v: Vals, cols: readonly string[]): Vals => Object.fromEntries(cols.map((c) => [c, r2(v[c] ?? 0)]));
export const listSum = (f: AnnualForm, code: string, cols: readonly string[]) =>
  pick(add(...(f.lists[code] ?? []).map((x) => Object.fromEntries(cols.map((c) => [c, Number(x[c]) || 0])))), cols);

/* ---------- form shape ---------- */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function allRows(defs: TableDef[]) {
  return defs.flatMap((t) => t.rows.filter((r) => !r.list).map((r) => ({ t, r })));
}
export const allLists = (defs: TableDef[]) => defs.flatMap((t) => (t.lists ?? []).map((l) => ({ t, l })));

/** Any form-shaped object → a complete form: every entered row present, numbers rounded, lists cleaned. */
export function normalize(defs: TableDef[], src: unknown): AnnualForm {
  const s = obj(src);
  const v = obj(s.v);
  const lists = obj(s.lists);
  const text = obj(s.text);
  const f: AnnualForm = { v: {}, lists: {}, text: {} };
  for (const { r } of allRows(defs)) {
    if (r.calc) continue;
    const x = obj(v[r.code]);
    f.v[r.code] = Object.fromEntries(r.cols.map((c) => [c, r2(x[c])]));
  }
  for (const { l } of allLists(defs)) {
    f.lists[l.code] = (Array.isArray(lists[l.code]) ? (lists[l.code] as unknown[]) : []).map((x) => cleanListRow(l, obj(x)));
  }
  for (const t of defs) if (t.text) f.text[t.id] = String(text[t.id] ?? '').slice(0, 4000);
  return f;
}

export function cleanListRow(l: ListDef, x: Record<string, unknown>): ListRow {
  const out: ListRow = l.blank();
  for (const c of l.cols) {
    const raw = x[c.key];
    if (c.type === 'num' || c.type === 'rate') out[c.key] = r2(raw);
    else if (c.type === 'yn') out[c.key] = String(raw ?? '').trim().toUpperCase().startsWith('Y') ? 'Y' : 'N';
    else if (c.type === 'uqc' || c.type === 'hsn') out[c.key] = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
    else out[c.key] = String(raw ?? '').trim().slice(0, 500);
  }
  return out;
}

export const blankForm = (defs: TableDef[]) => normalize(defs, {});

/** Entered rows plus every computed row, in table order. */
export function resolve(defs: TableDef[], f: AnnualForm): Resolved {
  const r: Resolved = {};
  for (const { r: row } of allRows(defs)) {
    r[row.code] = row.calc ? pick(row.calc(r, f), row.cols) : pick(f.v[row.code] ?? {}, row.cols);
  }
  return r;
}

export function isBlank(f: AnnualForm): boolean {
  return Object.values(f.v).every((x) => Object.values(x).every((n) => !n))
    && Object.values(f.lists).every((l) => !l.length)
    && Object.values(f.text).every((t) => !t.trim());
}

/* ---------- checks every form shares ---------- */

const UQC = new Set(Object.keys(UQC_CODES));

/** Negative amounts in rows that cannot be negative; CGST ≠ SGST; malformed list cells. */
export function basicIssues(defs: TableDef[], f: AnnualForm): Issue[] {
  const out: Issue[] = [];
  for (const { t, r } of allRows(defs)) {
    if (r.calc) continue;
    const x = f.v[r.code] ?? {};
    const neg = r.cols.filter((c) => (x[c] ?? 0) < 0);
    if (neg.length && !r.signed) out.push({ severity: 'error', table: t.id, code: r.code, message: `${r.code}: ${neg.map((c) => colLabel(t, c)).join(', ')} cannot be negative.` });
    if (r.cols.includes('camt') && r.cols.includes('samt') && Math.abs((x.camt ?? 0) - (x.samt ?? 0)) > 1) {
      out.push({ severity: 'warning', table: t.id, code: r.code, message: `${r.code}: CGST (${x.camt ?? 0}) and SGST/UTGST (${x.samt ?? 0}) are normally equal.` });
    }
  }
  for (const { t, l } of allLists(defs)) {
    (f.lists[l.code] ?? []).forEach((x, i) => {
      const at = `${l.title} row ${i + 1}`;
      for (const c of l.cols) {
        const v = x[c.key];
        if ((c.type === 'num' || c.type === 'rate') && Number(v) < 0) out.push({ severity: 'error', table: t.id, message: `${at}: ${c.label} cannot be negative.` });
        if (c.type === 'uqc' && v && !UQC.has(String(v))) out.push({ severity: 'error', table: t.id, message: `${at}: UQC "${v}" is not a GST unit quantity code (e.g. NOS, KGS, PCS, NA).` });
        if (c.type === 'text' && c.key === 'desc' && !String(v ?? '').trim() && l.cols.some((k) => k.type === 'num' && Number(x[k.key]))) {
          out.push({ severity: 'error', table: t.id, message: `${at}: enter a description.` });
        }
      }
    });
  }
  return out;
}

export const colLabel = (t: TableDef, key: string) => t.cols.find((c) => c.key === key)?.label ?? COL_LABEL[key] ?? key;

/** True when the difference is more than a rupee. */
export const differs = (a: number, b: number) => Math.abs(a - b) > 1;

/** "₹1,23,456.00" for messages. */
export const rs = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ---------- financial year ---------- */

/** "2024-25" → { start: 2024, months: ["042024" … "032025"], fp: "032025" }; null if malformed. */
export function fyInfo(fy: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) return null;
  const start = Number(m[1]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const mm = ((i + 3) % 12) + 1;
    return `${String(mm).padStart(2, '0')}${mm >= 4 ? start : start + 1}`;
  });
  return { start, months, fp: `03${start + 1}` };
}

/** Financial years to pick from: the current one back to 2017-18. */
export function fyChoices(now = new Date()) {
  const current = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: current - 2017 + 1 }, (_, i) => current - i).map((y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
}

/** Financial year of a return period MMYYYY ("072024" → "2024-25"). */
export function fyOf(fp: string) {
  const m = Number(fp.slice(0, 2));
  const y = Number(fp.slice(2));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/* ---------- Excel ---------- */

/** "6B Inputs" → "6binputs": codes and headings compare without case, spaces or punctuation. */
export const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES: Record<string, string[]> = {
  code: ['code', 'table', 'tableno', 'sno', 'srno'],
  desc: ['description', 'details', 'nature', 'particulars'],
  reason: ['reason', 'reasons'],
  txval: ['taxablevalue', 'taxable', 'totaltaxablevalue'],
  iamt: ['igst', 'integratedtax'],
  camt: ['cgst', 'centraltax'],
  samt: ['sgstutgst', 'sgst', 'stateuttax', 'statetax', 'utgst'],
  csamt: ['cess'],
  hsn_sc: ['hsn', 'hsncode', 'hsnsac', 'hsnsc'],
  uqc: ['uqc', 'unit'],
  qty: ['totalquantity', 'quantity', 'qty'],
  rt: ['rate', 'rateoftax', 'taxrate'],
};

/** Heading → column key for a form's tables (the labels it writes plus common variants). */
function headerMap(defs: TableDef[]) {
  const m = new Map<string, string>();
  for (const [k, names] of Object.entries(ALIASES)) for (const n of names) m.set(n, k);
  for (const t of defs) {
    for (const c of t.cols) m.set(norm(c.label), c.key);
    for (const l of t.lists ?? []) for (const c of l.cols) m.set(norm(c.label), c.key);
  }
  return m;
}

/** Union of a table's columns and its lists' columns, as written to the sheet (Description is its own column). */
export function sheetCols(t: TableDef): Col[] {
  const out = [...t.cols];
  for (const l of t.lists ?? []) for (const c of l.cols) if (c.key !== 'desc' && !out.some((x) => x.key === c.key)) out.push({ key: c.key, label: c.label });
  return out;
}

export interface ExcelImport {
  form: AnnualForm;
  read: { rows: number; listRows: number; text: number };
  issues: string[];
}

/**
 * Reads a form's Excel template, or any sheet laid out the same way: a heading row with "Code" (or
 * "HSN") and the column names, then rows by code. A sheet may hold several tables, each with its own
 * heading row. Computed rows are ignored (they are recalculated); anything unreadable is reported.
 */
export function parseAnnualExcel(defs: TableDef[], sheets: { name: string; rows: unknown[][] }[], formName: string): ExcelImport {
  const form = blankForm(defs);
  const issues: string[] = [];
  const read = { rows: 0, listRows: 0, text: 0 };
  const hm = headerMap(defs);
  const byCode = new Map(allRows(defs).map(({ t, r }) => [norm(r.code), { t, r }]));
  const listBy = new Map(allLists(defs).map(({ t, l }) => [norm(l.code), { t, l }]));
  const textBy = new Map(defs.filter((t) => t.text).map((t) => [norm(t.id), t]));
  const seen = new Set<string>();
  const listsSeen = new Set<string>();

  for (const sh of sheets) {
    let col: Record<string, number> | null = null;
    const missingNoted = new Set<string>();
    // A list whose sheet this is (HSN sheets need no Code column).
    const sheetList = allLists(defs).find(({ l }) => norm(sh.name).startsWith(norm(l.code)) && !byCode.has(norm(l.code)));
    for (let i = 0; i < sh.rows.length; i++) {
      const row = sh.rows[i] ?? [];
      if (!row.some((c) => c != null && String(c).trim() !== '')) continue;
      const keys: Record<string, number> = {};
      row.forEach((c, j) => { const k = hm.get(norm(c)); if (k && keys[k] == null) keys[k] = j; });
      if ((keys.code != null || keys.hsn_sc != null) && Object.keys(keys).length >= 2) { col = keys; continue; }
      if (!col) continue;
      const c = col;
      const at = (k: string) => (c[k] == null ? undefined : row[c[k]]);
      const where = `${sh.name} row ${i + 1}`;
      const code = norm(at('code') ?? (c.code == null ? '' : row[0]));

      const def = byCode.get(code);
      if (def) {
        if (def.r.calc) continue;
        if (seen.has(def.r.code)) issues.push(`${where}: ${def.r.code} appears more than once – the last one is used.`);
        seen.add(def.r.code);
        const vals: Vals = {};
        let bad = false;
        for (const key of def.r.cols) {
          if (c[key] == null) {
            if (!missingNoted.has(key)) issues.push(`${sh.name}: no "${colLabel(def.t, key)}" column – taken as 0.`);
            missingNoted.add(key);
            continue;
          }
          const v = amount(at(key));
          if (v == null) { issues.push(`${where}: ${def.r.code} ${colLabel(def.t, key)} "${String(at(key))}" is not a number – row skipped.`); bad = true; break; }
          vals[key] = v;
        }
        if (bad) continue;
        for (const key of sheetCols(def.t).map((x) => x.key)) {
          if (def.r.cols.includes(key) || c[key] == null) continue;
          const v = amount(at(key));
          if (v) issues.push(`${where}: ${def.r.code} has no ${colLabel(def.t, key)} on the GST portal – ${v} ignored.`);
        }
        form.v[def.r.code] = { ...form.v[def.r.code], ...vals };
        read.rows++;
        continue;
      }

      const text = textBy.get(code);
      if (text) {
        const v = String(at('reason') ?? '').trim();
        if (v) { form.text[text.id] = v.slice(0, 4000); read.text++; }
        continue;
      }

      const list = listBy.get(code) ?? (!code ? sheetList : undefined);
      if (list) {
        const raw: Record<string, unknown> = {};
        let bad = false;
        for (const lc of list.l.cols) {
          const v = at(lc.key);
          if (lc.type === 'num' || lc.type === 'rate') {
            const n = amount(v);
            if (n == null) { issues.push(`${where}: ${lc.label} "${String(v)}" is not a number – row skipped.`); bad = true; break; }
            raw[lc.key] = n;
          } else raw[lc.key] = v instanceof Date ? '' : v;
        }
        if (bad) continue;
        const lr = cleanListRow(list.l, raw);
        if (!list.l.cols.some((lc) => (lc.type === 'num' || lc.type === 'rate' ? Number(lr[lc.key]) : lc.type !== 'yn' && lr[lc.key]))) continue;
        // A list in the file replaces the list in the form (not appended to the blank one).
        if (!listsSeen.has(list.l.code)) { form.lists[list.l.code] = []; listsSeen.add(list.l.code); }
        form.lists[list.l.code].push(lr);
        read.listRows++;
      }
    }
  }
  if (!read.rows && !read.listRows && !read.text) {
    issues.unshift(`No ${formName} rows found. Use the ${formName} Excel template: a "Code" column with the table codes (4A, 4B …) and the amount columns.`);
  }
  return { form: normalize(defs, form), read, issues };
}
