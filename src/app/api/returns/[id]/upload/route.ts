import { z } from 'zod';
import { api } from '@/server/http';
import { UploadJob } from '@/server/models';
import { PortalAdapter } from '@/server/portal/service';
import { loadReturn } from '@/server/services/returns';

export const GET = api('return:view', async (req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  if (req.nextUrl.searchParams.get('refresh')) return { job: await PortalAdapter.checkUploadStatus(auth, params.id).catch((e) => ({ error: e.message })) };
  return { jobs: await UploadJob.find({ returnId: ret._id, orgId: ret.orgId }).sort({ createdAt: -1 }).limit(20).lean() };
});

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), mode: z.enum(['http', 'manual']) }),
  z.object({ action: z.literal('mark'), status: z.enum(['uploaded', 'processed', 'filed']), note: z.string().max(500).optional() }),
]);

export const POST = api('portal:operate', async (req, { auth, params }) => {
  const b = Body.parse(await req.json());
  if (b.action === 'start') return { job: await PortalAdapter.uploadGstr1(auth, params.id, b.mode) };
  return PortalAdapter.markManual(auth, params.id, b.status, b.note);
}, { rateLimit: { key: 'upload', max: 10, windowMs: 60_000 } });
