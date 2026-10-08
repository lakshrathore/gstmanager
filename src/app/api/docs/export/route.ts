import { api } from '@/server/http';
import { exportRecords, exportReport } from '@/server/docs/export';
import { recordQuery } from '@/server/docs/query';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel: ?what=report&companyId&fy[&fp] (full report) or ?what=records&… (records matching the filters). */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  const f = q.get('what') === 'records'
    ? await exportRecords(auth, recordQuery(q))
    : await exportReport(auth, q.get('companyId') ?? '', q.get('fy') ?? '', q.get('fp') || undefined);
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': XLSX, 'content-disposition': `attachment; filename="${f.fileName}"` } });
}, { rateLimit: { key: 'docs-export', max: 20, windowMs: 60_000 } });
