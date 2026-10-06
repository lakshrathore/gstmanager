import { z } from 'zod';
import { api } from '@/server/http';
import { runRecon } from '@/server/recon';

/** Books vs GSTR-2A or GSTR-2B for a company + period, with the user's decisions applied. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const against = z.enum(['gstr2a', 'gstr2b']).parse(q.get('against'));
  const tol = q.get('tolerance');
  const tolerance = tol == null ? undefined : z.coerce.number().min(0).max(1000).parse(tol);
  return runRecon(auth, q.get('companyId') ?? '', q.get('fp') ?? '', against, tolerance);
}, { feature: 'reconciliation' });
