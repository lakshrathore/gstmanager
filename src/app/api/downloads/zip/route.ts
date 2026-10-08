import { api } from '@/server/http';
import { downloadZip } from '@/server/downloads';
import { criteriaFrom, formatsFrom } from '@/server/downloads/query';

/** Every matching return as one ZIP: the list filters plus format=json|xlsx|both. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const { fileName, bytes } = await downloadZip(auth, criteriaFrom(q), formatsFrom(q.get('format')));
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${fileName}"` } });
}, { rateLimit: { key: 'download-zip', max: 10, windowMs: 60_000 } });
