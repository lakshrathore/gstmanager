import 'server-only';
import { z } from 'zod';
import { RETURN_TYPES, type Criteria, type Format } from '.';

const list = (s: string | null) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

const CriteriaSchema = z.object({
  types: z.array(z.enum(RETURN_TYPES)).min(1).max(4),
  companyIds: z.array(z.string().max(32)).max(500),
  from: z.string(),
  to: z.string(),
  status: z.enum(['all', 'filed', 'unfiled']),
});

/** Filters from the query string: types=gstr1,gstr9&companyIds=a,b&from=042024&to=032025&status=all */
export function criteriaFrom(q: URLSearchParams): Criteria {
  return CriteriaSchema.parse({ types: list(q.get('types')), companyIds: list(q.get('companyIds')), from: q.get('from') ?? '', to: q.get('to') ?? '', status: q.get('status') ?? 'all' });
}

export const formatsFrom = (s: string | null): Format[] => (s === 'both' ? ['json', 'xlsx'] : s === 'json' ? ['json'] : ['xlsx']);
