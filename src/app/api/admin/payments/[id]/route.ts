import { z } from 'zod';
import { reviewPayment } from '@/server/payments';
import { adminApi } from '@/server/superadmin';

const Body = z.object({ action: z.enum(['approve', 'reject']), note: z.string().max(500).optional() });

/** Approve (issues + activates a license for the package) or reject with a reason. */
export const PATCH = adminApi(async (req, { admin, params }) => {
  const b = Body.parse(await req.json());
  return reviewPayment(admin, params.id, b.action, b.note);
});
