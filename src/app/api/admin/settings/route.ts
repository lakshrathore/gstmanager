import { z } from 'zod';
import { paymentSettings, savePaymentSettings } from '@/server/payments';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async () => paymentSettings());

const price = z.coerce.number().min(0).max(1_000_000);
const Body = z.object({
  upiId: z.string().trim().max(120),
  payeeName: z.string().trim().max(80),
  paymentNote: z.string().trim().max(300).optional(),
  addonPrices: z.object({ companies: price, users: price, returnsPerMonth: price }).optional(),
});

export const PUT = adminApi(async (req) => savePaymentSettings(Body.parse(await req.json())));
