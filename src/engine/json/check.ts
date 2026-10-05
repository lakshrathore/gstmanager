import { profileForPeriod } from '../config/versions';
import { DOC_TYPES } from '../masters';
import type { AdvanceItem, AnyRecord, Item, ReturnContext, Section, ValidationIssue } from '../types';
import { checkGstin, parseDate, round2 } from '../util';
import { validateReturn, type ValidationSummary } from '../validation/validate';
import { generateGstr1Json } from './generate';
import { validateGstr1Json } from './schema';

/**
 * Validates a GSTR-1 upload JSON produced anywhere (this app, the offline tool, Tally/ERP exports).
 * Stages:
 *   1. parse  – is it JSON at all (with line/column on failure)
 *   2. header – gstin checksum, return period, format version for that period
 *   3. schema – structure, types, enums, required fields (unknown fields are warnings)
 *   4. rules  – the JSON is read back into records and every workbook rule is applied (GSTIN, dates
 *               in period, POS, rates, tax maths, invoice values, HSN/UQC, duplicates, Table 12
 *               reconciliation), plus checks that only exist in JSON (grouping, sply_ty, net_issue…).
 * Pure function – no I/O.
 */

export type StageId = 'parse' | 'header' | 'schema' | 'rules';
export interface JsonIssue {
  stage: StageId;
  severity: 'error' | 'warning';
  code: string;
  /** JSON path, e.g. b2b[0].inv[2].itms[0].itm_det.rt */
  path: string;
  message: string;
  suggestion?: string;
  section?: string;
  documentNo?: string;
  value?: unknown;
  /** Set when "Fix automatically" would change this value (see markAutoFixable). */
  autoFix?: boolean;
}
export interface JsonStage { id: StageId; label: string; status: 'pass' | 'warn' | 'fail' | 'skipped'; errors: number; warnings: number; note?: string }
export interface JsonCheckReport {
  ok: boolean;
  header: { gstin?: string; fp?: string; version?: string; expectedVersion?: string; profile?: string; quarterly: boolean; aatoAbove5Cr: boolean };
  stages: JsonStage[];
  issues: JsonIssue[];
  /** Issues beyond the cap are counted here but not listed. */
  truncated: number;
  sections: Record<string, { documents: number; taxableValue: number; tax: number }>;
  /** Sections present in the file that this validator does not check (amendments, ECO tables…). */
  unsupported: string[];
  summary: ValidationSummary | null;
  /** Number of changes "Fix automatically" would make (see markAutoFixable). */
  autoFixable?: number;
}
export interface JsonCheckOptions { aatoAbove5Cr: boolean; quarterly?: boolean; today?: Date; maxIssues?: number }

/** Sections GSTN accepts that this app neither generates nor rule-checks. */
const UNSUPPORTED = ['b2ba', 'b2cla', 'b2csa', 'cdnra', 'cdnura', 'expa', 'ata', 'txpda', 'supeco', 'supecoa', 'ecom', 'ecoma', 'ecomb2b', 'ecomb2c', 'ecomurp2b', 'ecomurp2c'];
const MONEY_KEYS = new Set(['val', 'txval', 'iamt', 'camt', 'samt', 'csamt', 'ad_amt', 'nil_amt', 'expt_amt', 'ngsup_amt']);
const STAGE_LABELS: Record<StageId, string> = {
  parse: 'Valid JSON', header: 'GSTIN, period and version', schema: 'Structure (GSTR-1 schema)', rules: 'GST rules and cross-checks',
};

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v == null ? '' : String(v).trim());
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
/** Portal date dd-mm-yyyy → ISO; keeps the raw text when unparseable so the date rule reports it. */
const date = (v: unknown) => parseDate(str(v)) ?? str(v);
const diffPct = (v: unknown) => { const n = num(v); return n == null ? null : round2(n * 100); };

function items(itms: unknown, path: string): { items: Item[]; paths: string[] } {
  const list = arr(itms);
  return {
    paths: list.map((_, i) => `${path}.itms[${i}]`),
    items: list.map((x) => {
      const o = isObj(x) ? x : {};
      const d = isObj(o.itm_det) ? o.itm_det : o; // exp items are flat
      return { rt: num(d.rt), txval: num(d.txval), iamt: num(d.iamt), camt: num(d.camt), samt: num(d.samt), csamt: num(d.csamt) };
    }),
  };
}

/** Reads GSTR-1 JSON back into engine records; each record's source.sheet is its JSON path. */
export function recordsFromGstr1Json(json: J): AnyRecord[] {
  const out: AnyRecord[] = [];
  const src = (path: string, n: number) => ({ sheet: path, rows: [n] });
  let n = 0;

  arr(json.b2b).forEach((g, gi) => {
    if (!isObj(g)) return;
    arr(g.inv).forEach((v, ii) => {
      if (!isObj(v)) return;
      const path = `b2b[${gi}].inv[${ii}]`;
      const ctin = str(g.ctin).toUpperCase(), inum = str(v.inum);
      out.push({ section: 'b2b', key: `b2b|${ctin}|${inum.toUpperCase()}|${path}`, source: src(path, ++n), data: {
        ctin, inum, idt: date(v.idt), val: num(v.val), pos: str(v.pos), rchrg: str(v.rchrg) === 'Y' ? 'Y' : 'N',
        invTyp: str(v.inv_typ), etin: str(v.etin) || undefined, diffPercent: diffPct(v.diff_percent), items: items(v.itms, path).items,
      } });
    });
  });

  arr(json.b2cl).forEach((g, gi) => {
    if (!isObj(g)) return;
    arr(g.inv).forEach((v, ii) => {
      if (!isObj(v)) return;
      const path = `b2cl[${gi}].inv[${ii}]`;
      out.push({ section: 'b2cl', key: `b2cl|${str(v.inum).toUpperCase()}|${path}`, source: src(path, ++n), data: {
        inum: str(v.inum), idt: date(v.idt), val: num(v.val), pos: str(g.pos), etin: str(v.etin) || undefined,
        diffPercent: diffPct(v.diff_percent), items: items(v.itms, path).items,
      } });
    });
  });

  arr(json.b2cs).forEach((v, i) => {
    if (!isObj(v)) return;
    const path = `b2cs[${i}]`;
    out.push({ section: 'b2cs', key: `b2cs|${path}`, source: src(path, ++n), data: {
      typ: str(v.typ), pos: str(v.pos), etin: str(v.etin) || undefined, diffPercent: diffPct(v.diff_percent),
      rt: num(v.rt), txval: num(v.txval), iamt: num(v.iamt), camt: num(v.camt), samt: num(v.samt), csamt: num(v.csamt),
    } });
  });

  arr(json.exp).forEach((g, gi) => {
    if (!isObj(g)) return;
    arr(g.inv).forEach((v, ii) => {
      if (!isObj(v)) return;
      const path = `exp[${gi}].inv[${ii}]`;
      out.push({ section: 'exp', key: `exp|${str(v.inum).toUpperCase()}|${path}`, source: src(path, ++n), data: {
        expTyp: str(g.exp_typ), inum: str(v.inum), idt: date(v.idt), val: num(v.val), portCode: str(v.sbpcode) || undefined,
        sbNum: str(v.sbnum) || undefined, sbDt: v.sbdt ? date(v.sbdt) : undefined, items: items(v.itms, path).items,
      } });
    });
  });

  arr(json.cdnr).forEach((g, gi) => {
    if (!isObj(g)) return;
    arr(g.nt).forEach((v, ii) => {
      if (!isObj(v)) return;
      const path = `cdnr[${gi}].nt[${ii}]`;
      const ctin = str(g.ctin).toUpperCase(), ntNum = str(v.nt_num);
      out.push({ section: 'cdnr', key: `cdnr|${ctin}|${ntNum.toUpperCase()}|${path}`, source: src(path, ++n), data: {
        ctin, ntNum, ntDt: date(v.nt_dt), ntty: str(v.ntty), pos: str(v.pos), rchrg: str(v.rchrg) === 'Y' ? 'Y' : 'N',
        invTyp: str(v.inv_typ), val: num(v.val), diffPercent: diffPct(v.diff_percent), items: items(v.itms, path).items,
      } });
    });
  });

  arr(json.cdnur).forEach((v, i) => {
    if (!isObj(v)) return;
    const path = `cdnur[${i}]`;
    out.push({ section: 'cdnur', key: `cdnur|${str(v.nt_num).toUpperCase()}|${path}`, source: src(path, ++n), data: {
      urType: str(v.typ), ntNum: str(v.nt_num), ntDt: date(v.nt_dt), ntty: str(v.ntty), pos: str(v.pos) || undefined,
      val: num(v.val), diffPercent: diffPct(v.diff_percent), items: items(v.itms, path).items,
    } });
  });

  for (const s of ['at', 'txpd'] as const) {
    arr(json[s]).forEach((v, i) => {
      if (!isObj(v)) return;
      const path = `${s}[${i}]`;
      out.push({ section: s, key: `${s}|${path}`, source: src(path, ++n), data: {
        pos: str(v.pos), diffPercent: diffPct(v.diff_percent),
        items: arr(v.itms).map((x): AdvanceItem => {
          const o = isObj(x) ? x : {};
          return { rt: num(o.rt), adAmt: num(o.ad_amt), iamt: num(o.iamt), camt: num(o.camt), samt: num(o.samt), csamt: num(o.csamt) };
        }),
      } });
    });
  }

  if (isObj(json.nil)) {
    arr(json.nil.inv).forEach((v, i) => {
      if (!isObj(v)) return;
      const path = `nil.inv[${i}]`;
      out.push({ section: 'nil', key: `nil|${path}`, source: src(path, ++n), data: {
        splyTy: str(v.sply_ty), nilAmt: num(v.nil_amt) ?? 0, exptAmt: num(v.expt_amt) ?? 0, ngsupAmt: num(v.ngsup_amt) ?? 0,
      } });
    });
  }

  if (isObj(json.hsn)) {
    // A single hsn.data list is reconciled against all supplies, like the pre-split profile does.
    const lists: [string, 'hsn_b2b' | 'hsn_b2c'][] = [['data', 'hsn_b2b'], ['hsn_b2b', 'hsn_b2b'], ['hsn_b2c', 'hsn_b2c']];
    for (const [k, section] of lists) {
      arr((json.hsn as J)[k]).forEach((v, i) => {
        if (!isObj(v)) return;
        const path = `hsn.${k}[${i}]`;
        out.push({ section, key: `${section}|${path}`, source: src(path, ++n), data: {
          hsn: str(v.hsn_sc), desc: str(v.desc) || undefined, uqc: str(v.uqc).toUpperCase(), qty: num(v.qty), rt: num(v.rt),
          txval: num(v.txval), iamt: num(v.iamt), camt: num(v.camt), samt: num(v.samt), csamt: num(v.csamt),
        } });
      });
    }
  }

  if (isObj(json.doc_issue)) {
    const byNum = Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [v, k]));
    arr(json.doc_issue.doc_det).forEach((g, gi) => {
      if (!isObj(g)) return;
      const docTyp = byNum[num(g.doc_num) ?? -1] ?? str(g.doc_typ);
      arr(g.docs).forEach((v, ii) => {
        if (!isObj(v)) return;
        const path = `doc_issue.doc_det[${gi}].docs[${ii}]`;
        out.push({ section: 'docs', key: `docs|${path}`, source: src(path, ++n), data: {
          docTyp, from: str(v.from), to: str(v.to), totnum: num(v.totnum), cancel: num(v.cancel),
        } });
      });
    });
  }
  return out;
}

/** Checks that only make sense on the JSON (grouping, sply_ty, item rates, net_issue, decimals…). */
function jsonOnlyRules(json: J, supplierState: string, hsnSplit: boolean, add: (i: Omit<JsonIssue, 'stage'>) => void) {
  const groupDup = (section: string, key: string, label: string) => {
    const seen = new Map<string, number>();
    arr(json[section]).forEach((g, i) => {
      if (!isObj(g)) return;
      const k = str(g[key]).toUpperCase();
      if (seen.has(k)) add({ severity: 'warning', code: 'JSON_GROUP_REPEATED', section, path: `${section}[${i}].${key}`, value: k, message: `${label} "${k}" appears in more than one group (first at ${section}[${seen.get(k)}])`, suggestion: `Put all documents for one ${label} under a single group.` });
      else seen.set(k, i);
    });
  };
  groupDup('b2b', 'ctin', 'Recipient GSTIN');
  groupDup('cdnr', 'ctin', 'Recipient GSTIN');
  groupDup('b2cl', 'pos', 'Place of supply');
  groupDup('exp', 'exp_typ', 'Export type');

  // One item per rate inside a document
  const rateDup = (list: unknown, path: string, section: string, docNo?: string) => {
    const seen = new Set<number>();
    arr(list).forEach((x, i) => {
      const o = isObj(x) ? (isObj(x.itm_det) ? x.itm_det : x) : {};
      const rt = num(o.rt);
      if (rt == null) return;
      if (seen.has(rt)) add({ severity: 'error', code: 'JSON_RATE_REPEATED', section, documentNo: docNo, path: `${path}.itms[${i}]`, value: rt, message: `Rate ${rt}% appears more than once in this document`, suggestion: 'Combine the items with the same rate into one item.' });
      seen.add(rt);
    });
  };
  for (const [s, child, no] of [['b2b', 'inv', 'inum'], ['b2cl', 'inv', 'inum'], ['exp', 'inv', 'inum'], ['cdnr', 'nt', 'nt_num']] as const) {
    arr(json[s]).forEach((g, gi) => isObj(g) && arr(g[child]).forEach((v, ii) => isObj(v) && rateDup(v.itms, `${s}[${gi}].${child}[${ii}]`, s, str(v[no]))));
  }
  arr(json.cdnur).forEach((v, i) => isObj(v) && rateDup(v.itms, `cdnur[${i}]`, 'cdnur', str(v.nt_num)));

  // sply_ty must follow POS vs supplier state; one line per key
  for (const s of ['b2cs', 'at', 'txpd'] as const) {
    const seen = new Map<string, number>();
    arr(json[s]).forEach((v, i) => {
      if (!isObj(v)) return;
      const pos = str(v.pos), expected = pos === supplierState ? 'INTRA' : 'INTER';
      if (pos && v.sply_ty && str(v.sply_ty) !== expected) add({ severity: 'error', code: 'JSON_SPLY_TY', section: s, path: `${s}[${i}].sply_ty`, value: v.sply_ty, message: `sply_ty must be ${expected} for POS ${pos} (supplier state ${supplierState})`, suggestion: `Set sply_ty to ${expected}.` });
      if (s !== 'b2cs') rateDup(v.itms, `${s}[${i}]`, s);
      const k = s === 'b2cs' ? [pos, num(v.rt), str(v.typ), str(v.etin), num(v.diff_percent) ?? ''].join('|') : [pos, num(v.diff_percent) ?? ''].join('|');
      if (seen.has(k)) add({ severity: 'error', code: 'JSON_DUPLICATE_LINE', section: s, path: `${s}[${i}]`, message: s === 'b2cs' ? `Duplicate B2CS line for POS ${pos}, rate ${num(v.rt)}%, type ${str(v.typ)} (same as b2cs[${seen.get(k)}])` : `Duplicate ${s} line for POS ${pos} (same as ${s}[${seen.get(k)}])`, suggestion: 'The portal accepts one line per key – combine them.' });
      else seen.set(k, i);
    });
  }

  if (isObj(json.nil)) {
    arr(json.nil.inv).forEach((v, i) => {
      if (!isObj(v)) return;
      if (!['nil_amt', 'expt_amt', 'ngsup_amt'].some((k) => k in v)) add({ severity: 'warning', code: 'JSON_NIL_EMPTY', section: 'nil', path: `nil.inv[${i}]`, message: 'Nil/exempt line has no amounts', suggestion: 'Remove the line or fill nil_amt / expt_amt / ngsup_amt.' });
    });
  }

  if (isObj(json.hsn)) {
    const h = json.hsn as J;
    if (hsnSplit && 'data' in h) add({ severity: 'error', code: 'JSON_HSN_FORMAT', section: 'hsn', path: 'hsn.data', message: 'For this return period Table 12 must be split into hsn_b2b and hsn_b2c', suggestion: 'Regenerate the JSON with the current offline tool / this app.' });
    if (!hsnSplit && ('hsn_b2b' in h || 'hsn_b2c' in h)) add({ severity: 'error', code: 'JSON_HSN_FORMAT', section: 'hsn', path: 'hsn', message: 'For this return period Table 12 uses a single hsn.data list (the B2B/B2C split starts May 2025)' });
  }

  if (isObj(json.doc_issue)) {
    arr(json.doc_issue.doc_det).forEach((g, gi) => {
      if (!isObj(g)) return;
      const dn = num(g.doc_num), dt = str(g.doc_typ);
      if (dn != null && dt && DOC_TYPES[dt] !== undefined && DOC_TYPES[dt] !== dn) add({ severity: 'warning', code: 'JSON_DOC_TYPE', section: 'docs', path: `doc_issue.doc_det[${gi}]`, value: { doc_num: dn, doc_typ: dt }, message: `doc_num ${dn} does not match doc_typ "${dt}" (expected ${DOC_TYPES[dt]})` });
      arr(g.docs).forEach((v, i) => {
        if (!isObj(v)) return;
        const t = num(v.totnum), c = num(v.cancel), ni = num(v.net_issue);
        if (t != null && c != null && ni != null && ni !== t - c) add({ severity: 'error', code: 'JSON_NET_ISSUE', section: 'docs', path: `doc_issue.doc_det[${gi}].docs[${i}].net_issue`, value: ni, message: `net_issue (${ni}) must equal totnum − cancel (${t - c})`, suggestion: `Set net_issue to ${t - c}.` });
      });
    });
  }

  // Amounts with more than 2 decimals (portal rounds or rejects)
  let decimals = 0, firstPath = '';
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (MONEY_KEYS.has(k) && typeof x === 'number' && Math.abs(x * 100 - Math.round(x * 100)) > 1e-6) { decimals++; firstPath ||= p; }
      else walk(x, p);
    }
  };
  walk(json, '');
  if (decimals) add({ severity: 'warning', code: 'JSON_DECIMALS', path: firstPath, message: `${decimals} amount(s) have more than 2 decimal places (first at ${firstPath})`, suggestion: 'Round amounts to 2 decimals before uploading.' });

  if (!isObj(json.doc_issue) && Object.keys(json).some((k) => ['b2b', 'b2cl', 'b2cs', 'exp', 'cdnr', 'cdnur'].includes(k))) {
    add({ severity: 'warning', code: 'JSON_DOCS_MISSING', section: 'docs', path: 'doc_issue', message: 'Table 13 (documents issued) is missing', suggestion: 'Report the invoice/note series issued during the period.' });
  }
}

const parseError = (text: string, e: Error) => {
  const m = e.message.match(/position (\d+)/);
  const lc = e.message.match(/line (\d+) column (\d+)/);
  if (lc) return `${e.message}`;
  if (!m) return e.message;
  const before = text.slice(0, Number(m[1]));
  const line = before.split('\n').length, col = Number(m[1]) - before.lastIndexOf('\n');
  return `${e.message.replace(/ in JSON at position \d+.*$/, '')} at line ${line}, column ${col}`;
};

export function checkGstr1Json(input: string | unknown, opts: JsonCheckOptions): JsonCheckReport {
  const max = opts.maxIssues ?? 1000;
  const issues: JsonIssue[] = [];
  let truncated = 0;
  const counts: Record<StageId, { errors: number; warnings: number }> = {
    parse: { errors: 0, warnings: 0 }, header: { errors: 0, warnings: 0 }, schema: { errors: 0, warnings: 0 }, rules: { errors: 0, warnings: 0 },
  };
  const push = (i: JsonIssue) => {
    counts[i.stage][i.severity === 'error' ? 'errors' : 'warnings']++;
    if (issues.length < max) issues.push(i); else truncated++;
  };
  const report: JsonCheckReport = {
    ok: false, header: { quarterly: !!opts.quarterly, aatoAbove5Cr: opts.aatoAbove5Cr }, stages: [], issues, truncated: 0,
    sections: {}, unsupported: [], summary: null,
  };
  const stage = (id: StageId, status?: 'skipped', note?: string) => {
    const { errors, warnings } = counts[id];
    report.stages.push({ id, label: STAGE_LABELS[id], status: status ?? (errors ? 'fail' : warnings ? 'warn' : 'pass'), errors, warnings, note });
  };
  const finish = () => {
    for (const id of ['parse', 'header', 'schema', 'rules'] as StageId[]) if (!report.stages.some((s) => s.id === id)) stage(id, 'skipped');
    report.truncated = truncated;
    report.ok = report.stages.every((s) => s.status === 'pass' || s.status === 'warn');
    return report;
  };

  /* 1. parse */
  let json: unknown = input;
  if (typeof input === 'string') {
    const text = input.replace(/^﻿/, '');
    if (!text.trim()) { push({ stage: 'parse', severity: 'error', code: 'JSON_EMPTY', path: '/', message: 'The file is empty' }); stage('parse'); return finish(); }
    try { json = JSON.parse(text); }
    catch (e) { push({ stage: 'parse', severity: 'error', code: 'JSON_SYNTAX', path: '/', message: `Not valid JSON: ${parseError(text, e as Error)}`, suggestion: 'Check for a missing comma, bracket or quote near that position, or re-export the file.' }); stage('parse'); return finish(); }
  }
  if (!isObj(json)) { push({ stage: 'parse', severity: 'error', code: 'JSON_NOT_OBJECT', path: '/', message: 'The JSON must be an object with gstin, fp, version and sections' }); stage('parse'); return finish(); }
  stage('parse');
  const root = json as J;

  /* 2. header */
  const gstin = str(root.gstin).toUpperCase(), fp = str(root.fp), version = str(root.version);
  Object.assign(report.header, { gstin: gstin || undefined, fp: fp || undefined, version: version || undefined });
  const g = checkGstin(gstin);
  if (!g.ok) push({ stage: 'header', severity: 'error', code: 'JSON_GSTIN', path: 'gstin', value: root.gstin, message: `Supplier GSTIN: ${g.reason}` });
  const fpOk = /^(0[1-9]|1[0-2])\d{4}$/.test(fp);
  if (!fpOk) push({ stage: 'header', severity: 'error', code: 'JSON_FP', path: 'fp', value: root.fp, message: `Return period "${fp}" must be MMYYYY (e.g. 062025)` });
  const profile = fpOk ? profileForPeriod(fp) : null;
  if (fpOk && profile) {
    report.header.expectedVersion = profile.jsonVersion;
    report.header.profile = profile.id;
    const today = opts.today ?? new Date();
    const fpKey = Number(fp.slice(2)) * 100 + Number(fp.slice(0, 2));
    const nowKey = today.getUTCFullYear() * 100 + today.getUTCMonth() + 1;
    if (fpKey > nowKey) push({ stage: 'header', severity: 'error', code: 'JSON_FP_FUTURE', path: 'fp', value: fp, message: `Return period ${fp} is in the future` });
    if (Number(fp.slice(2)) < 2017 || fpKey < 201707) push({ stage: 'header', severity: 'error', code: 'JSON_FP_BEFORE_GST', path: 'fp', value: fp, message: 'Return period is before GST began (July 2017)' });
    if (opts.quarterly && ![3, 6, 9, 12].includes(Number(fp.slice(0, 2)))) push({ stage: 'header', severity: 'error', code: 'JSON_FP_QUARTER', path: 'fp', value: fp, message: 'Quarterly (QRMP) returns use the quarter-ending month (03, 06, 09 or 12)' });
    if (version && version !== profile.jsonVersion) push({ stage: 'header', severity: 'warning', code: 'JSON_VERSION', path: 'version', value: version, message: `Format version ${version} differs from ${profile.jsonVersion} expected for ${fp}`, suggestion: 'Generate the file with the current offline tool or this app if the portal rejects it.' });
  }
  if (!version) push({ stage: 'header', severity: 'error', code: 'JSON_VERSION_MISSING', path: 'version', message: 'version is missing' });
  stage('header');

  /* 3. schema */
  report.unsupported = UNSUPPORTED.filter((k) => k in root);
  const forSchema: J = { ...root };
  for (const k of report.unsupported) delete forSchema[k];
  const schemaIssues: JsonIssue[] = validateGstr1Json(forSchema).errors.map((e) => {
    const path = e.path.replace(/^\//, '').replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.') || '/';
    if (e.keyword === 'additionalProperties') {
      return { stage: 'schema', severity: 'warning', code: 'SCHEMA_UNKNOWN_FIELD', path: path === '/' ? e.property! : `${path}.${e.property}`, message: `Unknown field "${e.property}"`, suggestion: 'The portal may reject or ignore fields it does not know. Remove it unless your format version requires it.' };
    }
    return { stage: 'schema', severity: 'error', code: `SCHEMA_${e.keyword.toUpperCase()}`, path, ...schemaText(e.keyword, e.message, path, valueAt(root, e.path)) };
  });
  const schemaNote = report.unsupported.length ? `Not checked: ${report.unsupported.join(', ')}` : undefined;

  /* 4. rules */
  if (!g.ok || !profile) {
    schemaIssues.forEach(push);
    stage('schema', undefined, schemaNote);
    stage('rules', 'skipped', 'Needs a valid GSTIN and return period');
    return finish();
  }
  const ctx: ReturnContext = { supplierGstin: gstin, fp, quarterly: opts.quarterly, aatoAbove5Cr: opts.aatoAbove5Cr, profile };
  const records = recordsFromGstr1Json(root);
  const byKey = new Map(records.map((r) => [r.key, r]));
  const byRow = new Map(records.map((r) => [r.source.rows[0], r.source.sheet]));
  const { issues: ruleIssues, summary } = validateReturn(records, ctx);
  report.summary = summary;
  const rules: JsonIssue[] = ruleIssues.map((i) => fromRuleIssue(i, byKey.get(i.recordKey), byRow));
  jsonOnlyRules(root, gstin.slice(0, 2), profile.hsnSplit, (i) => rules.push({ ...i, stage: 'rules' }));
  // The same field reported by both checks is shown once – the rule's message is the more specific one.
  const ruleErrorPaths = new Set(rules.filter((i) => i.severity === 'error').map((i) => i.path));
  schemaIssues.filter((i) => !ruleErrorPaths.has(i.path)).forEach(push);
  stage('schema', undefined, schemaNote);
  rules.forEach(push);
  try { report.sections = generateGstr1Json(records, ctx).log.sections; } catch { report.sections = {}; }
  stage('rules');
  return finish();
}

/** Value at an ajv instance path ("/b2b/0/inv/1/idt"). */
function valueAt(root: unknown, instancePath: string): unknown {
  let at = root;
  for (const p of instancePath.split('/').filter(Boolean)) at = Array.isArray(at) ? at[Number(p)] : isObj(at) ? at[p] : undefined;
  return at;
}

const FIELD_NAMES: Record<string, string> = {
  hsn_sc: 'HSN/SAC', idt: 'Invoice date', nt_dt: 'Note date', sbdt: 'Shipping bill date', pos: 'Place of supply',
  gstin: 'Supplier GSTIN', ctin: 'Recipient GSTIN', etin: 'E-commerce GSTIN', inum: 'Invoice number', nt_num: 'Note number',
  fp: 'Return period', val: 'Invoice value', txval: 'Taxable value', rt: 'Rate', iamt: 'IGST', camt: 'CGST', samt: 'SGST/UTGST',
  csamt: 'Cess', qty: 'Quantity', uqc: 'UQC', desc: 'Description', ad_amt: 'Advance amount', totnum: 'Total number',
  cancel: 'Cancelled', net_issue: 'Net issued', doc_num: 'Document type number', itms: 'Items', inv: 'Invoices', nt: 'Notes',
  rchrg: 'Reverse charge', inv_typ: 'Invoice type', ntty: 'Note type', typ: 'Type', sply_ty: 'Supply type', exp_typ: 'Export type',
  diff_percent: 'Applicable % of rate', version: 'Format version', hash: 'hash',
};
const PATTERN_TEXT: Record<string, [string, string]> = {
  hsn_sc: ['must be 4, 6 or 8 digits only – no spaces, dots or letters', 'Type only the digits, e.g. 847130.'],
  idt: ['must be a date written dd-mm-yyyy', 'e.g. 05-08-2026.'], nt_dt: ['must be a date written dd-mm-yyyy', 'e.g. 05-08-2026.'],
  sbdt: ['must be a date written dd-mm-yyyy', 'e.g. 05-08-2026.'],
  pos: ['must be the 2-digit state code', 'e.g. 08 for Rajasthan, 27 for Maharashtra.'],
  gstin: ['must be a 15-character GSTIN', 'Check for a missing or extra character.'], ctin: ['must be a 15-character GSTIN', 'Check for a missing or extra character.'],
  etin: ['must be a 15-character GSTIN', 'Check for a missing or extra character.'],
  inum: ['must be 1–16 characters using only letters, digits, "/" and "-"', 'Remove spaces and other symbols, or shorten it.'],
  nt_num: ['must be 1–16 characters using only letters, digits, "/" and "-"', 'Remove spaces and other symbols, or shorten it.'],
  fp: ['must be MMYYYY', 'e.g. 082026 for August 2026.'],
};

/** Plain-language text for a schema error (ajv's own message is only a fallback). */
function schemaText(keyword: string, ajvMessage: string, path: string, value: unknown): { message: string; suggestion?: string; value?: unknown } {
  const field = path.split('.').pop()!.replace(/\[\d+\]$/, '');
  const name = FIELD_NAMES[field] ?? field;
  const shown = value === undefined || typeof value === 'object' ? undefined : value;
  switch (keyword) {
    case 'pattern': {
      const [what, suggestion] = PATTERN_TEXT[field] ?? ['has an invalid format', undefined];
      return { message: `${name} ${what}`, suggestion, value: shown };
    }
    case 'type': return { message: `${name} ${ajvMessage.replace(/^must be /, 'must be a ')}`, value: shown };
    case 'required': {
      const missing = ajvMessage.match(/'([^']+)'/)?.[1];
      return { message: `Required field "${missing ? FIELD_NAMES[missing] ?? missing : '?'}" is missing`, suggestion: missing ? `Add "${missing}".` : undefined };
    }
    case 'enum': return { message: `${name} ${ajvMessage.replace(/^must be equal to one of the allowed values/, 'must be one of')}`, value: shown };
    case 'minimum': return { message: `${name} cannot be negative`, value: shown };
    case 'maxLength': return { message: `${name} is too long`, suggestion: ajvMessage.replace(/^must NOT have more than/, 'Use at most'), value: shown };
    case 'minItems': return { message: `${name} must have at least one entry` };
    default: return { message: `${name}: ${ajvMessage}`, value: shown };
  }
}

/** Maps a record-level issue to its JSON path (items[0].rt → itms[0].itm_det.rt etc.). */
function fromRuleIssue(i: ValidationIssue, rec: AnyRecord | undefined, byRow: Map<number, string>): JsonIssue {
  const base = rec?.source.sheet ?? (i.section.startsWith('hsn') ? 'hsn' : i.section);
  const flat = i.section === 'exp' || i.section === 'at' || i.section === 'txpd';
  const FIELD: Partial<Record<Section, Record<string, string>>> = {
    b2b: { invTyp: 'inv_typ', ctin: '^ctin' }, cdnr: { invTyp: 'inv_typ', ntNum: 'nt_num', ntDt: 'nt_dt', ctin: '^ctin' },
    cdnur: { urType: 'typ', ntNum: 'nt_num', ntDt: 'nt_dt' }, exp: { expTyp: '^exp_typ', portCode: 'sbpcode', sbNum: 'sbnum', sbDt: 'sbdt' },
    b2cl: { pos: '^pos' }, nil: { splyTy: 'sply_ty', nilAmt: 'nil_amt', exptAmt: 'expt_amt', ngsupAmt: 'ngsup_amt' },
    hsn_b2b: { hsn: 'hsn_sc' }, hsn_b2c: { hsn: 'hsn_sc' }, docs: { docTyp: '^doc_num' },
  };
  const COMMON: Record<string, string> = { diffPercent: 'diff_percent', etin: 'etin', adAmt: 'ad_amt' };
  let field = i.field;
  const m = field.match(/^items\[(\d+)\]\.?(.*)$/);
  let path: string;
  if (m) {
    const sub = COMMON[m[2]] ?? m[2];
    path = `${base}.itms[${m[1]}]${sub ? (flat ? `.${sub}` : `.itm_det.${sub}`) : ''}`;
  } else {
    field = FIELD[i.section]?.[field] ?? COMMON[field] ?? field;
    if (!i.recordKey) path = base;
    else if (field.startsWith('^')) path = `${base.replace(/\.(inv|nt|docs)\[\d+\]$/, '')}.${field.slice(1)}`;
    else path = field === 'items' ? `${base}.itms` : `${base}.${field}`;
  }
  return {
    stage: 'rules', severity: i.severity, code: i.code, path, message: i.message.replace(/\(also in \w+, row (\d+)\)/, (_, n) => `(also at ${byRow.get(Number(n)) ?? '?'})`).replace(/same as row (\d+)/, (_, n) => `same as ${byRow.get(Number(n)) ?? '?'}`),
    suggestion: i.suggestion, section: i.section, documentNo: i.documentNo, value: i.value,
  };
}
