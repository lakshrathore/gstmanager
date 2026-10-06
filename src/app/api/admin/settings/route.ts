import { z } from 'zod';
import { paymentSettings, savePaymentSettings } from '@/server/payments';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async () => paymentSettings());

const Body = z.object({
  upiId: z.string().trim().max(120),
  payeeName: z.string().trim().max(80),
  paymentNote: z.string().trim().max(300).optional(),
});

export const PUT = adminApi(async (req) => savePaymentSettings(Body.parse(await req.json())));
