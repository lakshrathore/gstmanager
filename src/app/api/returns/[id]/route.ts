import { profileForPeriod } from '@/engine';
import { api } from '@/server/http';
import { GeneratedJson, Gstr1Error, UploadJob } from '@/server/models';
import { loadReturn } from '@/server/gst/gstr1';

export const GET = api('return:view', async (_req, { auth, params }) => {
  const { ret, company } = await loadReturn(auth, params.id);
  const [json, upload, importIssues, portalErrors] = await Promise.all([
    ret.currentJsonId ? GeneratedJson.findById(ret.currentJsonId).select({ payload: 0 }).lean() : null,
    UploadJob.findOne({ returnId: ret._id, orgId: ret.orgId }).sort({ createdAt: -1 }).lean(),
    Gstr1Error.countDocuments({ returnId: ret._id, orgId: ret.orgId, origin: 'import' }),
    Gstr1Error.countDocuments({ returnId: ret._id, orgId: ret.orgId, origin: 'portal' }),
  ]);
  return { return: ret, company, profile: profileForPeriod(ret.fp), json, upload, counts: { importIssues, portalErrors } };
});
