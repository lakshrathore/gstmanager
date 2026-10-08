import { api, HttpError } from '@/server/http';
import { upload, workspace } from '@/server/docs';

/** Client documents: GET ?companyId&fy[&fp] is the workspace; POST multipart (companyId or "auto", files) uploads. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return workspace(auth, q.get('companyId') ?? '', q.get('fy') ?? '', q.get('fp') || undefined);
});

export const POST = api('return:edit', async (req, { auth }) => {
  const form = await req.formData();
  const target = typeof form.get('companyId') === 'string' ? (form.get('companyId') as string) : '';
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (!target) throw new HttpError(400, 'Pick the client (or "detect from documents")');
  if (!files.length) throw new HttpError(400, 'Attach the files as "files"');
  if (files.length > 50) throw new HttpError(400, 'Upload at most 50 files per request');
  return upload(auth, target, files);
}, { rateLimit: { key: 'docs-upload', max: 120, windowMs: 60_000 } });
