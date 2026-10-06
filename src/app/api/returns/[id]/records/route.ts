import { api } from '@/server/http';
import { Gstr1Record } from '@/server/models';
import { createRecord, loadReturn } from '@/server/gst/gstr1';
import { z } from 'zod';

export const GET = api('return:view', async (req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const size = Math.min(200, Number(sp.get('size') ?? 50));
  const filter: Record<string, unknown> = { returnId: ret._id, orgId: ret.orgId };
  if (sp.get('section')) filter.section = sp.get('section');
  if (sp.get('status') === 'errors') filter.hasErrors = true;
  if (sp.get('status') === 'warnings') filter.hasWarnings = true;
  const q = sp.get('q')?.trim();
  if (q) filter.key = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [records, total] = await Promise.all([
    Gstr1Record.find(filter).sort({ hasErrors: -1, section: 1, _id: 1 }).skip((page - 1) * size).limit(size).lean(),
    Gstr1Record.countDocuments(filter),
  ]);
  return { records, total, page, size };
});

const Body = z.object({ section: z.string().min(2).max(20), data: z.record(z.string(), z.unknown()), recomputeTax: z.boolean().default(true) });

/** Manual entry: add one record (invoice, note, B2CS line, HSN line, documents …). */
export const POST = api('return:edit', async (req, { auth, params }) => {
  const b = Body.parse(await req.json());
  return createRecord(auth, params.id, b.section, b.data, b.recomputeTax);
}, { feature: 'manualEntry' });
