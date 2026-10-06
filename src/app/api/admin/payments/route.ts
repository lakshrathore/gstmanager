import { oid, Organization, PAYMENT_STATUSES, PaymentRequest } from '@/server/models';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async (req) => {
  const status = req.nextUrl.searchParams.get('status');
  const filter = status && (PAYMENT_STATUSES as readonly string[]).includes(status) ? { status } : {};
  const payments = await PaymentRequest.find(filter).sort({ status: 1, createdAt: -1 }).limit(300).lean();
  const orgs = await Organization.find({ _id: { $in: [...new Set(payments.map((p) => String(p.orgId)))].map(oid) } }).select({ name: 1 }).lean();
  const name = new Map(orgs.map((o) => [String(o._id), o.name]));
  return {
    payments: payments.map((p) => ({ ...p, orgName: name.get(String(p.orgId)) ?? '(deleted)' })),
    pending: await PaymentRequest.countDocuments({ status: 'pending' }),
  };
});
