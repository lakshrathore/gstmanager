import 'server-only';
import { ADDON_LABELS, ADDON_UNITS, upiLink, type AddonKey } from '@/lib/upi';
import type { Auth } from './auth';
import { auditForOrg } from './admin-audit';
import { audit } from './audit';
import { HttpError } from './http';
import { applyLicense, generateKey, licenseState } from './license';
import { License, oid, Organization, Package, PaymentRequest, PlatformSettings } from './models';
import type { AdminAuth } from './superadmin';

/**
 * Manual UPI payments (no gateway): the firm scans a UPI QR generated from the super admin's UPI ID,
 * pays, then submits the UTR and a screenshot. The super admin checks the payment in their bank/UPI
 * app and approves. Two kinds:
 *  - package: approval issues a license for the package and activates it (renewal stacks)
 *  - addon:   extra companies / team members / returns added to the current license until it ends
 */

export const UPI_ID_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const ADDON_KEYS = Object.keys(ADDON_UNITS) as AddonKey[];

export type AddonPrices = Record<AddonKey, number>;

export async function paymentSettings() {
  const s = await PlatformSettings.findOne({ key: 'platform' }).lean();
  const addonPrices = Object.fromEntries(ADDON_KEYS.map((k) => [k, s?.addonPrices?.[k] ?? 0])) as AddonPrices;
  return { upiId: s?.upiId ?? '', payeeName: s?.payeeName ?? '', paymentNote: s?.paymentNote ?? '', addonPrices };
}

export async function savePaymentSettings(input: { upiId: string; payeeName: string; paymentNote?: string; addonPrices?: AddonPrices }) {
  if (input.upiId && !UPI_ID_RE.test(input.upiId)) throw new HttpError(400, 'UPI ID looks wrong – it should look like name@bank');
  await PlatformSettings.updateOne({ key: 'platform' }, { $set: input }, { upsert: true });
  return paymentSettings();
}

/** Add-ons the org can buy now: needs an active license whose package limits that resource, and a price. */
async function addonOffer(orgId: string) {
  const [settings, st] = await Promise.all([paymentSettings(), licenseState(orgId)]);
  if (st.status !== 'active' || !st.plan || !st.id) return { licenseId: null, expiresAt: null, items: [] as { key: AddonKey; label: string; unit: number; priceInr: number; current: number }[] };
  const items = ADDON_KEYS
    .filter((k) => settings.addonPrices[k] > 0 && st.plan!.baseLimits[k] > 0)
    .map((k) => ({ key: k, label: ADDON_LABELS[k], unit: ADDON_UNITS[k], priceInr: settings.addonPrices[k], current: st.plan!.limits[k] }));
  return { licenseId: st.id, expiresAt: st.expiresAt, items };
}

/** Packages a firm can buy (each with its UPI link), and add-ons for its current plan. */
export async function paymentOptions(orgId: string) {
  const settings = await paymentSettings();
  const org = await Organization.findById(oid(orgId)).select({ name: 1 }).lean();
  const pkgs = await Package.find({ active: true, isTrial: { $ne: true }, priceInr: { $gt: 0 } }).sort({ priceInr: 1 }).lean();
  const addons = await addonOffer(orgId);
  return {
    upiId: settings.upiId,
    payeeName: settings.payeeName,
    paymentNote: settings.paymentNote,
    orgName: org?.name ?? '',
    packages: pkgs.map((p) => ({
      _id: String(p._id), name: p.name, description: p.description ?? '', priceInr: p.priceInr, durationDays: p.durationDays,
      limits: p.limits, features: p.features ?? [],
      upiLink: settings.upiId ? upiLink(settings.upiId, settings.payeeName, p.priceInr, `GST Desk ${p.name} ${org?.name ?? ''}`) : null,
    })),
    addons: { expiresAt: addons.expiresAt, items: settings.upiId ? addons.items : [] },
  };
}

function imageType(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Checks shared by both kinds of payment: UPI configured, UTR, screenshot, no duplicates. */
async function commonProof(auth: Auth, utrRaw: string, file: File | null) {
  const settings = await paymentSettings();
  if (!settings.upiId) throw new HttpError(409, 'Online payment is not set up yet. Contact the software provider.');
  const utr = utrRaw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'Enter the UPI transaction ID / UTR exactly as shown in your UPI app (6–30 letters or digits)');
  if (!file || !file.size) throw new HttpError(400, 'Attach the payment screenshot');
  if (file.size > MAX_SCREENSHOT) throw new HttpError(413, 'Screenshot is too large (max 5 MB)');
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = imageType(bytes);
  if (!type) throw new HttpError(400, 'Screenshot must be a PNG, JPG or WEBP image');
  if (await PaymentRequest.exists({ utr, status: { $ne: 'rejected' } })) throw new HttpError(409, 'This transaction ID has already been submitted');
  if (await PaymentRequest.exists({ orgId: oid(auth.orgId), status: 'pending' })) throw new HttpError(409, 'You already have a payment waiting for approval');
  return { settings, utr, bytes, type };
}

export interface PaymentInput {
  kind: 'package' | 'addon';
  packageId?: string;
  /** Add-on units: companies and users one each, returnsPerMonth in blocks of 10. */
  units?: Partial<Record<AddonKey, number>>;
  utr: string;
  note?: string;
}

export async function submitPayment(auth: Auth, input: PaymentInput, file: File | null) {
  if (input.kind === 'addon') return submitAddon(auth, input, file);
  const pkg = await Package.findOne({ _id: oid(input.packageId ?? ''), active: true, isTrial: { $ne: true } }).lean();
  if (!pkg) throw new HttpError(404, 'Package not found');
  const { settings, utr, bytes, type } = await commonProof(auth, input.utr, file);
  const p = await PaymentRequest.create({
    orgId: oid(auth.orgId), userId: oid(auth.userId), userEmail: auth.email, kind: 'package', packageId: pkg._id, packageName: pkg.name,
    amountInr: pkg.priceInr, durationDays: pkg.durationDays, upiId: settings.upiId, utr, note: input.note?.slice(0, 500),
    screenshot: bytes, screenshotType: type, screenshotSize: bytes.length,
  });
  await audit(auth, 'payment.submitted', 'PaymentRequest', String(p._id), { package: pkg.name, amountInr: pkg.priceInr, utr });
  return { _id: String(p._id), status: p.status };
}

/** Human summary of an add-on purchase, e.g. "+1 company, +20 returns/month". */
export function describeAddon(a: Partial<Record<AddonKey, number | null>> | null | undefined) {
  if (!a) return '';
  const parts = [];
  if (a.companies) parts.push(`+${a.companies} ${a.companies === 1 ? 'company' : 'companies'}`);
  if (a.users) parts.push(`+${a.users} team ${a.users === 1 ? 'member' : 'members'}`);
  if (a.returnsPerMonth) parts.push(`+${a.returnsPerMonth} returns/month`);
  return parts.join(', ');
}

async function submitAddon(auth: Auth, input: PaymentInput, file: File | null) {
  const offer = await addonOffer(auth.orgId);
  if (!offer.licenseId) throw new HttpError(409, 'Add-ons need an active plan. Buy or renew a plan first.');
  const units = Object.fromEntries(ADDON_KEYS.map((k) => [k, Math.floor(Number(input.units?.[k] ?? 0))])) as Record<AddonKey, number>;
  if (ADDON_KEYS.some((k) => !Number.isFinite(units[k]) || units[k] < 0 || units[k] > 100)) throw new HttpError(400, 'Choose between 0 and 100 of each add-on');
  let amount = 0;
  for (const k of ADDON_KEYS) {
    if (!units[k]) continue;
    const item = offer.items.find((i) => i.key === k);
    if (!item) throw new HttpError(400, `${ADDON_LABELS[k]} is not available for your plan`);
    amount += units[k] * item.priceInr;
  }
  if (!amount) throw new HttpError(400, 'Choose at least one add-on');
  const { settings, utr, bytes, type } = await commonProof(auth, input.utr, file);
  const addon = { companies: units.companies * ADDON_UNITS.companies, users: units.users * ADDON_UNITS.users, returnsPerMonth: units.returnsPerMonth * ADDON_UNITS.returnsPerMonth };
  const lic = await License.findById(oid(offer.licenseId)).select({ packageId: 1 }).lean();
  const pkg = lic ? await Package.findById(lic.packageId).select({ name: 1 }).lean() : null;
  const p = await PaymentRequest.create({
    orgId: oid(auth.orgId), userId: oid(auth.userId), userEmail: auth.email, kind: 'addon', addon, forLicenseId: oid(offer.licenseId),
    packageId: lic?.packageId, packageName: `Add-on: ${describeAddon(addon)}${pkg ? ` (${pkg.name})` : ''}`,
    amountInr: amount, upiId: settings.upiId, utr, note: input.note?.slice(0, 500),
    screenshot: bytes, screenshotType: type, screenshotSize: bytes.length,
  });
  await audit(auth, 'payment.submitted', 'PaymentRequest', String(p._id), { addon, amountInr: amount, utr });
  return { _id: String(p._id), status: p.status };
}

export async function myPayments(orgId: string) {
  return PaymentRequest.find({ orgId: oid(orgId) }).sort({ createdAt: -1 }).limit(20)
    .select({ kind: 1, packageName: 1, addon: 1, amountInr: 1, utr: 1, status: 1, reviewNote: 1, createdAt: 1, reviewedAt: 1 }).lean();
}

async function rejectPayment(admin: AdminAuth, p: { _id: unknown; orgId: unknown; utr: string }, note: string) {
  // Claim atomically so two admins cannot act on the same request.
  const r = await PaymentRequest.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'rejected', reviewedAt: new Date(), reviewedBy: admin.email, reviewNote: note } });
  if (!r.modifiedCount) throw new HttpError(409, 'This payment was already reviewed');
  await auditForOrg(admin, p.orgId, 'payment.rejected', 'PaymentRequest', String(p._id), { utr: p.utr, reason: note });
  return { status: 'rejected' };
}

export async function reviewPayment(admin: AdminAuth, id: string, action: 'approve' | 'reject', note?: string) {
  const p = await PaymentRequest.findById(oid(id));
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.status !== 'pending') throw new HttpError(409, `This payment is already ${p.status}`);
  if (action === 'reject') {
    if (!note?.trim()) throw new HttpError(400, 'Give a reason so the customer knows what to fix');
    return rejectPayment(admin, p, note.trim());
  }

  if (p.kind === 'addon') {
    // The add-on belongs to the license it was bought for; it must still be the org's active license.
    const org = await Organization.findById(p.orgId).select({ licenseId: 1 }).lean();
    const lic = p.forLicenseId ? await License.findById(p.forLicenseId).lean() : null;
    if (!lic || String(org?.licenseId) !== String(lic._id) || lic.status !== 'active' || !lic.expiresAt || lic.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(409, 'The plan this add-on was bought for is no longer active. Reject it (the customer can buy again on the new plan) or add the capacity by hand on the Customers page.');
    }
    const claimed = await PaymentRequest.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'approved', reviewedAt: new Date(), reviewedBy: admin.email, reviewNote: note?.trim(), licenseId: lic._id } });
    if (!claimed.modifiedCount) throw new HttpError(409, 'This payment was already reviewed');
    const inc = Object.fromEntries(ADDON_KEYS.map((k) => [`extras.${k}`, p.addon?.[k] ?? 0]));
    await License.updateOne({ _id: lic._id }, { $inc: inc });
    await auditForOrg(admin, p.orgId, 'payment.approved', 'PaymentRequest', String(p._id), { utr: p.utr, amountInr: p.amountInr, addon: p.addon, licenseId: String(lic._id) });
    return { status: 'approved', expiresAt: lic.expiresAt };
  }

  const pkg = await Package.findById(p.packageId).lean();
  if (!pkg) throw new HttpError(404, 'The package of this payment no longer exists');
  const claimed = await PaymentRequest.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'approved', reviewedAt: new Date(), reviewedBy: admin.email, reviewNote: note?.trim() } });
  if (!claimed.modifiedCount) throw new HttpError(409, 'This payment was already reviewed');
  const lic = await License.create({
    key: generateKey(), packageId: pkg._id, durationDays: p.durationDays ?? pkg.durationDays,
    issuedTo: p.userEmail, note: `UPI payment ${p.utr} · ₹${p.amountInr}`, createdBy: oid(admin.adminId),
  });
  let applied;
  try {
    applied = await applyLicense(p.orgId, lic._id);
  } catch (e) {
    // Put the request back so it can be approved again once the problem is fixed.
    await License.deleteOne({ _id: lic._id, status: 'unused' });
    await PaymentRequest.updateOne({ _id: p._id }, { $set: { status: 'pending' }, $unset: { reviewedAt: 1, reviewedBy: 1, reviewNote: 1 } });
    throw e;
  }
  await PaymentRequest.updateOne({ _id: p._id }, { $set: { licenseId: lic._id } });
  await auditForOrg(admin, p.orgId, 'payment.approved', 'PaymentRequest', String(p._id), { utr: p.utr, amountInr: p.amountInr, package: pkg.name, licenseId: String(lic._id), expiresAt: applied.expiresAt });
  return { status: 'approved', expiresAt: applied.expiresAt };
}
