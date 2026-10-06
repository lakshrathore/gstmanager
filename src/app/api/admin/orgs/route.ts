import { licenseState, usage } from '@/server/license';
import { License, Organization, PaymentRequest, User } from '@/server/models';
import { adminApi } from '@/server/superadmin';

/** Every organisation with its owner, license and usage, plus platform totals. */
export const GET = adminApi(async () => {
  const orgs = await Organization.find().sort({ createdAt: -1 }).limit(1000).lean();
  const owners = await User.find({ role: 'owner', orgId: { $in: orgs.map((o) => o._id) } }).select({ orgId: 1, email: 1, name: 1 }).lean();
  const ownerBy = new Map(owners.map((u) => [String(u.orgId), { name: u.name, email: u.email }]));
  const rows = await Promise.all(orgs.map(async (o) => ({
    _id: String(o._id),
    name: o.name,
    createdAt: o.createdAt,
    owner: ownerBy.get(String(o._id)) ?? null,
    license: await licenseState(o._id),
    usage: await usage(o._id),
  })));
  const soon = Date.now() + 7 * 86_400_000;
  return {
    orgs: rows,
    stats: {
      orgs: rows.length,
      licensed: rows.filter((r) => r.license.status === 'active').length,
      expiringSoon: rows.filter((r) => r.license.status === 'active' && r.license.expiresAt && r.license.expiresAt.getTime() < soon).length,
      unlicensed: rows.filter((r) => r.license.status !== 'active').length,
      unusedKeys: await License.countDocuments({ status: 'unused' }),
      users: await User.countDocuments({ active: true }),
      pendingPayments: await PaymentRequest.countDocuments({ status: 'pending' }),
    },
  };
});
