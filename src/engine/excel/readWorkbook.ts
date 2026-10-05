import ExcelJS from 'exceljs';
import type { SheetTable } from './parseGstr1';

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ('text' in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if ('error' in v) return null;
    return String(v);
  }
  return v;
}

/** Reads an .xlsx buffer into plain tables (row i = Excel row i+1). */
export async function readWorkbook(buf: ArrayBuffer | Buffer, maxRowsPerSheet = 200_000): Promise<SheetTable[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  const tables: SheetTable[] = [];
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    const last = Math.min(ws.actualRowCount ? ws.rowCount : 0, maxRowsPerSheet);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellValue(cell.value);
      });
      rows.push(cells);
    }
    tables.push({ name: ws.name, rows });
  });
  return tables;
}
