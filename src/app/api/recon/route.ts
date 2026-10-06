import { api } from '@/server/http';
import { status } from '@/server/recon';

/** What has been uploaded for a company + period (books, GSTR-2A, GSTR-2B). */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return status(auth, q.get('companyId') ?? '', q.get('fp') ?? '');
}, { feature: 'reconciliation' });
