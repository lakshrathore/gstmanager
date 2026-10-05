import 'server-only';
import type { Auth } from '../../auth';
import { HttpError } from '../../http';
import { auditReturn } from '../gst-audit';
import { describeGstnError, getGstClient, GstnError, GstnSessionError, GST_PORTAL_URL, type ClientContext } from '../gst-client';
import { maskUsername } from '../gst-client/sandbox-protocol';
import { loadReturn } from '../gstr1';

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

async function loginContext(auth: Auth, returnId: string) {
  const { ret, company } = await loadReturn(auth, returnId);
  const ctx: ClientContext = { orgId: auth.orgId, companyId: String(company._id), gstin: ret.gstin };
  const client = getGstClient();
  if (!client.capabilities.authenticate || !client.requestLoginOtp || !client.verifyLoginOtp) {
    throw new HttpError(409, 'This installation uses the manual GST portal workflow (GST_INTEGRATION=manual).');
  }
  return { ret, ctx, client };
}

export async function requestLoginOtp(auth: Auth, returnId: string, username: string) {
  const u = username.trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(u)) throw new HttpError(422, 'Enter the GST portal username');
  const { ret, ctx, client } = await loginContext(auth, returnId);
  const res = await client.requestLoginOtp!(ctx, u, { userId: auth.userId, email: auth.email }).catch(gstnHttpError);
  await auditReturn(auth, ret, 'gst.login_otp_requested', { client: client.id, username: maskUsername(u), transactionId: res.transactionId });
  return { ok: true };
}

export async function verifyLoginOtp(auth: Auth, returnId: string, otp: string) {
  if (!/^\d{4,8}$/.test(otp.trim())) throw new HttpError(422, 'Enter the OTP exactly as received');
  const { ret, ctx, client } = await loginContext(auth, returnId);
  const s = await client.verifyLoginOtp!(ctx, otp.trim()).catch(gstnHttpError);
  await auditReturn(auth, ret, 'gst.login', { client: client.id, username: s.connectedAs, sessionExpiresAt: s.expiresAt?.toISOString() });
  return { ok: true, expiresAt: s.expiresAt };
}

export async function endLogin(auth: Auth, returnId: string) {
  const { ret, ctx, client } = await loginContext(auth, returnId);
  await client.endSession?.(ctx);
  await auditReturn(auth, ret, 'gst.logout', { client: client.id });
}
