import { api, HttpError } from '@/server/http';
import { myPayments, paymentOptions, submitPayment } from '@/server/payments';

/** Packages and add-ons to buy (with UPI QR links) and this workspace's payment history. */
export const GET = api('return:view', async (_req, { auth }) => ({
  ...(await paymentOptions(auth.orgId)),
  payments: await myPayments(auth.orgId),
}));

/**
 * multipart: kind ("package" | "addon"), packageId (package) or companies / users / returnsPerMonth
 * units (addon), utr, note?, screenshot (image). Works without a license, by design.
 */
export const POST = api('org:manage', async (req, { auth }) => {
  const form = await req.formData();
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const file = form.get('screenshot');
  if (file !== null && !(file instanceof File)) throw new HttpError(400, 'Attach the screenshot as "screenshot"');
  const kind = text('kind') === 'addon' ? 'addon' : 'package';
  return submitPayment(auth, {
    kind, packageId: text('packageId'), utr: text('utr'), note: text('note') || undefined,
    units: { companies: Number(text('companies') || 0), users: Number(text('users') || 0), returnsPerMonth: Number(text('returnsPerMonth') || 0) },
  }, file);
}, { unlicensed: true, rateLimit: { key: 'payment-submit', max: 5, windowMs: 10 * 60_000 } });
