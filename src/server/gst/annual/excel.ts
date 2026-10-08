import 'server-only';
import ExcelJS from 'exceljs';
import { resolve, sheetCols, type AnnualForm, type TableDef } from './common';

/**
 * Excel for an annual form, laid out like the GST portal's tables: one heading row per table (Code,
 * Description, the table's columns), rows by code, list rows under their list code, reasons as text.
 * Computed rows are written as values (and recalculated on import); columns a row does not have are
 * greyed. The same file imports back.
 */
export async function annualWorkbook(defs: TableDef[], form: AnnualForm, title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const grey: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E5E5' } };
  const calcFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  const money = '#,##0.00';
  const r = resolve(defs, form);
  const sheets = new Map<string, ExcelJS.Worksheet>();

  const sheetFor = (name: string) => {
    let ws = sheets.get(name);
    if (ws) return ws;
    ws = wb.addWorksheet(name.slice(0, 31));
    ws.addRow([title]).font = { bold: true, size: 12 };
    ws.addRow(['Amounts in rupees. Keep the Code column and the column headings; blank cells count as 0. Grey rows are calculated and are recalculated on import.']).font = { italic: true, color: { argb: 'FF666666' } };
    sheets.set(name, ws);
    return ws;
  };
  const heading = (ws: ExcelJS.Worksheet, cells: string[]) => {
    const h = ws.addRow(cells);
    h.font = { bold: true };
    h.eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
  };

  for (const t of defs) {
    const ws = sheetFor(t.sheet);
    ws.addRow([]);
    ws.addRow([t.title]).font = { bold: true, size: 11 };
    if (t.note) ws.addRow([t.note]).font = { italic: true, color: { argb: 'FF666666' } };

    if (t.text) {
      heading(ws, ['Code', 'Description', 'Reason']);
      const row = ws.addRow([t.id, t.title.replace(/^\d+\.\s*/, ''), form.text[t.id] ?? '']);
      row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
      ws.getColumn(3).width = Math.max(ws.getColumn(3).width ?? 0, 80);
      continue;
    }

    // A table that is only a list (HSN summary) has no Code column.
    if (!t.rows.length && t.lists?.length === 1) {
      const l = t.lists[0];
      heading(ws, l.cols.map((c) => c.label));
      for (const x of form.lists[l.code] ?? []) {
        const row = ws.addRow(l.cols.map((c) => x[c.key] ?? null));
        l.cols.forEach((c, j) => { if (c.type === 'num') row.getCell(j + 1).numFmt = money; });
      }
      ws.columns = l.cols.map((c) => ({ width: c.key === 'hsn_sc' || c.key === 'uqc' ? 12 : 18 }));
      continue;
    }

    const cols = sheetCols(t);
    heading(ws, ['Code', 'Description', ...cols.map((c) => c.label)]);
    for (const def of t.rows) {
      if (def.list) {
        const l = t.lists!.find((x) => x.code === def.list)!;
        const items = form.lists[l.code]?.length ? form.lists[l.code] : [l.blank()];
        for (const x of items) {
          const row = ws.addRow([l.code, l.cols.some((c) => c.key === 'desc') ? x.desc : def.label, ...cols.map((c) => (l.cols.some((lc) => lc.key === c.key) ? x[c.key] ?? null : null))]);
          cols.forEach((c, j) => {
            const lc = l.cols.find((x2) => x2.key === c.key);
            if (!lc) row.getCell(3 + j).fill = grey;
            else if (lc.type === 'num') row.getCell(3 + j).numFmt = money;
          });
        }
        continue;
      }
      const v = r[def.code] ?? {};
      const row = ws.addRow([def.code, def.calc ? `${def.label} (calculated)` : def.label, ...cols.map((c) => (def.cols.includes(c.key) ? v[c.key] ?? 0 : null))]);
      cols.forEach((c, j) => {
        const cell = row.getCell(3 + j);
        if (!def.cols.includes(c.key)) cell.fill = grey;
        else { cell.numFmt = money; if (def.calc) cell.fill = calcFill; }
      });
      if (def.calc) { row.font = { italic: true }; row.getCell(1).fill = calcFill; row.getCell(2).fill = calcFill; }
    }
    ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 0, 13);
    ws.getColumn(2).width = Math.max(ws.getColumn(2).width ?? 0, 70);
    cols.forEach((_, j) => { ws.getColumn(3 + j).width = Math.max(ws.getColumn(3 + j).width ?? 0, 18); });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
