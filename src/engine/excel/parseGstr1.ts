import { INVOICE_TYPES, NIL_SUPPLY_TYPES } from '../masters';
import type {
  AdvanceData, AnyRecord, B2bData, B2clData, B2csData, CdnrData, CdnurData, DocData, ExpData,
  HsnData, Item, NilData, ParseResult, Section, Severity, ValidationIssue,
} from '../types';
import { computeTax, norm, parseDate, parseNumber, parsePos, parseYN, round2 } from '../util';
import { KNOWN_UNSUPPORTED, SHEETS, type SheetDef } from './template';

/** A worksheet as a plain 2-D array; rows[i] is Excel row i+1. Keeps the parser independent of any Excel lib. */
export interface SheetTable {
  name: string;
  rows: unknown[][];
}

export interface ParseOptions {
  supplierGstin: string;
  /** When the profile has no HSN split, a single "hsn" sheet is expected. */
  hsnSplit: boolean;
}

interface Row {
  row: number;
  v: Record<string, unknown>;
  present: Set<string>;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const up = (v: unknown) => str(v).toUpperCase();

function findSheetDef(name: string): SheetDef | undefined {
  const n = norm(name);
  return SHEETS.find((d) => d.sheetNames.some((s) => norm(s) === n));
}

/** Locate the header row (offline template has summary rows above it) and map columns. */
function mapHeader(table: SheetTable, def: SheetDef) {
  const limit = Math.min(table.rows.length, 15);
  let best: { rowIdx: number; map: Map<string, number>; score: number } | null = null;
  for (let r = 0; r < limit; r++) {
    const cells = (table.rows[r] ?? []).map(norm);
    const map = new Map<string, number>();
    for (const col of def.columns) {
      const idx = cells.findIndex((c) => c && col.headers.some((h) => norm(h) === c));
      if (idx >= 0) map.set(col.key, idx);
    }
    const required = def.columns.filter((c) => c.required);
    const score = required.filter((c) => map.has(c.key)).length / required.length;
    if (!best || score > best.score) best = { rowIdx: r, map, score };
  }
  return best && best.score >= 0.6 ? best : null;
}

export function parseGstr1Tables(tables: SheetTable[], opts: ParseOptions): ParseResult {
  const result: ParseResult = { records: [], issues: [], sheetsParsed: [], sheetsSkipped: [] };
  const supplierState = opts.supplierGstin.slice(0, 2);

  const issue = (
    severity: Severity, section: Section, sheet: string, row: number, field: string,
    message: string, extra: Partial<ValidationIssue> = {},
  ) => result.issues.push({ code: `PARSE_${field.toUpperCase()}`, severity, section, recordKey: '', sheet, row, field, message, ...extra });

  for (const table of tables) {
    const def = findSheetDef(table.name);
    if (!def) {
      const reason = KNOWN_UNSUPPORTED[norm(table.name)];
      if (reason) result.sheetsSkipped.push({ sheet: table.name, reason });
      else if (!/^(help|instructions|master|summary)/i.test(table.name)) {
        result.sheetsSkipped.push({ sheet: table.name, reason: 'Not a recognised GSTR-1 sheet' });
      }
      continue;
    }
    const header = mapHeader(table, def);
    if (!header) {
      result.sheetsSkipped.push({ sheet: table.name, reason: 'Header row not found – template columns do not match' });
      continue;
    }
    const missing = def.columns.filter((c) => c.required && !header.map.has(c.key)).map((c) => c.headers[0]);
    if (missing.length) {
      result.issues.push({
        code: 'PARSE_MISSING_COLUMNS', severity: 'error', section: def.section, recordKey: '', sheet: table.name,
        row: header.rowIdx + 1, field: 'header', message: `Missing column(s): ${missing.join(', ')}`,
        suggestion: 'Use the latest GSTR-1 offline-tool Excel template.',
      });
    }

    const rows: Row[] = [];
    for (let r = header.rowIdx + 1; r < table.rows.length; r++) {
      const cells = table.rows[r] ?? [];
      const v: Record<string, unknown> = {};
      const present = new Set<string>();
      for (const [key, idx] of header.map) {
        const cell = cells[idx];
        if (cell != null && str(cell) !== '') {
          v[key] = typeof cell === 'string' ? cell.trim() : cell;
          present.add(key);
        }
      }
      if (present.size === 0) continue;
      rows.push({ row: r + 1, v, present });
    }

    let section = def.section;
    if (norm(table.name) === 'hsn' && opts.hsnSplit) {
      result.issues.push({
        code: 'PARSE_HSN_SINGLE', severity: 'warning', section: 'hsn_b2b', recordKey: '', sheet: table.name,
        field: 'sheet', message: 'Single "hsn" sheet found; treated as HSN B2B (Table 12A).',
        suggestion: 'For periods from May 2025, report B2C lines separately in the hsn(b2c) sheet.',
      });
      section = 'hsn_b2b';
    }

    const before = result.records.length;
    const issuesBefore = result.issues.length;
    const ctx = { sheet: table.name, supplierState, issue, out: result.records };
    BUILDERS[section](rows, ctx as BuildCtx);
    // link row-level import issues to the record that absorbed that row
    const built = result.records.slice(before);
    for (const iss of result.issues.slice(issuesBefore)) {
      if (iss.recordKey || iss.row == null) continue;
      const rec = built.find((r) => r.source.rows.includes(iss.row!));
      if (rec) iss.recordKey = rec.key;
    }
    result.sheetsParsed.push({ sheet: table.name, section, rows: rows.length, records: result.records.length - before });
  }
  return result;
}

interface BuildCtx {
  sheet: string;
  supplierState: string;
  issue: (s: Severity, sec: Section, sheet: string, row: number, field: string, msg: string, extra?: Partial<ValidationIssue>) => void;
  out: AnyRecord[];
}

function dateField(r: Row, key: string, ctx: BuildCtx, section: Section): string {
  const raw = r.v[key];
  if (raw == null) return '';
  const d = parseDate(raw);
  if (!d) {
    ctx.issue('error', section, ctx.sheet, r.row, key, `Unrecognised date "${str(raw)}"`, {
      value: str(raw), suggestion: 'Use dd-mm-yyyy or dd-MMM-yyyy (e.g. 05-Apr-2025).',
    });
    return str(raw);
  }
  return d;
}

function itemFrom(r: Row, taxOpts: { pos: string; supplierState: string; forceIgst?: boolean; noTax?: boolean; diffPercent?: number | null }): Item {
  const rt = parseNumber(r.v.rt);
  const txval = parseNumber(r.v.txval);
  const computed = rt != null && txval != null ? computeTax(rt, txval, taxOpts) : { iamt: null, camt: null, samt: null };
  const pick = (k: 'iamt' | 'camt' | 'samt') => (r.present.has(k) ? parseNumber(r.v[k]) : computed[k]);
  return {
    rt, txval, iamt: pick('iamt'), camt: pick('camt'), samt: pick('samt'),
    csamt: parseNumber(r.v.csamt) ?? 0,
  };
}

/** Merge rows of one document into items, one per rate. */
function groupItems(rows: Row[], mk: (r: Row) => Item, ctx: BuildCtx, section: Section, docNo: string): Item[] {
  const byRate = new Map<string, Item>();
  for (const r of rows) {
    const it = mk(r);
    const k = String(it.rt);
    const prev = byRate.get(k);
    if (!prev) { byRate.set(k, it); continue; }
    ctx.issue('warning', section, ctx.sheet, r.row, 'rt', `Rate ${it.rt}% repeated for ${docNo}; rows merged`, { documentNo: docNo });
    for (const f of ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const) {
      prev[f] = prev[f] == null || it[f] == null ? null : round2(prev[f]! + it[f]!);
    }
  }
  return [...byRate.values()];
}

function groupBy(rows: Row[], key: (r: Row) => string) {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function checkConsistent(rows: Row[], fields: string[], ctx: BuildCtx, section: Section, docNo: string) {
  for (const f of fields) {
    const first = str(rows[0].v[f]);
    const bad = rows.find((r) => str(r.v[f]) !== first);
    if (bad) {
      ctx.issue('error', section, ctx.sheet, bad.row, f, `"${f}" differs between rows of ${docNo} (row ${rows[0].row}: "${first}", row ${bad.row}: "${str(bad.v[f])}")`, {
        documentNo: docNo, value: str(bad.v[f]), suggestion: 'Invoice-level columns must be identical on every rate row of the same document.',
      });
    }
  }
}

const rawOf = (r: Row) => Object.fromEntries(Object.entries(r.v).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]));
const src = (ctx: BuildCtx, rows: Row[]) => ({ sheet: ctx.sheet, rows: rows.map((r) => r.row), raw: rawOf(rows[0]) });
const diffOf = (r: Row) => parseNumber(r.v.diffPercent);

const invTypeOf = (v: unknown) => INVOICE_TYPES[str(v).toLowerCase()] ?? (str(v) ? str(v) : 'R');

const BUILDERS: Record<Section, (rows: Row[], ctx: BuildCtx) => void> = {
  b2b(rows, ctx) {
    for (const [, g] of groupBy(rows, (r) => `${up(r.v.ctin)}|${up(r.v.inum)}`)) {
      const f = g[0];
      const inum = str(f.v.inum);
      checkConsistent(g, ['idt', 'val', 'pos', 'rchrg', 'invTyp'], ctx, 'b2b', inum);
      const invTyp = invTypeOf(f.v.invTyp);
      const pos = parsePos(f.v.pos);
      const diffPercent = diffOf(f);
      const data: B2bData = {
        ctin: up(f.v.ctin), receiverName: str(f.v.receiverName) || undefined, inum,
        idt: dateField(f, 'idt', ctx, 'b2b'), val: parseNumber(f.v.val), pos, rchrg: parseYN(f.v.rchrg),
        invTyp, etin: up(f.v.etin) || undefined, diffPercent,
        items: groupItems(g, (r) => itemFrom(r, {
          pos, supplierState: ctx.supplierState, diffPercent,
          forceIgst: invTyp === 'SEWP' || invTyp === 'SEWOP' || invTyp === 'CBW', noTax: invTyp === 'SEWOP',
        }), ctx, 'b2b', inum),
      };
      ctx.out.push({ section: 'b2b', key: `b2b|${data.ctin}|${inum.toUpperCase()}`, source: src(ctx, g), data });
    }
  },
  b2cl(rows, ctx) {
    for (const [, g] of groupBy(rows, (r) => up(r.v.inum))) {
      const f = g[0];
      const inum = str(f.v.inum);
      checkConsistent(g, ['idt', 'val', 'pos'], ctx, 'b2cl', inum);
      const pos = parsePos(f.v.pos);
      const diffPercent = diffOf(f);
      const data: B2clData = {
        inum, idt: dateField(f, 'idt', ctx, 'b2cl'), val: parseNumber(f.v.val), pos,
        etin: up(f.v.etin) || undefined, diffPercent,
        items: groupItems(g, (r) => itemFrom(r, { pos, supplierState: ctx.supplierState, diffPercent, forceIgst: true }), ctx, 'b2cl', inum),
      };
      ctx.out.push({ section: 'b2cl', key: `b2cl|${inum.toUpperCase()}`, source: src(ctx, g), data });
    }
  },
  b2cs(rows, ctx) {
    for (const [k, g] of groupBy(rows, (r) => `${up(r.v.typ)}|${parsePos(r.v.pos)}|${parseNumber(r.v.rt)}|${up(r.v.etin)}|${parseNumber(r.v.diffPercent) ?? ''}`)) {
      const f = g[0];
      const pos = parsePos(f.v.pos);
      const diffPercent = diffOf(f);
      const [item] = groupItems(g, (r) => itemFrom(r, { pos, supplierState: ctx.supplierState, diffPercent }), ctx, 'b2cs', `B2CS ${pos}@${str(f.v.rt)}%`);
      const data: B2csData = { typ: up(f.v.typ), pos, etin: up(f.v.etin) || undefined, diffPercent, ...item };
      ctx.out.push({ section: 'b2cs', key: `b2cs|${k}`, source: src(ctx, g), data });
    }
  },
  cdnr(rows, ctx) {
    for (const [, g] of groupBy(rows, (r) => `${up(r.v.ctin)}|${up(r.v.ntNum)}`)) {
      const f = g[0];
      const ntNum = str(f.v.ntNum);
      checkConsistent(g, ['ntDt', 'ntty', 'val', 'pos', 'invTyp'], ctx, 'cdnr', ntNum);
      const invTyp = invTypeOf(f.v.invTyp);
      const pos = parsePos(f.v.pos);
      const diffPercent = diffOf(f);
      const data: CdnrData = {
        ctin: up(f.v.ctin), receiverName: str(f.v.receiverName) || undefined, ntNum,
        ntDt: dateField(f, 'ntDt', ctx, 'cdnr'), ntty: up(f.v.ntty).slice(0, 1), pos, rchrg: parseYN(f.v.rchrg),
        invTyp, val: parseNumber(f.v.val), diffPercent,
        items: groupItems(g, (r) => itemFrom(r, {
          pos, supplierState: ctx.supplierState, diffPercent,
          forceIgst: invTyp === 'SEWP' || invTyp === 'SEWOP' || invTyp === 'CBW', noTax: invTyp === 'SEWOP',
        }), ctx, 'cdnr', ntNum),
      };
      ctx.out.push({ section: 'cdnr', key: `cdnr|${data.ctin}|${ntNum.toUpperCase()}`, source: src(ctx, g), data });
    }
  },
  cdnur(rows, ctx) {
    for (const [, g] of groupBy(rows, (r) => up(r.v.ntNum))) {
      const f = g[0];
      const ntNum = str(f.v.ntNum);
      checkConsistent(g, ['ntDt', 'ntty', 'val', 'urType'], ctx, 'cdnur', ntNum);
      const urType = up(f.v.urType);
      const pos = parsePos(f.v.pos);
      const diffPercent = diffOf(f);
      const data: CdnurData = {
        urType, ntNum, ntDt: dateField(f, 'ntDt', ctx, 'cdnur'), ntty: up(f.v.ntty).slice(0, 1),
        pos: pos || undefined, val: parseNumber(f.v.val), diffPercent,
        items: groupItems(g, (r) => itemFrom(r, {
          pos: pos || '96', supplierState: ctx.supplierState, diffPercent, forceIgst: true, noTax: urType === 'EXPWOP',
        }), ctx, 'cdnur', ntNum),
      };
      ctx.out.push({ section: 'cdnur', key: `cdnur|${ntNum.toUpperCase()}`, source: src(ctx, g), data });
    }
  },
  exp(rows, ctx) {
    for (const [, g] of groupBy(rows, (r) => up(r.v.inum))) {
      const f = g[0];
      const inum = str(f.v.inum);
      checkConsistent(g, ['expTyp', 'idt', 'val', 'portCode', 'sbNum'], ctx, 'exp', inum);
      const expTyp = up(f.v.expTyp);
      const data: ExpData = {
        expTyp, inum, idt: dateField(f, 'idt', ctx, 'exp'), val: parseNumber(f.v.val),
        portCode: up(f.v.portCode) || undefined, sbNum: str(f.v.sbNum) || undefined,
        sbDt: f.v.sbDt != null ? dateField(f, 'sbDt', ctx, 'exp') : undefined,
        items: groupItems(g, (r) => itemFrom(r, { pos: '96', supplierState: ctx.supplierState, forceIgst: true, noTax: expTyp === 'WOPAY' }), ctx, 'exp', inum),
      };
      ctx.out.push({ section: 'exp', key: `exp|${inum.toUpperCase()}`, source: src(ctx, g), data });
    }
  },
  at: (rows, ctx) => buildAdvance('at', rows, ctx),
  txpd: (rows, ctx) => buildAdvance('txpd', rows, ctx),
  nil(rows, ctx) {
    for (const r of rows) {
      const desc = str(r.v.desc);
      const data: NilData = {
        splyTy: NIL_SUPPLY_TYPES[desc.toLowerCase()] ?? desc,
        nilAmt: parseNumber(r.v.nilAmt) ?? 0, exptAmt: parseNumber(r.v.exptAmt) ?? 0, ngsupAmt: parseNumber(r.v.ngsupAmt) ?? 0,
      };
      ctx.out.push({ section: 'nil', key: `nil|${data.splyTy}|${r.row}`, source: src(ctx, [r]), data });
    }
  },
  hsn_b2b: (rows, ctx) => buildHsn('hsn_b2b', rows, ctx),
  hsn_b2c: (rows, ctx) => buildHsn('hsn_b2c', rows, ctx),
  docs(rows, ctx) {
    for (const r of rows) {
      const data: DocData = {
        docTyp: str(r.v.docTyp), from: str(r.v.from), to: str(r.v.to),
        totnum: parseNumber(r.v.totnum), cancel: parseNumber(r.v.cancel) ?? 0,
      };
      ctx.out.push({ section: 'docs', key: `docs|${data.docTyp}|${up(data.from)}|${r.row}`, source: src(ctx, [r]), data });
    }
  },
};

function buildAdvance(section: 'at' | 'txpd', rows: Row[], ctx: BuildCtx) {
  for (const [k, g] of groupBy(rows, (r) => `${parsePos(r.v.pos)}|${parseNumber(r.v.diffPercent) ?? ''}`)) {
    const f = g[0];
    const pos = parsePos(f.v.pos);
    const diffPercent = diffOf(f);
    const byRate = new Map<string, AdvanceData['items'][number]>();
    for (const r of g) {
      const rt = parseNumber(r.v.rt);
      const adAmt = parseNumber(r.v.adAmt);
      const t = rt != null && adAmt != null ? computeTax(rt, adAmt, { pos, supplierState: ctx.supplierState, diffPercent }) : { iamt: null, camt: null, samt: null };
      const it = {
        rt, adAmt,
        iamt: r.present.has('iamt') ? parseNumber(r.v.iamt) : t.iamt,
        camt: r.present.has('camt') ? parseNumber(r.v.camt) : t.camt,
        samt: r.present.has('samt') ? parseNumber(r.v.samt) : t.samt,
        csamt: parseNumber(r.v.csamt) ?? 0,
      };
      const prev = byRate.get(String(rt));
      if (!prev) byRate.set(String(rt), it);
      else {
        ctx.issue('warning', section, ctx.sheet, r.row, 'rt', `Rate ${rt}% repeated for POS ${pos}; rows merged`);
        for (const fk of ['adAmt', 'iamt', 'camt', 'samt', 'csamt'] as const) {
          prev[fk] = prev[fk] == null || it[fk] == null ? null : round2(prev[fk]! + it[fk]!);
        }
      }
    }
    const data: AdvanceData = { pos, diffPercent, items: [...byRate.values()] };
    ctx.out.push({ section, key: `${section}|${k}`, source: src(ctx, g), data } as AnyRecord);
  }
}

function buildHsn(section: 'hsn_b2b' | 'hsn_b2c', rows: Row[], ctx: BuildCtx) {
  for (const r of rows) {
    const hsnRaw = r.v.hsn;
    if (typeof hsnRaw === 'number' && String(hsnRaw).length % 2 === 1) {
      ctx.issue('warning', section, ctx.sheet, r.row, 'hsn', `HSN ${hsnRaw} was stored as a number; a leading zero may have been lost`, {
        value: hsnRaw, suggestion: 'Format the HSN column as Text in Excel.',
      });
    }
    const data: HsnData = {
      hsn: str(hsnRaw), desc: str(r.v.desc) || undefined, uqc: up(r.v.uqc).split('-')[0].trim(),
      qty: parseNumber(r.v.qty) ?? 0, rt: parseNumber(r.v.rt), txval: parseNumber(r.v.txval),
      iamt: parseNumber(r.v.iamt) ?? 0, camt: parseNumber(r.v.camt) ?? 0, samt: parseNumber(r.v.samt) ?? 0,
      csamt: parseNumber(r.v.csamt) ?? 0,
    };
    ctx.out.push({ section, key: `${section}|${data.hsn}|${data.uqc}|${data.rt}|${r.row}`, source: src(ctx, [r]), data } as AnyRecord);
  }
}
