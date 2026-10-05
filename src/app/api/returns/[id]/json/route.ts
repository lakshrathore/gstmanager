import { api, HttpError } from '@/server/http';
import { audit } from '@/server/gst/gst-audit';
import { GeneratedJson } from '@/server/models';
import { generateJson, jsonFileName, loadReturn } from '@/server/gst/gstr1';

export const POST = api('return:edit', async (_req, { auth, params }) => generateJson(auth, params.id));

export const GET = api('return:view', async (req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  if (!ret.currentJsonId) throw new HttpError(404, 'JSON not generated yet');
  const j = await GeneratedJson.findOne({ _id: ret.currentJsonId, orgId: ret.orgId }).lean();
  if (!j) throw new HttpError(404, 'JSON not found');
  if (req.nextUrl.searchParams.get('download')) {
    await audit(auth, 'json.download', 'GeneratedJson', String(j._id), { sha256: j.sha256 });
    return new Response(j.payload, {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${jsonFileName(ret.gstin, ret.fp)}"` },
    });
  }
  return { meta: { id: j._id, sha256: j.sha256, sizeBytes: j.sizeBytes, version: j.version, log: j.log, createdAt: j.createdAt, stale: ret.jsonStale }, preview: JSON.parse(j.payload) };
});
