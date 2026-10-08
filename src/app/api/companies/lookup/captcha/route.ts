import { gstinLookup } from '@/server/gst';
import { api } from '@/server/http';

/** A GST portal "Search Taxpayer" CAPTCHA, for adding a company when the Sandbox API is not set up. */
export const POST = api('company:manage', async (_req, { auth }) => gstinLookup.portalCaptcha(auth.userId),
  { rateLimit: { key: 'company-captcha', max: 40, windowMs: 60_000 } });
