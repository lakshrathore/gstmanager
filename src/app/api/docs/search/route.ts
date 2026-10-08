import { api } from '@/server/http';
import { searchAll } from '@/server/docs/search';

/** Search everything: ?q (plain English / Hindi / Hinglish) [&companyId] across the clients the user can see. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return searchAll(auth, q.get('q') ?? '', q.get('companyId') || undefined);
}, { rateLimit: { key: 'docs-search', max: 60, windowMs: 60_000 } });
