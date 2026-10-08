import { z } from 'zod';
import { can, type Permission } from '@/server/auth';
import { api, HttpError } from '@/server/http';
import { autofill, markFiled, overview, reopen, saveDraft } from '@/server/gst/annual';

/** GSTR-9 / GSTR-9C for one company and financial year: overview (GET ?kind&companyId&fy) and actions (POST). */
export const GET = api('return:view', async (req, { auth }) => {
  const q = req.nextUrl.searchParams;
  return overview(auth, q.get('kind') ?? '', q.get('companyId') ?? '', q.get('fy') ?? '');
});

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save_draft'), form: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('autofill') }),
  z.object({ action: z.literal('mark_filed'), arn: z.string().min(5).max(30), filedOn: z.string().min(8).max(30) }),
  z.object({ action: z.literal('reopen'), reason: z.string().min(3).max(200) }),
]);
type Action = z.infer<typeof Body>['action'];
const NEEDS: Record<Action, Permission> = { save_draft: 'return:edit', autofill: 'return:edit', mark_filed: 'return:file', reopen: 'return:file' };

const Target = z.object({ kind: z.enum(['gstr9', 'gstr9c']), companyId: z.string().min(1).max(32), fy: z.string().regex(/^\d{4}-\d{2}$/) });

export const POST = api('return:view', async (req, { auth }) => {
  const raw = await req.json();
  const { kind, companyId, fy } = Target.parse(raw);
  const b = Body.parse(raw);
  if (!can(auth, NEEDS[b.action])) throw new HttpError(403, 'You do not have permission for this action');
  switch (b.action) {
    case 'save_draft': return saveDraft(auth, kind, companyId, fy, b.form);
    case 'autofill': return autofill(auth, kind, companyId, fy);
    case 'mark_filed': return markFiled(auth, kind, companyId, fy, b);
    case 'reopen': return reopen(auth, kind, companyId, fy, b.reason);
  }
}, { rateLimit: { key: 'annual', max: 60, windowMs: 60_000 } });
