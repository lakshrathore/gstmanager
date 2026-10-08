import { z } from 'zod';
import { can } from '@/server/auth';
import { api, HttpError } from '@/server/http';
import { requireLicense } from '@/server/license';
import { endCompanyLogin, requestCompanyLoginOtp, verifyCompanyLoginOtp } from '@/server/gst/gst-login';
import { deletePortalFetch, fetchFromPortal, PORTAL_TYPES, portalStatus } from '@/server/downloads/portal';

/** GST login, downloads made so far, and whether this installation can download from the portal: ?companyId */
export const GET = api('return:view', async (req, { auth }) => {
  const companyId = req.nextUrl.searchParams.get('companyId');
  if (!companyId) throw new HttpError(400, 'Pick a client');
  return { ...(await portalStatus(auth, companyId)), canOperate: can(auth, 'portal:operate'), canFetch: can(auth, 'return:edit') };
});

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('login_otp'), companyId: z.string().min(1).max(32), username: z.string().min(3).max(64) }),
  z.object({ action: z.literal('login_verify'), companyId: z.string().min(1).max(32), otp: z.string().min(4).max(8) }),
  z.object({ action: z.literal('logout'), companyId: z.string().min(1).max(32) }),
  z.object({
    action: z.literal('fetch'), companyId: z.string().min(1).max(32), type: z.enum(PORTAL_TYPES), period: z.string().min(6).max(7),
    toDocuments: z.boolean().optional(), force: z.boolean().optional(),
  }),
  z.object({ action: z.literal('delete'), id: z.string().min(1).max(32) }),
]);

/** Log in to GST (OTP), download one return/period from GSTN, or remove a download. */
export const POST = api('return:view', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  const need = (p: Parameters<typeof can>[1]) => { if (!can(auth, p)) throw new HttpError(403, 'Your role cannot do this'); };
  switch (b.action) {
    case 'login_otp': need('portal:operate'); return requestCompanyLoginOtp(auth, b.companyId, b.username);
    case 'login_verify': need('portal:operate'); return verifyCompanyLoginOtp(auth, b.companyId, b.otp);
    case 'logout': need('portal:operate'); await endCompanyLogin(auth, b.companyId); return { ok: true };
    case 'fetch':
      need('return:edit');
      await requireLicense(auth.orgId, 'gstApi');
      return fetchFromPortal(auth, b);
    case 'delete': need('return:edit'); return deletePortalFetch(auth, b.id);
  }
}, { rateLimit: { key: 'portal-download', max: 120, windowMs: 60_000 } });
