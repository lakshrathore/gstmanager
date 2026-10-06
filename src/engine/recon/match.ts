import { checkGstin } from '../util';
import { daysBetween, editDistance, matchKey, numericCore, panOf, totalTax } from './normalize';
import type {
  Diff, PurchaseDoc, ReconDecision, ReconOptions, ReconRow, ReconStatus, ReconSummary, ReconTotals,
} from './types';

/**
 * Books (purchase register) ↔ portal (GSTR-2A or GSTR-2B) reconciliation.
 *
 * Matching passes, each on what is still unmatched:
 *  1. manual links made by the user
 *  2. same supplier GSTIN + document type + normalised document number (exact text first)
 *  3. probable: same GSTIN + type, same numeric core or 1–2 character difference, amounts within
 *     tolerance and dates within `fuzzyDateDays`
 *  4. probable: same PAN (another GSTIN of the same supplier) + same normalised number
 * Matched pairs are compared field by field; differences above tolerance make a mismatch.
 * Leftovers are "not in portal" (books only) or "not in books" (portal only). Portal documents of
 * other periods are searched for books-only invoices (timing differences).
 */

export const DEFAULT_OPTIONS: Omit<ReconOptions, 'recipientGstin'> = { amountTolerance: 1, fuzzyDateDays: 30 };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function compare(b: PurchaseDoc, p: PurchaseDoc, o: ReconOptions): Diff[] {
  const diffs: Diff[] = [];
  const tol = o.amountTolerance;
  const amt = (field: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess') => {
    const d = r2(b[field] - p[field]);
    if (Math.abs(d) > tol) diffs.push({ field, books: r2(b[field]), portal: r2(p[field]), diff: d });
  };
  amt('taxable');
  const tb = totalTax(b), tp = totalTax(p);
  const headsDiffer = Math.abs(b.igst - p.igst) > tol || Math.abs(b.cgst - p.cgst) > tol || Math.abs(b.sgst - p.sgst) > tol;
  if (headsDiffer && Math.abs(tb - tp) <= tol) {
    // Same total tax booked under the wrong head – usually a wrong place of supply (inter vs intra state).
    diffs.push({ field: 'taxHead', books: b.igst ? 'IGST' : 'CGST+SGST', portal: p.igst ? 'IGST' : 'CGST+SGST' });
  } else {
    amt('igst'); amt('cgst'); amt('sgst');
  }
  amt('cess');
  if (Math.abs(tb - tp) > tol && !diffs.some((d) => d.field === 'taxHead')) diffs.push({ field: 'totalTax', books: r2(tb), portal: r2(tp), diff: r2(tb - tp) });
  if (b.docDate && p.docDate && b.docDate !== p.docDate) diffs.push({ field: 'docDate', books: b.docDate, portal: p.docDate });
  if (b.docNo.trim().toUpperCase() !== p.docNo.trim().toUpperCase()) diffs.push({ field: 'docNo', books: b.docNo, portal: p.docNo });
  if (b.rcm != null && p.rcm != null && b.rcm !== p.rcm) diffs.push({ field: 'rcm', books: b.rcm, portal: p.rcm });
  if (b.pos && p.pos && b.pos !== p.pos) diffs.push({ field: 'pos', books: b.pos, portal: p.pos });
  if (b.supplierGstin !== p.supplierGstin) diffs.push({ field: 'gstin', books: b.supplierGstin, portal: p.supplierGstin });
  return diffs;
}

/** Differences that make a pair a mismatch (document number spelling and date alone do not hide a match, but date is reported). */
const MATERIAL: ReadonlySet<Diff['field']> = new Set(['taxable', 'igst', 'cgst', 'sgst', 'cess', 'totalTax', 'taxHead', 'docDate', 'rcm', 'pos', 'gstin']);

function portalNotes(p: PurchaseDoc, periodOfRecon: string): string[] {
  const n: string[] = [];
  if (p.itcAvailable === false) n.push(`ITC not available as per ${p.source === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'}${p.itcReason ? `: ${p.itcReason}` : ''}`);
  if (p.supplierFiled === false) n.push('Supplier has not filed GSTR-1 for this document yet');
  if (p.gstinCancelledOn) n.push(`Supplier GSTIN cancelled from ${p.gstinCancelledOn}`);
  if (p.amended) n.push(`Amended by supplier${p.originalDocNo ? ` (original no. ${p.originalDocNo})` : ''}`);
  if (p.rcm) n.push('Reverse charge – pay tax yourself before claiming ITC');
  if (p.period && p.period !== periodOfRecon) n.push(`Appears in the ${p.source === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} of ${p.period.slice(0, 2)}/${p.period.slice(2)}`);
  return n;
}

function booksNotes(b: PurchaseDoc, o: ReconOptions): string[] {
  const n: string[] = [];
  const g = checkGstin(b.supplierGstin);
  if (!g.ok) n.push(`Supplier GSTIN in books looks wrong: ${g.reason}`);
  else if (b.supplierGstin === o.recipientGstin) n.push('Supplier GSTIN is your own GSTIN');
  return n;
}

export function reconcile(
  books: PurchaseDoc[], portal: PurchaseDoc[], opts: ReconOptions, decisions: ReconDecision[] = [],
  context: { period: string; otherPortal?: PurchaseDoc[] } = { period: '' },
): { rows: ReconRow[]; summary: ReconSummary } {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const rows: ReconRow[] = [];
  const ignoredBooks = new Map(decisions.filter((d) => d.action === 'ignore' && d.booksKey).map((d) => [d.booksKey!, d.reason ?? '']));
  const ignoredPortal = new Map(decisions.filter((d) => d.action === 'ignore' && d.portalKey).map((d) => [d.portalKey!, d.reason ?? '']));
  const accepted = new Set(decisions.filter((d) => d.action === 'accept').map((d) => `${d.booksKey}|${d.portalKey}`));

  // Duplicates inside one side: keep the first for matching, report the rest.
  const dedupe = (docs: PurchaseDoc[]) => {
    const seen = new Map<string, PurchaseDoc>();
    const dup: PurchaseDoc[] = [];
    for (const d of docs) {
      if (seen.has(d.key)) dup.push(d);
      else seen.set(d.key, d);
    }
    return { unique: [...seen.values()], dup };
  };
  const B = dedupe(books);
  const P = dedupe(portal);

  const freeB = new Set<PurchaseDoc>();
  const freeP = new Set<PurchaseDoc>();
  for (const b of B.unique) {
    if (ignoredBooks.has(b.key)) rows.push({ id: b.key, status: 'ignored', books: b, diffs: [], notes: booksNotes(b, o), ignoredReason: ignoredBooks.get(b.key) });
    else freeB.add(b);
  }
  for (const p of P.unique) {
    if (ignoredPortal.has(p.key)) rows.push({ id: p.key, status: 'ignored', portal: p, diffs: [], notes: portalNotes(p, context.period), ignoredReason: ignoredPortal.get(p.key) });
    else freeP.add(p);
  }

  const pair = (b: PurchaseDoc, p: PurchaseDoc, by: ReconRow['matchedBy'], probable = false) => {
    freeB.delete(b);
    freeP.delete(p);
    const diffs = compare(b, p, o);
    const isAccepted = accepted.has(`${b.key}|${p.key}`);
    const material = diffs.filter((d) => MATERIAL.has(d.field));
    const status: ReconStatus = isAccepted ? 'matched' : probable ? 'probable' : material.length ? 'mismatch' : 'matched';
    const notes = [...booksNotes(b, o), ...portalNotes(p, context.period)];
    if (by === 'pan') notes.unshift('Same supplier PAN but a different GSTIN – check which registration billed you');
    if (by === 'fuzzy') notes.unshift('Invoice number differs slightly – confirm it is the same invoice');
    if (isAccepted && material.length) notes.unshift('Differences accepted by you');
    rows.push({ id: `${b.key}~${p.key}`, status, books: b, portal: p, matchedBy: by, accepted: isAccepted || undefined, diffs, notes });
  };

  // 1. manual links
  const byKeyB = new Map(B.unique.map((b) => [b.key, b]));
  const byKeyP = new Map(P.unique.map((p) => [p.key, p]));
  for (const d of decisions.filter((x) => x.action === 'link')) {
    const b = byKeyB.get(d.booksKey ?? ''), p = byKeyP.get(d.portalKey ?? '');
    if (b && p && freeB.has(b) && freeP.has(p)) pair(b, p, 'manual');
  }

  // 2. GSTIN + type + normalised number (exact spelling preferred when several normalise alike)
  const portalByKey = new Map<string, PurchaseDoc[]>();
  for (const p of freeP) {
    const k = matchKey(p);
    if (!portalByKey.has(k)) portalByKey.set(k, []);
    portalByKey.get(k)!.push(p);
  }
  for (const b of [...freeB]) {
    const cands = (portalByKey.get(matchKey(b)) ?? []).filter((p) => freeP.has(p));
    if (!cands.length) continue;
    const exact = cands.find((p) => p.docNo.trim().toUpperCase() === b.docNo.trim().toUpperCase());
    const p = exact ?? cands[0];
    pair(b, p, exact ? 'exact' : 'normalised');
  }

  // 3. fuzzy – same GSTIN + type; number close; amounts and date agree
  const close = (b: PurchaseDoc, p: PurchaseDoc) =>
    Math.abs(b.taxable - p.taxable) <= o.amountTolerance && Math.abs(totalTax(b) - totalTax(p)) <= o.amountTolerance &&
    daysBetween(b.docDate, p.docDate) <= o.fuzzyDateDays;
  for (const b of [...freeB]) {
    const core = numericCore(b.docNo);
    const cands = [...freeP].filter((p) => p.supplierGstin === b.supplierGstin && p.docType === b.docType && close(b, p));
    const hit = cands.find((p) => core && numericCore(p.docNo) === core)
      ?? cands.find((p) => editDistance(matchKey(b), matchKey(p), 2) <= 2);
    if (hit) pair(b, hit, 'fuzzy', true);
  }

  // 4. same PAN, other GSTIN
  for (const b of [...freeB]) {
    const pan = panOf(b.supplierGstin);
    if (!pan) continue;
    const hit = [...freeP].find((p) => p.supplierGstin !== b.supplierGstin && panOf(p.supplierGstin) === pan && p.docType === b.docType &&
      matchKey({ ...p, supplierGstin: '' }) === matchKey({ ...b, supplierGstin: '' }));
    if (hit) pair(b, hit, 'pan', true);
  }

  // 5. leftovers (books-only invoices are looked up in the portal data of other periods)
  const other = new Map<string, PurchaseDoc>();
  for (const p of context.otherPortal ?? []) other.set(matchKey(p), p);
  for (const b of freeB) {
    const notes = booksNotes(b, o);
    const elsewhere = other.get(matchKey(b));
    if (elsewhere) notes.unshift(`Found in the ${elsewhere.source === 'gstr2b' ? 'GSTR-2B' : 'GSTR-2A'} of ${elsewhere.period.slice(0, 2)}/${elsewhere.period.slice(2)} – timing difference`);
    rows.push({ id: b.key, status: 'not_in_portal', books: b, diffs: [], notes });
  }
  for (const p of freeP) rows.push({ id: p.key, status: 'not_in_books', portal: p, diffs: [], notes: portalNotes(p, context.period) });
  for (const d of B.dup) rows.push({ id: `${d.key}#dup${rows.length}`, status: 'not_in_portal', books: d, diffs: [], notes: ['Duplicate entry in books – the same invoice is entered more than once'] });
  for (const d of P.dup) rows.push({ id: `${d.key}#dup${rows.length}`, status: 'not_in_books', portal: d, diffs: [], notes: ['Duplicate in portal data'] });

  return { rows, summary: summarise(rows) };
}

function summarise(rows: ReconRow[]): ReconSummary {
  const z = (): ReconTotals => ({ count: 0, taxable: 0, tax: 0 });
  const byStatus = { matched: z(), mismatch: z(), probable: z(), not_in_portal: z(), not_in_books: z(), ignored: z() } as Record<ReconStatus, ReconTotals>;
  const books = z(), portal = z();
  const sign = (d: PurchaseDoc) => (d.docType === 'CN' ? -1 : 1);
  const itc = { books: 0, portal: 0, matched: 0, difference: 0 };
  for (const r of rows) {
    const doc = r.books ?? r.portal!;
    const t = byStatus[r.status];
    t.count++;
    t.taxable += sign(doc) * doc.taxable;
    t.tax += sign(doc) * totalTax(doc);
    if (r.status === 'ignored') continue;
    if (r.books) { books.count++; books.taxable += sign(r.books) * r.books.taxable; books.tax += sign(r.books) * totalTax(r.books); itc.books += sign(r.books) * totalTax(r.books); }
    if (r.portal) {
      portal.count++; portal.taxable += sign(r.portal) * r.portal.taxable; portal.tax += sign(r.portal) * totalTax(r.portal);
      if (r.portal.itcAvailable !== false) itc.portal += sign(r.portal) * totalTax(r.portal);
    }
    if (r.books && r.portal && r.status === 'matched' && r.portal.itcAvailable !== false) itc.matched += sign(r.books) * Math.min(totalTax(r.books), totalTax(r.portal));
  }
  for (const t of [...Object.values(byStatus), books, portal]) { t.taxable = r2(t.taxable); t.tax = r2(t.tax); }
  return { byStatus, books, portal, itc: { books: r2(itc.books), portal: r2(itc.portal), matched: r2(itc.matched), difference: r2(itc.books - itc.portal) } };
}
