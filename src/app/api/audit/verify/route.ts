import { api } from '@/server/http';
import { verifyAuditChain } from '@/server/gst/gst-audit';

export const GET = api('audit:view', async (_req, { auth }) => verifyAuditChain(auth.orgId));
