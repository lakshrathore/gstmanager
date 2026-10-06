import { LicenseAction } from '@/server/admin-schemas';
import { auditForOrg } from '@/server/admin-audit';
import { HttpError } from '@/server/http';
import { License, oid } from '@/server/models';
import { adminApi } from '@/server/superadmin';

const DAY = 86_400_000;

export const PATCH = adminApi(async (req, { admin, params }) => {
  const b = LicenseAction.parse(await req.json());
  const lic = await License.findById(oid(params.id));
  if (!lic) throw new HttpError(404, 'License not found');
  switch (b.action) {
    case 'suspend':
      if (lic.status !== 'active') throw new HttpError(409, 'Only an active license can be suspended');
      lic.status = 'suspended';
      break;
    case 'resume':
      if (lic.status !== 'suspended') throw new HttpError(409, 'Only a suspended license can be resumed');
      lic.status = 'active';
      break;
    case 'revoke':
      if (lic.status === 'revoked') throw new HttpError(409, 'Already revoked');
      lic.status = 'revoked';
      break;
    case 'extend':
      if (lic.status === 'unused') lic.durationDays = Math.max(1, lic.durationDays + b.days);
      else {
        // Extending an already expired license counts from today.
        const base = lic.expiresAt && lic.expiresAt.getTime() > Date.now() ? lic.expiresAt.getTime() : Date.now();
        lic.expiresAt = new Date(base + b.days * DAY);
      }
      break;
    case 'note':
      lic.issuedTo = b.issuedTo;
      lic.note = b.note;
      break;
    case 'extras':
      lic.set('extras', { companies: b.companies, users: b.users, returnsPerMonth: b.returnsPerMonth });
      break;
  }
  await lic.save();
  if (b.action !== 'note') await auditForOrg(admin, lic.orgId, `license.${b.action}`, 'License', String(lic._id), { ...b, expiresAt: lic.expiresAt });
  return { license: lic.toObject() };
});

/** Only keys that were never activated can be deleted. */
export const DELETE = adminApi(async (_req, { params }) => {
  const res = await License.deleteOne({ _id: oid(params.id), status: 'unused' });
  if (!res.deletedCount) throw new HttpError(409, 'Only unused license keys can be deleted – revoke it instead');
  return { ok: true };
});
