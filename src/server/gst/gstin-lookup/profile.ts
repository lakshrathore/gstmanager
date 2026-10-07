/**
 * GSTN public taxpayer record → the fields shown in the GSTIN validator. Pure (unit-tested).
 * Sandbox "Search GSTIN" and the GST portal "Search Taxpayer" both return GSTN's public record
 * (lgnm, tradeNam, sts, rgdt, …); the address is an object (pradr.addr) or a single line (pradr.adr).
 */
export interface TaxpayerProfile {
  gstin: string;
  legalName?: string;
  tradeName?: string;
  mobile?: string;
  status?: string;
  registrationDate?: string;
  cancellationDate?: string;
  taxpayerType?: string;
  constitution?: string;
  address?: string;
  natureOfBusiness?: string[];
  stateJurisdiction?: string;
  centreJurisdiction?: string;
  einvoice?: string;
  lastUpdated?: string;
}

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function normalizePhone(v: unknown): string | undefined {
  const text = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : undefined;
  if (!text) return undefined;
  const cleaned = text.replace(/[\s()\-]/g, '').replace(/\+/g, '+');
  return cleaned.length >= 8 && /^\+?[0-9]+$/.test(cleaned) ? cleaned : undefined;
}

function mobile(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = mobile(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof raw === 'string' || typeof raw === 'number') return normalizePhone(raw);
  if (typeof raw !== 'object') return undefined;
  for (const [key, value] of Object.entries(raw as J)) {
    if (/(mobile|mb|mob|phone|contact|tel)/i.test(key)) {
      const found = mobile(value);
      if (found) return found;
    }
  }
  return undefined;
}

function address(pradr: unknown): string | undefined {
  if (!pradr || typeof pradr !== 'object') return undefined;
  const p = pradr as J;
  if (s(p.adr)) return s(p.adr);
  const a = (p.addr && typeof p.addr === 'object' ? p.addr : null) as J | null;
  if (!a) return undefined;
  const parts = [a.flno, a.bno, a.bnm, a.st, a.locality, a.loc, a.dst, a.stcd, a.pncd].map(s).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : undefined;
}

/** Returns null when the record has no GSTIN/legal name (i.e. it is not a taxpayer record). */
export function toTaxpayerProfile(raw: unknown, fallbackGstin = ''): TaxpayerProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as J;
  const legalName = s(r.lgnm);
  const gstin = s(r.gstin) ?? fallbackGstin;
  if (!legalName && !s(r.sts)) return null;
  return {
    gstin, legalName, tradeName: s(r.tradeNam), mobile: mobile(r), status: s(r.sts), registrationDate: s(r.rgdt), cancellationDate: s(r.cxdt),
    taxpayerType: s(r.dty), constitution: s(r.ctb), address: address(r.pradr),
    natureOfBusiness: Array.isArray(r.nba) ? r.nba.map(s).filter((x): x is string => !!x) : undefined,
    stateJurisdiction: s(r.stj), centreJurisdiction: s(r.ctj), einvoice: s(r.einvoiceStatus), lastUpdated: s(r.lstupdt),
  };
}
