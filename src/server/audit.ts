import 'server-only';
import type { Auth } from './auth';
import { redact, sha256 } from './crypto';
import { AuditLog, oid } from './models';

/**
 * Append-only, hash-chained audit trail per organisation. Each entry's hash covers the previous
 * hash, so any edit/deletion directly in the database breaks the chain and is detectable via
 * verifyAuditChain(). Secrets are redacted before writing.
 */
export async function audit(auth: Pick<Auth, 'orgId' | 'userId' | 'email'>, action: string, entity: string, entityId: string, meta: Record<string, unknown> = {}) {
  const orgId = oid(auth.orgId)!;
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await AuditLog.findOne({ orgId }).sort({ seq: -1 }).select({ seq: 1, hash: 1 }).lean();
    const entry = {
      orgId, seq: (last?.seq ?? 0) + 1, at: new Date(), actorId: oid(auth.userId) ?? undefined, actorEmail: auth.email,
      action, entity, entityId, meta: redact(meta), prevHash: last?.hash ?? 'GENESIS',
    };
    const hash = sha256(JSON.stringify({ ...entry, orgId: String(orgId), actorId: auth.userId, at: entry.at.toISOString() }));
    try {
      await AuditLog.create({ ...entry, hash });
      return;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e; // concurrent append – retry with new seq
    }
  }
  throw new Error('Could not append audit entry');
}

export async function verifyAuditChain(orgId: string): Promise<{ ok: boolean; brokenAtSeq?: number; checked: number }> {
  let prev = 'GENESIS';
  let checked = 0;
  for await (const e of AuditLog.find({ orgId: oid(orgId) }).sort({ seq: 1 }).lean().cursor()) {
    const expected = sha256(JSON.stringify({
      orgId, seq: e.seq, at: e.at.toISOString(), actorId: e.actorId ? String(e.actorId) : undefined, actorEmail: e.actorEmail,
      action: e.action, entity: e.entity, entityId: e.entityId, meta: e.meta, prevHash: e.prevHash,
    }));
    if (e.prevHash !== prev || e.hash !== expected) return { ok: false, brokenAtSeq: e.seq, checked };
    prev = e.hash;
    checked++;
  }
  return { ok: true, checked };
}
