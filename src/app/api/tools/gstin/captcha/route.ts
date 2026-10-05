import { gstinLookup } from '@/server/gst';
import { api } from '@/server/http';

/** A fresh GST portal "Search Taxpayer" CAPTCHA for the user to read. */
export const POST = api('return:view', async (_req, { auth }) => gstinLookup.portalCaptcha(auth.userId),
  { rateLimit: { key: 'tools-captcha', max: 40, windowMs: 60_000 } });
