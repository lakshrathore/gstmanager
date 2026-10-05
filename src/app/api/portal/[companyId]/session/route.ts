import { z } from 'zod';
import { api } from '@/server/http';
import { GSTAuthService } from '@/server/portal/service';

export const GET = api('return:view', async (_req, { auth, params }) => GSTAuthService.status(auth, params.companyId));

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), username: z.string().min(3).max(64), remember: z.boolean().default(false) }),
  z.object({ action: z.literal('refresh_captcha') }),
  z.object({ action: z.literal('submit_captcha'), password: z.string().min(1).max(128), captcha: z.string().min(1).max(12) }),
  z.object({ action: z.literal('submit_otp'), otp: z.string().min(4).max(8) }),
  z.object({ action: z.literal('check') }),
  z.object({ action: z.literal('logout') }),
]);

/** Every value here (password, CAPTCHA, OTP) is typed by the user; none is stored or logged. */
export const POST = api('portal:operate', async (req, { auth, params }) => {
  const b = Body.parse(await req.json());
  const id = params.companyId;
  switch (b.action) {
    case 'start': return GSTAuthService.startLogin(auth, id, b.username, b.remember);
    case 'refresh_captcha': return GSTAuthService.refreshCaptcha(auth, id);
    case 'submit_captcha': return GSTAuthService.submitUserProvidedCaptcha(auth, id, b.password, b.captcha);
    case 'submit_otp': return GSTAuthService.verifyUserProvidedOtp(auth, id, b.otp);
    case 'check': return GSTAuthService.checkSession(auth, id);
    case 'logout': return GSTAuthService.logout(auth, id);
  }
}, { rateLimit: { key: 'portal-session', max: 15, windowMs: 60_000 } });
