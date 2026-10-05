import { IssueLicenseBody } from '@/server/admin-schemas';
import { auditForOrg } from '@/server/admin-audit';
import { HttpError } from '@/server/http';
import { applyLicense, generateKey } from '@/server/license';
import { License, LICENSE_STATUSES, oid, Organization, Package } from '@/server/models';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = {};
  const status = q.get('status');
  if (status && (LICENSE_STATUSES as readonly string[]).includes(status)) filter.status = status;
  if (q.get('packageId')) filter.packageId = oid(q.get('packageId')!);
  const search = q.get('q')?.trim();
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ key: rx }, { issuedTo: rx }];
  }
  const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const [pkgs, orgs] = await Promise.all([
    Package.find({ _id: { $in: [...new Set(licenses.map((l) => String(l.packageId)))].map(oid) } }).select({ name: 1 }).lean(),
    Organization.find({ _id: { $in: [...new Set(licenses.filter((l) => l.orgId).map((l) => String(l.orgId)))].map(oid) } }).select({ name: 1 }).lean(),
  ]);
  const pName = new Map(pkgs.map((p) => [String(p._id), p.name]));
  const oName = new Map(orgs.map((o) => [String(o._id), o.name]));
  return {
    licenses: licenses.map((l) => ({
      ...l,
      packageName: pName.get(String(l.packageId)) ?? '—',
      orgName: l.orgId ? oName.get(String(l.orgId)) ?? '(deleted)' : null,
      expired: l.status === 'active' && !!l.expiresAt && l.expiresAt.getTime() <= Date.now(),
    })),
  };
});

/** Generates license keys for a package; with orgId, activates the single key for that org at once. */
export const POST = adminApi(async (req, { admin }) => {
  const b = IssueLicenseBody.parse(await req.json());
  const pkg = await Package.findById(oid(b.packageId)).lean();
  if (!pkg) throw new HttpError(404, 'Package not found');
  if (!pkg.active) throw new HttpError(409, 'This package is archived – restore it to issue licenses');
  if (b.orgId && b.count !== 1) throw new HttpError(400, 'Assign one license at a time to an organisation');
  const org = b.orgId ? await Organization.findById(oid(b.orgId)).lean() : null;
  if (b.orgId && !org) throw new HttpError(404, 'Organisation not found');

  const created = await License.insertMany(Array.from({ length: b.count }, () => ({
    key: generateKey(), packageId: pkg._id, durationDays: b.durationDays ?? pkg.durationDays,
    issuedTo: b.issuedTo || org?.name, note: b.note, createdBy: oid(admin.adminId),
  })));
  if (org) {
    const lic = await applyLicense(org._id, created[0]._id);
    await auditForOrg(admin, org._id, 'license.assigned', 'License', String(lic._id), { package: pkg.name, expiresAt: lic.expiresAt });
    return { licenses: [lic] };
  }
  return { licenses: created.map((l) => l.toObject()) };
});
