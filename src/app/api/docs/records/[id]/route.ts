import { z } from 'zod';
import { api } from '@/server/http';
import { getRecord, updateRecord } from '@/server/docs';

export const GET = api('return:view', async (_req, { auth, params }) => getRecord(auth, params.id));

const Body = z.object({
  action: z.enum(['save', 'approve', 'reject', 'reopen']),
  data: z.record(z.string(), z.unknown()).optional(),
  direction: z.enum(['sales', 'purchase']).optional(),
});

/** Correct, approve, reject or reopen one extracted record. */
export const PATCH = api('return:edit', async (req, { auth, params }) => updateRecord(auth, params.id, Body.parse(await req.json())));
