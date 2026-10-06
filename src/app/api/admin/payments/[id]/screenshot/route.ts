import { HttpError } from '@/server/http';
import { oid, PaymentRequest } from '@/server/models';
import { adminApi } from '@/server/superadmin';

/** The customer's payment screenshot (super admin only). */
export const GET = adminApi(async (_req, { params }) => {
  const p = await PaymentRequest.findById(oid(params.id)).select('+screenshot screenshotType').lean();
  if (!p?.screenshot) throw new HttpError(404, 'Screenshot not found');
  const bytes = Buffer.from(p.screenshot.buffer ?? p.screenshot);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': p.screenshotType ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
});
