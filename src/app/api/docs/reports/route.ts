import { api } from '@/server/http';
import { report, reportXlsx } from '@/server/docs/search';

/** A report table: ?report&companyId&fy[&fp][&format=xlsx]. */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const args = [auth, q.get('companyId') ?? '', q.get('fy') ?? '', q.get('fp') || undefined, q.get('report') ?? ''] as const;
  if (q.get('format') !== 'xlsx') return report(...args);
  const f = await reportXlsx(...args);
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${f.fileName}"` } });
}, { rateLimit: { key: 'docs-reports', max: 60, windowMs: 60_000 } });
