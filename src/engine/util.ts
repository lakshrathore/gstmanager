import { STATE_CODES } from './masters';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Mod-36 check digit used by GSTIN/UIN. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return '?';
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck = { ok: true; kind: 'regular' | 'special' } | { ok: false; reason: string };

export function checkGstin(raw: string | undefined | null): GstinCheck {
  const g = (raw ?? '').trim().toUpperCase();
  if (!g) return { ok: false, reason: 'GSTIN is empty' };
  if (g.length !== 15) return { ok: false, reason: `GSTIN must be 15 characters (found ${g.length})` };
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(g)) return { ok: false, reason: 'GSTIN has invalid characters' };
  if (!STATE_CODES[g.slice(0, 2)] || g.startsWith('96')) return { ok: false, reason: `Invalid state code ${g.slice(0, 2)}` };
  if (gstinCheckDigit(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'GSTIN check digit is wrong (likely a typo)' };
  const regular = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
  return { ok: true, kind: regular ? 'regular' : 'special' };
}

/** 4th character of a PAN → holder type. */
const PAN_HOLDER: Record<string, string> = {
  P: 'Individual', C: 'Company', H: 'Hindu Undivided Family', F: 'Firm', E: 'Limited Liability Partnership',
  A: 'Association of Persons', B: 'Body of Individuals', T: 'Trust', L: 'Local authority',
  J: 'Artificial juridical person', G: 'Government',
};

export interface GstinParts {
  gstin: string;
  ok: boolean;
  reason?: string;
  stateCode?: string;
  stateName?: string;
  /** PAN (or TAN for tax deductors) embedded in characters 3–12. */
  pan?: string;
  panHolder?: string;
  /** 13th character: registration number for the same PAN in the state (1–9, then A–Z). */
  entityNo?: string;
  registrationType?: string;
}

/** Offline breakdown of a GSTIN: checksum, state, PAN, entity number and registration type. */
export function describeGstin(raw: string | undefined | null): GstinParts {
  const g = (raw ?? '').trim().toUpperCase();
  const c = checkGstin(g);
  const out: GstinParts = { gstin: g, ok: c.ok, reason: c.ok ? undefined : c.reason };
  if (STATE_CODES[g.slice(0, 2)]) {
    out.stateCode = g.slice(0, 2);
    out.stateName = STATE_CODES[g.slice(0, 2)];
  }
  if (g.length !== 15) return out;
  out.entityNo = g[12];
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) {
    out.registrationType = 'Normal taxpayer';
  } else if (/^\d{2}[A-Z]{4}\d{5}[A-Z][1-9A-Z]D[0-9A-Z]$/.test(g)) {
    out.registrationType = 'Tax deductor (TDS)';
  } else if (/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]C[0-9A-Z]$/.test(g)) {
    out.registrationType = 'Tax collector (TCS / e-commerce operator)';
  } else {
    out.registrationType = 'Special registration (UIN / NRTP / OIDAR / other)';
  }
  if (out.registrationType !== 'Special registration (UIN / NRTP / OIDAR / other)') {
    out.pan = g.slice(2, 12);
    out.panHolder = out.registrationType === 'Tax deductor (TDS)' ? 'TAN holder' : PAN_HOLDER[g[5]] ?? 'Unknown PAN type';
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parses Excel/date-ish input into ISO yyyy-mm-dd. Returns null when it cannot be parsed. */
export function parseDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date (1900 system)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

export const isIsoDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** ISO → portal "dd-mm-yyyy" */
export function toPortalDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

/** "29-Karnataka" | "29" | 29 → "29" */
export function parsePos(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})/);
  return m ? m[1].padStart(2, '0') : s;
}

export function parseNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/₹/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

export function parseYN(v: unknown): 'Y' | 'N' {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'Y' || s === 'YES' ? 'Y' : 'N';
}

/** Return period bounds (inclusive, ISO) for MMYYYY; quarterly covers the 3 months ending fp. */
export function periodBounds(fp: string, quarterly = false): { start: string; end: string } {
  const m = Number(fp.slice(0, 2));
  const y = Number(fp.slice(2));
  const end = new Date(Date.UTC(y, m, 0));
  const start = new Date(Date.UTC(y, m - (quarterly ? 3 : 1), 1));
  const f = (d: Date) => d.toISOString().slice(0, 10);
  return { start: f(start), end: f(end) };
}

/** Financial year label (e.g. "2025-26") for an ISO date. */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export interface TaxOptions {
  supplierState: string;
  pos: string;
  /** Always IGST (SEZ, exports, "Intra-State supplies attracting IGST"). */
  forceIgst?: boolean;
  /** No tax payable (SEZ/export without payment). */
  noTax?: boolean;
  /** 65 when "Applicable % of Tax Rate" is set. */
  diffPercent?: number | null;
}

export function computeTax(rt: number, base: number, o: TaxOptions) {
  if (o.noTax) return { iamt: 0, camt: 0, samt: 0 };
  const factor = o.diffPercent ? o.diffPercent / 100 : 1;
  const tax = (base * rt * factor) / 100;
  const inter = o.forceIgst || o.pos !== o.supplierState;
  if (inter) return { iamt: round2(tax), camt: 0, samt: 0 };
  const half = round2(tax / 2);
  return { iamt: 0, camt: half, samt: half };
}

export const isInterState = (supplierState: string, pos: string) => supplierState !== pos;

export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
