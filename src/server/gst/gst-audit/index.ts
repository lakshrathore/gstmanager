import 'server-only';
import type { Auth } from '../../auth';
import { audit, verifyAuditChain } from './chain';

export { audit, verifyAuditChain };

/** Minimal return identity stamped on every return-level audit entry (period + GSTIN always present). */
export interface ReturnRef {
  _id: unknown;
  gstin: string;
  fp: string;
}

/** Audit an action on a GSTR-1 return; always records returnId, GSTIN and return period. */
export function auditReturn(auth: Auth, ret: ReturnRef, action: string, meta: Record<string, unknown> = {}, entity = 'GstReturn', entityId?: string) {
  return audit(auth, action, entity, entityId ?? String(ret._id), { returnId: String(ret._id), gstin: ret.gstin, fp: ret.fp, ...meta });
}
