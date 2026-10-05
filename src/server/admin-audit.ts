import 'server-only';
import { audit } from './audit';
import type { AdminAuth } from './superadmin';

/** Records a super admin action in the affected organisation's own audit chain. */
export function auditForOrg(admin: AdminAuth, orgId: unknown, action: string, entity: string, entityId: string, meta: Record<string, unknown> = {}) {
  if (!orgId) return Promise.resolve();
  return audit({ orgId: String(orgId), userId: admin.adminId, email: `super-admin:${admin.email}` }, action, entity, entityId, meta);
}
