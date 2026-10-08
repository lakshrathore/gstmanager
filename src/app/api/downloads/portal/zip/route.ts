import { api, HttpError } from '@/server/http';
import { formatsFrom } from '@/server/downloads/query';
import { portalZip } from '@/server/downloads/portal';

/** Everything downloaded from the portal for a client (or the chosen ids) as one ZIP: ?companyId&ids=a,b&format=json|xlsx|both */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const companyId = q.get('companyId');
  if (!companyId) throw new HttpError(400, 'Pick a client');
  const ids = (q.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
  const z = await portalZip(auth, companyId, ids, formatsFrom(q.get('format')));
  return new Response(new Uint8Array(z.bytes), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${z.fileName}"` } });
}, { rateLimit: { key: 'portal-zip', max: 20, windowMs: 60_000 } });
