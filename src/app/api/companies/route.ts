import { z } from 'zod';
import { checkGstin } from '@/engine';
import { audit } from '@/server/gst/gst-audit';
import { api, HttpError } from '@/server/http';
import { assertWithinLimit } from '@/server/license';
import { Company, oid } from '@/server/models';

export const GET = api('return:view', async (_req, { auth }) => {
  const filter: Record<string, unknown> = { orgId: oid(auth.orgId) };
  if (auth.companyIds.length) filter._id = { $in: auth.companyIds.map(oid) };
  return { companies: await Company.find(filter).sort({ name: 1 }).lean() };
});

const Body = z.object({
  name: z.string().min(2).max(150),
  gstin: z.string().transform((s) => s.trim().toUpperCase()),
  aatoAbove5Cr: z.boolean().default(false),
  filingFrequency: z.enum(['monthly', 'quarterly']).default('monthly'),
});

export const POST = api('company:manage', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  const chk = checkGstin(b.gstin);
  if (!chk.ok) throw new HttpError(400, `GSTIN invalid: ${chk.reason}`);
  if (await Company.exists({ orgId: oid(auth.orgId), gstin: b.gstin })) throw new HttpError(409, 'This GSTIN already exists');
  await assertWithinLimit(auth.orgId, 'companies');
  const c = await Company.create({ ...b, orgId: oid(auth.orgId), stateCode: b.gstin.slice(0, 2) });
  await audit(auth, 'company.create', 'Company', String(c._id), { gstin: b.gstin, name: b.name });
  return { company: c.toObject() };
});
