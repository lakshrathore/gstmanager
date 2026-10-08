import 'server-only';
import ExcelJS from 'exceljs';
import { SECTION_LABELS, SECTIONS, type AnyRecord, type Section } from '@/engine';

/**
 * A GSTR-1 return's data as Excel: a summary by section (count, taxable value, tax) and one sheet per
 * section with a row per item (invoice fields repeated on each item row), for review and records.
 */

const HEADINGS: Record<string, string> = {
  ctin: 'GSTIN/UIN of recipient', receiverName: 'Receiver name', inum: 'Invoice number', idt: 'Invoice date', val: 'Invoice value',
  pos: 'Place of supply', rchrg: 'Reverse charge', invTyp: 'Invoice type', etin: 'E-commerce GSTIN', diffPercent: 'Applicable % of tax rate',
  typ: 'Type', ntNum: 'Note number', ntDt: 'Note date', ntty: 'Note type', urType: 'UR type', expTyp: 'Export type', portCode: 'Port code',
  sbNum: 'Shipping bill number', sbDt: 'Shipping bill date', splyTy: 'Supply type', nilAmt: 'Nil rated', exptAmt: 'Exempted', ngsupAmt: 'Non-GST',
  hsn: 'HSN', desc: 'Description', uqc: 'UQC', qty: 'Quantity', docTyp: 'Document type', from: 'Sr. no. from', to: 'Sr. no. to',
  totnum: 'Total number', cancel: 'Cancelled', oinum: 'Original invoice number', oidt: 'Original invoice date', ontNum: 'Original note number',
  ontDt: 'Original note date', omon: 'Original month', rt: 'Rate', txval: 'Taxable value', adAmt: 'Advance amount',
  iamt: 'IGST', camt: 'CGST', samt: 'SGST/UTGST', csamt: 'Cess',
};
const MONEY = new Set(['val', 'txval', 'adAmt', 'iamt', 'camt', 'samt', 'csamt', 'nilAmt', 'exptAmt', 'ngsupAmt']);

/** One row per item; records without items are one row. */
function flatten(r: AnyRecord): Record<string, unknown>[] {
  const d = r.data as unknown as Record<string, unknown>;
  const head = Object.fromEntries(Object.entries(d).filter(([k, v]) => k !== 'items' && (v == null || typeof v !== 'object')));
  const items = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : null;
  return items?.length ? items.map((it) => ({ ...head, ...it })) : [head];
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function gstr1Workbook(records: AnyRecord[], title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  summary.addRow([title]).font = { bold: true, size: 12 };
  summary.addRow([]);
  const h = summary.addRow(['Section', 'Table', 'Records', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST', 'Cess']);
  h.font = { bold: true };
  summary.columns = [{ width: 10 }, { width: 50 }, { width: 10 }, ...Array(5).fill({ width: 18 })];

  const bySection = new Map<Section, AnyRecord[]>();
  for (const r of records) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);

  for (const s of SECTIONS) {
    const recs = bySection.get(s);
    if (!recs?.length) continue;
    const rows = recs.flatMap(flatten);
    const sum = (k: string) => rows.reduce((a, x) => a + n(x[k]), 0);
    const sr = summary.addRow([s, SECTION_LABELS[s], recs.length, sum('txval') + sum('adAmt'), sum('iamt'), sum('camt'), sum('samt'), sum('csamt')]);
    for (let j = 4; j <= 8; j++) sr.getCell(j).numFmt = '#,##0.00';

    const keys: string[] = [];
    for (const x of rows) for (const k of Object.keys(x)) if (!keys.includes(k)) keys.push(k);
    const ws = wb.addWorksheet(s);
    ws.addRow([SECTION_LABELS[s]]).font = { bold: true };
    const hr = ws.addRow(keys.map((k) => HEADINGS[k] ?? k));
    hr.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    for (const x of rows) {
      const row = ws.addRow(keys.map((k) => (x[k] ?? null) as ExcelJS.CellValue));
      keys.forEach((k, j) => { if (MONEY.has(k)) row.getCell(j + 1).numFmt = '#,##0.00'; });
    }
    ws.columns = keys.map((k) => ({ width: Math.min(30, Math.max(10, (HEADINGS[k] ?? k).length + 2)) }));
  }
  if (!records.length) summary.addRow(['No records in this return.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
