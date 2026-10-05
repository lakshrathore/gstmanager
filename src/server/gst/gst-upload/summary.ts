import type { SectionSummary } from '../gst-client/sandbox-protocol';

/**
 * Section-by-section comparison of GSTN's GSTR-1 summary with the app's own totals (GeneratedJson.log).
 * Pure – shared by the server and tests. Differences are shown, never auto-corrected.
 *
 * GSTN summary fields: ttl_rec = records, ttl_tax = total taxable value, ttl_val = total document value,
 * ttl_igst/cgst/sgst/cess = tax. The app's log carries documents, taxable value and total tax.
 */

export interface AppSectionTotals {
  documents: number;
  taxableValue: number;
  tax: number;
}

export interface SummaryRow {
  section: string;
  app?: AppSectionTotals;
  gstn?: { records: number; taxableValue: number; tax: number; value: number; igst: number; cgst: number; sgst: number; cess: number };
  diff: { records: boolean; taxableValue: boolean; tax: boolean };
}

/** App log key → GSTN sec_nm. */
const GSTN_NAME: Record<string, string> = {
  b2b: 'B2B', b2cl: 'B2CL', b2cs: 'B2CS', cdnr: 'CDNR', cdnur: 'CDNUR', exp: 'EXP', at: 'AT', txpd: 'TXPD',
  nil: 'NIL', hsn: 'HSN', doc_issue: 'DOC_ISSUE',
};
/** Amount tolerance for rounding (₹1). */
const TOLERANCE = 1;

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function compareSummary(app: Record<string, AppSectionTotals> | undefined, gstn: SectionSummary[]): SummaryRow[] {
  const rows = new Map<string, SummaryRow>();
  const row = (name: string) => rows.get(name) ?? rows.set(name, { section: name, diff: { records: false, taxableValue: false, tax: false } }).get(name)!;

  for (const [key, t] of Object.entries(app ?? {})) row(GSTN_NAME[key] ?? key.toUpperCase()).app = t;
  for (const s of gstn) {
    const name = String(s.sec_nm ?? '').toUpperCase();
    if (!name) continue;
    const igst = num(s.ttl_igst), cgst = num(s.ttl_cgst), sgst = num(s.ttl_sgst), cess = num(s.ttl_cess);
    row(name).gstn = {
      records: num(s.ttl_rec), taxableValue: r2(num(s.ttl_tax)), value: r2(num(s.ttl_val)),
      tax: r2(igst + cgst + sgst + cess), igst, cgst, sgst, cess,
    };
  }

  for (const r of rows.values()) {
    const a = r.app ?? { documents: 0, taxableValue: 0, tax: 0 };
    const g = r.gstn ?? { records: 0, taxableValue: 0, tax: 0 };
    r.diff = {
      records: a.documents !== g.records,
      taxableValue: Math.abs(a.taxableValue - g.taxableValue) > TOLERANCE,
      tax: Math.abs(a.tax - g.tax) > TOLERANCE,
    };
  }
  // GSTN's order first, then sections only the app has.
  const order = gstn.map((s) => String(s.sec_nm ?? '').toUpperCase());
  return [...rows.values()].sort((x, y) => {
    const ix = order.indexOf(x.section), iy = order.indexOf(y.section);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.section.localeCompare(y.section);
  });
}

export const hasDifferences = (rows: SummaryRow[]) => rows.some((r) => r.diff.records || r.diff.taxableValue || r.diff.tax);
