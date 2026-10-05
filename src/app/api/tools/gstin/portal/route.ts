import { z } from 'zod';
import { gstinLookup } from '@/server/gst';
import { api } from '@/server/http';

const Body = z.object({
  sessionId: z.uuid(),
  gstin: z.string().trim().toUpperCase().length(15),
  captcha: z.string().trim().min(1).max(12),
});

/** Searches one GSTIN on the GST portal with the CAPTCHA the user typed. */
export const POST = api('return:view', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  return { result: await gstinLookup.portalSearch(auth.userId, b.sessionId, b.gstin, b.captcha) };
}, { feature: 'validators', rateLimit: { key: 'tools-portal', max: 40, windowMs: 60_000 } });
