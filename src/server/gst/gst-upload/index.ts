import 'server-only';
import { periodBounds } from '@/engine';
import { can, type Auth } from '../../auth';
import { sha256 } from '../../crypto';
import { HttpError } from '../../http';
import { GeneratedJson, GstReturn, oid, PortalEvidence, UploadJob, type CompanyDoc, type GstReturnDoc } from '../../models';
import { auditReturn } from '../gst-audit';
import { describeGstnError, getGstClient, GstnError, type GstClientCapabilities, type UploadContext } from '../gst-client';
import {
  errorLines, findGstr1Filing, type FiledReturn, flattenErrorReport, maskPan, PAN_RE, parseGstnDate, parseSummary, STATUS_CD_LABEL,
} from '../gst-client/sandbox-protocol';
import { importPortalErrorReport } from '../gst-error';
import { gstnHttpError, loginInfo } from '../gst-login';
import { sessionState } from '../gst-session';
import { assertCanMove, changeStatus, normalizeStatus, type ReturnStatus } from '../gst-status';
import { jsonFileName, loadReturn } from '../gstr1';
import { compareSummary, hasDifferences, type AppSectionTotals } from './summary';

/**
 * The GST-portal half of the workflow. With the manual client every portal-side transition is driven
 * by the user recording what the GST portal showed them. With an API client (Sandbox) each transition
 * is driven by GSTN's own response, which is stored as evidence before the status changes. In both
 * cases the app never assumes an outcome.
 */

export interface EvidenceFile {
  name: string;
  type: string;
  bytes: Buffer;
}

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const EVIDENCE_TYPES = /^(application\/pdf|image\/(png|jpeg)|application\/json|text\/plain)$/;

function checkFile(f?: EvidenceFile) {
  if (!f) return;
  if (f.bytes.length > MAX_EVIDENCE_BYTES) throw new HttpError(413, 'Attachment too large (max 5 MB)');
  if (!EVIDENCE_TYPES.test(f.type)) throw new HttpError(415, 'Attach a PDF, PNG, JPG, JSON or text file');
}

const cleanRef = (s?: string) => (s ?? '').trim().replace(/\s+/g, ' ').slice(0, 64);

async function addEvidence(
  auth: Auth,
  ret: { _id: unknown; orgId: unknown },
  kind: 'upload_reference' | 'processing_result' | 'summary' | 'acknowledgement' | 'note',
  input: { reference?: string; note?: string; file?: EvidenceFile },
) {
  const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
  const ev = await PortalEvidence.create({
    orgId: ret.orgId, returnId: ret._id, uploadJobId: job?._id, kind,
    reference: cleanRef(input.reference) || undefined, note: input.note?.trim().slice(0, 1000) || undefined,
    ...(input.file
      ? { fileName: input.file.name.slice(0, 200), contentType: input.file.type, sizeBytes: input.file.bytes.length, sha256: sha256(input.file.bytes), content: input.file.bytes }
      : {}),
    recordedBy: oid(auth.userId), recordedByEmail: auth.email,
  });
  return { ev, job };
}

async function jobEvent(jobId: unknown, status: string, note: string, by: string, set: Record<string, unknown> = {}) {
  if (!jobId) return;
  await UploadJob.updateOne({ _id: jobId }, { $set: { status, ...set }, $push: { history: { at: new Date(), status, note, by } } });
}

/* ---------- overview ---------- */

const ACTIONS: Partial<Record<ReturnStatus, string[]>> = {
  json_generated: ['mark_ready'],
  ready_for_upload: ['start_upload'],
  uploading: ['confirm_uploaded', 'cancel_upload'],
  uploaded: ['mark_processing', 'record_processed', 'import_error_report'],
  processing: ['record_processed', 'import_error_report'],
  error: ['import_error_report'],
  processed: ['record_filed'],
};

/** With an API client the portal steps are GSTN calls instead of user records. */
const API_ACTIONS: Partial<Record<ReturnStatus, string[]>> = {
  json_generated: ['mark_ready'],
  ready_for_upload: ['start_upload'],
  uploading: ['cancel_upload'],
  uploaded: ['check_status'],
  processing: ['check_status'],
  processed: ['proceed_to_file', 'fetch_summary', 'request_evc_otp', 'file_return', 'fetch_arn'],
};

const uploadCtx = (auth: Auth, ret: GstReturnDoc, company: CompanyDoc): UploadContext => ({
  orgId: auth.orgId, companyId: String(company._id), gstin: ret.gstin, fp: ret.fp,
});

function apiClient(cap: keyof GstClientCapabilities) {
  const client = getGstClient();
  if (!client.capabilities[cap]) throw new HttpError(409, 'This step needs the GST API integration (GST_INTEGRATION=sandbox).');
  return client;
}

/** A GSTN response kept as evidence (pretty JSON). Callers never pass anything containing tokens. */
const gstnFile = (name: string, raw: unknown): EvidenceFile => ({ name, type: 'application/json', bytes: Buffer.from(JSON.stringify(raw ?? null, null, 2)) });

async function evidenceJson(ret: { _id: unknown; orgId: unknown }, evidenceId: unknown, kind: string): Promise<unknown> {
  const ev = await PortalEvidence.findOne({ _id: evidenceId, returnId: ret._id, orgId: ret.orgId, kind }).select('+content').lean();
  if (!ev?.content) return null;
  const c = ev.content as unknown as Buffer | { buffer: ArrayBuffer | Buffer };
  return JSON.parse((Buffer.isBuffer(c) ? c : Buffer.from(c.buffer as ArrayBuffer)).toString('utf8'));
}

/** GSTN's summary next to the app's totals for the JSON that was uploaded. */
async function summaryView(ret: GstReturnDoc) {
  const id = ret.portal?.summaryEvidenceId;
  if (!id) return null;
  const [raw, ev, job] = await Promise.all([
    evidenceJson(ret, id, 'summary'),
    PortalEvidence.findById(id).select({ createdAt: 1, recordedByEmail: 1 }).lean(),
    UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id, client: { $ne: 'manual' } }).sort({ createdAt: -1 }).select({ jsonId: 1 }).lean(),
  ]);
  if (!raw) return null;
  const summary = parseSummary(raw);
  const json = await GeneratedJson.findOne({ _id: job?.jsonId ?? ret.currentJsonId, orgId: ret.orgId }).select({ log: 1, sha256: 1 }).lean();
  const rows = compareSummary((json?.log as { sections?: Record<string, AppSectionTotals> } | undefined)?.sections, summary.sec_sum);
  return {
    evidenceId: String(id), fetchedAt: ev?.createdAt, fetchedBy: ev?.recordedByEmail, chksum: summary.chksum,
    jsonSha256: json?.sha256, rows, hasDifferences: hasDifferences(rows),
  };
}

export async function portalOverview(auth: Auth, returnId: string) {
  const { ret, company } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  const client = getGstClient();
  const [evidence, jobs, json, session, summary] = await Promise.all([
    PortalEvidence.find({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean(),
    UploadJob.find({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ret.currentJsonId ? GeneratedJson.findById(ret.currentJsonId).select({ sha256: 1, version: 1, createdAt: 1, sizeBytes: 1 }).lean() : null,
    sessionState(uploadCtx(auth, ret, company)),
    client.capabilities.fileReturn ? summaryView(ret) : null,
  ]);
  return {
    status,
    actions: (client.capabilities.upload ? API_ACTIONS : ACTIONS)[status] ?? [],
    client: { id: client.id, label: client.label, capabilities: client.capabilities },
    login: loginInfo(),
    session,
    summary,
    json: json && !ret.jsonStale ? { ...json, fileName: jsonFileName(ret.gstin, ret.fp) } : null,
    portal: ret.portal ?? {},
    statusHistory: [...(ret.statusHistory ?? [])].reverse(),
    evidence,
    jobs,
  };
}

/* ---------- application → portal hand-off ---------- */

/** Reviewer sign-off: the current JSON is clean and approved for upload. */
export async function markReady(auth: Auth, returnId: string, note?: string) {
  const { ret } = await loadReturn(auth, returnId);
  const s = ret.summary as { errorCount?: number } | undefined;
  if (!ret.currentJsonId || ret.jsonStale) throw new HttpError(409, 'Generate the JSON again – records changed since it was generated');
  if (s?.errorCount) throw new HttpError(409, 'Validation errors must be fixed first');
  const json = await GeneratedJson.findById(ret.currentJsonId).select({ sha256: 1, version: 1 }).lean();
  await changeStatus(auth, ret, 'ready_for_upload', { note: note || `Approved JSON sha256 ${json?.sha256.slice(0, 12)}…` });
  await auditReturn(auth, ret, 'upload.approved', { jsonSha256: json?.sha256, version: json?.version, note });
}

/**
 * Starts an upload attempt. With the manual client this records the attempt; the user uploads on the
 * portal. With an API client the JSON is sent to GSTN (Save GSTR-1) and GSTN's reference is recorded.
 */
export async function startUpload(auth: Auth, returnId: string) {
  const { ret, company } = await loadReturn(auth, returnId);
  if (normalizeStatus(ret.status) !== 'ready_for_upload') throw new HttpError(409, 'Mark the return ready for upload first');
  const json = await GeneratedJson.findOne({ _id: ret.currentJsonId, orgId: ret.orgId }).lean();
  if (!json || ret.jsonStale) throw new HttpError(409, 'Generate the JSON again before uploading');
  const client = getGstClient();
  const ctx = uploadCtx(auth, ret, company);
  const viaApi = client.capabilities.upload && !!client.upload;
  if (viaApi && (await sessionState(ctx)).state !== 'active') throw new HttpError(409, 'Log in to GST with an OTP before sending the return', { session: 'required' });
  const startedAt = new Date();
  const job = await UploadJob.create({
    orgId: ret.orgId, returnId: ret._id, jsonId: json._id, jsonSha256: json.sha256, client: client.id, status: 'uploading',
    history: [{ at: startedAt, status: 'uploading', note: viaApi ? `Submitting via ${client.label}` : 'Waiting for the user to upload on the GST portal', by: auth.email }],
    createdBy: oid(auth.userId),
  });
  await changeStatus(auth, ret, 'uploading', { note: `Upload attempt ${String(job._id).slice(-6)}` });
  await auditReturn(auth, ret, 'upload.attempt', { uploadJobId: String(job._id), startedAt: startedAt.toISOString(), client: client.id, jsonSha256: json.sha256, version: json.version });

  if (viaApi) {
    // Official integration path – the reference comes from GSTN, never from this app.
    let res: Awaited<ReturnType<NonNullable<typeof client.upload>>>;
    try {
      res = await client.upload!(ctx, json.payload, jsonFileName(ret.gstin, ret.fp));
    } catch (e) {
      const why = e instanceof GstnError ? describeGstnError(e) : 'The submission failed before GSTN answered';
      const { ret: cur } = await loadReturn(auth, returnId);
      await changeStatus(auth, cur, 'ready_for_upload', { note: `Not submitted: ${why}`.slice(0, 500) });
      await jobEvent(job._id, 'error', why, auth.email);
      await auditReturn(auth, ret, 'upload.failed', { uploadJobId: String(job._id), client: client.id, gstnCode: e instanceof GstnError ? e.code ?? null : null });
      return gstnHttpError(e);
    }
    await confirmUploaded(auth, returnId, {
      reference: res.reference, note: `Saved to GSTN via ${client.label}`, file: gstnFile('gstn-save-gstr1-response.json', res.raw),
    });
    return { ok: true, reference: res.reference };
  }
  return { uploadJobId: String(job._id), downloadUrl: `/api/returns/${returnId}/json?download=1`, portalUrl: loginInfo().portalUrl };
}

export async function cancelUpload(auth: Auth, returnId: string, note?: string) {
  const { ret } = await loadReturn(auth, returnId);
  const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
  await changeStatus(auth, ret, 'ready_for_upload', { note: note || 'Upload cancelled' });
  await jobEvent(job?._id, 'cancelled', note || 'Cancelled by user', auth.email);
  await auditReturn(auth, ret, 'upload.cancelled', { uploadJobId: job ? String(job._id) : undefined, note });
}

/** User confirms the JSON was uploaded on the portal; optional portal reference/note recorded as evidence. */
export async function confirmUploaded(auth: Auth, returnId: string, input: { reference?: string; note?: string; file?: EvidenceFile }) {
  checkFile(input.file);
  const { ret } = await loadReturn(auth, returnId);
  if (normalizeStatus(ret.status) !== 'uploading') throw new HttpError(409, 'Start the upload first');
  const reference = cleanRef(input.reference);
  const { ev, job } = await addEvidence(auth, ret, 'upload_reference', { ...input, note: input.note || 'User confirmed the JSON was uploaded on the GST portal' });
  await changeStatus(auth, ret, 'uploaded', { evidenceId: String(ev._id), note: reference ? `Portal reference ${reference}` : 'Upload confirmed by user', set: reference ? { 'portal.uploadReference': reference } : undefined });
  await jobEvent(job?._id, 'uploaded', reference ? `Reference ${reference}` : 'Confirmed by user', auth.email, reference ? { reference } : {});
  await auditReturn(auth, ret, 'upload.confirmed', { evidenceId: String(ev._id), reference: reference || null, uploadJobId: job ? String(job._id) : undefined });
  return { ok: true };
}

export async function markProcessing(auth: Auth, returnId: string, note?: string) {
  const { ret } = await loadReturn(auth, returnId);
  const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
  await changeStatus(auth, ret, 'processing', { note: note || 'Portal shows the file as in progress' });
  await jobEvent(job?._id, 'processing', note || 'Portal processing', auth.email);
}

/** Processed requires something from the portal: its reference/status text or an attached screenshot/PDF. */
export async function recordProcessed(auth: Auth, returnId: string, input: { reference?: string; note?: string; file?: EvidenceFile }) {
  checkFile(input.file);
  const reference = cleanRef(input.reference);
  if (!reference && !input.file) throw new HttpError(422, 'Enter the reference/status shown by the GST portal or attach its screenshot/PDF');
  const { ret } = await loadReturn(auth, returnId);
  assertCanMove(ret.status, 'processed');
  const { ev, job } = await addEvidence(auth, ret, 'processing_result', input);
  await changeStatus(auth, ret, 'processed', {
    evidenceId: String(ev._id), note: reference ? `Portal: ${reference}` : `Portal confirmation attached (${input.file?.name})`,
    set: reference ? { 'portal.processingReference': reference } : undefined,
  });
  await jobEvent(job?._id, 'processed', reference || 'Confirmation attached', auth.email);
  await auditReturn(auth, ret, 'portal.processed_recorded', { evidenceId: String(ev._id), reference: reference || null, attachment: input.file?.name ?? null, attachmentSha256: ev.sha256 ?? null });
}

/** Filed requires the ARN from the portal's filing acknowledgement. */
export async function recordFiled(auth: Auth, returnId: string, input: { arn: string; filedOn: string; note?: string; file?: EvidenceFile }) {
  checkFile(input.file);
  const arn = (input.arn ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{15}$/.test(arn)) throw new HttpError(422, 'Enter the 15-character ARN exactly as shown on the GST portal acknowledgement');
  const { ret } = await loadReturn(auth, returnId);
  const filedOn = new Date(`${input.filedOn}T00:00:00Z`);
  if (isNaN(filedOn.getTime())) throw new HttpError(422, 'Enter the filing date');
  if (filedOn.getTime() > Date.now() + 86_400_000) throw new HttpError(422, 'Filing date cannot be in the future');
  if (input.filedOn < periodBounds(ret.fp, !!ret.quarterly).start) throw new HttpError(422, 'Filing date is before the return period');
  assertCanMove(ret.status, 'filed');
  const { ev, job } = await addEvidence(auth, ret, 'acknowledgement', { reference: arn, note: input.note, file: input.file });
  await changeStatus(auth, ret, 'filed', { evidenceId: String(ev._id), note: `ARN ${arn}`, set: { 'portal.arn': arn, 'portal.filedOn': filedOn } });
  await jobEvent(job?._id, 'filed', `ARN ${arn}`, auth.email);
  await auditReturn(auth, ret, 'portal.filed_recorded', { evidenceId: String(ev._id), arn, filedOn: input.filedOn, attachment: input.file?.name ?? null });
}

/* ---------- API integration: status → proceed → summary → EVC → file → ARN ---------- */

/** Polls GSTN for the saved upload. P → processed, PE/ER → GSTN's error report is imported and mapped. */
export async function checkGstnStatus(auth: Auth, returnId: string) {
  const client = apiClient('uploadStatus');
  const { ret, company } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  if (status !== 'uploaded' && status !== 'processing') throw new HttpError(409, 'Nothing is waiting for GSTN processing');
  const reference = ret.portal?.uploadReference;
  if (!reference) throw new HttpError(409, 'No GSTN reference is recorded for this upload');
  const res = await client.uploadStatus!(uploadCtx(auth, ret, company), reference).catch(gstnHttpError);
  const label = `${res.code} (${STATUS_CD_LABEL[res.code] ?? 'GSTN status'})`;
  await auditReturn(auth, ret, 'gst.status_checked', { reference, gstnStatus: res.code, transactionId: res.transactionId });

  if (res.state === 'processing') {
    if (status === 'uploaded') {
      const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
      await changeStatus(auth, ret, 'processing', { note: `GSTN status ${label}` });
      await jobEvent(job?._id, 'processing', `GSTN status ${label}`, auth.email);
    }
    return { state: 'processing', code: res.code, label };
  }

  if (res.state === 'processed') {
    const { ev, job } = await addEvidence(auth, ret, 'processing_result', { reference, note: `GSTN status ${label}`, file: gstnFile(`gstn-status-${res.code}.json`, res.raw) });
    await changeStatus(auth, ret, 'processed', { evidenceId: String(ev._id), note: `GSTN status ${label}`, set: { 'portal.processingReference': `GSTN ${res.code} · ${reference}`.slice(0, 64) } });
    await jobEvent(job?._id, 'processed', `GSTN status ${label}`, auth.email);
    await auditReturn(auth, ret, 'portal.processed_recorded', { evidenceId: String(ev._id), reference, gstnStatus: res.code });
    return { state: 'processed', code: res.code, label };
  }

  // PE / ER: GSTN's error report goes through the existing import + invoice mapping. The original
  // response is kept alongside; the parser reads only `error_report`.
  const report = { gstin: ret.gstin, fp: ret.fp, gstn_status: res.code, error_report: flattenErrorReport(res.errorReport ?? {}), gstn_response: res.raw };
  const r = await importPortalErrorReport(auth, returnId, { name: `gstn-error-report-${res.code}.json`, type: 'application/json', text: JSON.stringify(report, null, 2) });
  if (!r.count) {
    const { ret: cur } = await loadReturn(auth, returnId);
    await changeStatus(auth, cur, 'error', { evidenceId: r.evidenceId, note: `GSTN status ${label} without itemised errors` });
  }
  return { state: 'error', code: res.code, label, errors: r.count, matched: r.matched, messages: errorLines(res.errorReport) };
}

/** New Proceed to File: GSTN prepares the summary. Re-running it invalidates an earlier summary. */
export async function proceedToFile(auth: Auth, returnId: string) {
  const client = apiClient('fileReturn');
  const { ret, company } = await loadReturn(auth, returnId);
  if (normalizeStatus(ret.status) !== 'processed') throw new HttpError(409, 'GSTN must process the upload first');
  if (ret.portal?.fileSubmittedAt) throw new HttpError(409, 'This return was already submitted for filing – fetch the ARN instead');
  const res = await client.proceedToFile!(uploadCtx(auth, ret, company)).catch(gstnHttpError);
  const { ev } = await addEvidence(auth, ret, 'processing_result', { reference: res.reference, note: 'GSTN accepted proceed to file', file: gstnFile('gstn-proceed-to-file.json', res.raw) });
  await changeStatus(auth, ret, 'processed', { set: { 'portal.proceedReference': res.reference, 'portal.proceededAt': new Date(), 'portal.summaryEvidenceId': null, 'portal.evcRequestedAt': null } });
  await auditReturn(auth, ret, 'gst.proceed_to_file', { reference: res.reference, evidenceId: String(ev._id), transactionId: res.transactionId });
  return { ok: true, reference: res.reference };
}

/** Checks the proceed-to-file request, then fetches GSTN's GSTR-1 summary and keeps it as evidence. */
export async function fetchGstnSummary(auth: Auth, returnId: string) {
  const client = apiClient('fileReturn');
  const { ret, company } = await loadReturn(auth, returnId);
  if (normalizeStatus(ret.status) !== 'processed') throw new HttpError(409, 'GSTN must process the upload first');
  const proceedRef = ret.portal?.proceedReference;
  if (!proceedRef) throw new HttpError(409, 'Run "Proceed to file" first');
  const ctx = uploadCtx(auth, ret, company);

  const st = await client.uploadStatus!(ctx, proceedRef).catch(gstnHttpError);
  const label = `${st.code} (${STATUS_CD_LABEL[st.code] ?? 'GSTN status'})`;
  if (st.state === 'processing') return { pending: true, code: st.code, label };
  if (st.state === 'error') {
    await addEvidence(auth, ret, 'note', { reference: proceedRef, note: `Proceed to file: GSTN status ${label}`, file: gstnFile(`gstn-proceed-status-${st.code}.json`, st.raw) });
    const lines = errorLines(st.errorReport);
    throw new HttpError(422, `GSTN could not prepare the return for filing (${label})${lines.length ? `: ${lines.join('; ')}` : ''}`, { gstnStatus: st.code });
  }

  const res = await client.summary!(ctx).catch(gstnHttpError);
  if (res.summary.gstin && res.summary.gstin !== ret.gstin) throw new HttpError(422, `GSTN returned a summary for ${res.summary.gstin}, not ${ret.gstin}`);
  if (res.summary.ret_period && res.summary.ret_period !== ret.fp) throw new HttpError(422, `GSTN returned a summary for period ${res.summary.ret_period}, not ${ret.fp}`);
  const { ev } = await addEvidence(auth, ret, 'summary', {
    reference: res.summary.chksum, note: `GSTN GSTR-1 summary (${res.summary.sec_sum.length} sections)`, file: gstnFile('gstn-gstr1-summary.json', res.summary),
  });
  await changeStatus(auth, ret, 'processed', { set: { 'portal.summaryEvidenceId': ev._id } });
  const { ret: cur } = await loadReturn(auth, returnId);
  const view = await summaryView(cur);
  await auditReturn(auth, ret, 'gst.summary_fetched', {
    evidenceId: String(ev._id), chksum: res.summary.chksum, sections: res.summary.sec_sum.length, differences: !!view?.hasDifferences, transactionId: res.transactionId,
  });
  return { pending: false, evidenceId: String(ev._id) };
}

function assertCanFile(auth: Auth) {
  if (!can(auth, 'return:file')) throw new HttpError(403, 'Only an owner or admin can file the return');
}

function cleanPan(pan: string) {
  const p = (pan ?? '').trim().toUpperCase();
  if (!PAN_RE.test(p)) throw new HttpError(422, 'Enter the 10-character PAN of the authorised signatory');
  return p;
}

async function fileableReturn(auth: Auth, returnId: string) {
  const { ret, company } = await loadReturn(auth, returnId);
  if (normalizeStatus(ret.status) !== 'processed') throw new HttpError(409, 'GSTN must process the upload first');
  if (ret.portal?.fileSubmittedAt) throw new HttpError(409, 'This return was already submitted for filing – fetch the ARN instead');
  if (!ret.portal?.summaryEvidenceId) throw new HttpError(409, 'Fetch and review the GSTN summary first');
  return { ret, company };
}

/** Generate EVC OTP: GSTN sends an OTP to the signatory. The PAN is never stored or logged in full. */
export async function requestEvcOtp(auth: Auth, returnId: string, pan: string) {
  assertCanFile(auth);
  const p = cleanPan(pan);
  const client = apiClient('fileReturn');
  const { ret, company } = await fileableReturn(auth, returnId);
  const res = await client.requestEvcOtp!(uploadCtx(auth, ret, company), p).catch(gstnHttpError);
  await changeStatus(auth, ret, 'processed', { set: { 'portal.evcRequestedAt': new Date() } });
  await auditReturn(auth, ret, 'gst.evc_otp_requested', { pan: maskPan(p), transactionId: res.transactionId });
  return { ok: true };
}

/**
 * File GSTR-1 with EVC. Sends back exactly the GSTN summary the user reviewed (its checksum binds the
 * filing), stores GSTN's response as the acknowledgement, then asks GSTN for the ARN.
 */
export async function fileWithEvc(auth: Auth, returnId: string, input: { pan: string; otp: string; summaryEvidenceId: string; verified: boolean }) {
  assertCanFile(auth);
  if (input.verified !== true) throw new HttpError(422, 'Confirm that you have verified the GSTN summary');
  const p = cleanPan(input.pan);
  const otp = (input.otp ?? '').trim();
  if (!/^\d{4,8}$/.test(otp)) throw new HttpError(422, 'Enter the EVC OTP exactly as received');
  const client = apiClient('fileReturn');
  const { ret, company } = await fileableReturn(auth, returnId);
  if (String(ret.portal?.summaryEvidenceId) !== input.summaryEvidenceId) throw new HttpError(409, 'The GSTN summary changed since you reviewed it – review the latest summary and confirm again');
  const raw = await evidenceJson(ret, ret.portal!.summaryEvidenceId, 'summary');
  if (!raw) throw new HttpError(409, 'The reviewed GSTN summary could not be loaded – fetch it again');
  const summary = parseSummary(raw);

  const res = await client.fileReturn!(uploadCtx(auth, ret, company), p, otp, summary).catch(gstnHttpError);
  const { ev, job } = await addEvidence(auth, ret, 'acknowledgement', {
    reference: res.ackNum, note: `Filed with GSTN via ${client.label} (EVC, signatory PAN ${maskPan(p)})`, file: gstnFile('gstn-file-gstr1-response.json', res.raw),
  });
  await changeStatus(auth, ret, 'processed', { set: { 'portal.fileSubmittedAt': new Date(), ...(res.ackNum ? { 'portal.ackNum': res.ackNum } : {}) } });
  await jobEvent(job?._id, 'processed', `Filing submitted to GSTN${res.ackNum ? ` (ack ${res.ackNum})` : ''}`, auth.email);
  await auditReturn(auth, ret, 'gst.filed', {
    evidenceId: String(ev._id), ackNum: res.ackNum ?? null, pan: maskPan(p), summaryEvidenceId: input.summaryEvidenceId, chksum: summary.chksum, transactionId: res.transactionId,
  });
  let arn: { found: boolean; arn?: string; message?: string };
  try {
    arn = await fetchArn(auth, returnId);
  } catch (e) {
    arn = { found: false, message: (e as Error).message };
  }
  return { ackNum: res.ackNum ?? null, ...arn };
}

/** Track Returns: once GSTN lists the filed GSTR-1 with an ARN, the return moves to Filed. */
export async function fetchArn(auth: Auth, returnId: string): Promise<{ found: boolean; arn?: string; message?: string }> {
  const client = apiClient('fileReturn');
  const { ret, company } = await loadReturn(auth, returnId);
  const status = normalizeStatus(ret.status);
  if (status === 'filed') return { found: true, arn: ret.portal?.arn ?? undefined };
  if (status !== 'processed' || !ret.portal?.fileSubmittedAt) throw new HttpError(409, 'File the return first');
  const res = await client.trackReturn!(uploadCtx(auth, ret, company)).catch(gstnHttpError);
  const f = findGstr1Filing(res.filings, ret.fp);
  await auditReturn(auth, ret, 'gst.track_returns', { found: !!f, transactionId: res.transactionId });
  if (!f?.arn) return { found: false, message: 'GSTN has not listed an ARN for this GSTR-1 yet. Try "Fetch ARN" again in a few minutes.' };

  const arn = f.arn.toUpperCase();
  const filedOn = parseGstnDate(f.dof);
  const { ev, job } = await addEvidence(auth, ret, 'acknowledgement', {
    reference: arn, note: `GSTN Track Returns: ${f.status ?? 'Filed'}${f.dof ? ` on ${f.dof}` : ''}${f.mof ? ` (${f.mof})` : ''}`, file: gstnFile('gstn-track-returns.json', res.raw),
  });
  await changeStatus(auth, ret, 'filed', {
    evidenceId: String(ev._id), note: `ARN ${arn} (from GSTN)`, set: { 'portal.arn': arn, 'portal.filedVia': client.id, ...(filedOn ? { 'portal.filedOn': filedOn } : {}) },
  });
  await jobEvent(job?._id, 'filed', `ARN ${arn}`, auth.email);
  await auditReturn(auth, ret, 'portal.filed_recorded', { evidenceId: String(ev._id), arn, filedOn: f.dof ?? null, via: client.id });
  return { found: true, arn };
}

export async function addNote(auth: Auth, returnId: string, note: string) {
  if (!note?.trim()) throw new HttpError(400, 'Note is empty');
  const { ret } = await loadReturn(auth, returnId);
  const { ev } = await addEvidence(auth, ret, 'note', { note });
  await auditReturn(auth, ret, 'portal.note', { evidenceId: String(ev._id), note: note.slice(0, 200) });
}

export async function evidenceFile(auth: Auth, returnId: string, evidenceId: string) {
  const { ret } = await loadReturn(auth, returnId);
  const ev = await PortalEvidence.findOne({ _id: oid(evidenceId), returnId: ret._id, orgId: ret.orgId }).select('+content').lean();
  if (!ev?.content) throw new HttpError(404, 'No file attached to this evidence');
  const c = ev.content as unknown as Buffer | { buffer: ArrayBuffer | Buffer };
  return { ...ev, content: Buffer.isBuffer(c) ? c : Buffer.from(c.buffer as ArrayBuffer) };
}

/**
 * A GSTR-1 that GSTN lists as filed, found when the return was downloaded from the GST portal. GSTN's
 * Track Returns response is kept as the acknowledgement; the ARN and date are GSTN's, never made up.
 * The return was filed outside this app, so it moves to "filed" from whatever status it had here.
 */
export async function recordFiledFromGstn(auth: Auth, ret: GstReturnDoc, f: FiledReturn, raw: unknown) {
  if (!f.arn) throw new HttpError(422, 'GSTN listed no ARN');
  const arn = f.arn.toUpperCase();
  const filedOn = parseGstnDate(f.dof);
  const from = normalizeStatus(ret.status);
  const { ev } = await addEvidence(auth, ret, 'acknowledgement', {
    reference: arn, note: `GSTN Track Returns: ${f.status ?? 'Filed'}${f.dof ? ` on ${f.dof}` : ''} – found when downloading from the GST portal`,
    file: gstnFile('gstn-track-returns.json', raw),
  });
  await GstReturn.updateOne({ _id: ret._id }, {
    $set: { status: 'filed', 'portal.arn': arn, 'portal.filedVia': 'gstn-download', ...(filedOn ? { 'portal.filedOn': filedOn } : {}) },
    $push: { statusHistory: { from, to: 'filed', at: new Date(), by: oid(auth.userId), byEmail: auth.email, note: `Filed on GSTN, ARN ${arn} (downloaded from the GST portal)`, evidenceId: ev._id } },
  });
  await auditReturn(auth, ret, 'portal.filed_recorded', { evidenceId: String(ev._id), arn, filedOn: f.dof ?? null, via: 'gstn-download' });
  return arn;
}
