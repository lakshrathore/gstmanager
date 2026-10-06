import { z } from 'zod';
import { api } from '@/server/http';
import { exportRecon } from '@/server/recon';

export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const { buf, name } = await exportRecon(auth, q.get('companyId') ?? '', q.get('fp') ?? '', z.enum(['gstr2a', 'gstr2b']).parse(q.get('against')));
  return new Response(new Uint8Array(buf), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}"` },
  });
}, { feature: 'reconciliation' });
