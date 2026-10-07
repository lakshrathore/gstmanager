import 'server-only';
import type { Auth } from '../../auth';
import { HttpError } from '../../http';
import { audit, auditReturn } from '../gst-audit';
import { describeGstnError, getGstClient, GstnError, GstnSessionError, GST_PORTAL_URL, type ClientContext, type GstClient } from '../gst-client';
import { maskUsername } from '../gst-client/sandbox-protocol';
import { loadCompany, loadReturn } from '../gstr1';

/**
 * How the taxpayer signs in to GSTN for this return.
 * With the manual client the sign-in (username, password, CAPTCHA, OTP) happens entirely on the GST
 * portal in the user's browser – the app never sees or handles those values.
 * With an API client the user types their GST username and the OTP GSTN sends them; the app never
 * generates, reads or stores the OTP.
 */
export interface LoginInfo {
  mode: 'external' | 'integrated';
  portalUrl: string;
  steps: string[];
}

export function loginInfo(): LoginInfo {
  const client = getGstClient();
  if (client.capabilities.authenticate) {
    return {
      mode: 'integrated',
      portalUrl: GST_PORTAL_URL,
      steps: [
        'One time only: on the GST portal open View Profile → Manage API Access and set "Enable API Request" to Yes.',
        'Enter your GST username here. GSTN sends an OTP to the registered mobile and email.',
        'Type the OTP here. The login stays valid for about 6 hours.',
      ],
    };
  }
  return {
    mode: 'external',
    portalUrl: GST_PORTAL_URL,
    steps: [
      'Open the GST portal and sign in with your username, password and the CAPTCHA shown there.',
      'Go to Services → Returns → Returns Dashboard, pick the financial year and period, and open GSTR-1.',
      'Choose Prepare Offline → Upload, select the JSON downloaded from this app, and upload it.',
    ],
  };
}

/** Converts a GSTN failure into a response that shows GSTN's real code and message. */
export function gstnHttpError(e: unknown): never {
  if (e instanceof GstnSessionError) throw new HttpError(409, describeGstnError(e), { session: 'expired' });
  if (e instanceof GstnError) throw new HttpError(e.httpStatus && e.httpStatus >= 500 ? 502 : 422, describeGstnError(e), { gstnCode: e.code });
  throw e;
}

interface LoginTarget {
  ctx: ClientContext;
  client: GstClient;
  log: (action: string, meta: Record<string, unknown>) => Promise<unknown>;
}

function apiLoginClient() {
  const client = getGstClient();
  if (!client.capabilities.authenticate || !client.requestLoginOtp || !client.verifyLoginOtp) {
    throw new HttpError(409, 'This installation uses the manual GST portal workflow (GST_INTEGRATION=manual).');
  }
  return client;
}

/** Login started from a GSTR-1 return (audited on the return). */
async function returnTarget(auth: Auth, returnId: string): Promise<LoginTarget> {
  const { ret, company } = await loadReturn(auth, returnId);
  return {
    ctx: { orgId: auth.orgId, companyId: String(company._id), gstin: ret.gstin }, client: apiLoginClient(),
    log: (action, meta) => auditReturn(auth, ret, action, meta),
  };
}

/** Login started for a company outside a GSTR-1 return (GSTR-3B, reconciliation). The session is the same one. */
async function companyTarget(auth: Auth, companyId: string): Promise<LoginTarget> {
  const company = await loadCompany(auth, companyId);
  return {
    ctx: { orgId: auth.orgId, companyId: String(company._id), gstin: company.gstin }, client: apiLoginClient(),
    log: (action, meta) => audit(auth, action, 'Company', String(company._id), { gstin: company.gstin, ...meta }),
  };
}

async function otp(auth: Auth, target: () => Promise<LoginTarget>, username: string) {
  const u = username.trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(u)) throw new HttpError(422, 'Enter the GST portal username');
  const { ctx, client, log } = await target();
  const res = await client.requestLoginOtp!(ctx, u, { userId: auth.userId, email: auth.email }).catch(gstnHttpError);
  await log('gst.login_otp_requested', { client: client.id, username: maskUsername(u), transactionId: res.transactionId });
  return { ok: true };
}

async function verify(target: () => Promise<LoginTarget>, code: string) {
  if (!/^\d{4,8}$/.test(code.trim())) throw new HttpError(422, 'Enter the OTP exactly as received');
  const { ctx, client, log } = await target();
  const s = await client.verifyLoginOtp!(ctx, code.trim()).catch(gstnHttpError);
  await log('gst.login', { client: client.id, username: s.connectedAs, sessionExpiresAt: s.expiresAt?.toISOString() });
  return { ok: true, expiresAt: s.expiresAt };
}

async function end(target: () => Promise<LoginTarget>) {
  const { ctx, client, log } = await target();
  await client.endSession?.(ctx);
  await log('gst.logout', { client: client.id });
}

export const requestLoginOtp = (auth: Auth, returnId: string, username: string) => otp(auth, () => returnTarget(auth, returnId), username);
export const verifyLoginOtp = (auth: Auth, returnId: string, code: string) => verify(() => returnTarget(auth, returnId), code);
export const endLogin = (auth: Auth, returnId: string) => end(() => returnTarget(auth, returnId));

export const requestCompanyLoginOtp = (auth: Auth, companyId: string, username: string) => otp(auth, () => companyTarget(auth, companyId), username);
export const verifyCompanyLoginOtp = (auth: Auth, companyId: string, code: string) => verify(() => companyTarget(auth, companyId), code);
export const endCompanyLogin = (auth: Auth, companyId: string) => end(() => companyTarget(auth, companyId));
