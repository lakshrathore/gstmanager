/**
 * Format/version configuration. When GSTN changes the GSTR-1 format, add a new profile here
 * (with its effective-from period) instead of editing generator/validator code.
 *
 * VERIFY each value against the current GST Offline Tool release notes before production use.
 */

export interface FormatProfile {
  id: string;
  /** Value written into the JSON `version` field. */
  jsonVersion: string;
  /** First return period (YYYYMM, as a number for comparison) this profile applies to. */
  effectiveFrom: number;
  /** Table 12 split into hsn_b2b / hsn_b2c. */
  hsnSplit: boolean;
  /** Inter-state B2C invoices above this value go to B2CL (Table 5). */
  b2clThreshold: number;
  /** GST rates accepted in item rows. */
  allowedRates: number[];
  /** Minimum HSN digits by AATO band. */
  hsnDigits: { upTo5Cr: number; above5Cr: number };
}

const COMMON_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

export const FORMAT_PROFILES: FormatProfile[] = [
  {
    id: 'legacy-2024',
    jsonVersion: 'GST3.1.6',
    effectiveFrom: 202304,
    hsnSplit: false,
    b2clThreshold: 250000,
    allowedRates: COMMON_RATES,
    hsnDigits: { upTo5Cr: 4, above5Cr: 6 },
  },
  {
    id: 'b2cl-1lakh-2024-08',
    jsonVersion: 'GST3.1.8',
    effectiveFrom: 202408,
    hsnSplit: false,
    b2clThreshold: 100000,
    allowedRates: COMMON_RATES,
    hsnDigits: { upTo5Cr: 4, above5Cr: 6 },
  },
  {
    id: 'hsn-split-2025-05',
    jsonVersion: 'GST3.2.2',
    effectiveFrom: 202505,
    hsnSplit: true,
    b2clThreshold: 100000,
    allowedRates: COMMON_RATES,
    hsnDigits: { upTo5Cr: 4, above5Cr: 6 },
  },
  {
    id: 'gst-2-rates-2025-09',
    jsonVersion: 'GST3.2.2',
    effectiveFrom: 202509,
    hsnSplit: true,
    b2clThreshold: 100000,
    allowedRates: [...COMMON_RATES, 40],
    hsnDigits: { upTo5Cr: 4, above5Cr: 6 },
  },
];

/** fp = "MMYYYY" → profile in force for that period. */
export function profileForPeriod(fp: string): FormatProfile {
  const key = periodKey(fp);
  const sorted = [...FORMAT_PROFILES].sort((a, b) => b.effectiveFrom - a.effectiveFrom);
  return sorted.find((p) => key >= p.effectiveFrom) ?? sorted[sorted.length - 1];
}

/** "042025" → 202504 */
export function periodKey(fp: string): number {
  return Number(fp.slice(2, 6)) * 100 + Number(fp.slice(0, 2));
}
