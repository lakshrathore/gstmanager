import { api } from '@/server/http';
import { fileOf } from '@/server/docs';

/** The original file, shown inline (PDF/image viewer) or downloaded with ?download=1. */
export const GET = api('return:view', async (req, { auth, params }) => {
  const f = await fileOf(auth, params.id);
  const safe = f.fileName.replace(/["\r\n]/g, '_');
  const inline = !req.nextUrl.searchParams.get('download') && /^(application\/pdf|image\/)/.test(f.contentType);
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.contentType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safe}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
});
