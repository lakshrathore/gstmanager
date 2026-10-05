import { profileForPeriod } from '../config/versions';
import { DOC_TYPES } from '../masters';
import { checkGstin, computeTax, parseDate, parsePos, round2, toPortalDate } from '../util';
import type { FixCode } from './fixLabels';
import type { JsonCheckReport } from './check';
import { validateGstr1Json } from './schema';

export { FIX_LABELS, type FixCode } from './fixLabels';

/**
 * Safe, deterministic repairs of a GSTR-1 upload JSON. Every change is reported (path, before, after)
 * so the user can review it; nothing is guessed. Not fixed here (needs a person): wrong GSTINs,
 * invoice numbers, dates outside the period, invalid rates, B2CL↔B2CS moves, splitting hsn.data.
 * Pure function – no I/O.
 */

export interface AppliedFix { code: FixCode; path: string; message: string; before?: unknown; after?: unknown }
export interface FixOptions {
  /** Recalculate IGST/CGST/SGST where they are on the wrong head or off by more than ₹1. Default true. */
  recomputeTax?: boolean;
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): J[] => arr(v).filter(isObj);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const TAX_TOLERANCE = 1;

const MONEY = new Set(['val', 'txval', 'iamt', 'camt', 'samt', 'csamt', 'ad_amt', 'nil_amt', 'expt_amt', 'ngsup_amt']);
const NUMERIC = new Set([...MONEY, 'rt', 'qty', 'num', 'totnum', 'cancel', 'net_issue', 'doc_num', 'diff_percent']);
const UPPER = new Set(['gstin', 'ctin', 'etin', 'rchrg', 'inv_typ', 'ntty', 'typ', 'exp_typ', 'sply_ty', 'uqc', 'sbpcode']);
const DATES = new Set(['idt', 'nt_dt', 'sbdt']);
const UNSUPPORTED = ['b2ba', 'b2cla', 'b2csa', 'cdnra', 'cdnura', 'expa', 'ata', 'txpda', 'supeco', 'supecoa', 'ecom', 'ecoma', 'ecomb2b', 'ecomb2c', 'ecomurp2b', 'ecomurp2c'];

export function fixGstr1Json(input: unknown, opts: FixOptions = {}): { json: unknown; fixes: AppliedFix[] } {
  if (!isObj(input)) return { json: input, fixes: [] };
  const json = structuredClone(input) as J;
  const fixes: AppliedFix[] = [];
  const log = (code: FixCode, path: string, message: string, before?: unknown, after?: unknown) => fixes.push({ code, path, message, before, after });

  /* 1. scalar formats, outside amendment/ECO sections */
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (!path && UNSUPPORTED.includes(k)) continue;
      if (typeof x === 'object' && x !== null) { walk(x, p); continue; }
      let y: unknown = x;
      if (NUMERIC.has(k) && typeof y === 'string' && y.trim() !== '' && isFinite(Number(y.replace(/,/g, '')))) y = Number(y.replace(/,/g, ''));
      if (typeof y === 'string') {
        y = y.trim();
        if (UPPER.has(k)) y = (y as string).toUpperCase();
        if (k === 'uqc' && /^[A-Z]{2,3}-/.test(y as string)) y = (y as string).split('-')[0];
        if (k === 'rchrg') y = /^(Y|YES)$/.test(y as string) ? 'Y' : /^(N|NO)$/.test(y as string) ? 'N' : y;
        if (k === 'pos' && y) y = parsePos(y);
        if (DATES.has(k) && y && !/^\d{2}-\d{2}-\d{4}$/.test(y as string)) { const d = parseDate(y); if (d) y = toPortalDate(d); }
        if (k === 'desc' && (y as string).length > 30) y = (y as string).slice(0, 30);
      }
      if (k === 'pos' && typeof y === 'number') y = String(y).padStart(2, '0');
      if (k === 'hsn_sc' && typeof y === 'number') y = String(y);
      if (k === 'hsn_sc' && typeof y === 'string' && /^[\d\s.]+$/.test(y)) y = y.replace(/[\s.]/g, ''); // "8471.30" → "847130"
      if (k === 'diff_percent' && y === 65) y = 0.65;
      if (y !== x) log('FORMAT', p, `${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`, x, y);
      if (MONEY.has(k) && typeof y === 'number' && Math.abs(y * 100 - Math.round(y * 100)) > 1e-6) {
        const r = round2(y);
        log('ROUNDING', p, `${k}: ${y} → ${r}`, y, r);
        y = r;
      }
      v[k] = y;
    }
  };
  walk(json, '');

  /* 2. header */
  const gstin = typeof json.gstin === 'string' ? json.gstin : '';
  const fp = typeof json.fp === 'string' ? json.fp : '';
  const st = checkGstin(gstin).ok ? gstin.slice(0, 2) : null;
  const profile = /^(0[1-9]|1[0-2])\d{4}$/.test(fp) ? profileForPeriod(fp) : null;
  if (profile && json.version !== profile.jsonVersion) {
    log('VERSION', 'version', `version ${JSON.stringify(json.version ?? null)} → ${profile.jsonVersion}`, json.version, profile.jsonVersion);
    json.version = profile.jsonVersion;
  }
  if (typeof json.hash !== 'string') { log('HASH', 'hash', 'Added "hash": "hash"', json.hash, 'hash'); json.hash = 'hash'; }

  /* 3. repeated groups */
  const mergeGroups = (section: string, key: string, child: string) => {
    const list = objs(json[section]);
    if (!list.length) return;
    const out: J[] = [];
    const seen = new Map<string, J>();
    list.forEach((g, i) => {
      const k = String(g[key] ?? '');
      const first = seen.get(k);
      if (!first) { seen.set(k, g); out.push(g); return; }
      first[child] = [...arr(first[child]), ...arr(g[child])];
      log('GROUP_MERGED', `${section}[${i}]`, `${key} ${k}: merged into its first group`);
    });
    json[section] = out;
  };
  mergeGroups('b2b', 'ctin', 'inv');
  mergeGroups('cdnr', 'ctin', 'nt');
  mergeGroups('b2cl', 'pos', 'inv');
  mergeGroups('exp', 'exp_typ', 'inv');

  /* 4. one item per rate */
  const sum = (a: J, b: J, keys: string[]) => { for (const k of keys) if (k in a || k in b) a[k] = round2(num(a[k]) + num(b[k])); };
  const mergeRates = (doc: J, path: string, flat: boolean, keys: string[]) => {
    const list = objs(doc.itms);
    if (list.length < 2) return;
    const out: J[] = [];
    const byRate = new Map<number, J>();
    list.forEach((it, i) => {
      const d = flat ? it : isObj(it.itm_det) ? it.itm_det : it;
      const rt = typeof d.rt === 'number' ? d.rt : NaN;
      const first = byRate.get(rt);
      if (Number.isNaN(rt) || !first) { if (!Number.isNaN(rt)) byRate.set(rt, d); out.push(it); return; }
      sum(first, d, keys);
      log('RATE_MERGED', `${path}.itms[${i}]`, `Rate ${rt}% merged into the first ${rt}% item`);
    });
    doc.itms = out;
  };
  const ITEM_KEYS = ['txval', 'iamt', 'camt', 'samt', 'csamt'];
  for (const [s, child] of [['b2b', 'inv'], ['b2cl', 'inv'], ['exp', 'inv'], ['cdnr', 'nt']] as const) {
    objs(json[s]).forEach((g, gi) => objs(g[child]).forEach((d, di) => mergeRates(d, `${s}[${gi}].${child}[${di}]`, s === 'exp', ITEM_KEYS)));
  }
  objs(json.cdnur).forEach((d, i) => mergeRates(d, `cdnur[${i}]`, false, ITEM_KEYS));

  /* 5. B2CS / advances: sply_ty from POS, one line per key */
  const splyTy = (line: J, path: string) => {
    if (!st || typeof line.pos !== 'string' || !line.pos) return;
    const want = line.pos === st ? 'INTRA' : 'INTER';
    if (line.sply_ty !== want) { log('SPLY_TY', `${path}.sply_ty`, `sply_ty ${JSON.stringify(line.sply_ty ?? null)} → ${want} (POS ${line.pos})`, line.sply_ty, want); line.sply_ty = want; }
  };
  if (Array.isArray(json.b2cs)) {
    const out: J[] = [];
    const seen = new Map<string, J>();
    objs(json.b2cs).forEach((l, i) => {
      splyTy(l, `b2cs[${i}]`);
      const k = [l.pos, l.rt, l.typ, l.etin ?? '', l.diff_percent ?? ''].join('|');
      const first = seen.get(k);
      if (!first) { seen.set(k, l); out.push(l); return; }
      sum(first, l, ITEM_KEYS);
      log('LINE_MERGED', `b2cs[${i}]`, `POS ${l.pos}, ${l.rt}%, ${l.typ}: merged into the first matching line`);
    });
    json.b2cs = out;
  }
  for (const s of ['at', 'txpd'] as const) {
    if (!Array.isArray(json[s])) continue;
    const out: J[] = [];
    const seen = new Map<string, J>();
    objs(json[s]).forEach((l, i) => {
      splyTy(l, `${s}[${i}]`);
      const k = [l.pos, l.diff_percent ?? ''].join('|');
      const first = seen.get(k);
      if (!first) { seen.set(k, l); out.push(l); return; }
      first.itms = [...arr(first.itms), ...arr(l.itms)];
      log('LINE_MERGED', `${s}[${i}]`, `POS ${l.pos}: merged into the first line for this POS`);
    });
    out.forEach((l, i) => mergeRates(l, `${s}[${i}]`, true, ['ad_amt', 'iamt', 'camt', 'samt', 'csamt']));
    json[s] = out;
  }

  /* 6. tax heads and amounts (only where the validator would flag them) */
  if (opts.recomputeTax !== false && st) {
    const fixTax = (it: J, base: unknown, path: string, rule: { pos: string; forceIgst?: boolean; noTax?: boolean; diff?: unknown; igstOnly?: boolean }) => {
      if (typeof it.rt !== 'number' || typeof base !== 'number' || !rule.pos) return;
      const diffPercent = typeof rule.diff === 'number' ? rule.diff * 100 : null;
      const exp = computeTax(it.rt, base, { supplierState: st, pos: rule.pos, forceIgst: rule.forceIgst, noTax: rule.noTax, diffPercent });
      const inter = rule.noTax || rule.forceIgst || rule.pos !== st;
      const i = num(it.iamt), c = num(it.camt), s = num(it.samt);
      const wrongHead = inter ? c !== 0 || s !== 0 : i !== 0;
      const off = Math.abs(i + c + s - (exp.iamt + exp.camt + exp.samt)) > TAX_TOLERANCE || (!inter && Math.abs(c - s) > 0.01);
      if (!wrongHead && !off) return;
      const before = { iamt: it.iamt, camt: it.camt, samt: it.samt };
      if (inter || rule.igstOnly) { it.iamt = exp.iamt; delete it.camt; delete it.samt; }
      else { delete it.iamt; it.camt = exp.camt; it.samt = exp.samt; }
      const after = { iamt: it.iamt, camt: it.camt, samt: it.samt };
      log('TAX_RECALCULATED', path, `${base} × ${it.rt}%${diffPercent ? ' × 65%' : ''} → ${inter ? `IGST ${exp.iamt}` : `CGST ${exp.camt} + SGST ${exp.samt}`}`, before, after);
    };
    const docItems = (d: J, path: string, rule: Parameters<typeof fixTax>[3], flat = false) =>
      objs(d.itms).forEach((it, i) => {
        const det = flat ? it : isObj(it.itm_det) ? it.itm_det : null;
        if (det) fixTax(det, det.txval, `${path}.itms[${i}]${flat ? '' : '.itm_det'}`, rule);
      });
    const SEZ = ['SEWP', 'SEWOP', 'CBW'];
    for (const [s, child] of [['b2b', 'inv'], ['cdnr', 'nt']] as const) {
      objs(json[s]).forEach((g, gi) => objs(g[child]).forEach((d, di) => docItems(d, `${s}[${gi}].${child}[${di}]`,
        { pos: String(d.pos ?? ''), forceIgst: SEZ.includes(String(d.inv_typ)), noTax: d.inv_typ === 'SEWOP', diff: d.diff_percent })));
    }
    objs(json.b2cl).forEach((g, gi) => objs(g.inv).forEach((d, di) => docItems(d, `b2cl[${gi}].inv[${di}]`, { pos: String(g.pos ?? ''), forceIgst: true, diff: d.diff_percent })));
    objs(json.cdnur).forEach((d, i) => docItems(d, `cdnur[${i}]`, { pos: String(d.pos ?? '96'), forceIgst: true, noTax: d.typ === 'EXPWOP', diff: d.diff_percent }));
    objs(json.exp).forEach((g, gi) => objs(g.inv).forEach((d, di) => docItems(d, `exp[${gi}].inv[${di}]`, { pos: '96', forceIgst: true, noTax: g.exp_typ === 'WOPAY', igstOnly: true }, true)));
    objs(json.b2cs).forEach((l, i) => fixTax(l, l.txval, `b2cs[${i}]`, { pos: String(l.pos ?? ''), diff: l.diff_percent }));
    for (const s of ['at', 'txpd'] as const) {
      objs(json[s]).forEach((l, li) => objs(l.itms).forEach((it, i) => fixTax(it, it.ad_amt, `${s}[${li}].itms[${i}]`, { pos: String(l.pos ?? ''), diff: l.diff_percent })));
    }
  }

  /* 7. item numbers (rate × 100 + 1, as the offline tool writes them) – only when they clash */
  const clash = (list: J[]) => new Set(list.map((x) => x.num)).size !== list.length || list.some((x) => !Number.isInteger(x.num));
  const renumber = (d: J, path: string) => clash(objs(d.itms)) && objs(d.itms).forEach((it, i) => {
    if (!isObj(it.itm_det) || typeof it.itm_det.rt !== 'number') return;
    const want = Math.round(it.itm_det.rt * 100) + 1;
    if (it.num !== want) { log('ITEM_NUMBER', `${path}.itms[${i}].num`, `num ${JSON.stringify(it.num ?? null)} → ${want}`, it.num, want); it.num = want; }
  });
  for (const [s, child] of [['b2b', 'inv'], ['b2cl', 'inv'], ['cdnr', 'nt']] as const) {
    objs(json[s]).forEach((g, gi) => objs(g[child]).forEach((d, di) => renumber(d, `${s}[${gi}].${child}[${di}]`)));
  }
  objs(json.cdnur).forEach((d, i) => renumber(d, `cdnur[${i}]`));

  /* 8. HSN */
  if (isObj(json.hsn)) {
    const h = json.hsn;
    if (profile && !profile.hsnSplit && !h.data && (h.hsn_b2b || h.hsn_b2c)) {
      h.data = [...arr(h.hsn_b2b), ...arr(h.hsn_b2c)];
      delete h.hsn_b2b; delete h.hsn_b2c;
      log('HSN_LAYOUT', 'hsn', `hsn_b2b + hsn_b2c combined into hsn.data (single HSN table before May 2025)`);
    }
    // Numbering varies (the offline tool counts across both tables: 1,2,4 / 3,5; this app per table),
    // so a table is renumbered only when its own numbers clash.
    for (const k of ['data', 'hsn_b2b', 'hsn_b2c']) {
      const renumberHsn = clash(objs(h[k]));
      objs(h[k]).forEach((row, i) => {
        const p = `hsn.${k}[${i}]`;
        if (renumberHsn && row.num !== i + 1) { log('HSN_NUMBER', `${p}.num`, `num ${JSON.stringify(row.num ?? null)} → ${i + 1}`, row.num, i + 1); row.num = i + 1; }
        if (typeof row.hsn_sc === 'string' && row.hsn_sc.startsWith('99') && (row.uqc !== 'NA' || num(row.qty) !== 0)) {
          log('HSN_SAC_UQC', p, `SAC ${row.hsn_sc}: UQC ${JSON.stringify(row.uqc)} → "NA", qty ${row.qty ?? 0} → 0`, { uqc: row.uqc, qty: row.qty }, { uqc: 'NA', qty: 0 });
          row.uqc = 'NA'; row.qty = 0;
        }
      });
    }
    if (opts.recomputeTax !== false) fixHsnTax(json, h, log);
  }

  /* 9. documents issued */
  if (isObj(json.doc_issue)) {
    const byNum = Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [v, k]));
    objs(json.doc_issue.doc_det).forEach((g, gi) => {
      const p = `doc_issue.doc_det[${gi}]`;
      const want = typeof g.doc_typ === 'string' ? DOC_TYPES[g.doc_typ] : undefined;
      if (want !== undefined && g.doc_num !== want) { log('DOC_NUM', `${p}.doc_num`, `doc_num ${JSON.stringify(g.doc_num ?? null)} → ${want} for "${g.doc_typ}"`, g.doc_num, want); g.doc_num = want; }
      if (!g.doc_typ && typeof g.doc_num === 'number' && byNum[g.doc_num]) { log('DOC_NUM', `${p}.doc_typ`, `doc_typ set to "${byNum[g.doc_num]}"`, undefined, byNum[g.doc_num]); g.doc_typ = byNum[g.doc_num]; }
      const renumberDocs = clash(objs(g.docs));
      objs(g.docs).forEach((d, i) => {
        const dp = `${p}.docs[${i}]`;
        if (renumberDocs && d.num !== i + 1) { log('HSN_NUMBER', `${dp}.num`, `num ${JSON.stringify(d.num ?? null)} → ${i + 1}`, d.num, i + 1); d.num = i + 1; }
        if (d.cancel == null) d.cancel = 0;
        if (typeof d.totnum === 'number' && typeof d.cancel === 'number' && d.net_issue !== d.totnum - d.cancel) {
          log('NET_ISSUE', `${dp}.net_issue`, `net_issue ${JSON.stringify(d.net_issue ?? null)} → ${d.totnum - d.cancel}`, d.net_issue, d.totnum - d.cancel);
          d.net_issue = d.totnum - d.cancel;
        }
      });
    });
  }

  /* 10. fields the schema doesn't know (amendment/ECO sections are left alone) */
  const forSchema: J = { ...json };
  for (const k of UNSUPPORTED) delete forSchema[k];
  for (const e of validateGstr1Json(forSchema).errors) {
    if (e.keyword !== 'additionalProperties' || !e.property) continue;
    const parts = e.path.split('/').filter(Boolean);
    let at: unknown = json;
    for (const part of parts) at = Array.isArray(at) ? at[Number(part)] : isObj(at) ? at[part] : undefined;
    if (!isObj(at) || !(e.property in at)) continue;
    const path = [parts.map((x) => (/^\d+$/.test(x) ? `[${x}]` : `.${x}`)).join('').replace(/^\./, ''), e.property].filter(Boolean).join('.').replace(/\.\[/g, '[');
    log('UNKNOWN_FIELD', path, `Removed unknown field "${e.property}"`, at[e.property], undefined);
    delete at[e.property];
  }

  return { json, fixes };
}

type Log = (code: FixCode, path: string, message: string, before?: unknown, after?: unknown) => void;

/** IGST and CGST totals of the document sections behind one HSN table (credit notes subtract). */
function documentTax(json: J, sections: string[]) {
  let i = 0, c = 0;
  const add = (d: unknown, sign: number) => { if (isObj(d)) { i += sign * num(d.iamt); c += sign * num(d.camt); } };
  const items = (doc: J, sign: number, flat = false) => objs(doc.itms).forEach((it) => add(flat ? it : it.itm_det, sign));
  const noteSign = (d: J) => (d.ntty === 'C' ? -1 : 1);
  for (const s of sections) {
    if (s === 'b2b' || s === 'b2cl') objs(json[s]).forEach((g) => objs(g.inv).forEach((d) => items(d, 1)));
    if (s === 'exp') objs(json.exp).forEach((g) => objs(g.inv).forEach((d) => items(d, 1, true)));
    if (s === 'cdnr') objs(json.cdnr).forEach((g) => objs(g.nt).forEach((d) => items(d, noteSign(d))));
    if (s === 'cdnur') objs(json.cdnur).forEach((d) => items(d, noteSign(d)));
    if (s === 'b2cs') objs(json.b2cs).forEach((l) => add(l, 1));
  }
  return { i: round2(i), c: round2(c) };
}

/**
 * HSN rows whose tax doesn't match taxable value × rate (typically freight/courier SAC rows exported
 * with zero tax). The total is certain; whether it is IGST or CGST+SGST is decided from the documents:
 * the rows are assigned to the head whose document total exceeds the HSN total. Applied only when the
 * table then reconciles with its documents, so nothing is guessed.
 */
function fixHsnTax(json: J, h: J, log: Log) {
  const tables: [string, string[]][] = Array.isArray(h.data)
    ? [['data', ['b2b', 'cdnr', 'b2cl', 'b2cs', 'exp', 'cdnur']]]
    : [['hsn_b2b', ['b2b', 'cdnr']], ['hsn_b2c', ['b2cl', 'b2cs', 'exp', 'cdnur']]];
  for (const [k, sections] of tables) {
    const rows = objs(h[k]);
    const bad: { row: J; i: number; want: number }[] = [];
    let hsnI = 0, hsnC = 0;
    rows.forEach((row, i) => {
      const tax = num(row.iamt) + num(row.camt) + num(row.samt);
      if (typeof row.rt === 'number' && typeof row.txval === 'number') {
        const want = round2((row.txval * row.rt) / 100);
        const tol = Math.max(TAX_TOLERANCE, want * 0.001);
        if (Math.abs(tax - want) > tol && Math.abs(tax - want * 0.65) > tol) { bad.push({ row, i, want }); return; }
      }
      hsnI += num(row.iamt); hsnC += num(row.camt);
    });
    if (!bad.length) continue;
    const docs = documentTax(json, sections);
    let gapI = round2(docs.i - hsnI), gapC = round2(docs.c - hsnC);
    const plan: { b: (typeof bad)[number]; head: 'I' | 'C' }[] = [];
    for (const b of [...bad].sort((x, y) => y.want - x.want)) {
      if (b.want <= gapI + TAX_TOLERANCE) { plan.push({ b, head: 'I' }); gapI = round2(gapI - b.want); }
      else if (b.want / 2 <= gapC + TAX_TOLERANCE) { plan.push({ b, head: 'C' }); gapC = round2(gapC - round2(b.want / 2)); }
      else return; // can't place it – leave the table for a person
    }
    const slack = TAX_TOLERANCE * Math.max(1, plan.length);
    if (Math.abs(gapI) > slack || Math.abs(gapC) > slack) continue; // would not reconcile – don't guess
    for (const { b, head } of plan) {
      const before = { iamt: b.row.iamt, camt: b.row.camt, samt: b.row.samt };
      const half = round2(b.want / 2);
      Object.assign(b.row, head === 'I' ? { iamt: b.want, camt: 0, samt: 0 } : { iamt: 0, camt: half, samt: half });
      log('HSN_TAX', `hsn.${k}[${b.i}]`,
        `HSN ${b.row.hsn_sc}: ${b.row.txval} × ${b.row.rt}% → ${head === 'I' ? `IGST ${b.want}` : `CGST ${half} + SGST ${half}`} (matches the documents' ${head === 'I' ? 'IGST' : 'CGST/SGST'} total)`,
        before, { iamt: b.row.iamt, camt: b.row.camt, samt: b.row.samt });
    }
  }
}

/**
 * Marks the findings that "Fix automatically" would change, and counts its changes, by dry-running
 * the fixer and matching fix paths to finding paths (same value, or inside the same document/line).
 */
export function markAutoFixable(report: JsonCheckReport, json: unknown, opts: FixOptions = {}): JsonCheckReport {
  if (!isObj(json)) { report.autoFixable = 0; return report; }
  const fixes = fixGstr1Json(json, opts).fixes;
  report.autoFixable = fixes.length;
  // A fix that reports field values (e.g. a row's iamt/camt/samt) covers exactly those fields, not the whole row.
  const fieldsOf = (v: unknown) => (isObj(v) ? Object.keys(v) : []);
  const paths = fixes.flatMap((f) => {
    const keys = [...new Set([...fieldsOf(f.before), ...fieldsOf(f.after)])];
    return keys.length ? keys.map((k) => `${f.path}.${k}`) : [f.path];
  });
  const covers = (p: string) => paths.some((f) =>
    f === p || p.startsWith(`${f}.`) || p.startsWith(`${f}[`)
    // a fix inside a document or line (e.g. its items) fixes a finding on that document – not on a whole section
    || (p.includes('[') && (f.startsWith(`${p}.`) || f.startsWith(`${p}[`))));
  for (const i of report.issues) if (i.stage !== 'parse' && covers(i.path)) i.autoFix = true;
  return report;
}
