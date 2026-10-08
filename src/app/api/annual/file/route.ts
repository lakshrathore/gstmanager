import { api, HttpError } from '@/server/http';
import { download, importFile } from '@/server/gst/annual';

/** GSTR-9 / GSTR-9C files: GET ?kind&companyId&fy&format=json|xlsx downloads, POST multipart imports (.xlsx or .json). */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const format = q.get('format') === 'json' ? 'json' : 'xlsx';
  const f = await download(auth, q.get('kind') ?? '', q.get('companyId') ?? '', q.get('fy') ?? '', format);
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } });
});

/** multipart: kind, companyId, fy, file. Replaces the prepared form. */
export const POST = api('return:edit', async (req, { auth }) => {
  const form = await req.formData();
  const text = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : '');
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new HttpError(400, 'Attach the file as "file"');
  return importFile(auth, text('kind'), text('companyId'), text('fy'), file);
}, { rateLimit: { key: 'annual-file', max: 20, windowMs: 60_000 } });
