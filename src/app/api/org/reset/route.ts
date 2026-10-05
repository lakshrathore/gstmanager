import { z } from 'zod';
import { api } from '@/server/http';
import { dataCounts, resetOrganisation } from '@/server/org-reset';

/** What a reset would delete. */
export const GET = api('org:reset', async (_req, { auth }) => dataCounts(auth));

const Body = z.object({ confirm: z.string().max(40), password: z.string().min(1).max(128), removeTeam: z.boolean().default(false) });

/** Deletes all of the organisation's data (owner only, phrase + password). */
export const POST = api('org:reset', async (req, { auth }) => resetOrganisation(auth, Body.parse(await req.json())),
  { unlicensed: true, rateLimit: { key: 'org-reset', max: 5, windowMs: 10 * 60_000 } });
