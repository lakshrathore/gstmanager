import { z } from 'zod';
import { api } from '@/server/http';
import { Gstr1Error, Gstr1Record, oid } from '@/server/models';
import { deleteRecord, loadReturn, updateRecord } from '@/server/gst/gstr1';

export const GET = api('return:view', async (_req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  const record = await Gstr1Record.findOne({ _id: oid(params.recordId), returnId: ret._id, orgId: ret.orgId }).lean();
  const issues = record ? await Gstr1Error.find({ returnId: ret._id, orgId: ret.orgId, recordKey: record.key }).lean() : [];
  return { record, issues };
});

const Body = z.object({ data: z.record(z.string(), z.unknown()), recomputeTax: z.boolean().default(false) });

export const PATCH = api('return:edit', async (req, { auth, params }) => {
  const b = Body.parse(await req.json());
  return updateRecord(auth, params.id, params.recordId, b.data, b.recomputeTax);
});

export const DELETE = api('return:edit', async (_req, { auth, params }) => ({ summary: await deleteRecord(auth, params.id, params.recordId) }));
