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
  /** GSTN's taxpayer record shown when adding from the GSTIN. */
  profile: z.object({
    legalName: z.string().max(200).optional(), tradeName: z.string().max(200).optional(), status: z.string().max(40).optional(),
    constitution: z.string().max(120).optional(), taxpayerType: z.string().max(60).optional(), registrationDate: z.string().max(20).optional(),
    address: z.string().max(500).optional(),
  }).optional(),
});

export const POST = api('company:manage', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  const chk = checkGstin(b.gstin);
  if (!chk.ok) throw new HttpError(400, `GSTIN invalid: ${chk.reason}`);
  if (await Company.exists({ orgId: oid(auth.orgId), gstin: b.gstin })) throw new HttpError(409, 'This GSTIN already exists');
  await assertWithinLimit(auth.orgId, 'companies');
  const { profile, ...rest } = b;
  const c = await Company.create({
    ...rest, orgId: oid(auth.orgId), stateCode: b.gstin.slice(0, 2),
    ...(profile ? {
      legalName: profile.legalName, tradeName: profile.tradeName, registrationStatus: profile.status, constitution: profile.constitution,
      taxpayerType: profile.taxpayerType, registrationDate: profile.registrationDate, address: profile.address, profileFetchedAt: new Date(),
    } : {}),
  });
  await audit(auth, 'company.create', 'Company', String(c._id), { gstin: b.gstin, name: b.name, fromGstn: !!profile });
  return { company: c.toObject() };
});
