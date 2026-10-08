import 'server-only';
import ExcelJS from 'exceljs';
import { addTemplateSheets, SECTION_LABELS, SECTIONS, type AnyRecord, type Section } from '@/engine';

/**
 * A GSTR-1 return's data as Excel: a summary by section (count, taxable value, tax), then the
 * sections in the GSTR-1 offline-tool template layout – so the file can be corrected and imported
 * back (here or in GSTN's offline tool) without changing a column.
 */

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function gstr1Workbook(records: AnyRecord[], title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  summary.addRow([title]).font = { bold: true, size: 12 };
  summary.addRow(['The other sheets use the GSTR-1 offline-tool template layout – they can be imported back as they are.']);
  const h = summary.addRow(['Section', 'Table', 'Records', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST', 'Cess']);
  h.font = { bold: true };
  summary.columns = [{ width: 10 }, { width: 50 }, { width: 10 }, ...Array(5).fill({ width: 18 })];

  const bySection = new Map<Section, AnyRecord[]>();
  for (const r of records) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  for (const s of SECTIONS) {
    const recs = bySection.get(s);
    if (!recs?.length) continue;
    const rows = recs.flatMap((r) => {
      const d = r.data as unknown as Record<string, unknown>;
      return Array.isArray(d.items) && d.items.length ? (d.items as Record<string, unknown>[]) : [d];
    });
    const sum = (k: string) => rows.reduce((a, x) => a + n(x[k]), 0);
    const taxable = s === 'nil' ? recs.reduce((a, r) => { const d = r.data as { nilAmt?: number; exptAmt?: number; ngsupAmt?: number }; return a + n(d.nilAmt) + n(d.exptAmt) + n(d.ngsupAmt); }, 0) : sum('txval') + sum('adAmt');
    const sr = summary.addRow([s, SECTION_LABELS[s], recs.length, taxable, sum('iamt'), sum('camt'), sum('samt'), sum('csamt')]);
    for (let j = 4; j <= 8; j++) sr.getCell(j).numFmt = '#,##0.00';
  }
  if (!records.length) summary.addRow(['No records in this return.']);

  addTemplateSheets(wb, records);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
