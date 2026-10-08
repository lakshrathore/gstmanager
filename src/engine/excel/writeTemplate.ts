import ExcelJS from 'exceljs';
import { STATE_CODES, UQC_CODES } from '../masters';
import type { AnyRecord } from '../types';
import { SHEETS } from './template';

/**
 * A return's records as the GSTR-1 offline-tool Excel template: the template's sheet names
 * ("b2b,sez,de", "b2cl", "b2cs", "cdnr", "cdnur", "exp", "exemp", "hsn(b2b)", "hsn(b2c)", "docs" …),
 * headers on row 4 and its value formats ("27-Maharashtra", "05-Sep-2026", "Regular B2B",
 * "NOS-NUMBERS"). The workbook imports back into this app unchanged and opens in GSTN's offline tool.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_KEYS = new Set(['idt', 'ntDt', 'sbDt', 'oidt', 'ontDt']);
const MONEY_KEYS = new Set(['val', 'txval', 'adAmt', 'iamt', 'camt', 'samt', 'csamt', 'nilAmt', 'exptAmt', 'ngsupAmt']);
const INV_TYPE: Record<string, string> = {
  R: 'Regular B2B', SEWP: 'SEZ supplies with payment', SEWOP: 'SEZ supplies without payment', DE: 'Deemed Exp', CBW: 'Intra-State supplies attracting IGST',
};
const NIL_DESC: Record<string, string> = {
  INTRB2B: 'Inter-State supplies to registered persons', INTRAB2B: 'Intra-State supplies to registered persons',
  INTRB2C: 'Inter-State supplies to unregistered persons', INTRAB2C: 'Intra-State supplies to unregistered persons',
};

/** yyyy-mm-dd → dd-Mon-yyyy (the template's text dates); anything else unchanged. */
function templateDate(v: unknown) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : v;
}

function cell(key: string, v: unknown, section: string): ExcelJS.CellValue {
  if (v == null || v === '') return null;
  if (DATE_KEYS.has(key)) return templateDate(v) as string;
  if (key === 'pos') { const c = String(v).padStart(2, '0'); return STATE_CODES[c] ? `${c}-${STATE_CODES[c]}` : String(v); }
  if (key === 'invTyp') return INV_TYPE[String(v)] ?? String(v);
  if (key === 'uqc') { const c = String(v).toUpperCase(); return UQC_CODES[c] ? `${c}-${UQC_CODES[c]}` : c; }
  if (key === 'desc' && section === 'nil') return NIL_DESC[String(v)] ?? String(v);
  return v as ExcelJS.CellValue;
}

/** One row per item (invoice fields repeated); records without items are one row. */
function rowsOf(r: AnyRecord): Record<string, unknown>[] {
  const d = r.data as unknown as Record<string, unknown>;
  const head: Record<string, unknown> = { ...d };
  if (r.section === 'nil') head.desc = d.splyTy;
  const items = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : null;
  return items?.length ? items.map((it) => ({ ...head, ...it })) : [head];
}

/** Adds the template sheets for these records to the workbook (sections without records are left out). */
export function addTemplateSheets(wb: ExcelJS.Workbook, records: AnyRecord[]) {
  for (const def of SHEETS) {
    const recs = records.filter((r) => r.section === def.section);
    if (!recs.length) continue;
    const name = def.sheetNames[0];
    const ws = wb.addWorksheet(name);
    ws.addRow([`Summary For ${name}`]).font = { bold: true };
    ws.addRow([]);
    ws.addRow([]);
    const header = ws.addRow(def.columns.map((c) => c.headers[0]));
    header.font = { bold: true };
    header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0EC' } }; });
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    for (const r of recs) {
      for (const x of rowsOf(r)) {
        const row = ws.addRow(def.columns.map((c) => cell(c.key, x[c.key], def.section)));
        def.columns.forEach((c, i) => { if (MONEY_KEYS.has(c.key)) row.getCell(i + 1).numFmt = '0.00'; });
      }
    }
    ws.columns = def.columns.map((c) => ({ width: Math.min(32, Math.max(10, c.headers[0].length + 2)) }));
  }
}
