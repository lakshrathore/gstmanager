import 'server-only';
import bcrypt from 'bcryptjs';
import type { Auth } from './auth';
import { audit } from './gst/gst-audit';
import { HttpError } from './http';
import {
  AuditLog, Company, GeneratedJson, GstApiSession, GstReturn, Gstr1Error, Gstr1Record, oid, PortalEvidence, PurchaseDoc, PurchaseImport, ReconDecision, UploadJob, User,
} from './models';

/**
 * "Start fresh": deletes every record the organisation owns. The organisation and the owner's own
 * login are kept (optionally the other team members are removed too). Owner only, with the typed
 * confirmation phrase and the owner's password.
 *
 * The audit log is append-only through Mongoose hooks; this is the one place that deletes it, through
 * the driver on purpose. A new chain then starts with an `org.reset` entry, so Verify integrity passes.
 */

export const RESET_PHRASE = 'DELETE ALL DATA';

/** Children first, so a failed run never leaves records pointing at a deleted parent. Safe to re-run. */
const TARGETS: { key: string; label: string; model: { collection: Collection } }[] = [
  { key: 'records', label: 'Invoice / table records', model: Gstr1Record },
  { key: 'errors', label: 'Validation and portal errors', model: Gstr1Error },
  { key: 'json', label: 'Generated JSON files', model: GeneratedJson },
  { key: 'uploads', label: 'Upload jobs', model: UploadJob },
  { key: 'evidence', label: 'Portal evidence (references, reports, files)', model: PortalEvidence },
  { key: 'sessions', label: 'GST API sessions', model: GstApiSession },
  { key: 'purchases', label: 'Purchase documents (books, GSTR-2A, GSTR-2B)', model: PurchaseDoc },
  { key: 'purchaseImports', label: 'Purchase uploads', model: PurchaseImport },
  { key: 'reconDecisions', label: 'Reconciliation decisions', model: ReconDecision },
  { key: 'returns', label: 'GSTR-1 returns', model: GstReturn },
  { key: 'companies', label: 'Companies', model: Company },
  { key: 'audit', label: 'Audit log entries', model: AuditLog },
];

type Collection = typeof Company.collection;

export interface ResetCount { key: string; label: string; count: number }

const orgFilter = (auth: Auth) => {
  const orgId = oid(auth.orgId);
  if (!orgId) throw new HttpError(400, 'Invalid organisation');
  return { orgId };
};

export async function dataCounts(auth: Auth) {
  const { orgId } = orgFilter(auth);
  const counts: ResetCount[] = await Promise.all(TARGETS.map(async (t) => ({ key: t.key, label: t.label, count: await t.model.collection.countDocuments({ orgId }) })));
  const otherUsers = await User.countDocuments({ orgId, _id: { $ne: oid(auth.userId) } });
  return { counts, otherUsers, phrase: RESET_PHRASE };
}

export async function resetOrganisation(auth: Auth, input: { confirm: string; password: string; removeTeam: boolean }) {
  if (input.confirm.trim() !== RESET_PHRASE) throw new HttpError(400, `Type ${RESET_PHRASE} exactly to confirm`);
  const me = await User.findOne({ _id: oid(auth.userId), orgId: oid(auth.orgId) }).select('+passwordHash');
  if (!me || !(await bcrypt.compare(input.password, me.passwordHash))) throw new HttpError(403, 'Password is incorrect');

  const { orgId } = orgFilter(auth);
  const deleted: ResetCount[] = [];
  for (const t of TARGETS) {
    // Driver-level delete, always scoped to this organisation. For AuditLog this deliberately bypasses
    // the append-only hook (AuditLog.deleteMany throws).
    const res = await t.model.collection.deleteMany({ orgId });
    deleted.push({ key: t.key, label: t.label, count: res.deletedCount ?? 0 });
  }
  if (input.removeTeam) {
    const res = await User.deleteMany({ orgId, _id: { $ne: me._id } });
    deleted.push({ key: 'users', label: 'Other team members', count: res.deletedCount ?? 0 });
  }
  // First entry of the new chain.
  await audit(auth, 'org.reset', 'Organization', auth.orgId, { deleted: Object.fromEntries(deleted.map((d) => [d.key, d.count])), removeTeam: input.removeTeam });
  return { deleted };
}
