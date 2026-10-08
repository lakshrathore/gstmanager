import { api } from '@/server/http';
import { firmOverview } from '@/server/docs/firm';

/** Firm dashboard: every client × month of ?fy. */
export const GET = api('return:view', async (req, { auth }) => firmOverview(auth, req.nextUrl.searchParams.get('fy') ?? ''));
