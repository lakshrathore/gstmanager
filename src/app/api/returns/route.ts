import { z } from 'zod';
import { api } from '@/server/http';
import { Company, GstReturn, oid } from '@/server/models';
import { createReturn } from '@/server/gst/gstr1';
import { normalizeStatus } from '@/server/gst/gst-status/statuses';

export const GET = api('return:view', async (req, { auth }) => {
  const companyId = req.nextUrl.searchParams.get('companyId');
  const filter: Record<string, unknown> = { orgId: oid(auth.orgId) };
  if (companyId) filter.companyId = oid(companyId);
  if (auth.companyIds.length) filter.companyId = companyId && auth.companyIds.includes(companyId) ? oid(companyId) : { $in: auth.companyIds.map(oid) };
  const returns = await GstReturn.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  const companies = await Company.find({ orgId: oid(auth.orgId) }).select({ name: 1, gstin: 1 }).lean();
  const byId = new Map(companies.map((c) => [String(c._id), c]));
  return { returns: returns.map((r) => ({ ...r, status: normalizeStatus(r.status), company: byId.get(String(r.companyId)) })) };
});

const Body = z.object({ companyId: z.string(), fp: z.string() });

export const POST = api('return:edit', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  return { return: await createReturn(auth, b.companyId, b.fp) };
});
