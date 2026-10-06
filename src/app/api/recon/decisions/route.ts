import { z } from 'zod';
import { api } from '@/server/http';
import { addDecision } from '@/server/recon';

const Body = z.object({
  companyId: z.string().min(1),
  fp: z.string(),
  against: z.enum(['gstr2a', 'gstr2b']),
  action: z.enum(['ignore', 'link', 'accept']),
  booksKey: z.string().max(200).optional(),
  portalKey: z.string().max(200).optional(),
  reason: z.string().max(300).optional(),
});

/** Ignore a document, link a books document to a portal document, or accept a pair's differences. */
export const POST = api('return:edit', async (req, { auth }) => {
  const { companyId, fp, against, ...d } = Body.parse(await req.json());
  return addDecision(auth, companyId, fp, against, d);
}, { feature: 'reconciliation' });
