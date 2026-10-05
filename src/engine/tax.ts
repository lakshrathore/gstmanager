import type { AnyRecord, Item } from './types';
import { computeTax, type TaxOptions } from './util';

/** Recomputes IGST/CGST/SGST on every item of a record from rate × taxable value (used after edits). */
export function recomputeRecordTax(rec: AnyRecord, supplierGstin: string): AnyRecord {
  const st = supplierGstin.slice(0, 2);
  const apply = (it: Item, base: number | null, o: Omit<TaxOptions, 'supplierState'>) => {
    if (it.rt == null || base == null) return it;
    return { ...it, ...computeTax(it.rt, base, { ...o, supplierState: st }) };
  };
  const r = structuredClone(rec);
  switch (r.section) {
    case 'b2b':
    case 'cdnr': {
      const d = r.data;
      const o = { pos: d.pos, diffPercent: d.diffPercent, forceIgst: ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp), noTax: d.invTyp === 'SEWOP' };
      d.items = d.items.map((it) => apply(it, it.txval, o));
      break;
    }
    case 'b2cl':
      r.data.items = r.data.items.map((it) => apply(it, it.txval, { pos: r.data.pos, diffPercent: r.data.diffPercent, forceIgst: true }));
      break;
    case 'cdnur':
      r.data.items = r.data.items.map((it) => apply(it, it.txval, { pos: r.data.pos || '96', diffPercent: r.data.diffPercent, forceIgst: true, noTax: r.data.urType === 'EXPWOP' }));
      break;
    case 'exp':
      r.data.items = r.data.items.map((it) => apply(it, it.txval, { pos: '96', forceIgst: true, noTax: r.data.expTyp === 'WOPAY' }));
      break;
    case 'b2cs':
      Object.assign(r.data, apply(r.data, r.data.txval, { pos: r.data.pos, diffPercent: r.data.diffPercent }));
      break;
    case 'at':
    case 'txpd':
      r.data.items = r.data.items.map((it) =>
        it.rt == null || it.adAmt == null ? it : { ...it, ...computeTax(it.rt, it.adAmt, { pos: r.data.pos, supplierState: st, diffPercent: r.data.diffPercent }) },
      );
      break;
    default:
      break;
  }
  return r;
}

/** Natural key for document-type records; keeps keys in sync when a user edits GSTIN or document number. */
export function naturalKey(rec: AnyRecord): string | null {
  switch (rec.section) {
    case 'b2b': return `b2b|${String(rec.data.ctin ?? "").toUpperCase()}|${String(rec.data.inum ?? "").toUpperCase()}`;
    case 'cdnr': return `cdnr|${String(rec.data.ctin ?? "").toUpperCase()}|${String(rec.data.ntNum ?? "").toUpperCase()}`;
    case 'b2cl': return `b2cl|${String(rec.data.inum ?? "").toUpperCase()}`;
    case 'exp': return `exp|${String(rec.data.inum ?? "").toUpperCase()}`;
    case 'cdnur': return `cdnur|${String(rec.data.ntNum ?? "").toUpperCase()}`;
    default: return null;
  }
}
