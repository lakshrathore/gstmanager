import { api } from '@/server/http';
import { revalidate } from '@/server/gst/gstr1';

export const POST = api('return:edit', async (_req, { auth, params }) => revalidate(auth, params.id));
