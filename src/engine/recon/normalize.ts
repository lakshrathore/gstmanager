import type { PurchaseDoc, PurchaseDocType, PurchaseSource } from './types';

/**
 * Invoice-number normalisation used for matching. Suppliers and accountants write the same number
 * differently: "INV/001/25-26", "inv-1", "INV 0001 (2025-26)". We compare on a canonical form:
 *  - upper case, financial-year tags removed ("2025-26", "25-26", "FY25-26", "/2025")
 *  - everything except letters and digits removed
 *  - leading zeros dropped from every digit run
 */
const FY = /(?:FY\s*)?(?<!\d)(?:20)?(\d{2})\s*[-/]\s*(?:20)?(\d{2})(?!\d)/gi;
/** Removes "25-26" / "2025-26" / "FY 2025-2026" only when the two years are consecutive. */
const stripFy = (s: string) => s.replace(FY, (m, a: string, b: string) => ((Number(a) + 1) % 100 === Number(b) ? ' ' : m));

export function normaliseDocNo(no: string): string {
  const s = stripFy(String(no ?? '').toUpperCase());
  return s.replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (d) => String(Number(d.length > 15 ? d.slice(-15) : d)));
}

/** Digits only, without leading zeros – the "core" serial number for fuzzy matching. */
export function numericCore(no: string): string {
  const d = stripFy(String(no ?? '').toUpperCase()).replace(/\D/g, '');
  return d.replace(/^0+/, '');
}

export const docKey = (source: PurchaseSource, gstin: string, type: PurchaseDocType, docNo: string) =>
  `${source}|${gstin.toUpperCase()}|${type}|${normaliseDocNo(docNo)}`;

/** Match key without the source – the same invoice in books and portal shares it. */
export const matchKey = (d: Pick<PurchaseDoc, 'supplierGstin' | 'docType' | 'docNo'>) => `${d.supplierGstin.toUpperCase()}|${d.docType}|${normaliseDocNo(d.docNo)}`;

export const panOf = (gstin: string) => (gstin.length === 15 ? gstin.slice(2, 12).toUpperCase() : '');

/** Levenshtein distance, capped (returns cap+1 when larger) – for 1–2 character typos. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

export const totalTax = (d: Pick<PurchaseDoc, 'igst' | 'cgst' | 'sgst' | 'cess'>) => d.igst + d.cgst + d.sgst + d.cess;

export function daysBetween(a: string, b: string): number {
  if (!a || !b) return Infinity;
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}
