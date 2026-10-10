import { z } from 'zod';
import { MARKETPLACES } from '@/engine';
import { api, HttpError } from '@/server/http';
import { importMarketplace, removeMarketplace } from '@/server/gst/marketplace';

const Fields = z.object({
  marketplace: z.enum(['auto', ...(Object.keys(MARKETPLACES) as [keyof typeof MARKETPLACES, ...(keyof typeof MARKETPLACES)[]])]).default('auto'),
  etin: z.string().max(15).optional(),
  uqc: z.string().max(3).optional(),
  zeroRate: z.enum(['nil', 'exempt']).optional(),
});

/** multipart: marketplace, etin?, uqc?, zeroRate?, files (one or more .xlsx/.csv). */
export const POST = api('return:edit', async (req, { auth, params }) => {
  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) throw new HttpError(400, 'Attach the report files as "files"');
  const text = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : undefined);
  const b = Fields.parse({ marketplace: text('marketplace') || undefined, etin: text('etin') || undefined, uqc: text('uqc') || undefined, zeroRate: text('zeroRate') || undefined });
  return importMarketplace(auth, params.id, b, files);
}, { feature: 'marketplaceImport', rateLimit: { key: 'mp-import', max: 20, windowMs: 60_000 } });

export const DELETE = api('return:edit', async (req, { auth, params }) =>
  removeMarketplace(auth, params.id, req.nextUrl.searchParams.get('marketplace') ?? ''));
