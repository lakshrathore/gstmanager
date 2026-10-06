import { z } from 'zod';
import { api } from '@/server/http';
import { removeDecision } from '@/server/recon';

/** Undo a decision. */
export const DELETE = api('return:edit', async (req, { auth, params }) => {
  const q = req.nextUrl.searchParams;
  return removeDecision(auth, q.get('companyId') ?? '', q.get('fp') ?? '', z.enum(['gstr2a', 'gstr2b']).parse(q.get('against')), params.id);
}, { feature: 'reconciliation' });
