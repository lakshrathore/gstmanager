import { z } from 'zod';
import { gstinLookup } from '@/server/gst';
import { api, HttpError } from '@/server/http';

const Body = z.object({ text: z.string().max(20_000), mode: z.enum(['offline', 'sandbox']) });

/** Offline checks, or offline + Sandbox "Search GSTIN" for many GSTINs at once. */
export const POST = api('return:view', async (req) => {
  const b = Body.parse(await req.json());
  const list = gstinLookup.splitGstins(b.text);
  if (!list.length) throw new HttpError(400, 'Enter at least one GSTIN');
  if (list.length > gstinLookup.MAX_BATCH) throw new HttpError(400, `Enter up to ${gstinLookup.MAX_BATCH} GSTINs at a time`);
  return { results: b.mode === 'sandbox' ? await gstinLookup.checkWithSandbox(list) : gstinLookup.checkOffline(list) };
}, { rateLimit: { key: 'tools-gstin', max: 20, windowMs: 60_000 } });
