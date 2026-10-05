import { DOC_TYPES } from '../masters';
import type { AdvanceItem, AnyRecord, Gstr1Record, Item, ReturnContext, Section } from '../types';
import { round2, toPortalDate } from '../util';

/**
 * Converts validated internal records into GSTR-1 upload JSON.
 * Pure function of (records, context) – no Excel or DB knowledge – so it can be unit tested
 * and swapped per format profile.
 */

type Json = Record<string, unknown>;

const n = (v: number | null | undefined) => round2(v ?? 0);
const sply = (supplierState: string, pos: string) => (supplierState === pos ? 'INTRA' : 'INTER');
const diff = (d: number | null | undefined) => (d ? { diff_percent: d / 100 } : {});

function taxHeads(it: { iamt: number | null; camt: number | null; samt: number | null; csamt: number | null }, inter: boolean) {
  return inter
    ? { iamt: n(it.iamt), csamt: n(it.csamt) }
    : { camt: n(it.camt), samt: n(it.samt), csamt: n(it.csamt) };
}

/** Item serial used by the offline tool: rate × 100 + 1 (e.g. 18% → 1801). */
const itemNum = (rt: number | null, idx: number) => (rt != null ? Math.round(rt * 100) + 1 : idx + 1);

function itms(items: Item[], inter: boolean) {
  return items.map((it, idx) => ({
    num: itemNum(it.rt, idx),
    itm_det: { txval: n(it.txval), rt: it.rt ?? 0, ...taxHeads(it, inter) },
  }));
}

function bucket<T, K extends string>(arr: T[], key: (t: T) => K) {
  const m = new Map<K, T[]>();
  for (const t of arr) {
    const k = key(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t);
  }
  return m;
}

const of = <S extends Section>(records: AnyRecord[], s: S) => records.filter((r) => r.section === s) as unknown as Gstr1Record<S>[];

export interface GenerationLog {
  version: string;
  profile: string;
  sections: Record<string, { documents: number; taxableValue: number; tax: number }>;
  generatedAt: string;
}

export function generateGstr1Json(records: AnyRecord[], ctx: ReturnContext): { json: Json; log: GenerationLog } {
  const st = ctx.supplierGstin.slice(0, 2);
  const out: Json = { gstin: ctx.supplierGstin, fp: ctx.fp, version: ctx.profile.jsonVersion, hash: 'hash' };
  const log: GenerationLog = { version: ctx.profile.jsonVersion, profile: ctx.profile.id, sections: {}, generatedAt: new Date().toISOString() };
  const tally = (s: string, docs: number, items: { txval?: number | null; adAmt?: number | null; iamt: number | null; camt: number | null; samt: number | null; csamt: number | null }[]) => {
    log.sections[s] = {
      documents: docs,
      taxableValue: round2(items.reduce((a, i) => a + (i.txval ?? i.adAmt ?? 0), 0)),
      tax: round2(items.reduce((a, i) => a + n(i.iamt) + n(i.camt) + n(i.samt) + n(i.csamt), 0)),
    };
  };

  const b2b = of(records, 'b2b');
  if (b2b.length) {
    out.b2b = [...bucket(b2b, (r) => r.data.ctin)].map(([ctin, rs]) => ({
      ctin,
      inv: rs.map(({ data: d }) => {
        const inter = ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp) || d.pos !== st;
        return {
          inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val), pos: d.pos, rchrg: d.rchrg, inv_typ: d.invTyp,
          ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent), itms: itms(d.items, inter),
        };
      }),
    }));
    tally('b2b', b2b.length, b2b.flatMap((r) => r.data.items));
  }

  const b2cl = of(records, 'b2cl');
  if (b2cl.length) {
    out.b2cl = [...bucket(b2cl, (r) => r.data.pos)].map(([pos, rs]) => ({
      pos,
      inv: rs.map(({ data: d }) => ({
        inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val), ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent),
        itms: itms(d.items, true),
      })),
    }));
    tally('b2cl', b2cl.length, b2cl.flatMap((r) => r.data.items));
  }

  const exp = of(records, 'exp');
  if (exp.length) {
    out.exp = [...bucket(exp, (r) => r.data.expTyp)].map(([exp_typ, rs]) => ({
      exp_typ,
      inv: rs.map(({ data: d }) => ({
        inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val),
        ...(d.portCode ? { sbpcode: d.portCode } : {}), ...(d.sbNum ? { sbnum: d.sbNum } : {}),
        ...(d.sbDt ? { sbdt: toPortalDate(d.sbDt) } : {}),
        itms: d.items.map((it) => ({ txval: n(it.txval), rt: it.rt ?? 0, iamt: n(it.iamt), csamt: n(it.csamt) })),
      })),
    }));
    tally('exp', exp.length, exp.flatMap((r) => r.data.items));
  }

  const b2cs = of(records, 'b2cs');
  if (b2cs.length) {
    out.b2cs = b2cs.map(({ data: d }) => {
      const inter = d.pos !== st;
      return {
        sply_ty: sply(st, d.pos), pos: d.pos, typ: d.typ, ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent),
        rt: d.rt ?? 0, txval: n(d.txval), ...taxHeads(d, inter),
      };
    });
    tally('b2cs', b2cs.length, b2cs.map((r) => r.data));
  }

  const cdnr = of(records, 'cdnr');
  if (cdnr.length) {
    out.cdnr = [...bucket(cdnr, (r) => r.data.ctin)].map(([ctin, rs]) => ({
      ctin,
      nt: rs.map(({ data: d }) => {
        const inter = ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp) || d.pos !== st;
        return {
          ntty: d.ntty, nt_num: d.ntNum, nt_dt: toPortalDate(d.ntDt), val: n(d.val), pos: d.pos, rchrg: d.rchrg,
          inv_typ: d.invTyp, ...diff(d.diffPercent), itms: itms(d.items, inter),
        };
      }),
    }));
    tally('cdnr', cdnr.length, cdnr.flatMap((r) => r.data.items));
  }

  const cdnur = of(records, 'cdnur');
  if (cdnur.length) {
    out.cdnur = cdnur.map(({ data: d }) => ({
      typ: d.urType, ntty: d.ntty, nt_num: d.ntNum, nt_dt: toPortalDate(d.ntDt), val: n(d.val),
      ...(d.urType === 'B2CL' && d.pos ? { pos: d.pos } : {}), ...diff(d.diffPercent), itms: itms(d.items, true),
    }));
    tally('cdnur', cdnur.length, cdnur.flatMap((r) => r.data.items));
  }

  for (const s of ['at', 'txpd'] as const) {
    const rs = of(records, s);
    if (!rs.length) continue;
    out[s] = rs.map(({ data: d }) => {
      const inter = d.pos !== st;
      return {
        pos: d.pos, sply_ty: sply(st, d.pos), ...diff(d.diffPercent),
        itms: d.items.map((it: AdvanceItem) => ({ rt: it.rt ?? 0, ad_amt: n(it.adAmt), ...taxHeads(it, inter) })),
      };
    });
    tally(s, rs.length, rs.flatMap((r) => r.data.items));
  }

  const nil = of(records, 'nil');
  if (nil.length) {
    out.nil = {
      inv: nil.map(({ data: d }) => ({ sply_ty: d.splyTy, expt_amt: n(d.exptAmt), nil_amt: n(d.nilAmt), ngsup_amt: n(d.ngsupAmt) })),
    };
    log.sections.nil = { documents: nil.length, taxableValue: round2(nil.reduce((a, r) => a + n(r.data.nilAmt) + n(r.data.exptAmt) + n(r.data.ngsupAmt), 0)), tax: 0 };
  }

  const hsnRow = (r: Gstr1Record<'hsn_b2b' | 'hsn_b2c'>, i: number) => ({
    num: i + 1, hsn_sc: r.data.hsn, ...(r.data.desc ? { desc: r.data.desc.slice(0, 30) } : {}), uqc: r.data.uqc,
    qty: n(r.data.qty), rt: r.data.rt ?? 0, txval: n(r.data.txval), iamt: n(r.data.iamt), camt: n(r.data.camt),
    samt: n(r.data.samt), csamt: n(r.data.csamt),
  });
  const hb2b = of(records, 'hsn_b2b'), hb2c = of(records, 'hsn_b2c');
  if (hb2b.length || hb2c.length) {
    out.hsn = ctx.profile.hsnSplit
      ? { ...(hb2b.length ? { hsn_b2b: hb2b.map(hsnRow) } : {}), ...(hb2c.length ? { hsn_b2c: hb2c.map(hsnRow) } : {}) }
      : { data: [...hb2b, ...hb2c].map(hsnRow) };
    tally('hsn', hb2b.length + hb2c.length, [...hb2b, ...hb2c].map((r) => r.data));
  }

  const docs = of(records, 'docs');
  if (docs.length) {
    out.doc_issue = {
      doc_det: [...bucket(docs, (r) => r.data.docTyp)].map(([docTyp, rs]) => ({
        doc_num: DOC_TYPES[docTyp],
        doc_typ: docTyp,
        docs: rs.map(({ data: d }, i) => ({
          num: i + 1, from: d.from, to: d.to, totnum: d.totnum ?? 0, cancel: d.cancel ?? 0,
          net_issue: (d.totnum ?? 0) - (d.cancel ?? 0),
        })),
      })),
    };
    log.sections.doc_issue = { documents: docs.length, taxableValue: 0, tax: 0 };
  }

  return { json: out, log };
}
