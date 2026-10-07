import 'server-only';
import ExcelJS from 'exceljs';
import { STATE_CODES } from '@/engine/masters';
import { EXCEL_AMT_COLS, EXCEL_INWARD_ROWS, EXCEL_POS_TYPES, EXCEL_ROWS, blankForm, type Gstr3bForm } from './protocol';

/**
 * GSTR-3B Excel template: one sheet for tables 3.1 – 5.1 (rows by code, portal columns), one for 3.2
 * and one for table 5. Filled with `form` when given, so a download can be edited and imported again.
 * Columns a table does not have on the GST portal are greyed out.
 */
export async function gstr3bWorkbook(form: Gstr3bForm | null, title: string): Promise<Buffer> {
  const f = form ?? blankForm();
  const wb = new ExcelJS.Workbook();
  const grey: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E5E5' } };
  const money = '#,##0.00';
  const head = (ws: ExcelJS.Worksheet, cols: string[]) => {
    ws.addRow([title]).font = { bold: true, size: 12 };
    ws.addRow(['Enter amounts in rupees. Keep the Code column and the column headings as they are; blank cells count as 0.']).font = { italic: true, color: { argb: 'FF666666' } };
    const r = ws.addRow(cols);
    r.font = { bold: true };
    r.eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
    ws.views = [{ state: 'frozen', ySplit: 3 }];
  };

  const main = wb.addWorksheet('3.1 to 5.1');
  head(main, ['Code', 'Description', ...EXCEL_AMT_COLS.map((c) => c.label)]);
  for (const def of EXCEL_ROWS) {
    const a = def.get(f);
    const r = main.addRow([def.code, def.label, ...EXCEL_AMT_COLS.map((c) => (def.fields.includes(c.key) ? a[c.key] ?? 0 : null))]);
    EXCEL_AMT_COLS.forEach((c, j) => {
      const cell = r.getCell(3 + j);
      if (def.fields.includes(c.key)) cell.numFmt = money;
      else cell.fill = grey;
    });
  }
  main.columns = [{ width: 14 }, { width: 70 }, ...EXCEL_AMT_COLS.map(() => ({ width: 18 }))];

  const inter = wb.addWorksheet('3.2 Inter-state');
  head(inter, ['Type', 'Place of supply', 'Taxable value', 'IGST']);
  for (const t of EXCEL_POS_TYPES) {
    for (const p of f.inter_sup[t.key]) {
      const r = inter.addRow([t.label, `${p.pos}-${STATE_CODES[p.pos] ?? ''}`, p.txval, p.iamt]);
      r.getCell(3).numFmt = money; r.getCell(4).numFmt = money;
    }
  }
  const types = `"${EXCEL_POS_TYPES.map((t) => t.label).join(',')}"`;
  for (let i = 4; i <= 500; i++) inter.getCell(`A${i}`).dataValidation = { type: 'list', allowBlank: true, formulae: [types] };
  inter.columns = [{ width: 30 }, { width: 30 }, { width: 18 }, { width: 18 }];

  const inward = wb.addWorksheet('5 Exempt inward');
  head(inward, ['Code', 'Description', 'Inter-state', 'Intra-state']);
  for (const def of EXCEL_INWARD_ROWS) {
    const v = f.inward_sup.isup_details.find((r) => r.ty === def.ty);
    const r = inward.addRow([def.code, def.label, v?.inter ?? 0, v?.intra ?? 0]);
    r.getCell(3).numFmt = money; r.getCell(4).numFmt = money;
  }
  inward.columns = [{ width: 10 }, { width: 70 }, { width: 18 }, { width: 18 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}
