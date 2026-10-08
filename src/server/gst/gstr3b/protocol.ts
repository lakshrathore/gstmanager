/**
 * GSTR-3B: pure helpers (no I/O, no server-only imports – unit-tested and shared with the browser).
 * Shapes follow GSTN's GSTR-3B JSON as exposed by the Sandbox.co.in GST Compliance API:
 * Get GSTR-3B Details, Liability Auto Calc, Save GSTR-3B, Cash ITC Balance, Offset Liability and File GSTR-3B.
 */

export type Head = 'iamt' | 'camt' | 'samt' | 'csamt';
export const HEADS: Head[] = ['iamt', 'camt', 'samt', 'csamt'];
export const HEAD_LABEL: Record<Head, string> = { iamt: 'IGST', camt: 'CGST', samt: 'SGST/UTGST', csamt: 'Cess' };

export interface Amt { txval?: number; iamt?: number; camt?: number; samt?: number; csamt?: number }
export interface PosRow { pos: string; txval: number; iamt: number }
export interface ItcRow { ty: string; iamt: number; camt: number; samt: number; csamt: number }
export interface InwardRow { ty: 'GST' | 'NONGST'; inter: number; intra: number }

/** The tables a taxpayer fills in GSTR-3B (itc_net is always derived from avl − rev). */
export interface Gstr3bForm {
  sup_details: { osup_det: Amt; osup_zero: Amt; osup_nil_exmp: Amt; isup_rev: Amt; osup_nongst: Amt };
  eco_dtls: { eco_sup: Amt; eco_reg_sup: Amt };
  inter_sup: { unreg_details: PosRow[]; comp_details: PosRow[]; uin_details: PosRow[] };
  itc_elg: { itc_avl: ItcRow[]; itc_rev: ItcRow[]; itc_inelg: ItcRow[] };
  inward_sup: { isup_details: InwardRow[] };
  intr_ltfee: { intr_details: Amt; ltfee_details: Amt };
}

type AmtField = keyof Amt;
/** Amount columns of each table, as on the GST portal and in GSTN's save schema. */
export const FIELDS = {
  osup_det: ['txval', 'iamt', 'camt', 'samt', 'csamt'],
  osup_zero: ['txval', 'iamt', 'csamt'],
  osup_nil_exmp: ['txval'],
  isup_rev: ['txval', 'iamt', 'camt', 'samt', 'csamt'],
  osup_nongst: ['txval'],
  eco_sup: ['txval', 'iamt', 'camt', 'samt', 'csamt'],
  eco_reg_sup: ['txval'],
  intr_details: ['iamt', 'camt', 'samt', 'csamt'],
  ltfee_details: ['iamt', 'camt', 'samt', 'csamt'],
} as const satisfies Record<string, readonly AmtField[]>;

export const ITC_AVL_TYPES = ['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH'] as const;
export const ITC_REV_TYPES = ['RUL', 'OTH'] as const;
export const ITC_LABEL: Record<string, string> = {
  IMPG: '(1) Import of goods', IMPS: '(2) Import of services', ISRC: '(3) Inward supplies liable to reverse charge',
  ISD: '(4) Inward supplies from ISD', OTH: '(5) All other ITC',
};

/** Rounds to paise; anything that is not a finite number becomes 0. */
export const r2 = (n: unknown) => {
  const v = typeof n === 'string' ? Number(n) : n;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function amt(src: unknown, fields: readonly AmtField[]): Amt {
  const o = obj(src);
  return Object.fromEntries(fields.map((f) => [f, r2(o[f])])) as Amt;
}

const posRows = (src: unknown): PosRow[] =>
  arr(src)
    .map((r) => obj(r))
    .map((r) => ({ pos: String(r.pos ?? '').padStart(2, '0').slice(-2), txval: r2(r.txval), iamt: r2(r.iamt) }))
    .filter((r) => /^\d{2}$/.test(r.pos) && r.pos !== '00' && (r.txval || r.iamt));

function itcRows(src: unknown, types: readonly string[]): ItcRow[] {
  const byTy = new Map(arr(src).map((r) => obj(r)).map((r) => [String(r.ty ?? ''), r]));
  return types.map((ty) => ({ ty, ...(amt(byTy.get(ty), HEADS) as Required<Pick<Amt, Head>>) }));
}

export function blankForm(): Gstr3bForm {
  return normalizeForm({});
}

/**
 * Any GSTR-3B-shaped object (GSTN's Get Details response, a saved draft, the browser's edits) → a
 * complete form with every table present, amounts rounded to paise, and nothing GSTN would reject.
 */
export function normalizeForm(src: unknown): Gstr3bForm {
  const s = obj(src);
  const sup = obj(s.sup_details);
  const eco = obj(s.eco_dtls);
  const inter = obj(s.inter_sup);
  const itc = obj(s.itc_elg);
  const inward = obj(s.inward_sup);
  const fee = obj(s.intr_ltfee);
  const inwardBy = new Map(arr(inward.isup_details).map((r) => obj(r)).map((r) => [String(r.ty ?? ''), r]));
  return {
    sup_details: {
      osup_det: amt(sup.osup_det, FIELDS.osup_det),
      osup_zero: amt(sup.osup_zero, FIELDS.osup_zero),
      osup_nil_exmp: amt(sup.osup_nil_exmp, FIELDS.osup_nil_exmp),
      isup_rev: amt(sup.isup_rev, FIELDS.isup_rev),
      osup_nongst: amt(sup.osup_nongst, FIELDS.osup_nongst),
    },
    eco_dtls: { eco_sup: amt(eco.eco_sup, FIELDS.eco_sup), eco_reg_sup: amt(eco.eco_reg_sup, FIELDS.eco_reg_sup) },
    inter_sup: { unreg_details: posRows(inter.unreg_details), comp_details: posRows(inter.comp_details), uin_details: posRows(inter.uin_details) },
    itc_elg: { itc_avl: itcRows(itc.itc_avl, ITC_AVL_TYPES), itc_rev: itcRows(itc.itc_rev, ITC_REV_TYPES), itc_inelg: itcRows(itc.itc_inelg, ITC_REV_TYPES) },
    inward_sup: {
      isup_details: (['GST', 'NONGST'] as const).map((ty) => ({ ty, inter: r2(inwardBy.get(ty)?.inter), intra: r2(inwardBy.get(ty)?.intra) })),
    },
    intr_ltfee: { intr_details: amt(fee.intr_details, FIELDS.intr_details), ltfee_details: amt(fee.ltfee_details, FIELDS.ltfee_details) },
  };
}

/** Table 4(C): net ITC available = 4(A) − 4(B). */
export function itcNet(f: Gstr3bForm): Record<Head, number> {
  const sum = (rows: ItcRow[], h: Head) => rows.reduce((a, r) => a + r[h], 0);
  return Object.fromEntries(HEADS.map((h) => [h, r2(sum(f.itc_elg.itc_avl, h) - sum(f.itc_elg.itc_rev, h))])) as Record<Head, number>;
}

/** True when every amount in the return is zero – the case for filing a Nil GSTR-3B. */
export function isNilForm(f: Gstr3bForm): boolean {
  let nil = true;
  const walk = (v: unknown) => {
    if (!nil) return;
    if (typeof v === 'number') { if (v !== 0) nil = false; return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(f);
  return nil;
}

/**
 * Tax this return creates, before any set-off: other than reverse charge (3.1 a + b) and reverse
 * charge (3.1 d), plus interest and late fee (5.1). Supplies under 3.1.1(i) are taxed in the
 * e-commerce operator's hands, so they are not the supplier's liability.
 */
export function liabilityPreview(f: Gstr3bForm) {
  const s = f.sup_details;
  const pick = (a: Amt, h: Head) => a[h] ?? 0;
  const forward = Object.fromEntries(HEADS.map((h) => [h, r2(pick(s.osup_det, h) + pick(s.osup_zero, h))])) as Record<Head, number>;
  const reverse = Object.fromEntries(HEADS.map((h) => [h, r2(pick(s.isup_rev, h))])) as Record<Head, number>;
  const interest = Object.fromEntries(HEADS.map((h) => [h, r2(pick(f.intr_ltfee.intr_details, h))])) as Record<Head, number>;
  const lateFee = Object.fromEntries(HEADS.map((h) => [h, r2(pick(f.intr_ltfee.ltfee_details, h))])) as Record<Head, number>;
  return { forward, reverse, interest, lateFee, itc: itcNet(f) };
}

/** Body for Save GSTR-3B: only the columns each table has; 4(C) recomputed from 4(A) and 4(B). */
export function saveBody(f: Gstr3bForm, gstin: string, fp: string) {
  const n = normalizeForm(f);
  return {
    gstin, ret_period: fp,
    sup_details: n.sup_details,
    eco_dtls: n.eco_dtls,
    inter_sup: n.inter_sup,
    itc_elg: { ...n.itc_elg, itc_net: itcNet(n) },
    inward_sup: n.inward_sup,
    intr_ltfee: n.intr_ltfee,
  };
}

/* ---------- auto-calculated liability (GSTR-1 / IFF / GSTR-2B → 3B) ---------- */

const sub = (o: unknown) => obj(obj(o).subtotal);
const subRows = (o: unknown) => obj(o).subtotal;

/** GSTN's ITC table code in the auto-calculation → the GSTR-3B row it fills. */
const AUTO_ITC: Record<string, ['itc_avl' | 'itc_rev' | 'itc_inelg', string]> = {
  itc4a1: ['itc_avl', 'IMPG'], itc4a2: ['itc_avl', 'IMPS'], itc4a3: ['itc_avl', 'ISRC'], itc4a4: ['itc_avl', 'ISD'], itc4a5: ['itc_avl', 'OTH'],
  itc4b1: ['itc_rev', 'RUL'], itc4b2: ['itc_rev', 'OTH'],
  itc4d1: ['itc_inelg', 'RUL'], itc4d2: ['itc_inelg', 'OTH'],
};

export interface AutoLiability {
  form: Gstr3bForm;
  gstr1FiledOn?: string;
  gstr2bGeneratedOn?: string;
  generatedOn?: string;
}

/**
 * Liability Auto Calc (`r3bautopop`) → a GSTR-3B form, the way the GST portal pre-fills the return:
 * outward tables from GSTR-1/IFF, 3.1(d) and table 4 from GSTR-2B. Tables GSTN does not compute
 * (5, 5.1) start at zero.
 */
export function fromAutoLiability(inner: unknown): AutoLiability {
  const root = obj(obj(inner).r3bautopop);
  const liab = obj(root.liabitc);
  const sup = obj(liab.sup_details);
  const inter = obj(liab.inter_sup);
  const elg = obj(liab.elgitc);
  const itc: Record<string, Record<string, unknown>[]> = { itc_avl: [], itc_rev: [], itc_inelg: [] };
  for (const [code, [table, ty]] of Object.entries(AUTO_ITC)) if (elg[code]) itc[table].push({ ty, ...sub(elg[code]) });
  const form = normalizeForm({
    sup_details: {
      osup_det: sub(sup.osup_3_1a), osup_zero: sub(sup.osup_3_1b), osup_nil_exmp: sub(sup.osup_3_1c),
      isup_rev: sub(sup.isup_3_1d), osup_nongst: sub(sup.osup_3_1e),
    },
    eco_dtls: { eco_sup: sub(sup.osup_3_1_1i ?? sup.eco_sup), eco_reg_sup: sub(sup.osup_3_1_1ii ?? sup.eco_reg_sup) },
    inter_sup: {
      unreg_details: subRows(inter.osup_unreg_3_2), comp_details: subRows(inter.osup_comp_3_2), uin_details: subRows(inter.osup_uin_3_2),
    },
    itc_elg: itc,
  });
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { form, gstr1FiledOn: str(root.r1fildt), gstr2bGeneratedOn: str(root.r2bgendt), generatedOn: str(root.r3bgendt) };
}

/* ---------- ledgers ---------- */

export type Major = 'igst' | 'cgst' | 'sgst' | 'cess';
export const MAJORS: Major[] = ['igst', 'cgst', 'sgst', 'cess'];
export const MAJOR_LABEL: Record<Major, string> = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST/UTGST', cess: 'Cess' };
export const MAJOR_HEAD: Record<Major, Head> = { igst: 'iamt', cgst: 'camt', sgst: 'samt', cess: 'csamt' };
export type ByMajor = Record<Major, number>;

export interface LedgerBalance {
  /** Electronic cash ledger, per major head: minor heads and total. */
  cash: Record<Major, { tx: number; intr: number; fee: number; pen: number; oth: number; total: number }>;
  /** Electronic credit ledger (ITC) balance. */
  itc: ByMajor;
  /** ITC blocked by the department (not usable). */
  blocked: ByMajor;
}

export function parseLedger(inner: unknown): LedgerBalance {
  const d = obj(inner);
  const cash = obj(d.cash_bal);
  const itc = obj(d.itc_bal);
  const blk = obj(d.itc_blck_bal);
  const m = (f: (k: Major) => number) => Object.fromEntries(MAJORS.map((k) => [k, f(k)])) as ByMajor;
  return {
    cash: Object.fromEntries(MAJORS.map((k) => {
      const c = obj(cash[k]);
      const minor = { tx: r2(c.tx), intr: r2(c.intr), fee: r2(c.fee), pen: r2(c.pen), oth: r2(c.oth) };
      const total = cash[`${k}_tot_bal`] != null ? r2(cash[`${k}_tot_bal`]) : r2(minor.tx + minor.intr + minor.fee + minor.pen + minor.oth);
      return [k, { ...minor, total }];
    })) as LedgerBalance['cash'],
    itc: m((k) => r2(itc[`${k}_bal`])),
    blocked: m((k) => r2(blk[`${k}_blck_bal`])),
  };
}

/* ---------- liability set-off ---------- */

/** GSTN liability ledger transaction types in GSTR-3B's payment table. */
export const TRANS_FORWARD = 30002;
export const TRANS_REVERSE = 30003;

export interface TaxCell { tx: number; intr: number; fee: number }
export interface LiabilityRow {
  trans_typ: number;
  trans_desc: string;
  liab_ldg_id: number;
  igst: TaxCell; cgst: TaxCell; sgst: TaxCell; cess: TaxCell;
}

/** Whole rupees: GSTN posts and offsets liabilities in rupees. */
const rupees = (n: unknown) => Math.round(r2(n));
const cell = (v: unknown): TaxCell => { const o = obj(v); return { tx: rupees(o.tx), intr: rupees(o.intr), fee: rupees(o.fee) }; };

/** Tax payable rows (`tx_pmt.net_tax_pay`) from Get GSTR-3B Details, available once the return is saved. */
export function liabilityRows(details: unknown): LiabilityRow[] {
  return arr(obj(obj(details).tx_pmt).net_tax_pay).map((r) => obj(r)).map((r) => ({
    trans_typ: Number(r.trans_typ) || 0,
    trans_desc: String(r.trans_desc ?? r.tran_desc ?? ''),
    liab_ldg_id: Number(r.liab_ldg_id) || 0,
    igst: cell(r.igst), cgst: cell(r.cgst), sgst: cell(r.sgst), cess: cell(r.cess),
  })).filter((r) => r.trans_typ);
}

/** True once GSTN shows a set-off (ITC or cash) in the return's payment table. */
export function isOffset(details: unknown): boolean {
  const t = obj(obj(details).tx_pmt);
  const positive = (o: unknown) => Object.entries(obj(o)).some(([k, v]) => !['liab_ldg_id', 'trans_typ'].includes(k) && typeof v === 'number' && v > 0);
  return arr(t.pdcash).some(positive) || positive(t.pditc);
}

/**
 * ITC used against the forward-charge liability. Field names are GSTN's: i_pdc = IGST credit used for
 * CGST liability, c_pdi = CGST credit used for IGST liability, and so on. CGST credit can never pay
 * SGST (and vice versa), and cess credit pays only cess.
 */
export interface ItcUse { i_pdi: number; i_pdc: number; i_pds: number; c_pdi: number; c_pdc: number; s_pdi: number; s_pds: number; cs_pdcs: number }
export const ITC_USE_KEYS: (keyof ItcUse)[] = ['i_pdi', 'i_pdc', 'i_pds', 'c_pdi', 'c_pdc', 's_pdi', 's_pds', 'cs_pdcs'];

const emptyCells = (): Record<Major, TaxCell> => ({ igst: cell(null), cgst: cell(null), sgst: cell(null), cess: cell(null) });
export const forwardRow = (rows: LiabilityRow[]) => rows.find((r) => r.trans_typ === TRANS_FORWARD);

/** ITC available for set-off: credit ledger minus blocked credit, plus (optionally) this return's 4(C). */
export function itcAvailable(ledger: LedgerBalance, currentItc?: Record<Head, number>): ByMajor {
  return Object.fromEntries(MAJORS.map((k) => [k, Math.max(0, Math.floor(ledger.itc[k] + (currentItc?.[MAJOR_HEAD[k]] ?? 0)))])) as ByMajor;
}

/**
 * Suggested ITC set-off that leaves the least to pay in cash, within sections 49, 49A and rule 88A:
 * IGST credit first pays IGST, then CGST and SGST (and must be used up before CGST/SGST credit is
 * used); CGST credit pays CGST then IGST; SGST credit pays SGST then IGST; cess credit pays cess.
 */
export function suggestItcUse(rows: LiabilityRow[], itc: ByMajor): ItcUse {
  const f = forwardRow(rows) ?? { ...emptyCells() };
  let LI = f.igst.tx; const LC = f.cgst.tx; const LS = f.sgst.tx;
  const I = Math.floor(itc.igst), C = Math.floor(itc.cgst), S = Math.floor(itc.sgst);
  const u: ItcUse = { i_pdi: 0, i_pdc: 0, i_pds: 0, c_pdi: 0, c_pdc: 0, s_pdi: 0, s_pds: 0, cs_pdcs: 0 };

  u.i_pdi = Math.min(I, LI);
  LI -= u.i_pdi;
  let r = I - u.i_pdi;
  if (r > 0) {
    // First where the head's own credit falls short, then spread the rest so IGST credit is used up first.
    u.i_pdc = Math.min(r, Math.max(0, LC - C)); r -= u.i_pdc;
    u.i_pds = Math.min(r, Math.max(0, LS - S)); r -= u.i_pds;
    const a = Math.min(LC - u.i_pdc, Math.ceil(r / 2));
    const b = Math.min(LS - u.i_pds, r - a);
    const a2 = Math.min(LC - u.i_pdc - a, r - a - b);
    u.i_pdc += a + a2; u.i_pds += b;
  }
  u.c_pdc = Math.min(C, LC - u.i_pdc);
  u.c_pdi = Math.min(C - u.c_pdc, LI); LI -= u.c_pdi;
  u.s_pds = Math.min(S, LS - u.i_pds);
  u.s_pdi = Math.min(S - u.s_pds, LI);
  u.cs_pdcs = Math.min(Math.floor(itc.cess), f.cess.tx);
  return u;
}

export interface CashRow {
  liab_ldg_id: number; trans_typ: number;
  ipd: number; cpd: number; spd: number; cspd: number;
  i_intrpd: number; c_intrpd: number; s_intrpd: number; cs_intrpd: number;
  c_lfeepd: number; s_lfeepd: number;
}

export interface OffsetPlan {
  itcUse: ItcUse;
  cash: CashRow[];
  /** Cash needed per major head (tax + interest + late fee). */
  cashNeeded: ByMajor;
  cashAvailable: ByMajor;
  /** Cash to deposit (PMT-06 challan) before the set-off can go through. */
  shortfall: ByMajor;
  /** Credit still in the ledger after the set-off. */
  itcLeft: ByMajor;
  errors: string[];
  warnings: string[];
}

/** Checks an ITC set-off and works out what the cash ledger must pay. */
export function planOffset(rows: LiabilityRow[], ledger: LedgerBalance, itc: ByMajor, use: ItcUse): OffsetPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const u = Object.fromEntries(ITC_USE_KEYS.map((k) => [k, use[k]])) as unknown as ItcUse;
  for (const k of ITC_USE_KEYS) {
    if (!Number.isInteger(u[k]) || u[k] < 0) { errors.push('ITC set-off amounts must be whole rupees, zero or more.'); break; }
  }
  const used: ByMajor = { igst: u.i_pdi + u.i_pdc + u.i_pds, cgst: u.c_pdi + u.c_pdc, sgst: u.s_pdi + u.s_pds, cess: u.cs_pdcs };
  for (const k of MAJORS) if (used[k] > itc[k]) errors.push(`${MAJOR_LABEL[k]} credit used (₹${used[k]}) is more than the ${MAJOR_LABEL[k]} credit available (₹${itc[k]}).`);

  const f = forwardRow(rows);
  const paidByItc: ByMajor = { igst: u.i_pdi + u.c_pdi + u.s_pdi, cgst: u.i_pdc + u.c_pdc, sgst: u.i_pds + u.s_pds, cess: u.cs_pdcs };
  if (!f && MAJORS.some((k) => paidByItc[k] > 0)) errors.push('There is no forward-charge liability for ITC to pay.');
  if (f) for (const k of MAJORS) if (paidByItc[k] > f[k].tx) errors.push(`ITC applied to ${MAJOR_LABEL[k]} (₹${paidByItc[k]}) is more than the ${MAJOR_LABEL[k]} tax payable (₹${f[k].tx}).`);
  const owedForward = f ? f.igst.tx + f.cgst.tx + f.sgst.tx : 0;
  if (used.cgst + used.sgst > 0 && used.igst < Math.min(itc.igst, owedForward)) {
    warnings.push('IGST credit is not fully used while CGST/SGST credit is – rule 88A requires IGST credit to be used first. GSTN may reject this set-off.');
  }

  const cash: CashRow[] = rows.map((r) => {
    const fwd = r.trans_typ === TRANS_FORWARD;
    return {
      liab_ldg_id: r.liab_ldg_id, trans_typ: r.trans_typ,
      ipd: Math.max(0, r.igst.tx - (fwd ? paidByItc.igst : 0)),
      cpd: Math.max(0, r.cgst.tx - (fwd ? paidByItc.cgst : 0)),
      spd: Math.max(0, r.sgst.tx - (fwd ? paidByItc.sgst : 0)),
      cspd: Math.max(0, r.cess.tx - (fwd ? paidByItc.cess : 0)),
      i_intrpd: r.igst.intr, c_intrpd: r.cgst.intr, s_intrpd: r.sgst.intr, cs_intrpd: r.cess.intr,
      c_lfeepd: r.cgst.fee, s_lfeepd: r.sgst.fee,
    };
  });
  const extraFee: ByMajor = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const r of rows) { extraFee.igst += r.igst.fee; extraFee.cess += r.cess.fee; }
  if (extraFee.igst || extraFee.cess) warnings.push('GSTN shows a late fee under IGST or cess; it is not part of the set-off request and must be paid on the portal.');

  const cashNeeded: ByMajor = {
    igst: cash.reduce((a, c) => a + c.ipd + c.i_intrpd, 0),
    cgst: cash.reduce((a, c) => a + c.cpd + c.c_intrpd + c.c_lfeepd, 0),
    sgst: cash.reduce((a, c) => a + c.spd + c.s_intrpd + c.s_lfeepd, 0),
    cess: cash.reduce((a, c) => a + c.cspd + c.cs_intrpd, 0),
  };
  const cashAvailable = Object.fromEntries(MAJORS.map((k) => [k, Math.floor(ledger.cash[k].total)])) as ByMajor;
  const shortfall = Object.fromEntries(MAJORS.map((k) => [k, Math.max(0, cashNeeded[k] - cashAvailable[k])])) as ByMajor;
  const itcLeft = Object.fromEntries(MAJORS.map((k) => [k, Math.max(0, itc[k] - used[k])])) as ByMajor;
  return { itcUse: u, cash, cashNeeded, cashAvailable, shortfall, itcLeft, errors, warnings };
}

/** Body for Offset Liability. */
export function offsetBody(rows: LiabilityRow[], plan: OffsetPlan) {
  const f = forwardRow(rows);
  return {
    pdcash: plan.cash,
    pditc: { liab_ldg_id: f?.liab_ldg_id ?? 0, trans_typ: TRANS_FORWARD, ...plan.itcUse },
    nettaxpay: rows.map((r) => ({
      trans_typ: r.trans_typ, trans_desc: r.trans_desc, liab_ldg_id: r.liab_ldg_id,
      sgst: r.sgst, cgst: r.cgst, cess: r.cess, igst: r.igst,
    })),
  };
}

/** Body for filing a Nil GSTR-3B (no save or set-off needed). */
export const nilFileBody = (gstin: string, fp: string) => ({ ret_period: fp, gstin, isNil: 'Y' });

/* ---------- Excel import / template ---------- */

/** One row of the template's main sheet: code in the "Code" column, amounts under the head columns. */
export interface ExcelRow {
  code: string;
  label: string;
  fields: readonly (keyof Amt)[];
  get: (f: Gstr3bForm) => Amt;
  set: (f: Gstr3bForm, a: Amt) => void;
}

const itcRow = (table: 'itc_avl' | 'itc_rev' | 'itc_inelg', ty: string) => ({
  fields: HEADS,
  get: (f: Gstr3bForm): Amt => f.itc_elg[table].find((r) => r.ty === ty) ?? { iamt: 0, camt: 0, samt: 0, csamt: 0 },
  set: (f: Gstr3bForm, a: Amt) => {
    f.itc_elg[table] = f.itc_elg[table].map((r) => (r.ty === ty ? { ty, iamt: a.iamt ?? 0, camt: a.camt ?? 0, samt: a.samt ?? 0, csamt: a.csamt ?? 0 } : r));
  },
});

export const EXCEL_ROWS: ExcelRow[] = [
  { code: '3.1(a)', label: 'Outward taxable supplies (other than zero rated, nil rated and exempted)', fields: FIELDS.osup_det, get: (f) => f.sup_details.osup_det, set: (f, a) => { f.sup_details.osup_det = a; } },
  { code: '3.1(b)', label: 'Outward taxable supplies (zero rated)', fields: FIELDS.osup_zero, get: (f) => f.sup_details.osup_zero, set: (f, a) => { f.sup_details.osup_zero = a; } },
  { code: '3.1(c)', label: 'Other outward supplies (nil rated, exempted)', fields: FIELDS.osup_nil_exmp, get: (f) => f.sup_details.osup_nil_exmp, set: (f, a) => { f.sup_details.osup_nil_exmp = a; } },
  { code: '3.1(d)', label: 'Inward supplies (liable to reverse charge)', fields: FIELDS.isup_rev, get: (f) => f.sup_details.isup_rev, set: (f, a) => { f.sup_details.isup_rev = a; } },
  { code: '3.1(e)', label: 'Non-GST outward supplies', fields: FIELDS.osup_nongst, get: (f) => f.sup_details.osup_nongst, set: (f, a) => { f.sup_details.osup_nongst = a; } },
  { code: '3.1.1(i)', label: 'Taxable supplies on which the e-commerce operator pays tax u/s 9(5)', fields: FIELDS.eco_sup, get: (f) => f.eco_dtls.eco_sup, set: (f, a) => { f.eco_dtls.eco_sup = a; } },
  { code: '3.1.1(ii)', label: 'Taxable supplies made through an e-commerce operator u/s 9(5)', fields: FIELDS.eco_reg_sup, get: (f) => f.eco_dtls.eco_reg_sup, set: (f, a) => { f.eco_dtls.eco_reg_sup = a; } },
  { code: '4A(1)', label: 'ITC available – import of goods', ...itcRow('itc_avl', 'IMPG') },
  { code: '4A(2)', label: 'ITC available – import of services', ...itcRow('itc_avl', 'IMPS') },
  { code: '4A(3)', label: 'ITC available – inward supplies liable to reverse charge', ...itcRow('itc_avl', 'ISRC') },
  { code: '4A(4)', label: 'ITC available – inward supplies from ISD', ...itcRow('itc_avl', 'ISD') },
  { code: '4A(5)', label: 'ITC available – all other ITC', ...itcRow('itc_avl', 'OTH') },
  { code: '4B(1)', label: 'ITC reversed – as per rules 38, 42 & 43 and section 17(5)', ...itcRow('itc_rev', 'RUL') },
  { code: '4B(2)', label: 'ITC reversed – others', ...itcRow('itc_rev', 'OTH') },
  { code: '4D(1)', label: 'ITC reclaimed which was reversed under 4(B)(2) earlier', ...itcRow('itc_inelg', 'RUL') },
  { code: '4D(2)', label: 'Ineligible ITC under section 16(4) & ITC restricted due to PoS rules', ...itcRow('itc_inelg', 'OTH') },
  { code: '5.1 Interest', label: 'Interest', fields: FIELDS.intr_details, get: (f) => f.intr_ltfee.intr_details, set: (f, a) => { f.intr_ltfee.intr_details = a; } },
  { code: '5.1 Late fee', label: 'Late fee', fields: ['camt', 'samt'], get: (f) => f.intr_ltfee.ltfee_details, set: (f, a) => { f.intr_ltfee.ltfee_details = a; } },
];

export const EXCEL_AMT_COLS: { key: keyof Amt; label: string }[] = [
  { key: 'txval', label: 'Taxable value' }, { key: 'iamt', label: 'IGST' }, { key: 'camt', label: 'CGST' }, { key: 'samt', label: 'SGST/UTGST' }, { key: 'csamt', label: 'Cess' },
];
export const EXCEL_INWARD_ROWS: { code: string; ty: 'GST' | 'NONGST'; label: string }[] = [
  { code: '5(a)', ty: 'GST', label: 'From a supplier under composition scheme, exempt and nil rated supply' },
  { code: '5(b)', ty: 'NONGST', label: 'Non-GST supply' },
];
export const EXCEL_POS_TYPES: { key: keyof Gstr3bForm['inter_sup']; label: string }[] = [
  { key: 'unreg_details', label: 'Unregistered persons' },
  { key: 'comp_details', label: 'Composition taxable persons' },
  { key: 'uin_details', label: 'UIN holders' },
];

/** "3.1 (a)" → "31a", "SGST/UTGST" → "sgstutgst": comparisons ignore case, spaces and punctuation. */
const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fieldName = (k: keyof Amt) => (k === 'txval' ? 'taxable value' : HEAD_LABEL[k]);

/** Amount from a cell: numbers, "1,23,456.78", "(100)" for negatives; blank is 0; anything else null. */
export function amount(v: unknown): number | null {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return r2(v);
  const s = String(v).trim().replace(/[₹,\s]/g, '');
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(neg ? s.slice(1, -1) : s);
  return Number.isFinite(n) ? r2(neg ? -n : n) : null;
}

const HEADER: Record<string, string[]> = {
  code: ['code', 'table', 'tableno'],
  txval: ['taxablevalue', 'totaltaxablevalue', 'taxable'],
  iamt: ['igst', 'integratedtax'],
  camt: ['cgst', 'centraltax'],
  samt: ['sgstutgst', 'sgst', 'stateuttax', 'statetax', 'utgst'],
  csamt: ['cess'],
  inter: ['interstate', 'interstatesupplies'],
  intra: ['intrastate', 'intrastatesupplies'],
  type: ['type', 'suppliesmadeto', 'madeto', 'category'],
  pos: ['placeofsupply', 'pos', 'placeofsupplystateut'],
};

/** Column positions from the first row (within the first 15) that names at least two known columns. */
function header(rows: unknown[][]): { at: number; col: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const col: Record<string, number> = {};
    (rows[i] ?? []).forEach((c, j) => {
      const n = norm(c);
      for (const [k, names] of Object.entries(HEADER)) if (col[k] == null && names.includes(n)) col[k] = j;
    });
    if (Object.keys(col).length >= 2) return { at: i, col };
  }
  return null;
}

/** "29", 29, "29-Karnataka" or a state name → "29"; null if not a state code. */
export function posCode(v: unknown, states: Record<string, string>): string | null {
  const s = String(v ?? '').trim();
  const m = /^(\d{1,2})(\D|$)/.exec(s);
  if (m) { const c = m[1].padStart(2, '0'); return states[c] && c !== '96' ? c : null; }
  const n = norm(s);
  return Object.entries(states).find(([c, name]) => c !== '96' && norm(name) === n)?.[0] ?? null;
}

export interface ExcelImport {
  form: Gstr3bForm;
  /** Rows taken from each part, to tell the user what was read. */
  read: { tables: number; interState: number; inward: number };
  issues: string[];
}

/**
 * Reads the GSTR-3B Excel template, or any sheet laid out the same way. Rows of tables 3.1 – 5.1 are
 * found by their code in the "Code" column, table 5 by 5(a)/5(b), and 3.2 by "Type" + "Place of
 * supply". Sheets are recognised by their header row, so they may be renamed or reordered. Anything
 * that cannot be read is reported, never guessed.
 */
export function parseGstr3bExcel(sheets: { name: string; rows: unknown[][] }[], states: Record<string, string>): ExcelImport {
  const form = blankForm();
  const issues: string[] = [];
  const read = { tables: 0, interState: 0, inward: 0 };
  const byCode = new Map(EXCEL_ROWS.map((r) => [norm(r.code), r]));
  const inwardByCode = new Map(EXCEL_INWARD_ROWS.map((r) => [norm(r.code), r]));
  const seen = new Set<string>();

  for (const sh of sheets) {
    const h = header(sh.rows);
    if (!h) continue;
    const { col } = h;
    const at = (row: unknown[], k: string) => (col[k] == null ? undefined : row[col[k]]);
    const where = (i: number) => `${sh.name} row ${i + 1}`;

    for (let i = h.at + 1; i < sh.rows.length; i++) {
      const row = sh.rows[i] ?? [];
      if (!row.some((c) => c != null && String(c).trim() !== '')) continue;

      // 3.2: type + place of supply + taxable value + IGST
      if (col.pos != null && col.type != null) {
        const tyText = norm(at(row, 'type'));
        if (!tyText) continue;
        const ty = EXCEL_POS_TYPES.find((t) => norm(t.label).startsWith(tyText.slice(0, 4)) || tyText.startsWith(norm(t.label).slice(0, 4)));
        if (!ty) { issues.push(`${where(i)}: type "${String(at(row, 'type'))}" is not Unregistered persons, Composition taxable persons or UIN holders – row skipped.`); continue; }
        const pos = posCode(at(row, 'pos'), states);
        if (!pos) { issues.push(`${where(i)}: place of supply "${String(at(row, 'pos') ?? '')}" is not a valid state code – row skipped.`); continue; }
        const txval = amount(at(row, 'txval'));
        const iamt = amount(at(row, 'iamt'));
        if (txval == null || iamt == null) { issues.push(`${where(i)}: taxable value or IGST is not a number – row skipped.`); continue; }
        if (!txval && !iamt) continue;
        const same = form.inter_sup[ty.key].find((r) => r.pos === pos);
        if (same) { same.txval = r2(same.txval + txval); same.iamt = r2(same.iamt + iamt); } else form.inter_sup[ty.key].push({ pos, txval, iamt });
        read.interState++;
        continue;
      }

      const code = norm(at(row, 'code') ?? row[0]);
      if (!code) continue;

      // Table 5: inter-state / intra-state
      const inward = col.inter != null ? inwardByCode.get(code) : undefined;
      if (inward) {
        const inter = amount(at(row, 'inter'));
        const intra = amount(at(row, 'intra'));
        if (inter == null || intra == null) { issues.push(`${where(i)}: ${inward.code} is not a number – row skipped.`); continue; }
        form.inward_sup.isup_details = form.inward_sup.isup_details.map((r) => (r.ty === inward.ty ? { ...r, inter, intra } : r));
        read.inward++;
        continue;
      }

      const def = byCode.get(code);
      if (!def) continue; // headings, totals and notes
      if (seen.has(def.code)) issues.push(`${where(i)}: ${def.code} appears more than once – the last one is used.`);
      seen.add(def.code);
      const a: Amt = {};
      let bad = false;
      for (const { key } of EXCEL_AMT_COLS) {
        const raw = at(row, key);
        const v = amount(raw);
        if (v == null) { issues.push(`${where(i)}: ${def.code} ${fieldName(key)} "${String(raw)}" is not a number – row skipped.`); bad = true; continue; }
        if (def.fields.includes(key)) a[key] = v;
        else if (v) issues.push(`${where(i)}: ${def.code} has no ${fieldName(key)} on the GST portal – ${v} ignored.`);
      }
      if (bad) continue;
      def.set(form, { ...def.get(form), ...a });
      read.tables++;
    }
  }
  if (!read.tables && !read.interState && !read.inward) {
    issues.unshift('No GSTR-3B rows found. Use the GSTR-3B Excel template: a "Code" column with 3.1(a) … 5.1 Late fee, and columns Taxable value, IGST, CGST, SGST/UTGST, Cess.');
  }
  return { form: normalizeForm(form), read, issues };
}
