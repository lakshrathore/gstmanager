import { api, HttpError } from '@/server/http';
import { importExcel } from '@/server/gst/gstr1';

export const POST = api('return:edit', async (req, { auth, params }) => {
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Attach the Excel file as "file"');
  return importExcel(auth, params.id, file);
}, { rateLimit: { key: 'import', max: 20, windowMs: 60_000 } });
