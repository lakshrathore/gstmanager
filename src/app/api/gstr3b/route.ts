import { z } from 'zod';
import { can, type Permission } from '@/server/auth';
import { api, HttpError } from '@/server/http';
import { requireLicense } from '@/server/license';
import { endCompanyLogin, requestCompanyLoginOtp, verifyCompanyLoginOtp } from '@/server/gst/gst-login';
import {
  checkSave, fetchArn, fetchDetails, fetchFromPortal, fileWithEvc, offsetLiability, overview, refreshPayment, requestEvcOtp,
  saveDraft, saveToGstn, useValues,
} from '@/server/gst/gstr3b';

/**
 * GSTR-3B for one company and period: overview (GET ?companyId&fp) and actions (POST). Login,
 * fetch, save, offset and file call GSTN through the GST API integration; OTPs and PANs in these
 * bodies go straight to GSTN and are never stored or logged.
 */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return overview(auth, q.get('companyId') ?? '', q.get('fp') ?? '');
});

const whole = z.number().int().min(0).max(1e12);
const ItcUse = z.object({ i_pdi: whole, i_pdc: whole, i_pds: whole, c_pdi: whole, c_pdc: whole, s_pdi: whole, s_pds: whole, cs_pdcs: whole });
const Pan = z.string().min(10).max(10);

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('login_otp'), username: z.string().min(3).max(64) }),
  z.object({ action: z.literal('login_verify'), otp: z.string().min(4).max(8) }),
  z.object({ action: z.literal('logout') }),
  z.object({ action: z.literal('fetch') }),
  z.object({ action: z.literal('save_draft'), form: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('use_values'), source: z.enum(['auto', 'portal']) }),
  z.object({ action: z.literal('save') }),
  z.object({ action: z.literal('check_save') }),
  z.object({ action: z.literal('refresh_payment') }),
  z.object({ action: z.literal('offset'), itcUse: ItcUse, includeCurrentItc: z.boolean(), confirmed: z.boolean() }),
  z.object({ action: z.literal('fetch_details') }),
  z.object({ action: z.literal('request_evc_otp'), pan: Pan, nil: z.boolean().default(false) }),
  z.object({ action: z.literal('file'), pan: Pan, otp: z.string().min(4).max(8), detailsEvidenceId: z.string().max(32).optional(), verified: z.boolean(), nil: z.boolean().default(false) }),
  z.object({ action: z.literal('fetch_arn') }),
]);
type Action = z.infer<typeof Body>['action'];

/** Who may run each action (filing and set-off are narrowed further in the service). */
const NEEDS: Record<Action, Permission> = {
  login_otp: 'portal:operate', login_verify: 'portal:operate', logout: 'portal:operate',
  fetch: 'return:edit', save_draft: 'return:edit', use_values: 'return:edit',
  save: 'portal:operate', check_save: 'portal:operate', refresh_payment: 'portal:operate', fetch_details: 'portal:operate', fetch_arn: 'portal:operate',
  offset: 'return:file', request_evc_otp: 'return:file', file: 'return:file',
};
const LOCAL = new Set<Action>(['save_draft', 'use_values']);

const Target = z.object({ companyId: z.string().min(1).max(32), fp: z.string().regex(/^\d{6}$/) });

export const POST = api('return:view', async (req, { auth }) => {
  const raw = await req.json();
  const { companyId, fp } = Target.parse(raw);
  const b = Body.parse(raw);
  if (!can(auth, NEEDS[b.action])) throw new HttpError(403, 'You do not have permission for this action');
  if (!LOCAL.has(b.action)) await requireLicense(auth.orgId, 'gstApi');
  switch (b.action) {
    case 'login_otp': return requestCompanyLoginOtp(auth, companyId, b.username);
    case 'login_verify': return verifyCompanyLoginOtp(auth, companyId, b.otp);
    case 'logout': await endCompanyLogin(auth, companyId); return { ok: true };
    case 'fetch': return fetchFromPortal(auth, companyId, fp);
    case 'save_draft': return saveDraft(auth, companyId, fp, b.form);
    case 'use_values': return useValues(auth, companyId, fp, b.source);
    case 'save': return saveToGstn(auth, companyId, fp);
    case 'check_save': return checkSave(auth, companyId, fp);
    case 'refresh_payment': return refreshPayment(auth, companyId, fp);
    case 'offset': return offsetLiability(auth, companyId, fp, b);
    case 'fetch_details': return fetchDetails(auth, companyId, fp);
    case 'request_evc_otp': return requestEvcOtp(auth, companyId, fp, b.pan, b.nil);
    case 'file': return fileWithEvc(auth, companyId, fp, b);
    case 'fetch_arn': return fetchArn(auth, companyId, fp);
  }
}, { rateLimit: { key: 'gstr3b', max: 30, windowMs: 60_000 } });
