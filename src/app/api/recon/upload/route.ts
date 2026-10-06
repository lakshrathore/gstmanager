import { z } from 'zod';
import { api, HttpError } from '@/server/http';
import { importPurchaseFiles, removeSource } from '@/server/recon';

const Source = z.enum(['books', 'gstr2a', 'gstr2b']);

/** multipart: companyId, fp, source (books | gstr2a | gstr2b), files. Replaces that source's data for the period. */
export const POST = api('return:edit', async (req, { auth }) => {
  const form = await req.formData();
  const text = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : '');
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) throw new HttpError(400, 'Attach the file(s) as "files"');
  return importPurchaseFiles(auth, text('companyId'), text('fp'), Source.parse(text('source')), files);
}, { feature: 'reconciliation', rateLimit: { key: 'recon-upload', max: 30, windowMs: 60_000 } });

export const DELETE = api('return:edit', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return removeSource(auth, q.get('companyId') ?? '', q.get('fp') ?? '', Source.parse(q.get('source')));
}, { feature: 'reconciliation' });
