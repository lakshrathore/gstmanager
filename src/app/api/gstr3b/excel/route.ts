import { api, HttpError } from '@/server/http';
import { excelTemplate, importExcel } from '@/server/gst/gstr3b';

/** GSTR-3B Excel: GET ?companyId&fp downloads the template (filled with the prepared tables), POST multipart imports it. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const { fileName, bytes } = await excelTemplate(auth, q.get('companyId') ?? '', q.get('fp') ?? '');
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${fileName}"` },
  });
});

/** multipart: companyId, fp, file (.xlsx). Replaces the prepared tables. */
export const POST = api('return:edit', async (req, { auth }) => {
  const form = await req.formData();
  const text = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : '');
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new HttpError(400, 'Attach the Excel file as "file"');
  return importExcel(auth, text('companyId'), text('fp'), file);
}, { rateLimit: { key: 'gstr3b-excel', max: 20, windowMs: 60_000 } });
