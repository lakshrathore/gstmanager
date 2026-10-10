import 'server-only';
import {
  buildMarketplaceRecords, checkGstin, MARKETPLACES, parseCsv, readMarketplaceTables, readWorkbook, UQC_CODES,
  type DocLine, type MarketplaceId, type SaleLine, type SheetTable,
} from '@/engine';
import type { Auth } from '../../auth';
import { HttpError } from '../../http';
import { GeneratedJson, GstReturn, Gstr1Error, Gstr1Record } from '../../models';
import { auditReturn } from '../gst-audit';
import { contextFor, loadReturn, OTHER_SOURCES, revalidate } from '../gstr1';
import { changeStatus, DATA_LOCKED, normalizeStatus, STATUS_LABELS } from '../gst-status';

/**
 * Marketplace sales reports (Amazon MTR, Flipkart sales report, Meesho GST report, or a generic sales
 * register) → GSTR-1 records. All files of one marketplace are imported together so returns net
 * against sales; re-importing a marketplace replaces only that marketplace's records.
 */

const MAX_FILE = 40 * 1024 * 1024;

async function readFile(file: File): Promise<SheetTable[]> {
  const name = file.name;
  if (file.size > MAX_FILE) throw new HttpError(413, `${name} is too large (max 40 MB)`);
  if (/\.zip$/i.test(name)) throw new HttpError(400, `${name} is a ZIP file – extract it and upload the .xlsx / .csv files inside`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (/\.(csv|txt|tsv)$/i.test(name)) return [parseCsv(bytes.toString('utf8'), name)];
  if (/\.xlsx$/i.test(name)) {
    const tables = await readWorkbook(bytes);
    // Sheet names are prefixed with the file so messages point at the right file.
    return tables.map((t) => ({ ...t, name: tables.length > 1 ? `${name} › ${t.name}` : name }));
  }
  if (/\.xls$/i.test(name)) throw new HttpError(400, `${name} is an old .xls file – open it in Excel and save as .xlsx (or CSV)`);
  throw new HttpError(400, `${name}: upload .xlsx or .csv files`);
}

export async function importMarketplace(
  auth: Auth, returnId: string,
  input: { marketplace: MarketplaceId | 'auto'; etin?: string; uqc?: string },
  files: File[],
) {
  const { ret, company } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  if (DATA_LOCKED.has(status)) throw new HttpError(409, `The return is "${STATUS_LABELS[status]}" – import is locked.`);
  if (!files.length) throw new HttpError(400, 'Choose at least one report file');
  if (files.length > 12) throw new HttpError(400, 'Upload up to 12 files at a time');
  let etin = input.etin?.trim().toUpperCase() || undefined;
  if (etin) {
    const c = checkGstin(etin);
    if (!c.ok) throw new HttpError(400, `E-commerce operator GSTIN: ${c.reason}`);
    if (etin[13] !== 'C') throw new HttpError(400, 'E-commerce operator GSTIN should be the marketplace\'s TCS registration (14th character "C")');
  }
  const uqc = (input.uqc || 'NOS').toUpperCase();
  if (!UQC_CODES[uqc]) throw new HttpError(400, `Unknown UQC ${uqc}`);

  const ctx = contextFor(ret, company);
  const lines: SaleLine[] = [];
  const docs: DocLine[] = [];
  const detected = new Set<MarketplaceId>();
  const unread: { file: string; reason: string }[] = [];
  for (const file of files) {
    const res = readMarketplaceTables(await readFile(file), file.name, input.marketplace, ctx.profile.allowedRates);
    unread.push(...res.skipped);
    if (!res.marketplace) continue;
    detected.add(res.marketplace);
    lines.push(...res.lines);
    docs.push(...res.docs);
  }
  if (!detected.size) {
    throw new HttpError(422, 'No marketplace sales report recognised in these files', unread.map((u) => ({ sheet: u.file, reason: u.reason })));
  }
  if (detected.size > 1) throw new HttpError(400, `Upload one marketplace at a time (found ${[...detected].map((m) => MARKETPLACES[m].label).join(' and ')})`);
  const marketplace = [...detected][0];
  if (!lines.length) throw new HttpError(422, 'The report has no sale or return lines');

  // Meesho's report carries its own TCS GSTIN; use it when the user did not type one.
  let etinFromReport = false;
  if (!etin) {
    const fromReport = [...new Set(lines.map((l) => l.ecoGstin).filter((g): g is string => !!g && checkGstin(g).ok))];
    if (fromReport.length === 1) { etin = fromReport[0]; etinFromReport = true; }
  }

  const source = `mp:${marketplace}`;
  const built = buildMarketplaceRecords(lines, {
    marketplace, source, supplierGstin: company.gstin, fp: ret.fp, quarterly: !!ret.quarterly,
    hsnSplit: ctx.profile.hsnSplit, aatoAbove5Cr: ctx.aatoAbove5Cr, b2clThreshold: ctx.profile.b2clThreshold, allowedRates: ctx.profile.allowedRates, etin, uqc,
  }, docs);
  if (!built.records.length) throw new HttpError(422, `No lines for ${company.gstin} in these files (${built.summary.otherGstinLines} line(s) are for other GSTINs)`);
  // Own billing software: sales through no e-commerce operator, so no Type E reminder.
  if (!etin && marketplace !== 'generic') {
    built.issues.push({
      code: 'MP_ETIN', severity: 'warning', section: 'b2cs', recordKey: '', sheet: source, field: 'etin',
      message: `No e-commerce operator GSTIN given – ${MARKETPLACES[marketplace].label} B2C sales are reported as your own sales (Type OE)`,
      suggestion: `Re-import with ${MARKETPLACES[marketplace].label}'s TCS GSTIN for your state (on its TCS certificate / GSTR-2A TCS credit) so they are reported as Type E.`,
    });
  }

  // Replace this marketplace's previous import; everything else in the return stays – except a GSTR-1
  // Excel import holding the same invoices/notes (typically this report's own Excel download imported
  // back): the report replaces it, otherwise every document would be in the return twice.
  const base = { orgId: ret.orgId, returnId: ret._id };
  const docKey = (section: string, d: { inum?: string; ntNum?: string }) => `${section}|${String(d.inum ?? d.ntNum ?? '').trim().toUpperCase()}`;
  const DOC_SECTIONS = ['b2b', 'b2cl', 'exp', 'cdnr', 'cdnur'];
  const incoming = new Set(built.records.filter((r) => DOC_SECTIONS.includes(r.section)).map((r) => docKey(r.section, r.data as { inum?: string; ntNum?: string })));
  const fromExcel = incoming.size
    ? await Gstr1Record.find({ ...base, section: { $in: DOC_SECTIONS }, 'source.sheet': { $not: OTHER_SOURCES } }).select({ section: 1, data: 1 }).lean()
    : [];
  const replacesExcel = fromExcel.some((r) => incoming.has(docKey(r.section, r.data as { inum?: string; ntNum?: string })));
  const ours = (field: string) => (replacesExcel ? { $or: [{ [field]: source }, { [field]: { $not: OTHER_SOURCES } }] } : { [field]: source });
  await Promise.all([
    Gstr1Record.deleteMany({ ...base, ...ours('source.sheet') }),
    Gstr1Error.deleteMany({ ...base, origin: 'import', ...ours('sheet') }),
    GeneratedJson.deleteMany(base),
  ]);
  if (replacesExcel) {
    built.issues.push({
      code: 'IMPORT_REPLACED_EXCEL', severity: 'warning', section: 'b2b', recordKey: '', sheet: source, field: 'source',
      message: `The GSTR-1 Excel imported earlier has the same invoices as this ${MARKETPLACES[marketplace].label} report – it was replaced by the report`,
      suggestion: 'Nothing to do if that Excel was this return’s own download. Manual entries and other sales-report imports are kept.',
    });
  }
  for (let i = 0; i < built.records.length; i += 1000) {
    await Gstr1Record.insertMany(built.records.slice(i, i + 1000).map((r) => ({ ...base, section: r.section, key: r.key, source: r.source, data: r.data })), { ordered: false });
  }
  if (built.issues.length) await Gstr1Error.insertMany(built.issues.map((i) => ({ ...base, origin: 'import', ...i })));

  const summary = { ...built.summary, unreadFiles: unread, etinFromReport };
  const entry = { marketplace, label: MARKETPLACES[marketplace].label, importedAt: new Date(), etin: etin ?? '', uqc, summary };
  const others = ((ret as { marketplaceImports?: { marketplace: string }[] }).marketplaceImports ?? []).filter((m) => m.marketplace !== marketplace);
  const set = { marketplaceImports: [...others, entry], currentJsonId: null, jsonStale: false };
  if (status === 'draft') await changeStatus(auth, ret, 'imported', { note: `Imported ${MARKETPLACES[marketplace].label} report`, set });
  else await GstReturn.updateOne({ _id: ret._id }, { $set: set });

  await auditReturn(auth, ret, 'return.marketplace_import', {
    marketplace, files: summary.files, lines: summary.lines, sales: summary.sales, returns: summary.returns,
    netTaxable: summary.netTaxable, records: summary.records, issues: built.issues.length,
  });
  const validation = await revalidate(auth, returnId, { silent: true });
  return { marketplace, summary, issues: built.issues.length, validation: validation.summary };
}

/** Removes everything one marketplace import added. */
export async function removeMarketplace(auth: Auth, returnId: string, marketplace: string) {
  const { ret } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  if (DATA_LOCKED.has(status)) throw new HttpError(409, `The return is "${STATUS_LABELS[status]}" – changes are locked.`);
  if (!(marketplace in MARKETPLACES)) throw new HttpError(400, 'Unknown marketplace');
  const source = `mp:${marketplace}`;
  const base = { orgId: ret.orgId, returnId: ret._id };
  const res = await Gstr1Record.deleteMany({ ...base, 'source.sheet': source });
  await Gstr1Error.deleteMany({ ...base, origin: 'import', sheet: source });
  const left = ((ret as { marketplaceImports?: { marketplace: string }[] }).marketplaceImports ?? []).filter((m) => m.marketplace !== marketplace);
  await GstReturn.updateOne({ _id: ret._id }, { $set: { marketplaceImports: left, jsonStale: !!ret.currentJsonId } });
  await auditReturn(auth, ret, 'return.marketplace_removed', { marketplace, records: res.deletedCount });
  await revalidate(auth, returnId, { silent: true });
  return { removed: res.deletedCount };
}
