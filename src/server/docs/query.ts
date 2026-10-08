import 'server-only';
import type { RecordQuery } from '.';

const num = (s: string | null) => (s != null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
const str = (s: string | null, max = 60) => (s ? s.slice(0, max) : undefined);

/** Record filters from the query string. */
export function recordQuery(q: URLSearchParams): RecordQuery {
  const kind = q.get('kind');
  const direction = q.get('direction');
  return {
    companyId: q.get('companyId') ?? '', fy: str(q.get('fy'), 7), fp: str(q.get('fp'), 6),
    kind: kind === 'invoice' || kind === 'bank' ? kind : undefined,
    direction: direction === 'sales' || direction === 'purchase' ? direction : undefined,
    source: str(q.get('source'), 20), review: str(q.get('review'), 20), flag: str(q.get('flag'), 120), mode: str(q.get('mode'), 20),
    minAmount: num(q.get('min')), maxAmount: num(q.get('max')), q: str(q.get('q'), 120), docId: str(q.get('docId'), 32),
    ids: q.get('ids') ? q.get('ids')!.split(',').slice(0, 2000) : undefined,
    page: num(q.get('page')), limit: num(q.get('limit')),
  };
}
