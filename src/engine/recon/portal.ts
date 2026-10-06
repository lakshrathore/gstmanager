import type { SheetTable } from '../excel/parseGstr1';
import { stateCode } from '../marketplace/states';
import { norm, parseDate, parseNumber, round2 } from '../util';
import { docKey } from './normalize';
import type { PurchaseDoc, PurchaseDocType, PurchaseSource } from './types';

/**
 * GSTR-2A / GSTR-2B as downloaded from the GST portal – JSON or Excel – into PurchaseDocs.
 * Covered: B2B invoices, B2BA (amended invoices), CDNR / CDN (credit & debit notes), CDNRA.
 * ISD, IMPG, TDS/TCS sections are not supplier invoices you book and are reported as skipped.
 */

export interface PortalReadResult { docs: PurchaseDoc[]; notes: string[] }

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const num = (v: unknown) => parseNumber(v) ?? 0;
const iso = (v: unknown) => (v instanceof Date || typeof v === 'number' ? parseDate(v) : parseDate(str(v).split(/[ T]/)[0])) ?? '';
const yn = (v: unknown): boolean | undefined => {
  const s = str(v).toUpperCase();
  return s === 'Y' || s === 'YES' ? true : s === 'N' || s === 'NO' ? false : undefined;
};

/** Adds docs of the same key together (rate-wise rows / items of one document). */
class Collector {
  map = new Map<string, PurchaseDoc>();
  add(d: PurchaseDoc) {
    const prev = this.map.get(d.key);
    if (!prev) { this.map.set(d.key, d); return; }
    for (const f of ['taxable', 'igst', 'cgst', 'sgst', 'cess'] as const) prev[f] = round2(prev[f] + d[f]);
  }
  get docs() { return [...this.map.values()]; }
}

function mk(source: PurchaseSource, period: string, base: Omit<PurchaseDoc, 'key' | 'source' | 'period'>): PurchaseDoc {
  return { ...base, key: docKey(source, base.supplierGstin, base.docType, base.docNo), source, period };
}

/* ---------------- JSON ---------------- */

type J = Record<string, unknown>;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);

/** Item-level amounts: 2A uses itms[].itm_det {txval, iamt, camt, samt, csamt}; 2B uses items[] {txval, igst, cgst, sgst, cess}. */
function amounts(doc: J) {
  const has = (k: string) => doc[k] != null;
  if (has('txval') || has('igst') || has('iamt')) {
    return { taxable: num(doc.txval), igst: num(doc.igst ?? doc.iamt), cgst: num(doc.cgst ?? doc.camt), sgst: num(doc.sgst ?? doc.samt), cess: num(doc.cess ?? doc.csamt) };
  }
  const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const it of [...arr(doc.items), ...arr(doc.itms)]) {
    const d = (it.itm_det as J | undefined) ?? it;
    t.taxable += num(d.txval); t.igst += num(d.igst ?? d.iamt); t.cgst += num(d.cgst ?? d.camt); t.sgst += num(d.sgst ?? d.samt); t.cess += num(d.cess ?? d.csamt);
  }
  return { taxable: round2(t.taxable), igst: round2(t.igst), cgst: round2(t.cgst), sgst: round2(t.sgst), cess: round2(t.cess) };
}

const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "112019" | "Nov-19" | "November-2019" → "112019" (MMYYYY); '' when not a period. */
export function periodOf(v: unknown): string {
  const raw = str(v);
  const m = raw.match(/^([A-Za-z]{3})[A-Za-z]*[-\s/'’]*(\d{2}|\d{4})$/);
  if (m && MON[m[1].toLowerCase()]) return `${MON[m[1].toLowerCase()]}${m[2].length === 2 ? `20${m[2]}` : m[2]}`;
  const s = raw.replace(/\D/g, '');
  return s.length === 6 ? s : '';
}

/** GSTR-2B "rsn" codes → text. */
const REASON: Record<string, string> = {
  P: 'POS and supplier state are the same but recipient state is different',
  C: 'Return filed after the time limit of section 16(4) (annual cut-off)',
};
const reasonOf = (v: unknown) => { const r = str(v); return r ? REASON[r.toUpperCase()] ?? r : undefined; };

export function readPortalJson(json: unknown, source: PurchaseSource, file: string, fp: string): PortalReadResult {
  const notes: string[] = [];
  const c = new Collector();
  const root = (json ?? {}) as J;
  // 2B: { data: { gstin, rtnprd, docdata: { b2b, b2ba, cdnr, cdnra, ... } } }; 2A: { gstin, fp, b2b, cdn, ... }
  const data = (root.data as J | undefined) ?? root;
  const sections = ((data.docdata as J | undefined) ?? data) as J;
  const period = periodOf(data.rtnprd ?? data.fp ?? root.fp) || fp;
  const is2b = !!data.docdata || source === 'gstr2b';
  if (data.gstin && typeof data.gstin === 'string') notes.push(`File is for GSTIN ${data.gstin}, period ${period.slice(0, 2)}/${period.slice(2)}`);

  const supplierBase = (s: J) => ({
    supplierGstin: str(s.ctin).toUpperCase(), supplierName: str(s.trdnm) || undefined,
    supplierPeriod: periodOf(s.supprd ?? s.flprdr1) || undefined, supplierFilingDate: iso(s.supfildt ?? s.fldtr1) || undefined,
    supplierFiled: s.cfs != null ? yn(s.cfs) : undefined, gstinCancelledOn: iso(s.dtcancel) || undefined,
  });

  const invoices = (key: string, amended: boolean) => {
    for (const s of arr(sections[key])) {
      const sb = supplierBase(s);
      for (const inv of arr(s.inv)) {
        c.add(mk(source, period, {
          ...sb, docType: 'INV', docNo: str(inv.inum), docDate: iso(inv.dt ?? inv.idt), pos: str(inv.pos) || undefined,
          rcm: yn(inv.rev ?? inv.rchrg), invoiceValue: num(inv.val), ...amounts(inv),
          itcAvailable: inv.itcavl != null ? yn(inv.itcavl) ?? null : undefined, itcReason: reasonOf(inv.rsn),
          amended: amended || undefined, originalDocNo: amended ? str(inv.oinum) || undefined : undefined,
        }));
      }
    }
  };
  const notesOf = (key: string, amended: boolean) => {
    for (const s of arr(sections[key])) {
      const sb = supplierBase(s);
      for (const nt of arr(s.nt)) {
        const t = str(nt.typ ?? nt.ntty).toUpperCase();
        const docType: PurchaseDocType = t === 'D' ? 'DN' : 'CN';
        c.add(mk(source, period, {
          ...sb, docType, docNo: str(nt.ntnum ?? nt.nt_num), docDate: iso(nt.dt ?? nt.nt_dt), pos: str(nt.pos) || undefined,
          rcm: yn(nt.rev ?? nt.rchrg), invoiceValue: num(nt.val), ...amounts(nt),
          itcAvailable: nt.itcavl != null ? yn(nt.itcavl) ?? null : undefined, itcReason: reasonOf(nt.rsn),
          amended: amended || undefined, originalDocNo: amended ? str(nt.ontnum ?? nt.ont_num) || undefined : undefined,
        }));
      }
    }
  };
  invoices('b2b', false);
  invoices('b2ba', true);
  notesOf(is2b ? 'cdnr' : 'cdn', false);
  if (!is2b) notesOf('cdnr', false);
  notesOf(is2b ? 'cdnra' : 'cdna', true);
  if (!is2b) notesOf('cdnra', true);

  const skippedSections = Object.keys(sections).filter((k) => !['b2b', 'b2ba', 'cdnr', 'cdnra', 'cdn', 'cdna'].includes(k) && Array.isArray(sections[k]) && (sections[k] as unknown[]).length);
  if (skippedSections.length) notes.push(`Not reconciled (no supplier invoices): ${skippedSections.join(', ')}`);
  if (!c.map.size && !Object.keys(sections).some((k) => ['b2b', 'b2ba', 'cdnr', 'cdn'].includes(k))) notes.push('This does not look like a GSTR-2A/2B JSON file');
  return { docs: c.docs, notes };
}

/* ---------------- Excel ---------------- */

/** Column aliases for the portal's 2A/2B Excel (headers span two rows: group header + column). */
const COLS: Record<string, string[]> = {
  gstin: ['GSTIN of supplier', 'GSTIN of Supplier'],
  name: ['Trade/Legal name', 'Trade/Legal name of the Supplier', 'Trade/Legal Name'],
  docNo: ['Invoice number', 'Note number', 'Note Number', 'Invoice Number', 'Credit note/Debit note number', 'Note/Refund Voucher Number'],
  origNo: ['Original Invoice number', 'Original Note number', 'Original invoice number', 'Original note number'],
  docType: ['Note type', 'Note Type', 'Invoice type', 'Invoice Type', 'Note/Refund Voucher type'],
  docDate: ['Invoice Date', 'Note date', 'Note Date', 'Invoice date', 'Note/Refund Voucher date'],
  value: ['Invoice Value(₹)', 'Invoice Value (₹)', 'Note Value (₹)', 'Note Value(₹)', 'Invoice Value', 'Note Value'],
  pos: ['Place of supply', 'Place Of Supply'],
  rcm: ['Supply Attract Reverse Charge', 'Reverse Charge'],
  taxable: ['Taxable Value (₹)', 'Taxable Value(₹)', 'Taxable Value'],
  igst: ['Integrated Tax(₹)', 'Integrated Tax (₹)', 'Integrated Tax'],
  cgst: ['Central Tax(₹)', 'Central Tax (₹)', 'Central Tax'],
  sgst: ['State/UT Tax(₹)', 'State/UT tax (₹)', 'State/UT Tax (₹)', 'State/UT Tax', 'State/UT tax', 'State Tax (₹)', 'State Tax'],
  cess: ['Cess(₹)', 'Cess (₹)', 'Cess', 'Cess Amount (₹)', 'Cess Amount'],
  supplierPeriod: ['GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-1A/5 Filing Period', 'GSTR-1/5 Filing Period', 'GSTR-1/IFF/GSTR-1A/5 Period'],
  supplierFilingDate: ['GSTR-1/IFF/GSTR-5 Filing Date', 'GSTR-1/IFF/GSTR-1A/5 Filing Date', 'GSTR-1/5 Filing Date'],
  supplierFiled: ['GSTR-1/IFF/GSTR-1A/5 Filing Status', 'GSTR-1/5 Filing Status', 'GSTR-1/IFF/GSTR-5 Filing Status'],
  itc: ['ITC Availability', 'ITC availability'],
  reason: ['Reason'],
  cancelled: ['Effective date of cancellation'],
};

/** Header cells, with the group header of a merged two-row header carried over when the lower cell is blank. */
function headerCells(rows: unknown[][], r: number): string[] {
  const top = rows[r] ?? [];
  const low = rows[r + 1] ?? [];
  const width = Math.max(top.length, low.length);
  const out: string[] = [];
  for (let i = 0; i < width; i++) out.push(str(low[i]) || str(top[i]));
  return out;
}

function mapCols(cells: string[]) {
  const n = cells.map(norm);
  const map = new Map<string, number>();
  for (const [k, aliases] of Object.entries(COLS)) {
    for (const a of aliases) {
      const i = n.findIndex((c, idx) => c === norm(a) && ![...map.values()].includes(idx));
      if (i >= 0) { map.set(k, i); break; }
    }
  }
  return map;
}

/** All columns whose header is one of the field's aliases (B2BA/CDNRA: original first, revised last). */
function allCols(cells: string[], key: string) {
  const wanted = new Set(COLS[key].map(norm));
  return cells.map(norm).flatMap((c, i) => (wanted.has(c) ? [i] : []));
}

/**
 * The portal uses one to three header rows (title band, "Original/Revised details", group headers like
 * "Tax Amount", then column names). Every row and row-pair near the top is tried; the one that maps
 * the most columns wins and data starts below it.
 */
function findHeader(t: SheetTable) {
  const ok = (m: Map<string, number>) => m.has('gstin') && m.has('docNo') && m.has('taxable');
  let best: { map: Map<string, number>; cells: string[]; start: number } | null = null;
  for (let r = 0; r < Math.min(t.rows.length, 12); r++) {
    const single = (t.rows[r] ?? []).map(str);
    const double = headerCells(t.rows, r);
    for (const [cells, start] of [[single, r + 1], [double, r + 2]] as const) {
      const map = mapCols(cells);
      if (ok(map) && (!best || map.size > best.map.size || (map.size === best.map.size && start > best.start))) best = { map, cells, start };
    }
  }
  return best;
}

/** Sheet name → what it holds. */
function sheetKind(name: string): { kind: 'inv' | 'note'; amended: boolean } | 'skip' | null {
  const n = name.toUpperCase().replace(/\s+/g, '');
  if (/^B2BA$/.test(n)) return { kind: 'inv', amended: true };
  if (/^B2B$/.test(n)) return { kind: 'inv', amended: false };
  if (/CDNRA$|CDNA$/.test(n)) return { kind: 'note', amended: true };
  if (/CDNR$|CDN$/.test(n)) return { kind: 'note', amended: false };
  if (/^(ISD|ISDA|IMPG|IMPGSEZ|IMPGA|IMPGSEZA|TDS|TDSA|TCS|ECO|ECOA)|ITC/.test(n)) return 'skip';
  return null;
}

export function readPortalTables(tables: SheetTable[], source: PurchaseSource, file: string, fp: string): PortalReadResult {
  const notes: string[] = [];
  const c = new Collector();
  for (const t of tables) {
    const kind = sheetKind(t.name);
    // Only mention skipped sheets that actually hold data rows (templates carry empty sheets).
    const hasData = t.rows.some((row) => (row ?? []).some((c) => /^[0-9]{2}[0-9A-Z]{13}$/.test(str(c).toUpperCase())));
    if (kind === 'skip') { if (hasData) notes.push(`Sheet "${t.name}" not reconciled (no supplier invoices)`); continue; }
    if (!kind) continue;
    const h = findHeader(t);
    if (!h) { notes.push(`Sheet "${t.name}": header row not recognised`); continue; }
    if (kind.amended) {
      // Original details come first, revised details after: the last number/date/type column is the revised one.
      const nos = allCols(h.cells, 'docNo');
      if (nos.length > 1) { h.map.set('origNo', nos[0]); h.map.set('docNo', nos[nos.length - 1]); }
      for (const k of ['docDate', 'docType']) { const c = allCols(h.cells, k); if (c.length > 1) h.map.set(k, c[c.length - 1]); }
    }
    const get = (row: unknown[], k: string) => (h.map.has(k) ? row[h.map.get(k)!] : undefined);
    let n = 0;
    for (let r = h.start; r < t.rows.length; r++) {
      const row = t.rows[r] ?? [];
      const gstin = str(get(row, 'gstin')).toUpperCase();
      const docNo = str(get(row, 'docNo'));
      if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin) || !docNo) continue;
      const tRaw = str(get(row, 'docType')).toUpperCase();
      const docType: PurchaseDocType = kind.kind === 'inv' ? 'INV' : /DEBIT|^D$/.test(tRaw) ? 'DN' : 'CN';
      const itc = get(row, 'itc');
      c.add(mk(source, fp, {
        supplierGstin: gstin, supplierName: str(get(row, 'name')) || undefined, docType, docNo, docDate: iso(get(row, 'docDate')),
        pos: stateCode(get(row, 'pos')) || undefined, rcm: yn(get(row, 'rcm')), invoiceValue: num(get(row, 'value')),
        taxable: num(get(row, 'taxable')), igst: num(get(row, 'igst')), cgst: num(get(row, 'cgst')), sgst: num(get(row, 'sgst')), cess: num(get(row, 'cess')),
        supplierPeriod: periodOf(get(row, 'supplierPeriod')) || undefined,
        supplierFilingDate: iso(get(row, 'supplierFilingDate')) || undefined,
        supplierFiled: yn(get(row, 'supplierFiled')),
        itcAvailable: itc != null && str(itc) ? yn(itc) ?? null : undefined, itcReason: reasonOf(get(row, 'reason')),
        gstinCancelledOn: iso(get(row, 'cancelled')) || undefined,
        amended: kind.amended || undefined, originalDocNo: kind.amended ? str(get(row, 'origNo')) || undefined : undefined,
        origin: { file, sheet: t.name, row: r + 1 },
      }));
      n++;
    }
    if (!n && hasData) notes.push(`Sheet "${t.name}": rows found but none had a valid supplier GSTIN and document number`);
  }
  if (!c.map.size && !notes.length) notes.push('No B2B / CDNR sheets found – is this the GSTR-2A/2B Excel from the portal?');
  return { docs: c.docs, notes };
}
