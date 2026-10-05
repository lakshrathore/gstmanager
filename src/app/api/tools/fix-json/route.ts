import { z } from 'zod';
import { jsonCheck } from '@/server/gst';
import { api } from '@/server/http';

const Body = z.object({
  text: z.string().max(25_000_000, 'JSON file is larger than 25 MB'),
  aatoAbove5Cr: z.boolean().optional(),
  quarterly: z.boolean().optional(),
  recomputeTax: z.boolean().default(true),
});

/** Applies the safe automatic fixes to a GSTR-1 JSON and returns the fixed file with a fresh report. */
export const POST = api('return:view', async (req, { auth }) => {
  const { text, ...settings } = Body.parse(await req.json());
  return jsonCheck.fixJson(auth, text, settings);
}, { feature: 'validators', rateLimit: { key: 'tools-json', max: 30, windowMs: 60_000 } });
