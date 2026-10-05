import { z } from 'zod';
import { PackageBody } from '@/server/admin-schemas';
import { HttpError } from '@/server/http';
import { License, oid, Package } from '@/server/models';
import { adminApi } from '@/server/superadmin';

export const PATCH = adminApi(async (req, { params }) => {
  const raw = await req.json();
  // Either the full edit form, or just { active } to archive / restore.
  const b = raw && typeof raw === 'object' && Object.keys(raw).join() === 'active' ? z.object({ active: z.boolean() }).parse(raw) : PackageBody.parse(raw);
  if ('isTrial' in b && b.isTrial) await Package.updateMany({ isTrial: true, _id: { $ne: oid(params.id) } }, { $set: { isTrial: false } });
  const p = await Package.findByIdAndUpdate(oid(params.id), { $set: b }, { returnDocument: 'after' }).lean();
  if (!p) throw new HttpError(404, 'Package not found');
  return { package: p };
});

/** Deletes a package that was never used; otherwise archive it (PATCH active=false). */
export const DELETE = adminApi(async (_req, { params }) => {
  if (await License.exists({ packageId: oid(params.id) })) throw new HttpError(409, 'Licenses exist for this package – archive it instead of deleting');
  await Package.deleteOne({ _id: oid(params.id) });
  return { ok: true };
});
