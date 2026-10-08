import { api } from '@/server/http';
import { listReturns } from '@/server/downloads';
import { criteriaFrom } from '@/server/downloads/query';

/** Returns matching the filters (types, companyIds, from, to, status), with the formats each can be downloaded in. */
export const GET = api('return:view', async (req, { auth }) => ({ items: await listReturns(auth, criteriaFrom(req.nextUrl.searchParams)) }));
