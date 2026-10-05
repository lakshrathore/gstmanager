import { z } from 'zod';
import { jsonCheck } from '@/server/gst';
import { api } from '@/server/http';

const Body = z.object({
  text: z.string().max(25_000_000, 'JSON file is larger than 25 MB'),
  /** Omit both to use the settings of the company with the file's GSTIN (when it is one of yours). */
  aatoAbove5Cr: z.boolean().optional(),
  quarterly: z.boolean().optional(),
  /** Only affects which findings are marked as fixable automatically. */
  recomputeTax: z.boolean().default(true),
});

export const POST = api('return:view', async (req, { auth }) => {
  const { text, ...settings } = Body.parse(await req.json());
  return jsonCheck.checkJson(auth, text, settings);
}, { feature: 'validators', rateLimit: { key: 'tools-json', max: 30, windowMs: 60_000 } });
