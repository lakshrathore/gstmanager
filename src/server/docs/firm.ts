import 'server-only';
import { canAccessCompany, type Auth } from '../auth';
import { HttpError } from '../http';
import { fyInfo } from '../gst/annual/common';
import { ClientDoc, Company, DocRecord, oid } from '../models';

/**
 * Firm dashboard: every client × month of a financial year at a glance – what is uploaded, what waits
 * for review, errors, the ITC difference between purchase books and GSTR-2B, and missing GSTR-2B –
 * so the CA opens only the clients that need attention. Totals come from one aggregation, not from
 * re-running each client's full analysis.
 */

export type CellState = 'empty' | 'ok' | 'attention' | 'error';

export interface Cell {
  fp: string; state: CellState; records: number; review: number; errors: number;
  salesTaxable: number | null; purchaseTaxable: number | null; itcBooks: number | null; itcPortal: number | null; itcDiff: number | null;
  missing2b: boolean; bank: number; notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function firmOverview(auth: Auth, fy: string) {
  const info = fyInfo(fy);
  if (!info) throw new HttpError(400, 'Financial year must look like 2026-27');
  const companies = (await Company.find({ orgId: oid(auth.orgId) }).select({ name: 1, gstin: 1 }).sort({ name: 1 }).lean()).filter((c) => canAccessCompany(auth, String(c._id)));
  const ids = companies.map((c) => c._id);

  const tax = { $add: [{ $ifNull: ['$data.igst', 0] }, { $ifNull: ['$data.cgst', 0] }, { $ifNull: ['$data.sgst', 0] }, { $ifNull: ['$data.cess', 0] }] };
  const sign = { $cond: [{ $eq: ['$data.docType', 'CN'] }, -1, 1] };
  const [groups, docs] = await Promise.all([
    DocRecord.aggregate<{ _id: { c: unknown; fp: string; kind: string; source: string | null; dir: string | null }; n: number; taxable: number; tax: number; availTax: number; review: number; errors: number }>([
      { $match: { orgId: oid(auth.orgId), companyId: { $in: ids }, fy, review: { $ne: 'rejected' } } },
      {
        $group: {
          _id: { c: '$companyId', fp: '$fp', kind: '$kind', source: '$source', dir: '$direction' },
          n: { $sum: 1 },
          taxable: { $sum: { $multiply: [sign, { $ifNull: ['$data.taxable', 0] }] } },
          tax: { $sum: { $multiply: [sign, tax] } },
          availTax: { $sum: { $cond: [{ $eq: ['$data.itcAvailable', false] }, 0, { $multiply: [sign, tax] }] } },
          review: { $sum: { $cond: [{ $eq: ['$review', 'review'] }, 1, 0] } },
          errors: { $sum: { $cond: [{ $and: [{ $ne: ['$review', 'approved'] }, { $in: ['error', { $ifNull: ['$flags.severity', []] }] }] }, 1, 0] } },
        },
      },
    ]),
    ClientDoc.aggregate<{ _id: { c: unknown; status: string }; n: number }>([
      { $match: { orgId: oid(auth.orgId), companyId: { $in: ids }, $or: [{ fy }, { fy: null }, { fy: { $exists: false } }] } },
      { $group: { _id: { c: '$companyId', status: '$status' }, n: { $sum: 1 } } },
    ]),
  ]);

  const clients = companies.map((c) => {
    const mine = groups.filter((g) => String(g._id.c) === String(c._id));
    const cells: Cell[] = info.months.map((fp) => {
      const m = mine.filter((g) => g._id.fp === fp);
      const pick = (f: (g: (typeof m)[number]) => boolean) => m.filter(f);
      const sum = (gs: typeof m, k: 'n' | 'taxable' | 'tax' | 'availTax' | 'review' | 'errors') => gs.reduce((a, g) => a + g[k], 0);
      const books = (dir: string) => {
        const reg = pick((g) => g._id.kind === 'invoice' && g._id.dir === dir && g._id.source === 'register');
        return reg.length ? reg : pick((g) => g._id.kind === 'invoice' && g._id.dir === dir && g._id.source === 'document');
      };
      const sales = books('sales');
      const purchase = books('purchase');
      const portal = pick((g) => g._id.source === 'gstr2b').length ? pick((g) => g._id.source === 'gstr2b') : pick((g) => g._id.source === 'gstr2a');
      const records = sum(m, 'n');
      const review = sum(m, 'review');
      const errors = sum(m, 'errors');
      const itcBooks = purchase.length ? r2(sum(purchase, 'tax')) : null;
      const itcPortal = portal.length ? r2(sum(portal, 'availTax')) : null;
      const itcDiff = itcBooks != null && itcPortal != null ? r2(itcBooks - itcPortal) : null;
      const missing2b = !!purchase.length && !portal.length;
      const notes: string[] = [];
      if (errors) notes.push(`${errors} record(s) with errors`);
      if (review) notes.push(`${review} to review`);
      if (itcDiff != null && Math.abs(itcDiff) > 1) notes.push(`ITC difference ₹${Math.round(itcDiff).toLocaleString('en-IN')}`);
      if (missing2b) notes.push('GSTR-2B not uploaded');
      const state: CellState = !records ? 'empty' : errors ? 'error' : review || missing2b || (itcDiff != null && Math.abs(itcDiff) > 1) ? 'attention' : 'ok';
      return {
        fp, state, records, review, errors,
        salesTaxable: sales.length ? r2(sum(sales, 'taxable')) : null, purchaseTaxable: purchase.length ? r2(sum(purchase, 'taxable')) : null,
        itcBooks, itcPortal, itcDiff, missing2b, bank: sum(pick((g) => g._id.kind === 'bank'), 'n'), notes,
      };
    });
    const st = (s: string) => docs.filter((d) => String(d._id.c) === String(c._id) && d._id.status === s).reduce((a, d) => a + d.n, 0);
    const itcDiff = r2(cells.reduce((a, x) => a + (x.itcDiff ?? 0), 0));
    return {
      _id: String(c._id), name: c.name, gstin: c.gstin, cells,
      totals: {
        review: cells.reduce((a, x) => a + x.review, 0), errors: cells.reduce((a, x) => a + x.errors, 0), itcDiff,
        failed: st('failed'), processing: st('queued') + st('processing'), needsReview: st('needs_review'),
        monthsWithData: cells.filter((x) => x.records).length,
      },
    };
  });
  // Clients that need the CA first.
  const weight = (c: (typeof clients)[number]) => c.totals.errors * 3 + c.totals.review + c.totals.failed * 2 + (Math.abs(c.totals.itcDiff) > 1 ? 5 : 0) + c.cells.filter((x) => x.missing2b).length * 2;
  clients.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
  const unassigned = auth.companyIds.length ? 0 : await ClientDoc.countDocuments({ orgId: oid(auth.orgId), companyId: null, status: { $ne: 'duplicate' } });
  return { fy, months: info.months, clients, unassigned };
}

/** Recent uploads of this user (last 7 days): how far each batch has got. */
export async function recentBatches(auth: Auth) {
  const rows = await ClientDoc.aggregate<{ _id: string; total: number; at: Date; statuses: string[]; companies: unknown[] }>([
    { $match: { orgId: oid(auth.orgId), uploadedBy: auth.email, createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) }, batchId: { $ne: null } } },
    { $group: { _id: '$batchId', total: { $sum: 1 }, at: { $min: '$createdAt' }, statuses: { $push: '$status' }, companies: { $addToSet: '$companyId' } } },
    { $sort: { at: -1 } },
    { $limit: 5 },
  ]);
  return rows.map((b) => {
    const count = (s: string) => b.statuses.filter((x) => x === s).length;
    return {
      batchId: b._id, at: b.at, total: b.total,
      processed: count('processed'), needsReview: count('needs_review'), duplicate: count('duplicate'), failed: count('failed'),
      pending: count('queued') + count('processing'), clients: b.companies.filter(Boolean).length,
    };
  });
}
