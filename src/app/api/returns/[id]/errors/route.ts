import { api } from '@/server/http';
import { Gstr1Error } from '@/server/models';
import { loadReturn } from '@/server/gst/gstr1';

const COLS = ['severity', 'origin', 'section', 'documentNo', 'sheet', 'row', 'field', 'value', 'message', 'suggestion', 'code'] as const;
const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // guard against CSV formula injection
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const GET = api('return:view', async (req, { auth, params }) => {
  const { ret } = await loadReturn(auth, params.id);
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { returnId: ret._id, orgId: ret.orgId };
  for (const k of ['origin', 'severity', 'section']) if (sp.get(k)) filter[k] = sp.get(k);
  const errors = await Gstr1Error.find(filter).sort({ severity: 1, section: 1, row: 1 }).limit(sp.get('format') === 'csv' ? 100_000 : 2000).lean();
  if (sp.get('format') === 'csv') {
    const body = [COLS.join(','), ...errors.map((e) => COLS.map((c) => csvCell((e as Record<string, unknown>)[c])).join(','))].join('\n');
    return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="GSTR1_errors_${ret.gstin}_${ret.fp}.csv"` } });
  }
  return { errors };
});
