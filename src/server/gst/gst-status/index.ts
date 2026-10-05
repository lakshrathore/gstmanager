import 'server-only';
import type { Auth } from '../../auth';
import { HttpError } from '../../http';
import { GstReturn, oid, PortalEvidence } from '../../models';
import { auditReturn, type ReturnRef } from '../gst-audit';
import { EVIDENCE_REQUIRED, normalizeStatus, STATUS_LABELS, TRANSITIONS, type ReturnStatus } from './statuses';

export * from './statuses';

/** Throws unless `to` is reachable from the current status. Call before recording evidence for it. */
export function assertCanMove(status: string, to: ReturnStatus) {
  const from = normalizeStatus(status);
  if (from !== to && !TRANSITIONS[from].includes(to)) {
    throw new HttpError(409, `Can't move this return from "${STATUS_LABELS[from]}" to "${STATUS_LABELS[to]}"`);
  }
}

interface ChangeOpts {
  note?: string;
  /** PortalEvidence id backing this change – mandatory for processed / filed / error. */
  evidenceId?: string;
  /** Extra $set fields written atomically with the status change. */
  set?: Record<string, unknown>;
}

/**
 * The only place that writes GstReturn.status. Enforces the transition table and the evidence rule,
 * appends status history, and audits the change. Uses a conditional update so two concurrent requests
 * can't both move the return from the same state.
 */
export async function changeStatus(auth: Auth, ret: ReturnRef & { status: string; orgId: unknown }, to: ReturnStatus, opts: ChangeOpts = {}) {
  const from = normalizeStatus(ret.status);
  if (from === to && !opts.set) return from;
  assertCanMove(from, to);
  const needed = EVIDENCE_REQUIRED[to];
  if (needed && from !== to) {
    const ev = opts.evidenceId && (await PortalEvidence.findOne({ _id: oid(opts.evidenceId), returnId: ret._id, orgId: ret.orgId, kind: needed }).lean());
    if (!ev) throw new HttpError(422, `"${STATUS_LABELS[to]}" needs portal evidence (${needed.replace('_', ' ')})`);
  }
  const res = await GstReturn.updateOne(
    { _id: ret._id, status: { $in: [ret.status, from] } },
    {
      $set: { status: to, ...(opts.set ?? {}) },
      ...(from !== to
        ? { $push: { statusHistory: { from, to, at: new Date(), by: oid(auth.userId), byEmail: auth.email, note: opts.note, evidenceId: opts.evidenceId ? oid(opts.evidenceId) : undefined } } }
        : {}),
    },
  );
  if (!res.matchedCount) throw new HttpError(409, 'The return was changed by someone else – reload and try again');
  if (from !== to) await auditReturn(auth, ret, 'status.change', { from, to, note: opts.note, evidenceId: opts.evidenceId });
  return to;
}
