import { api } from '@/server/http';
import { AuditLog, Gstr1Record } from '@/server/models';
import { loadReturn } from '@/server/gst/gstr1';

export const GET = api('audit:view', async (_req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  const recordIds = (await Gstr1Record.find({ returnId: ret._id, orgId: ret.orgId, edited: true }).select({ _id: 1 }).lean()).map((r) => String(r._id));
  const entries = await AuditLog.find({
    orgId: ret.orgId,
    $or: [{ entityId: String(ret._id) }, { 'meta.returnId': String(ret._id) }, { entityId: { $in: recordIds } }],
  }).sort({ seq: -1 }).limit(500).lean();
  return { entries };
});
