import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { can } from '@/server/auth';
import { api, HttpError } from '@/server/http';
import { requireLicense } from '@/server/license';
import { endLogin, requestLoginOtp, verifyLoginOtp } from '@/server/gst/gst-login';
import {
  addNote, cancelUpload, checkGstnStatus, confirmUploaded, fetchArn, fetchGstnSummary, fileWithEvc, markProcessing, markReady,
  portalOverview, proceedToFile, recordFiled, recordProcessed, requestEvcOtp, startUpload, type EvidenceFile,
} from '@/server/gst/gst-upload';

/**
 * GST portal step: overview (GET) and portal actions (POST, JSON or multipart with "file").
 * Manual actions record what the user did on the portal; API actions (login_*, check_status …
 * fetch_arn) call GSTN through the configured client. OTPs and PANs in these bodies are passed
 * straight to GSTN and never stored or logged.
 */
export const GET = api('return:view', async (_req, { auth, params }) => ({
  ...(await portalOverview(auth, params.id)), canOperate: can(auth, 'portal:operate'), canFile: can(auth, 'return:file'),
}));

/** Actions that call GSTN through the API integration – need the plan's gstApi feature. */
const API_ACTIONS = new Set(['login_otp', 'login_verify', 'logout', 'check_status', 'proceed_to_file', 'fetch_summary', 'request_evc_otp', 'file_return', 'fetch_arn']);

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mark_ready'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('start_upload') }),
  z.object({ action: z.literal('cancel_upload'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('confirm_uploaded'), reference: z.string().max(64).optional(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('mark_processing'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('record_processed'), reference: z.string().max(64).optional(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('record_filed'), arn: z.string().max(20), filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('add_note'), note: z.string().min(1).max(1000) }),
  /* API integration */
  z.object({ action: z.literal('login_otp'), username: z.string().min(3).max(64) }),
  z.object({ action: z.literal('login_verify'), otp: z.string().min(4).max(8) }),
  z.object({ action: z.literal('logout') }),
  z.object({ action: z.literal('check_status') }),
  z.object({ action: z.literal('proceed_to_file') }),
  z.object({ action: z.literal('fetch_summary') }),
  z.object({ action: z.literal('request_evc_otp'), pan: z.string().min(10).max(10) }),
  z.object({ action: z.literal('file_return'), pan: z.string().min(10).max(10), otp: z.string().min(4).max(8), summaryEvidenceId: z.string().min(1).max(32), verified: z.boolean() }),
  z.object({ action: z.literal('fetch_arn') }),
]);

async function readBody(req: NextRequest): Promise<{ body: unknown; file?: EvidenceFile }> {
  if (!req.headers.get('content-type')?.includes('multipart/form-data')) return { body: await req.json() };
  const form = await req.formData();
  const body: Record<string, string> = {};
  let file: EvidenceFile | undefined;
  for (const [k, v] of form.entries()) {
    if (v instanceof File) {
      if (v.size) file = { name: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
    } else body[k] = v;
  }
  return { body, file };
}

export const POST = api('portal:operate', async (req, { auth, params }) => {
  const { body, file } = await readBody(req);
  const b = Body.parse(body);
  const id = params.id;
  const opt = (s?: string) => (s && s.trim() ? s : undefined);
  if (API_ACTIONS.has(b.action)) await requireLicense(auth.orgId, 'gstApi');
  switch (b.action) {
    case 'mark_ready': await markReady(auth, id, opt(b.note)); break;
    case 'start_upload': return startUpload(auth, id);
    case 'cancel_upload': await cancelUpload(auth, id, opt(b.note)); break;
    case 'confirm_uploaded': await confirmUploaded(auth, id, { reference: opt(b.reference), note: opt(b.note), file }); break;
    case 'mark_processing': await markProcessing(auth, id, opt(b.note)); break;
    case 'record_processed': await recordProcessed(auth, id, { reference: opt(b.reference), note: opt(b.note), file }); break;
    case 'record_filed': await recordFiled(auth, id, { arn: b.arn, filedOn: b.filedOn, note: opt(b.note), file }); break;
    case 'add_note': await addNote(auth, id, b.note); break;
    case 'login_otp': return requestLoginOtp(auth, id, b.username);
    case 'login_verify': return verifyLoginOtp(auth, id, b.otp);
    case 'logout': await endLogin(auth, id); break;
    case 'check_status': return checkGstnStatus(auth, id);
    case 'proceed_to_file': return proceedToFile(auth, id);
    case 'fetch_summary': return fetchGstnSummary(auth, id);
    case 'request_evc_otp': return requestEvcOtp(auth, id, b.pan);
    case 'file_return': return fileWithEvc(auth, id, { pan: b.pan, otp: b.otp, summaryEvidenceId: b.summaryEvidenceId, verified: b.verified });
    case 'fetch_arn': return fetchArn(auth, id);
    default: throw new HttpError(400, 'Unknown action');
  }
  return { ok: true };
}, { rateLimit: { key: 'gst-portal-step', max: 30, windowMs: 60_000 } });
