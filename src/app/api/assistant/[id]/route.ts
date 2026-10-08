import { api } from '@/server/http';
import { deleteChat, getChat } from '@/server/assistant';

export const GET = api('return:view', async (_req, { auth, params }) => getChat(auth, params.id));
export const DELETE = api('return:view', async (_req, { auth, params }) => deleteChat(auth, params.id));
