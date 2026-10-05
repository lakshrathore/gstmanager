import { PackageBody } from '@/server/admin-schemas';
import { FEATURES, LIMITS } from '@/server/license';
import { License, Package } from '@/server/models';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async () => {
  const packages = await Package.find().sort({ active: -1, priceInr: 1 }).lean();
  const counts = await License.aggregate<{ _id: unknown; total: number; active: number }>([
    { $group: { _id: '$packageId', total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c]));
  return {
    packages: packages.map((p) => ({ ...p, licenses: byId.get(String(p._id))?.total ?? 0, activeLicenses: byId.get(String(p._id))?.active ?? 0 })),
    featureLabels: FEATURES,
    limitLabels: LIMITS,
  };
});

export const POST = adminApi(async (req) => {
  const b = PackageBody.parse(await req.json());
  if (b.isTrial) await Package.updateMany({ isTrial: true }, { $set: { isTrial: false } });
  return { package: (await Package.create(b)).toObject() };
});
