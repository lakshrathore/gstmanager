import 'server-only';
import { randomInt } from 'node:crypto';
import type { Types } from 'mongoose';
import { HttpError } from './http';
import { Company, GstReturn, License, Organization, Package, User, oid, type FeatureKey } from './models';

/**
 * Licensing: a License (key) binds one Package (limits + features) to one organisation for a period.
 * The org's current license is Organization.licenseId. Without a valid license the workspace is
 * read-only: GET requests work, everything that changes data is refused (see api() in http.ts).
 */

export const FEATURES: Record<FeatureKey, string> = {
  validators: 'GSTIN / HSN / JSON validators',
  gstApi: 'File returns through the GST API integration',
  marketplaceImport: 'Import Amazon / Flipkart / Meesho sales reports',
  manualEntry: 'Add and edit return entries manually',
};

export const LIMITS = {
  companies: 'Companies (GSTINs)',
  users: 'Active team members',
  returnsPerMonth: 'New returns per month',
} as const;
export type LimitKey = keyof typeof LIMITS;

export type LicenseStatus = 'active' | 'expired' | 'suspended' | 'revoked' | 'none';

export interface LicenseState {
  status: LicenseStatus;
  id: string | null;
  key: string | null;
  expiresAt: Date | null;
  daysLeft: number | null;
  /** limits = package limits + extras (0 stays unlimited); baseLimits = the package alone. */
  plan: { id: string; name: string; limits: Record<LimitKey, number>; baseLimits: Record<LimitKey, number>; extras: Record<LimitKey, number>; features: FeatureKey[] } | null;
}

const LIMIT_KEYS = ['companies', 'users', 'returnsPerMonth'] as const;

const DAY = 86_400_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function generateKey() {
  const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `GSTD-${group()}-${group()}-${group()}-${group()}`;
}

export const normalizeKey = (k: string) => k.trim().toUpperCase().replace(/\s+/g, '');

export async function licenseState(orgId: string | Types.ObjectId): Promise<LicenseState> {
  const org = await Organization.findById(orgId).select({ licenseId: 1 }).lean();
  const lic = org?.licenseId ? await License.findById(org.licenseId).lean() : null;
  if (!lic) return { status: 'none', id: null, key: null, expiresAt: null, daysLeft: null, plan: null };
  const pkg = await Package.findById(lic.packageId).lean();
  const expiresAt = lic.expiresAt ?? null;
  const expired = !expiresAt || expiresAt.getTime() <= Date.now();
  const status: LicenseStatus = lic.status === 'suspended' ? 'suspended' : lic.status === 'revoked' ? 'revoked' : lic.status !== 'active' || expired ? 'expired' : 'active';
  return {
    status,
    id: String(lic._id),
    key: lic.key,
    expiresAt,
    daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / DAY)) : null,
    plan: pkg
      ? (() => {
          const base = Object.fromEntries(LIMIT_KEYS.map((k) => [k, pkg.limits?.[k] ?? 0])) as Record<LimitKey, number>;
          const extras = Object.fromEntries(LIMIT_KEYS.map((k) => [k, lic.extras?.[k] ?? 0])) as Record<LimitKey, number>;
          const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, base[k] ? base[k] + extras[k] : 0])) as Record<LimitKey, number>;
          return { id: String(pkg._id), name: pkg.name, limits, baseLimits: base, extras, features: (pkg.features ?? []) as FeatureKey[] };
        })()
      : null,
  };
}

const STATUS_MESSAGE: Record<Exclude<LicenseStatus, 'active'>, string> = {
  none: 'This workspace has no license. Activate a license key on the License page to make changes.',
  expired: 'Your license has expired. Renew it on the License page to make changes.',
  suspended: 'Your license is suspended. Contact the software provider.',
  revoked: 'Your license has been revoked. Contact the software provider.',
};

/** Throws 402 unless the org has an active license (and the feature, when given). */
export async function requireLicense(orgId: string, feature?: FeatureKey) {
  const st = await licenseState(orgId);
  if (st.status !== 'active') throw new HttpError(402, STATUS_MESSAGE[st.status]);
  if (feature && !st.plan?.features.includes(feature)) throw new HttpError(402, `Your ${st.plan?.name ?? ''} plan does not include: ${FEATURES[feature]}. Upgrade your package to use it.`);
  return st;
}

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

export async function usage(orgId: string | Types.ObjectId): Promise<Record<LimitKey, number>> {
  const o = oid(String(orgId));
  const [companies, users, returnsPerMonth] = await Promise.all([
    Company.countDocuments({ orgId: o }),
    User.countDocuments({ orgId: o, active: true }),
    GstReturn.countDocuments({ orgId: o, createdAt: { $gte: monthStart() } }),
  ]);
  return { companies, users, returnsPerMonth };
}

/** Throws 402 when adding one more of `what` would exceed the plan. */
export async function assertWithinLimit(orgId: string, what: LimitKey) {
  const st = await requireLicense(orgId);
  const max = st.plan?.limits[what] ?? 0;
  if (!max) return;
  const used = (await usage(orgId))[what];
  if (used >= max) throw new HttpError(402, `Your ${st.plan!.name} plan allows ${max} ${LIMITS[what].toLowerCase()} (using ${used}). Buy an add-on or upgrade your plan on the License page.`);
}

/**
 * Puts a license into force for an org. If the org's current license is still valid, the new period
 * starts when it ends (renewal); otherwise from now. The previous license is marked replaced.
 */
export async function applyLicense(orgId: Types.ObjectId, licenseId: Types.ObjectId) {
  const lic = await License.findById(licenseId);
  if (!lic) throw new HttpError(404, 'License not found');
  if (lic.status !== 'unused') throw new HttpError(409, 'This license key has already been used');
  const org = await Organization.findById(orgId);
  if (!org) throw new HttpError(404, 'Organisation not found');
  const prev = org.licenseId ? await License.findById(org.licenseId) : null;
  const prevEnd = prev?.status === 'active' && prev.expiresAt && prev.expiresAt.getTime() > Date.now() ? prev.expiresAt.getTime() : Date.now();
  // Claim atomically so the same key cannot be activated twice concurrently.
  const claimed = await License.findOneAndUpdate(
    { _id: lic._id, status: 'unused' },
    { $set: { status: 'active', orgId, activatedAt: new Date(), expiresAt: new Date(prevEnd + lic.durationDays * DAY) } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw new HttpError(409, 'This license key has already been used');
  if (prev && String(prev._id) !== String(claimed._id) && prev.status === 'active') {
    prev.status = 'replaced';
    await prev.save();
  }
  org.licenseId = claimed._id;
  await org.save();
  return claimed.toObject();
}

export async function activateKey(orgId: string, key: string) {
  const lic = await License.findOne({ key: normalizeKey(key) }).lean();
  if (!lic) throw new HttpError(404, 'License key not found. Check it and try again.');
  return applyLicense(oid(orgId)!, lic._id);
}

/** Gives a brand-new org the trial package, if the super admin has marked one. */
export async function grantTrial(orgId: Types.ObjectId) {
  const pkg = await Package.findOne({ isTrial: true, active: true }).sort({ updatedAt: -1 }).lean();
  if (!pkg) return null;
  const lic = await License.create({ key: generateKey(), packageId: pkg._id, durationDays: pkg.durationDays, issuedTo: 'Trial (auto)' });
  return applyLicense(orgId, lic._id);
}
