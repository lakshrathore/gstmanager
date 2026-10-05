import { api, HttpError } from '@/server/http';
import { importPortalErrorReport } from '@/server/gst/gst-error';

/** Accepts the error-report JSON downloaded from the GST portal (multipart field "file"). */
export const POST = api('portal:operate', async (req, { auth, params }) => {
  const f = (await req.formData()).get('file');
  if (!(f instanceof File)) throw new HttpError(400, 'Attach the error report JSON as "file"');
  if (f.size > 20 * 1024 * 1024) throw new HttpError(413, 'File too large');
  return importPortalErrorReport(auth, params.id, { name: f.name, type: f.type, text: await f.text() });
});
