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
  sections: Record<string, { documents: number; taxableValue: number; tax: number; igst?: number; cgst?: number; sgst?: number; cess?: number }>;
  generatedAt: string;
  /** For the on-screen summary only: Table 12 by side and Table 13 counts (not compared with GSTN). */
  detail?: {
    hsnB2b?: GenerationLog['sections'][string]; hsnB2c?: GenerationLog['sections'][string];
    docs?: { series: number; issued: number; cancelled: number; net: number };
  };
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
      igst: round2(items.reduce((a, i) => a + n(i.iamt), 0)), cgst: round2(items.reduce((a, i) => a + n(i.camt), 0)),
      sgst: round2(items.reduce((a, i) => a + n(i.samt), 0)), cess: round2(items.reduce((a, i) => a + n(i.csamt), 0)),
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
    // The same POS/rate/type/e-commerce GSTIN can come from several sources (Excel, manual entry,
    // each marketplace report). The portal wants one row per combination, so they are summed here.
    const merged = [...bucket(b2cs, (r) => `${r.data.pos}|${r.data.typ}|${r.data.etin ?? ''}|${r.data.rt}|${r.data.diffPercent ?? ''}`).values()].map((rs) => {
      const d = rs.reduce((a, { data: x }) => ({
        ...a, txval: (a.txval ?? 0) + (x.txval ?? 0), iamt: (a.iamt ?? 0) + (x.iamt ?? 0), camt: (a.camt ?? 0) + (x.camt ?? 0),
        samt: (a.samt ?? 0) + (x.samt ?? 0), csamt: (a.csamt ?? 0) + (x.csamt ?? 0),
      }), { ...rs[0].data, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
      return d;
    });
    out.b2cs = merged.map((d) => {
      const inter = d.pos !== st;
      return {
        sply_ty: sply(st, d.pos), pos: d.pos, typ: d.typ, ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent),
        rt: d.rt ?? 0, txval: n(d.txval), ...taxHeads(d, inter),
      };
    });
    tally('b2cs', merged.length, merged);
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

  /* ---------- amendments (9A, 9C, 10, 11) ---------- */
  const b2ba = of(records, 'b2ba');
  if (b2ba.length) {
    out.b2ba = [...bucket(b2ba, (r) => r.data.ctin)].map(([ctin, rs]) => ({
      ctin,
      inv: rs.map(({ data: d }) => {
        const inter = ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp) || d.pos !== st;
        return {
          oinum: d.oinum, oidt: toPortalDate(d.oidt), inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val), pos: d.pos, rchrg: d.rchrg,
          ...(d.etin ? { etin: d.etin } : {}), inv_typ: d.invTyp, ...diff(d.diffPercent), itms: itms(d.items, inter),
        };
      }),
    }));
    tally('b2ba', b2ba.length, b2ba.flatMap((r) => r.data.items));
  }
  const b2cla = of(records, 'b2cla');
  if (b2cla.length) {
    out.b2cla = [...bucket(b2cla, (r) => r.data.pos)].map(([pos, rs]) => ({
      pos,
      inv: rs.map(({ data: d }) => ({
        oinum: d.oinum, oidt: toPortalDate(d.oidt), inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val),
        ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent), itms: itms(d.items, true),
      })),
    }));
    tally('b2cla', b2cla.length, b2cla.flatMap((r) => r.data.items));
  }
  const expa = of(records, 'expa');
  if (expa.length) {
    out.expa = [...bucket(expa, (r) => r.data.expTyp)].map(([exp_typ, rs]) => ({
      exp_typ,
      inv: rs.map(({ data: d }) => ({
        oinum: d.oinum, oidt: toPortalDate(d.oidt), inum: d.inum, idt: toPortalDate(d.idt), val: n(d.val),
        ...(d.portCode ? { sbpcode: d.portCode } : {}), ...(d.sbNum ? { sbnum: d.sbNum } : {}), ...(d.sbDt ? { sbdt: toPortalDate(d.sbDt) } : {}),
        itms: d.items.map((it) => ({ txval: n(it.txval), rt: it.rt ?? 0, iamt: n(it.iamt), csamt: n(it.csamt) })),
      })),
    }));
    tally('expa', expa.length, expa.flatMap((r) => r.data.items));
  }
  const cdnra = of(records, 'cdnra');
  if (cdnra.length) {
    out.cdnra = [...bucket(cdnra, (r) => r.data.ctin)].map(([ctin, rs]) => ({
      ctin,
      nt: rs.map(({ data: d }) => {
        const inter = ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp) || d.pos !== st;
        return {
          ont_num: d.ontNum, ont_dt: toPortalDate(d.ontDt), ntty: d.ntty, nt_num: d.ntNum, nt_dt: toPortalDate(d.ntDt), val: n(d.val),
          pos: d.pos, rchrg: d.rchrg, inv_typ: d.invTyp, ...diff(d.diffPercent), itms: itms(d.items, inter),
        };
      }),
    }));
    tally('cdnra', cdnra.length, cdnra.flatMap((r) => r.data.items));
  }
  const cdnura = of(records, 'cdnura');
  if (cdnura.length) {
    out.cdnura = cdnura.map(({ data: d }) => ({
      typ: d.urType, ont_num: d.ontNum, ont_dt: toPortalDate(d.ontDt), ntty: d.ntty, nt_num: d.ntNum, nt_dt: toPortalDate(d.ntDt), val: n(d.val),
      ...(d.urType === 'B2CL' && d.pos ? { pos: d.pos } : {}), ...(d.urType === 'B2CL' ? diff(d.diffPercent) : {}), itms: itms(d.items, true),
    }));
    tally('cdnura', cdnura.length, cdnura.flatMap((r) => r.data.items));
  }
  const b2csa = of(records, 'b2csa');
  if (b2csa.length) {
    // One object per original month + POS + type (+ ECO GSTIN), holding every rate.
    out.b2csa = [...bucket(b2csa, (r) => `${r.data.omon}|${r.data.pos}|${r.data.typ}|${r.data.etin ?? ''}|${r.data.diffPercent ?? ''}`).values()].map((rs) => {
      const d = rs[0].data;
      const inter = d.pos !== st;
      const byRate = [...bucket(rs, (r) => String(r.data.rt)).values()].map((g) => g.reduce((a, { data: x }) => ({
        rt: x.rt ?? 0, txval: a.txval + (x.txval ?? 0), iamt: a.iamt + (x.iamt ?? 0), camt: a.camt + (x.camt ?? 0), samt: a.samt + (x.samt ?? 0), csamt: a.csamt + (x.csamt ?? 0),
      }), { rt: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }));
      return {
        omon: d.omon, pos: d.pos, sply_ty: sply(st, d.pos), typ: d.typ, ...(d.etin ? { etin: d.etin } : {}), ...diff(d.diffPercent),
        itms: byRate.map((it) => ({ rt: it.rt, txval: n(it.txval), ...taxHeads(it, inter) })),
      };
    });
    tally('b2csa', b2csa.length, b2csa.map((r) => r.data));
  }
  for (const s of ['ata', 'txpda'] as const) {
    const rs = of(records, s);
    if (!rs.length) continue;
    out[s] = rs.map(({ data: d }) => {
      const inter = d.pos !== st;
      return {
        omon: d.omon, pos: d.pos, sply_ty: sply(st, d.pos), ...diff(d.diffPercent),
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
  /** One line per HSN + UQC + rate, summed across sources (see b2cs above). */
  const mergeHsn = <S extends 'hsn_b2b' | 'hsn_b2c'>(rs: Gstr1Record<S>[]) =>
    [...bucket(rs, (r) => `${r.data.hsn}|${r.data.uqc}|${r.data.rt}`).values()].map((g) => g.length === 1 ? g[0] : {
      ...g[0],
      data: g.slice(1).reduce((a, { data: x }) => ({
        ...a, qty: (a.qty ?? 0) + (x.qty ?? 0), txval: (a.txval ?? 0) + (x.txval ?? 0), iamt: (a.iamt ?? 0) + (x.iamt ?? 0),
        camt: (a.camt ?? 0) + (x.camt ?? 0), samt: (a.samt ?? 0) + (x.samt ?? 0), csamt: (a.csamt ?? 0) + (x.csamt ?? 0),
      }), { ...g[0].data }),
    });
  const hb2b = mergeHsn(of(records, 'hsn_b2b')), hb2c = mergeHsn(of(records, 'hsn_b2c'));
  if (hb2b.length || hb2c.length) {
    out.hsn = ctx.profile.hsnSplit
      ? { ...(hb2b.length ? { hsn_b2b: hb2b.map(hsnRow) } : {}), ...(hb2c.length ? { hsn_b2c: hb2c.map(hsnRow) } : {}) }
      : { data: [...hb2b, ...hb2c].map(hsnRow) };
    log.detail = {};
    if (ctx.profile.hsnSplit) {
      for (const [k, rs] of [['hsnB2b', hb2b], ['hsnB2c', hb2c]] as const) {
        if (!rs.length) continue;
        tally('_', rs.length, rs.map((r) => r.data));
        log.detail[k] = log.sections._;
        delete log.sections._;
      }
    }
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
    const issued = docs.reduce((a, r) => a + (r.data.totnum ?? 0), 0), cancelled = docs.reduce((a, r) => a + (r.data.cancel ?? 0), 0);
    log.detail = { ...log.detail, docs: { series: docs.length, issued, cancelled, net: issued - cancelled } };
  }

  return { json: out, log };
}
