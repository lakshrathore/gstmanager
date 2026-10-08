import { checkHsn } from '../hsn';
import { DOC_TYPES, STATE_CODES, UQC_CODES } from '../masters';
import type {
  AdvanceItem, AnyRecord, Gstr1Record, Item, ReturnContext, Section, Severity, ValidationIssue,
} from '../types';
import { checkGstin, computeTax, isIsoDate, periodBounds, round2 } from '../util';

const TAX_TOLERANCE = 1; // ₹1 rounding tolerance per item
const DOC_NO_RE = /^[A-Za-z0-9/-]+$/;

type Add = (field: string, message: string, opts?: { value?: unknown; suggestion?: string; severity?: Severity; code?: string }) => void;

function adder(rec: AnyRecord, out: ValidationIssue[], docNo?: string): Add {
  return (field, message, opts = {}) =>
    out.push({
      code: opts.code ?? `${rec.section.toUpperCase()}_${field.toUpperCase()}`,
      severity: opts.severity ?? 'error',
      section: rec.section,
      recordKey: rec.key,
      documentNo: docNo,
      sheet: rec.source.sheet,
      row: rec.source.rows[0],
      field,
      value: opts.value,
      message,
      suggestion: opts.suggestion,
    });
}

/* ---------- field-level helpers ---------- */

function docNumber(add: Add, field: string, v: string, label: string) {
  if (!v) return add(field, `${label} is mandatory`);
  if (v.length > 16) add(field, `${label} exceeds 16 characters`, { value: v, suggestion: 'Shorten the document series/number to max 16 characters.' });
  if (!DOC_NO_RE.test(v)) add(field, `${label} contains invalid characters`, { value: v, suggestion: 'Only letters, digits, "/" and "-" are allowed.' });
  if (/^0+$/.test(v)) add(field, `${label} cannot be all zeros`, { value: v });
}

function docDate(add: Add, field: string, v: string, ctx: ReturnContext, label: string) {
  if (!v) return add(field, `${label} is mandatory`);
  if (!isIsoDate(v)) return add(field, `${label} is not a valid date`, { value: v, suggestion: 'Use dd-mm-yyyy.' });
  const { start, end } = periodBounds(ctx.fp, ctx.quarterly);
  if (v > end) add(field, `${label} ${v} is after the return period (ends ${end})`, { value: v, suggestion: 'Report this document in the period in which it was issued.' });
  else if (v < start) add(field, `${label} ${v} is before the return period – reported as a missed document`, { value: v, severity: 'warning', suggestion: 'Confirm it was not already reported in an earlier return.' });
}

function posCheck(add: Add, pos: string | undefined, required = true) {
  if (!pos) { if (required) add('pos', 'Place of supply is mandatory', { suggestion: 'Use "29-Karnataka" or the 2-digit state code.' }); return; }
  if (!STATE_CODES[pos] || pos === '96') add('pos', `Invalid place of supply "${pos}"`, { value: pos, suggestion: 'Use a valid 2-digit state code (01–38, 97).' });
}

function gstinField(add: Add, field: string, v: string | undefined, ctx: ReturnContext, label: string) {
  const c = checkGstin(v);
  if (!c.ok) return add(field, `${label}: ${c.reason}`, { value: v, suggestion: 'Verify the GSTIN on the GST portal "Search Taxpayer".' });
  if (v === ctx.supplierGstin) add(field, `${label} is the same as your own GSTIN`, { value: v });
  if (c.kind === 'special') add(field, `${label} is a special registration (UIN/TDS/NRTP/OIDAR) – verify`, { value: v, severity: 'warning' });
}

function rateCheck(add: Add, rt: number | null, ctx: ReturnContext, field = 'rt') {
  if (rt == null) return add(field, 'Rate is mandatory');
  if (!ctx.profile.allowedRates.includes(rt)) add(field, `Rate ${rt}% is not a valid GST rate`, { value: rt, suggestion: `Allowed: ${ctx.profile.allowedRates.join(', ')}` });
}

function nonNeg(add: Add, field: string, v: number | null, label: string, required = true) {
  if (v == null) { if (required) add(field, `${label} is mandatory / not a number`); return; }
  if (v < 0) add(field, `${label} cannot be negative`, { value: v });
}

interface TaxRule { pos: string; supplierState: string; forceIgst?: boolean; noTax?: boolean; diffPercent?: number | null }

function taxCheck(add: Add, it: Item | AdvanceItem, base: number | null, rule: TaxRule, idx: number) {
  const p = `items[${idx}]`;
  nonNeg(add, `${p}.csamt`, it.csamt, 'Cess', false);
  if (it.rt == null || base == null) return;
  const exp = computeTax(it.rt, base, rule);
  const i = it.iamt ?? 0, c = it.camt ?? 0, s = it.samt ?? 0;
  if (rule.noTax) {
    if (i || c || s) add(`${p}.iamt`, 'Tax must be zero for supplies without payment of tax', { value: i + c + s, suggestion: 'Set IGST/CGST/SGST to 0 or change the supply type to "with payment".' });
    return;
  }
  const inter = rule.forceIgst || rule.pos !== rule.supplierState;
  if (inter && (c || s)) add(`${p}.camt`, 'Inter-state supply must carry IGST, not CGST/SGST', { value: { camt: c, samt: s }, suggestion: `IGST = ${exp.iamt}` });
  if (!inter && i) add(`${p}.iamt`, 'Intra-state supply must carry CGST+SGST/UTGST, not IGST', { value: i, suggestion: `CGST = SGST = ${exp.camt}` });
  if (!inter && Math.abs(c - s) > 0.01) add(`${p}.samt`, 'CGST and SGST/UTGST must be equal', { value: { camt: c, samt: s } });
  const diff = Math.abs(i + c + s - (exp.iamt + exp.camt + exp.samt));
  if (diff > TAX_TOLERANCE) {
    add(`${p}.${inter ? 'iamt' : 'camt'}`, `Tax amount does not match ${base} × ${it.rt}%${rule.diffPercent ? ` × ${rule.diffPercent}%` : ''}`, {
      value: round2(i + c + s), suggestion: inter ? `IGST = ${exp.iamt}` : `CGST = SGST = ${exp.camt}`,
    });
  }
}

function itemsCheck(add: Add, items: Item[], ctx: ReturnContext, rule: TaxRule, allowZeroTxval = false) {
  if (!items.length) return add('items', 'At least one rate row is required');
  items.forEach((it, idx) => {
    rateCheck(add, it.rt, ctx, `items[${idx}].rt`);
    nonNeg(add, `items[${idx}].txval`, it.txval, 'Taxable value');
    if (!allowZeroTxval && it.txval === 0) add(`items[${idx}].txval`, 'Taxable value is zero', { severity: 'warning', value: 0 });
    taxCheck(add, it, it.txval, rule, idx);
  });
}

function invoiceValueCheck(add: Add, val: number | null, items: Item[], label = 'Invoice value') {
  if (val == null) return add('val', `${label} is mandatory`);
  if (val < 0) return add('val', `${label} cannot be negative`, { value: val });
  const tx = items.reduce((a, b) => a + (b.txval ?? 0), 0);
  if (val + TAX_TOLERANCE < tx) add('val', `${label} (${val}) is less than total taxable value (${round2(tx)})`, { value: val, severity: 'warning' });
}

function diffCheck(add: Add, d: number | null | undefined) {
  if (d != null && d !== 65) add('diffPercent', 'Applicable % of tax rate can only be 65 or blank', { value: d });
}

/* ---------- per-section rules ---------- */

type Rule<S extends Section> = (r: Gstr1Record<S>, add: Add, ctx: ReturnContext) => void;
const ss = (ctx: ReturnContext) => ctx.supplierGstin.slice(0, 2);

/* ---------- amendments (Tables 9A, 9C, 10, 11) ---------- */

/** Revised documents usually keep their original (earlier) date, so "before the period" is expected, not a warning. */
const amendAdd = (add: Add): Add => (field, message, opts) => {
  if (opts?.severity === 'warning' && /before the return period/.test(message)) return;
  add(field, message, opts);
};

function originalDoc(add: Add, noField: string, no: string, dateField: string, date: string, ctx: ReturnContext, label: string) {
  docNumber(add, noField, no, `Original ${label} number`);
  if (!date) return add(dateField, `Original ${label} date is mandatory`);
  if (!isIsoDate(date)) return add(dateField, `Original ${label} date is not a valid date`, { value: date });
  const { start } = periodBounds(ctx.fp, ctx.quarterly);
  if (date >= start) add(dateField, `Original ${label} date ${date} is in this return period – only documents reported in an earlier return can be amended`, { value: date, suggestion: 'Edit the document in its own table instead of amending it.' });
}

function originalMonth(add: Add, omon: string, ctx: ReturnContext) {
  if (!omon) return add('omon', 'Original month (MMYYYY) is mandatory');
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(omon)) return add('omon', 'Original month must be MMYYYY, e.g. 042025', { value: omon });
  const key = (fp: string) => Number(fp.slice(2)) * 100 + Number(fp.slice(0, 2));
  if (key(omon) >= key(ctx.fp)) add('omon', `Original month ${omon} must be before this return period ${ctx.fp}`, { value: omon });
}

function amendment<S extends Section, B extends Section>(base: Rule<B>, extra: (r: Gstr1Record<S>, add: Add, ctx: ReturnContext) => void): Rule<S> {
  return (r, add, ctx) => {
    base(r as unknown as Gstr1Record<B>, amendAdd(add), ctx);
    extra(r, add, ctx);
  };
}

type AmendSection = 'b2ba' | 'b2cla' | 'expa' | 'cdnra' | 'cdnura' | 'b2csa' | 'ata' | 'txpda';

const BASE_RULES: { [S in Exclude<Section, AmendSection>]: Rule<S> } = {
  b2b(r, add, ctx) {
    const d = r.data;
    gstinField(add, 'ctin', d.ctin, ctx, 'Recipient GSTIN');
    docNumber(add, 'inum', d.inum, 'Invoice number');
    docDate(add, 'idt', d.idt, ctx, 'Invoice date');
    posCheck(add, d.pos);
    diffCheck(add, d.diffPercent);
    if (!['R', 'SEWP', 'SEWOP', 'DE', 'CBW'].includes(d.invTyp)) add('invTyp', `Unknown invoice type "${d.invTyp}"`, { value: d.invTyp, suggestion: 'Regular B2B / SEZ supplies with payment / SEZ supplies without payment / Deemed Exp / Intra-State supplies attracting IGST' });
    if (d.invTyp === 'CBW' && d.pos !== ss(ctx)) add('invTyp', '"Intra-State supplies attracting IGST" requires POS = your state', { value: d.pos });
    if ((d.invTyp === 'SEWP' || d.invTyp === 'SEWOP') && d.rchrg === 'Y') add('rchrg', 'Reverse charge is not applicable to SEZ supplies', { value: 'Y' });
    if (d.etin) gstinField(add, 'etin', d.etin, ctx, 'E-commerce GSTIN');
    invoiceValueCheck(add, d.val, d.items);
    itemsCheck(add, d.items, ctx, {
      pos: d.pos, supplierState: ss(ctx), diffPercent: d.diffPercent,
      forceIgst: ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp), noTax: d.invTyp === 'SEWOP',
    });
  },
  b2cl(r, add, ctx) {
    const d = r.data;
    docNumber(add, 'inum', d.inum, 'Invoice number');
    docDate(add, 'idt', d.idt, ctx, 'Invoice date');
    posCheck(add, d.pos);
    diffCheck(add, d.diffPercent);
    if (d.pos && d.pos === ss(ctx)) add('pos', 'B2C Large is only for inter-state supplies', { value: d.pos, suggestion: 'Move this invoice to B2C Others (b2cs).' });
    if (d.val != null && d.val <= ctx.profile.b2clThreshold) add('val', `Invoice value must exceed ₹${ctx.profile.b2clThreshold.toLocaleString('en-IN')} for B2C Large`, { value: d.val, suggestion: 'Move this invoice to B2C Others (b2cs).' });
    if (d.etin) gstinField(add, 'etin', d.etin, ctx, 'E-commerce GSTIN');
    invoiceValueCheck(add, d.val, d.items);
    itemsCheck(add, d.items, ctx, { pos: d.pos, supplierState: ss(ctx), diffPercent: d.diffPercent, forceIgst: true });
  },
  b2cs(r, add, ctx) {
    const d = r.data;
    posCheck(add, d.pos);
    diffCheck(add, d.diffPercent);
    if (d.typ !== 'OE' && d.typ !== 'E') add('typ', `Type must be OE or E (found "${d.typ}")`, { value: d.typ });
    if (d.typ === 'E' && !d.etin) add('etin', 'E-commerce GSTIN is mandatory when Type is E');
    if (d.typ === 'OE' && d.etin) add('etin', 'E-commerce GSTIN must be blank when Type is OE', { value: d.etin, suggestion: 'Change Type to E or clear the GSTIN.' });
    if (d.etin) gstinField(add, 'etin', d.etin, ctx, 'E-commerce GSTIN');
    rateCheck(add, d.rt, ctx);
    if (d.rt === 0) add('rt', 'B2C Others takes taxable supplies only – 0% (nil-rated / exempt) supplies go to Table 8', { value: 0, suggestion: 'Delete this line and enter the amount in Nil / Exempt (Table 8) under the matching inter/intra-state B2C description.' });
    nonNeg(add, 'txval', d.txval, 'Taxable value');
    taxCheck(add, d, d.txval, { pos: d.pos, supplierState: ss(ctx), diffPercent: d.diffPercent }, 0);
  },
  cdnr(r, add, ctx) {
    const d = r.data;
    gstinField(add, 'ctin', d.ctin, ctx, 'Recipient GSTIN');
    docNumber(add, 'ntNum', d.ntNum, 'Note number');
    docDate(add, 'ntDt', d.ntDt, ctx, 'Note date');
    posCheck(add, d.pos);
    diffCheck(add, d.diffPercent);
    if (d.ntty !== 'C' && d.ntty !== 'D') add('ntty', `Note type must be C or D (found "${d.ntty}")`, { value: d.ntty });
    if (!['R', 'SEWP', 'SEWOP', 'DE', 'CBW'].includes(d.invTyp)) add('invTyp', `Unknown note supply type "${d.invTyp}"`, { value: d.invTyp });
    invoiceValueCheck(add, d.val, d.items, 'Note value');
    itemsCheck(add, d.items, ctx, {
      pos: d.pos, supplierState: ss(ctx), diffPercent: d.diffPercent,
      forceIgst: ['SEWP', 'SEWOP', 'CBW'].includes(d.invTyp), noTax: d.invTyp === 'SEWOP',
    });
  },
  cdnur(r, add, ctx) {
    const d = r.data;
    docNumber(add, 'ntNum', d.ntNum, 'Note number');
    docDate(add, 'ntDt', d.ntDt, ctx, 'Note date');
    diffCheck(add, d.diffPercent);
    if (!['B2CL', 'EXPWP', 'EXPWOP'].includes(d.urType)) add('urType', `UR type must be B2CL, EXPWP or EXPWOP (found "${d.urType}")`, { value: d.urType });
    if (d.ntty !== 'C' && d.ntty !== 'D') add('ntty', `Note type must be C or D (found "${d.ntty}")`, { value: d.ntty });
    if (d.urType === 'B2CL') {
      posCheck(add, d.pos);
      if (d.pos === ss(ctx)) add('pos', 'B2CL notes must be inter-state', { value: d.pos });
    } else if (d.pos) add('pos', 'Place of supply must be blank for export notes', { value: d.pos, severity: 'warning' });
    invoiceValueCheck(add, d.val, d.items, 'Note value');
    itemsCheck(add, d.items, ctx, { pos: d.pos || '96', supplierState: ss(ctx), diffPercent: d.diffPercent, forceIgst: true, noTax: d.urType === 'EXPWOP' });
  },
  exp(r, add, ctx) {
    const d = r.data;
    docNumber(add, 'inum', d.inum, 'Invoice number');
    docDate(add, 'idt', d.idt, ctx, 'Invoice date');
    if (d.expTyp !== 'WPAY' && d.expTyp !== 'WOPAY') add('expTyp', `Export type must be WPAY or WOPAY (found "${d.expTyp}")`, { value: d.expTyp });
    if (d.portCode && !/^[A-Z0-9]{6}$/.test(d.portCode)) add('portCode', 'Port code must be 6 alphanumeric characters', { value: d.portCode });
    if (d.sbNum && !/^\d{3,7}$/.test(d.sbNum)) add('sbNum', 'Shipping bill number must be 3–7 digits', { value: d.sbNum });
    if ((d.sbNum && !d.sbDt) || (!d.sbNum && d.sbDt)) add('sbDt', 'Shipping bill number and date must be given together');
    if (d.sbNum && !d.portCode) add('portCode', 'Port code is required when shipping bill is given');
    if (d.sbDt) {
      if (!isIsoDate(d.sbDt)) add('sbDt', 'Shipping bill date is not valid', { value: d.sbDt });
      else if (isIsoDate(d.idt) && d.sbDt < d.idt) add('sbDt', 'Shipping bill date cannot be before invoice date', { value: d.sbDt });
    }
    invoiceValueCheck(add, d.val, d.items);
    itemsCheck(add, d.items, ctx, { pos: '96', supplierState: ss(ctx), forceIgst: true, noTax: d.expTyp === 'WOPAY' });
  },
  at: (r, add, ctx) => advanceRule(r, add, ctx),
  txpd: (r, add, ctx) => advanceRule(r, add, ctx),
  nil(r, add) {
    const d = r.data;
    if (!['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'].includes(d.splyTy)) add('splyTy', `Unknown description "${d.splyTy}"`, { value: d.splyTy, suggestion: 'Use the four standard descriptions from the template.' });
    nonNeg(add, 'nilAmt', d.nilAmt, 'Nil rated');
    nonNeg(add, 'exptAmt', d.exptAmt, 'Exempted');
    nonNeg(add, 'ngsupAmt', d.ngsupAmt, 'Non-GST');
  },
  hsn_b2b: (r, add, ctx) => hsnRule(r, add, ctx, true),
  hsn_b2c: (r, add, ctx) => hsnRule(r, add, ctx, false),
  docs(r, add) {
    const d = r.data;
    if (!DOC_TYPES[d.docTyp]) add('docTyp', `Unknown nature of document "${d.docTyp}"`, { value: d.docTyp, suggestion: 'Pick a value from the template list (e.g. "Invoices for outward supply").' });
    if (!d.from) add('from', 'Serial number from is mandatory');
    if (!d.to) add('to', 'Serial number to is mandatory');
    if (d.from.length > 16 || d.to.length > 16) add('from', 'Serial numbers cannot exceed 16 characters');
    nonNeg(add, 'totnum', d.totnum, 'Total number');
    nonNeg(add, 'cancel', d.cancel, 'Cancelled', false);
    if (d.totnum != null && d.cancel != null && d.cancel > d.totnum) add('cancel', 'Cancelled cannot exceed total number', { value: d.cancel });
    const mf = d.from.match(/^(.*?)(\d+)$/), mt = d.to.match(/^(.*?)(\d+)$/);
    if (mf && mt && mf[1] === mt[1] && d.totnum != null) {
      const span = Number(mt[2]) - Number(mf[2]) + 1;
      if (span < 1) add('to', 'Serial "to" is lower than "from"', { value: d.to });
      else if (span !== d.totnum) add('totnum', `Total number (${d.totnum}) differs from series span (${span})`, {
        value: d.totnum, severity: 'warning',
        suggestion: span > d.totnum
          ? `If ${span - d.totnum} number${span - d.totnum === 1 ? ' was' : 's were'} cancelled, set total to ${span} and cancelled to ${span - d.totnum + (d.cancel ?? 0)}. Otherwise check the series.`
          : 'The total cannot be more than the numbers in the series – check "from", "to" and the total.',
      });
    }
  },
};

function advanceRule(r: Gstr1Record<'at' | 'txpd'>, add: Add, ctx: ReturnContext) {
  const d = r.data;
  posCheck(add, d.pos);
  diffCheck(add, d.diffPercent);
  if (!d.items.length) add('items', 'At least one rate row is required');
  d.items.forEach((it, idx) => {
    rateCheck(add, it.rt, ctx, `items[${idx}].rt`);
    nonNeg(add, `items[${idx}].adAmt`, it.adAmt, 'Advance amount');
    taxCheck(add, it, it.adAmt, { pos: d.pos, supplierState: ss(ctx), diffPercent: d.diffPercent }, idx);
  });
}

function hsnRule(r: Gstr1Record<'hsn_b2b' | 'hsn_b2c'>, add: Add, ctx: ReturnContext, b2b: boolean) {
  const d = r.data;
  const hc = checkHsn(d.hsn);
  // checkHsn tolerates "8471.30" for lookups; the portal and the JSON need digits only.
  if (hc.code !== d.hsn.trim() && /^\d+$/.test(hc.code)) add('hsn', 'HSN/SAC must be digits only – no spaces or dots', { value: d.hsn, suggestion: `Use ${hc.code}.` });
  for (const i of hc.issues) add('hsn', i.message, { value: d.hsn, severity: i.severity, suggestion: i.suggestion });
  if (hc.ok) {
    const min = b2b && ctx.aatoAbove5Cr ? ctx.profile.hsnDigits.above5Cr : ctx.profile.hsnDigits.upTo5Cr;
    if (d.hsn.length < min) add('hsn', `HSN must have at least ${min} digits for your turnover band`, { value: d.hsn, suggestion: `Report the ${min}-digit code.` });
  }
  const isSac = d.hsn.startsWith('99');
  if (!UQC_CODES[d.uqc]) add('uqc', `Invalid UQC "${d.uqc}"`, { value: d.uqc, suggestion: 'Use a GST UQC such as NOS, KGS, PCS, LTR (NA for services).' });
  if (isSac && d.uqc !== 'NA') add('uqc', 'Services (SAC 99xx) must use UQC "NA"', { value: d.uqc, suggestion: 'Set UQC = NA and quantity = 0.' });
  if (isSac && d.qty) add('qty', 'Quantity must be 0 for services', { value: d.qty });
  if (!isSac && d.uqc === 'NA') add('uqc', 'UQC "NA" is only for services', { value: d.uqc, severity: 'warning' });
  nonNeg(add, 'qty', d.qty, 'Quantity', false);
  rateCheck(add, d.rt, ctx);
  nonNeg(add, 'txval', d.txval, 'Taxable value');
  const i = d.iamt ?? 0, c = d.camt ?? 0, s = d.samt ?? 0;
  if (Math.abs(c - s) > 0.01) add('samt', 'Central and State/UT tax must be equal', { value: { camt: c, samt: s } });
  if (d.rt != null && d.txval != null) {
    const exp = (d.txval * d.rt) / 100;
    const tol = Math.max(TAX_TOLERANCE, exp * 0.001);
    if (Math.abs(i + c + s - exp) > tol) {
      // 65% concessional rate is the common legitimate exception
      const at65 = Math.abs(i + c + s - exp * 0.65) <= tol;
      if (!at65) add('iamt', `Tax (${round2(i + c + s)}) does not match taxable value × rate (${round2(exp)})`, { value: round2(i + c + s), suggestion: `Total tax should be ≈ ${round2(exp)}` });
    }
  }
}

const RULES: { [S in Section]: Rule<S> } = {
  ...BASE_RULES,
  b2ba: amendment<'b2ba', 'b2b'>(BASE_RULES.b2b, (r, add, ctx) => originalDoc(add, 'oinum', r.data.oinum, 'oidt', r.data.oidt, ctx, 'invoice')),
  b2cla: amendment<'b2cla', 'b2cl'>(BASE_RULES.b2cl, (r, add, ctx) => originalDoc(add, 'oinum', r.data.oinum, 'oidt', r.data.oidt, ctx, 'invoice')),
  expa: amendment<'expa', 'exp'>(BASE_RULES.exp, (r, add, ctx) => originalDoc(add, 'oinum', r.data.oinum, 'oidt', r.data.oidt, ctx, 'invoice')),
  cdnra: amendment<'cdnra', 'cdnr'>(BASE_RULES.cdnr, (r, add, ctx) => originalDoc(add, 'ontNum', r.data.ontNum, 'ontDt', r.data.ontDt, ctx, 'note')),
  cdnura: amendment<'cdnura', 'cdnur'>(BASE_RULES.cdnur, (r, add, ctx) => originalDoc(add, 'ontNum', r.data.ontNum, 'ontDt', r.data.ontDt, ctx, 'note')),
  b2csa: amendment<'b2csa', 'b2cs'>(BASE_RULES.b2cs, (r, add, ctx) => originalMonth(add, r.data.omon, ctx)),
  ata: amendment<'ata', 'at'>(BASE_RULES.at, (r, add, ctx) => originalMonth(add, r.data.omon, ctx)),
  txpda: amendment<'txpda', 'txpd'>(BASE_RULES.txpd, (r, add, ctx) => originalMonth(add, r.data.omon, ctx)),
};

/* ---------- cross-record checks ---------- */

/** "row 12" for Excel rows, otherwise where the record came from (manual entry, marketplace report). */
const sourceGroup = (r: AnyRecord) => (r.source.sheet === 'manual' ? 'manual' : r.source.sheet?.startsWith('mp:') ? r.source.sheet.split(':').slice(0, 2).join(':') : 'excel');
const where = (r: AnyRecord) => (r.source.rows?.length ? `row ${r.source.rows[0]}` : r.source.sheet === 'manual' ? 'a manual entry' : r.source.sheet || 'another record');

function crossChecks(records: AnyRecord[], ctx: ReturnContext, out: ValidationIssue[]) {
  const seen = new Map<string, AnyRecord>();
  const dup = (rec: AnyRecord, no: string, field: string, label: string) => {
    const k = `${label}|${no.toUpperCase()}`;
    const first = seen.get(k);
    if (first) {
      adder(rec, out, no)(field, `Duplicate ${label} number "${no}" (also in ${first.section}, ${where(first)})`, {
        value: no, code: 'DUPLICATE_DOCUMENT', suggestion: 'Each document number must be unique in a financial year.',
      });
    } else seen.set(k, rec);
  };
  const keys = new Map<string, AnyRecord>();
  for (const r of records) {
    if (r.section === 'b2b' || r.section === 'b2cl' || r.section === 'exp') dup(r, r.data.inum, 'inum', 'invoice');
    if (r.section === 'cdnr' || r.section === 'cdnur') dup(r, r.data.ntNum, 'ntNum', 'note');
    // An earlier document can be amended only once per return.
    if (r.section === 'b2ba' || r.section === 'b2cla' || r.section === 'expa') dup(r, r.data.oinum, 'oinum', 'amended original invoice');
    if (r.section === 'cdnra' || r.section === 'cdnura') dup(r, r.data.ontNum, 'ontNum', 'amended original note');
    if (r.section === 'nil' || r.section === 'hsn_b2b' || r.section === 'hsn_b2c') {
      // Lines from different sources (Excel, manual, each marketplace) are summed by the JSON generator;
      // a repeat inside one source is a data-entry mistake.
      const k = `${sourceGroup(r)}|${r.section === 'nil' ? r.data.splyTy : `${r.section}|${r.data.hsn}|${r.data.uqc}|${r.data.rt}`}`;
      const first = keys.get(k);
      if (first) adder(r, out)(r.section === 'nil' ? 'splyTy' : 'hsn', `Duplicate line (same as ${where(first)})`, { code: 'DUPLICATE_LINE', suggestion: 'Combine the two lines into one.' });
      else keys.set(k, r);
    }
  }

  // Table 12 reconciliation
  // Table 8 belongs to the B2B or B2C side by its supply type; nil-rated and exempt supplies are in
  // Table 12 at 0% (non-GST supplies are not).
  const nilSide = (splyTy: string) => (/B2B$/.test(splyTy) ? 'b2b' : 'b2c');
  const sum = (secs: Section[], sign = true, nil?: 'b2b' | 'b2c' | 'all') =>
    records.filter((r) => secs.includes(r.section) || (nil && r.section === 'nil' && (nil === 'all' || nilSide((r.data as { splyTy: string }).splyTy) === nil))).reduce((a, r) => {
      if (r.section === 'nil') { const d = r.data as { nilAmt: number | null; exptAmt: number | null }; return a + (d.nilAmt ?? 0) + (d.exptAmt ?? 0); }
      if (r.section === 'b2cs' || r.section === 'hsn_b2b' || r.section === 'hsn_b2c') return a + (r.data.txval ?? 0);
      if ('items' in r.data && r.section !== 'at' && r.section !== 'txpd') {
        const tx = (r.data.items as Item[]).reduce((x, i) => x + (i.txval ?? 0), 0);
        const neg = sign && (r.section === 'cdnr' || r.section === 'cdnur') && (r.data as { ntty: string }).ntty === 'C';
        return a + (neg ? -tx : tx);
      }
      return a;
    }, 0);
  const has = (s: Section) => records.some((r) => r.section === s);
  const NAMES: Partial<Record<Section, string>> = { b2b: 'B2B', cdnr: 'CN/DN registered', b2cl: 'B2C Large', b2cs: 'B2C Small', exp: 'Exports', cdnur: 'CN/DN unregistered' };
  const inr = (n: number) => `₹${round2(n).toLocaleString('en-IN')}`;
  const recon = (label: string, hsnSec: Section, secs: Section[], nil: 'b2b' | 'b2c' | 'all') => {
    const books = round2(sum(secs, true, nil)), hsn = round2(sum([hsnSec]));
    const diff = Math.abs(books - hsn);
    if (diff > Math.max(100, Math.abs(books) * 0.01)) {
      const parts = [...secs.filter(has).map((s) => `${NAMES[s] ?? s} ${inr(sum([s]))}`), ...(sum([], true, nil) ? [`Nil/exempt (Table 8) ${inr(sum([], true, nil))}`] : [])];
      out.push({
        code: 'HSN_RECONCILIATION', severity: 'warning', section: hsnSec, recordKey: '', field: 'txval', value: hsn,
        message: `${label}: HSN taxable value ${inr(hsn)} differs from the documents ${inr(books)} (${parts.join(' + ') || 'none'}) by ${inr(hsn - books)}`,
        suggestion: 'Table 12 should match the taxable value of these tables, net of credit notes. Common causes: an HSN row left out because returns exceeded sales, records added or edited by hand on one side only.',
      });
    }
  };
  if (ctx.profile.hsnSplit) {
    if ((has('b2b') || has('cdnr')) && !has('hsn_b2b')) out.push({ code: 'HSN_B2B_MISSING', severity: 'error', section: 'hsn_b2b', recordKey: '', field: 'hsn', message: 'B2B supplies exist but Table 12 (B2B HSN) is empty', suggestion: 'Fill the hsn(b2b) sheet.' });
    if ((has('b2cl') || has('b2cs') || has('exp')) && !has('hsn_b2c')) out.push({ code: 'HSN_B2C_MISSING', severity: 'warning', section: 'hsn_b2c', recordKey: '', field: 'hsn', message: 'B2C supplies exist but Table 12 (B2C HSN) is empty' });
    recon('B2B', 'hsn_b2b', ['b2b', 'cdnr'], 'b2b');
    recon('B2C', 'hsn_b2c', ['b2cl', 'b2cs', 'exp', 'cdnur'], 'b2c');
  } else {
    recon('All supplies', 'hsn_b2b', ['b2b', 'cdnr', 'b2cl', 'b2cs', 'exp', 'cdnur'], 'all');
  }
}

/* ---------- public API ---------- */

export interface ValidationSummary {
  total: number;
  valid: number;
  withErrors: number;
  withWarnings: number;
  errorCount: number;
  warningCount: number;
  bySection: Record<string, { total: number; errors: number }>;
}

export function validateRecord(rec: AnyRecord, ctx: ReturnContext): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const docNo =
    'inum' in rec.data ? rec.data.inum : 'ntNum' in rec.data ? rec.data.ntNum : 'hsn' in rec.data ? rec.data.hsn : undefined;
  (RULES[rec.section] as Rule<Section>)(rec as Gstr1Record<Section>, adder(rec, out, docNo), ctx);
  return out;
}

export function validateReturn(records: AnyRecord[], ctx: ReturnContext): { issues: ValidationIssue[]; summary: ValidationSummary } {
  const issues: ValidationIssue[] = [];
  for (const r of records) issues.push(...validateRecord(r, ctx));
  crossChecks(records, ctx, issues);

  const errKeys = new Set(issues.filter((i) => i.severity === 'error' && i.recordKey).map((i) => i.recordKey));
  const warnKeys = new Set(issues.filter((i) => i.severity === 'warning' && i.recordKey).map((i) => i.recordKey));
  const bySection: ValidationSummary['bySection'] = {};
  for (const r of records) {
    bySection[r.section] ??= { total: 0, errors: 0 };
    bySection[r.section].total++;
    if (errKeys.has(r.key)) bySection[r.section].errors++;
  }
  return {
    issues,
    summary: {
      total: records.length,
      valid: records.length - errKeys.size,
      withErrors: errKeys.size,
      withWarnings: warnKeys.size,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      bySection,
    },
  };
}
