import { z } from 'zod';
import { api } from '@/server/http';
import { approveClean, listRecords } from '@/server/docs';
import { recordQuery } from '@/server/docs/query';

/** Extracted records with filters (see recordQuery); POST { action: "approve_clean", ids } approves those without errors. */
export const GET = api('return:view', async (req, { auth }) => listRecords(auth, recordQuery(req.nextUrl.searchParams)));

const Body = z.object({ action: z.literal('approve_clean'), ids: z.array(z.string().max(32)).min(1).max(5000) });
export const POST = api('return:edit', async (req, { auth }) => { const b = Body.parse(await req.json()); return approveClean(auth, b.ids); });
