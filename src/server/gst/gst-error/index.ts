import 'server-only';
import { parsePortalErrorReport, type ValidationIssue } from '@/engine';
import type { Auth } from '../../auth';
import { sha256 } from '../../crypto';
import { HttpError } from '../../http';
import { Gstr1Error, Gstr1Record, oid, PortalEvidence, UploadJob } from '../../models';
import { auditReturn } from '../gst-audit';
import { changeStatus, normalizeStatus } from '../gst-status';
import { loadReturn } from '../gstr1';

/** Portal statuses in which a GST portal error report can be recorded. */
const ACCEPTS_REPORT = new Set(['uploaded', 'processing', 'error']);

/**
 * Records the error report the user downloaded from the GST portal, keeps the original file as
 * evidence, and maps each portal error back to the invoice/record it refers to.
 * A report with zero errors is stored but does NOT mark the return processed – processing must be
 * recorded separately with the portal's own confirmation.
 */
export async function importPortalErrorReport(auth: Auth, returnId: string, file: { name: string; type: string; text: string }) {
  const { ret } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  if (!ACCEPTS_REPORT.has(status)) throw new HttpError(409, 'Record the upload first – a portal error report belongs to an uploaded return');

  let report: unknown;
  try {
    report = JSON.parse(file.text);
  } catch {
    throw new HttpError(400, 'The error report must be the JSON file downloaded from the GST portal');
  }
  const r = report as { gstin?: string; fp?: string };
  if (r?.gstin && r.gstin !== ret.gstin) throw new HttpError(400, `Error report is for ${r.gstin}, not ${ret.gstin}`);
  if (r?.fp && r.fp !== ret.fp) throw new HttpError(400, `Error report is for period ${r.fp}, not ${ret.fp}`);
  const errors = parsePortalErrorReport(report);

  const base = { orgId: ret.orgId, returnId: ret._id };
  const job = await UploadJob.findOne(base).sort({ createdAt: -1 }).lean();
  const evidence = await PortalEvidence.create({
    ...base, uploadJobId: job?._id, kind: 'error_report', fileName: file.name, contentType: file.type || 'application/json',
    sizeBytes: Buffer.byteLength(file.text), sha256: sha256(file.text), content: Buffer.from(file.text),
    note: `${errors.length} error(s) in report`, recordedBy: oid(auth.userId), recordedByEmail: auth.email,
  });

  const docs = await Gstr1Record.find(base).select({ section: 1, key: 1, data: 1 }).lean();
  const findKey = (section: string, docNo?: string, ctin?: string) => {
    if (!docNo) return '';
    const up = docNo.toUpperCase();
    const d = docs.find((x) => {
      if (x.section !== section) return false;
      const dd = x.data as Record<string, string>;
      const no = String(dd.inum ?? dd.ntNum ?? dd.hsn ?? '').toUpperCase();
      return no === up && (!ctin || !dd.ctin || dd.ctin === ctin);
    });
    return d?.key ?? '';
  };
  const rows: Partial<ValidationIssue & { origin: string }>[] = errors.map((e) => ({
    origin: 'portal', code: e.errorCode ?? 'PORTAL', severity: 'error', section: e.section as ValidationIssue['section'],
    recordKey: findKey(e.section, e.documentNo, e.ctin), documentNo: e.documentNo, field: e.path, message: e.message,
    suggestion: 'Correct the record, regenerate the JSON and upload it again.',
  }));
  await Gstr1Error.deleteMany({ ...base, origin: 'portal' });
  if (rows.length) await Gstr1Error.insertMany(rows.map((x) => ({ ...base, ...x })));
  const keys = [...new Set(rows.map((x) => x.recordKey).filter(Boolean))];
  if (keys.length) await Gstr1Record.updateMany({ ...base, key: { $in: keys } }, { $set: { hasErrors: true } });

  await auditReturn(auth, ret, 'portal.error_report_imported', {
    evidenceId: String(evidence._id), fileName: file.name, sha256: evidence.sha256, errors: rows.length, matched: keys.length,
    unmatched: rows.length - rows.filter((x) => x.recordKey).length,
  });

  if (rows.length) {
    await changeStatus(auth, ret, 'error', { evidenceId: String(evidence._id), note: `Portal reported ${rows.length} error(s)` });
    if (job) await UploadJob.updateOne({ _id: job._id }, { $set: { status: 'error', portalErrorCount: rows.length }, $push: { history: { at: new Date(), status: 'error', note: `Portal error report: ${rows.length} error(s)`, by: auth.email } } });
  }
  return { count: rows.length, matched: keys.length, evidenceId: String(evidence._id), status: rows.length ? 'error' : status };
}
