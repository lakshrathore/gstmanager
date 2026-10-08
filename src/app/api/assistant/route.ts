import { z } from 'zod';
import { api } from '@/server/http';
import { ask, listChats } from '@/server/assistant';

/** GET ?companyId: the user's conversations about a client. POST { companyId, message, chatId? }: ask a question. */
export const GET = api('return:view', async (req, { auth }) => listChats(auth, req.nextUrl.searchParams.get('companyId') ?? ''));

const Body = z.object({ companyId: z.string().min(1).max(32), chatId: z.string().max(32).optional(), message: z.string().min(1).max(2000) });
export const POST = api('return:view', async (req, { auth }) => ask(auth, Body.parse(await req.json())), { rateLimit: { key: 'assistant', max: 20, windowMs: 60_000 } });
