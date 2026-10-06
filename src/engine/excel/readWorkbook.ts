import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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
  try {
    await wb.xlsx.load(buf as ArrayBuffer);
  } catch (e) {
    // exceljs fails on some generated workbooks (e.g. drawing parts without anchors, as in some GST
    // portal downloads). The cell values are still readable straight from the XML.
    try {
      return await readCellsOnly(buf, maxRowsPerSheet);
    } catch {
      throw new Error(`Could not read the Excel file (${(e as Error).message}). Open it in Excel, save it as .xlsx and try again.`);
    }
  }
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

/* ---------- fallback: values straight from the sheet XML ---------- */

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** Text of all <t> elements inside a fragment (shared strings and inline strings may be rich text). */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function readCellsOnly(buf: ArrayBuffer | Buffer, maxRowsPerSheet = 200_000): Promise<SheetTable[]> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (path: string) => (await zip.file(path)?.async('string')) ?? '';
  const workbook = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1] ?? '';
    const t = m[0].match(/\bTarget="([^"]+)"/)?.[1] ?? '';
    return [id, t.startsWith('/') ? t.slice(1) : `xl/${t}`] as const;
  }));
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));

  const tables: SheetTable[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '');
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? '';
    const xml = await read(target.get(rid) ?? '');
    const rows: unknown[][] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(rm[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
      if (r > maxRowsPerSheet) break;
      const cells: unknown[] = [];
      let next = 0;
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const body = cm[2] ?? '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value: unknown = null;
        if (type === 's') value = v != null ? shared[Number(v)] ?? null : null;
        else if (type === 'inlineStr') value = texts(body);
        else if (type === 'str' || type === 'e') value = v != null ? decode(v) : null;
        else if (type === 'b') value = v === '1';
        else if (v != null) value = Number.isFinite(Number(v)) ? Number(v) : decode(v);
        cells[idx] = value;
      }
      rows[r - 1] = cells;
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    tables.push({ name, rows });
  }
  if (!tables.length) throw new Error('No worksheets found');
  return tables;
}
