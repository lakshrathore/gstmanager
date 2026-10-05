import { api } from '@/server/http';
import { auditReturn } from '@/server/gst/gst-audit';
import { evidenceFile } from '@/server/gst/gst-upload';
import { loadReturn } from '@/server/gst/gstr1';

export const GET = api('return:view', async (_req, { auth, params }) => {
  const ev = await evidenceFile(auth, params.id, params.evidenceId);
  const { ret } = await loadReturn(auth, params.id);
  await auditReturn(auth, ret, 'evidence.download', { evidenceId: params.evidenceId, kind: ev.kind });
  const safeName = (ev.fileName ?? 'evidence').replace(/[^\w.\-]/g, '_');
  return new Response(new Uint8Array(ev.content as Buffer), {
    headers: { 'content-type': ev.contentType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="${safeName}"`, 'x-content-type-options': 'nosniff' },
  });
});
