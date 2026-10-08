import { z } from 'zod';
import { api } from '@/server/http';
import { downloadPortalFile } from '@/server/downloads/portal';

const Q = z.object({ id: z.string().min(1).max(32), format: z.enum(['json', 'xlsx']) });

/** One return downloaded from the GST portal, as GSTN's JSON or as Excel: ?id&format */
export const GET = api('return:view', async (req, { auth }) => {
  const q = Q.parse(Object.fromEntries(req.nextUrl.searchParams));
  const f = await downloadPortalFile(auth, q.id, q.format);
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } });
}, { rateLimit: { key: 'portal-file', max: 120, windowMs: 60_000 } });
