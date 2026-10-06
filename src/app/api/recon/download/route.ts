import { z } from 'zod';
import { api } from '@/server/http';
import { downloadSource } from '@/server/recon';

/** Excel of the books / GSTR-2A / GSTR-2B data stored for a company + period (uploaded or fetched from GSTN). */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const { buf, name } = await downloadSource(auth, q.get('companyId') ?? '', q.get('fp') ?? '', z.enum(['books', 'gstr2a', 'gstr2b']).parse(q.get('source')));
  return new Response(new Uint8Array(buf), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}"` },
  });
}, { feature: 'reconciliation' });
