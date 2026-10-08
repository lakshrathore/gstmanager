import { z } from 'zod';
import { api } from '@/server/http';
import { downloadOne, RETURN_TYPES } from '@/server/downloads';

const Q = z.object({ type: z.enum(RETURN_TYPES), companyId: z.string().min(1).max(32), period: z.string().min(6).max(7), format: z.enum(['json', 'xlsx']) });

/** One return as a file: ?type&companyId&period (MMYYYY or 2024-25)&format=json|xlsx */
export const GET = api('return:view', async (req, { auth }) => {
  const q = Q.parse(Object.fromEntries(req.nextUrl.searchParams));
  const f = await downloadOne(auth, q.type, q.companyId, q.period, q.format);
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } });
}, { rateLimit: { key: 'download-file', max: 120, windowMs: 60_000 } });
