import type { SheetTable } from '../excel/parseGstr1';

/**
 * RFC 4180 CSV → table (quoted fields, "" escapes, CRLF/LF, newlines inside quotes).
 * Also accepts tab-separated text (Amazon offers .txt reports) when there are no commas in the header.
 */
export function parseCsv(text: string, name: string): SheetTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, src.search(/\r?\n/) === -1 ? src.length : src.search(/\r?\n/));
  const sep = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const rows: unknown[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { name, rows: rows.map((r) => r.map((v) => (typeof v === 'string' ? v.trim() : v))) };
}
