import { z } from 'zod';
import { api } from '@/server/http';
import { docAction, docDetail } from '@/server/docs';

export const GET = api('return:view', async (_req, { auth, params }) => docDetail(auth, params.id));

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), companyId: z.string().min(1).max(32) }),
  z.object({ action: z.literal('set_kind'), kind: z.string().min(2).max(40) }),
  z.object({ action: z.literal('reprocess') }),
  z.object({ action: z.literal('delete') }),
]);

/** Document actions: assign to a client, correct its type, read again, delete (with its records). */
export const POST = api('return:edit', async (req, { auth, params }) => docAction(auth, params.id, Body.parse(await req.json())));
