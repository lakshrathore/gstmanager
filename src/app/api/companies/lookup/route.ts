import { z } from 'zod';
import { gstinLookup } from '@/server/gst';
import { api, HttpError } from '@/server/http';
import { Company, oid } from '@/server/models';

const Body = z.object({ text: z.string().max(5_000) });

/**
 * GSTN details for adding companies: GSTINs (one or many) → taxpayer record and filing frequency
 * through the Sandbox API, and which of them are companies here already. Without Sandbox the page
 * falls back to the GST portal search (CAPTCHA), one GSTIN at a time.
 */
export const POST = api('company:manage', async (req, { auth }) => {
  const list = gstinLookup.splitGstins(Body.parse(await req.json()).text);
  if (!list.length) throw new HttpError(400, 'Enter a GSTIN');
  const existing = (await Company.find({ orgId: oid(auth.orgId), gstin: { $in: list } }).select({ gstin: 1 }).lean()).map((c) => c.gstin);
  if (!gstinLookup.sandboxConfigured()) return { mode: 'portal' as const, results: gstinLookup.checkOffline(list), existing };
  if (list.length > gstinLookup.MAX_SANDBOX_BATCH) throw new HttpError(400, `Enter up to ${gstinLookup.MAX_SANDBOX_BATCH} GSTINs at a time`);
  // Companies already added are not looked up again (each lookup is a paid API call).
  const looked = await gstinLookup.lookupForCompanies(list.filter((g) => !existing.includes(g)));
  return { mode: 'sandbox' as const, results: list.map((g) => looked.find((r) => r.input === g) ?? gstinLookup.checkOffline([g])[0]), existing };
}, { rateLimit: { key: 'company-lookup', max: 20, windowMs: 60_000 } });
