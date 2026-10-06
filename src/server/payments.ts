import 'server-only';
import type { Auth } from './auth';
import { auditForOrg } from './admin-audit';
import { audit } from './audit';
import { HttpError } from './http';
import { applyLicense, generateKey } from './license';
import { License, oid, Organization, Package, PaymentRequest, PlatformSettings } from './models';
import type { AdminAuth } from './superadmin';

/**
 * Manual UPI payments (no gateway): the firm scans a UPI QR generated from the super admin's UPI ID,
 * pays the package price, then submits the UTR and a screenshot. The super admin checks the payment
 * in their bank/UPI app and approves – approval issues a license for the package and activates it.
 */

export const UPI_ID_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
const MAX_SCREENSHOT = 5 * 1024 * 1024;

export async function paymentSettings() {
  const s = await PlatformSettings.findOne({ key: 'platform' }).lean();
  return { upiId: s?.upiId ?? '', payeeName: s?.payeeName ?? '', paymentNote: s?.paymentNote ?? '' };
}

export async function savePaymentSettings(input: { upiId: string; payeeName: string; paymentNote?: string }) {
  if (input.upiId && !UPI_ID_RE.test(input.upiId)) throw new HttpError(400, 'UPI ID looks wrong – it should look like name@bank');
  await PlatformSettings.updateOne({ key: 'platform' }, { $set: input }, { upsert: true });
  return paymentSettings();
}

/** Standard UPI deep link (NPCI "upi://pay"); every UPI app understands it and it is what the QR encodes. */
export function upiLink(upiId: string, payeeName: string, amount: number, note: string) {
  const q = new URLSearchParams({ pa: upiId, pn: payeeName || upiId, am: amount.toFixed(2), cu: 'INR', tn: note.slice(0, 60) });
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** Packages a firm can buy, each with its UPI link. */
export async function paymentOptions(orgId: string) {
  const settings = await paymentSettings();
  const org = await Organization.findById(oid(orgId)).select({ name: 1 }).lean();
  const pkgs = await Package.find({ active: true, isTrial: { $ne: true }, priceInr: { $gt: 0 } }).sort({ priceInr: 1 }).lean();
  return {
    upiId: settings.upiId,
    payeeName: settings.payeeName,
    paymentNote: settings.paymentNote,
    packages: pkgs.map((p) => ({
      _id: String(p._id), name: p.name, description: p.description ?? '', priceInr: p.priceInr, durationDays: p.durationDays,
      limits: p.limits, features: p.features ?? [],
      upiLink: settings.upiId ? upiLink(settings.upiId, settings.payeeName, p.priceInr, `GST Desk ${p.name} ${org?.name ?? ''}`) : null,
    })),
  };
}

function imageType(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function submitPayment(auth: Auth, input: { packageId: string; utr: string; note?: string }, file: File | null) {
  const settings = await paymentSettings();
  if (!settings.upiId) throw new HttpError(409, 'Online payment is not set up yet. Contact the software provider.');
  const pkg = await Package.findOne({ _id: oid(input.packageId), active: true, isTrial: { $ne: true } }).lean();
  if (!pkg) throw new HttpError(404, 'Package not found');
  const utr = input.utr.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'Enter the UPI transaction ID / UTR exactly as shown in your UPI app (6–30 letters or digits)');
  if (!file || !file.size) throw new HttpError(400, 'Attach the payment screenshot');
  if (file.size > MAX_SCREENSHOT) throw new HttpError(413, 'Screenshot is too large (max 5 MB)');
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = imageType(bytes);
  if (!type) throw new HttpError(400, 'Screenshot must be a PNG, JPG or WEBP image');
  if (await PaymentRequest.exists({ utr, status: { $ne: 'rejected' } })) throw new HttpError(409, 'This transaction ID has already been submitted');
  if (await PaymentRequest.exists({ orgId: oid(auth.orgId), status: 'pending' })) throw new HttpError(409, 'You already have a payment waiting for approval');

  const p = await PaymentRequest.create({
    orgId: oid(auth.orgId), userId: oid(auth.userId), userEmail: auth.email, packageId: pkg._id, packageName: pkg.name,
    amountInr: pkg.priceInr, durationDays: pkg.durationDays, upiId: settings.upiId, utr, note: input.note?.slice(0, 500),
    screenshot: bytes, screenshotType: type, screenshotSize: bytes.length,
  });
  await audit(auth, 'payment.submitted', 'PaymentRequest', String(p._id), { package: pkg.name, amountInr: pkg.priceInr, utr });
  return { _id: String(p._id), status: p.status };
}

export async function myPayments(orgId: string) {
  return PaymentRequest.find({ orgId: oid(orgId) }).sort({ createdAt: -1 }).limit(20)
    .select({ packageName: 1, amountInr: 1, utr: 1, status: 1, reviewNote: 1, createdAt: 1, reviewedAt: 1 }).lean();
}

export async function reviewPayment(admin: AdminAuth, id: string, action: 'approve' | 'reject', note?: string) {
  const p = await PaymentRequest.findById(oid(id));
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.status !== 'pending') throw new HttpError(409, `This payment is already ${p.status}`);
  if (action === 'reject') {
    if (!note?.trim()) throw new HttpError(400, 'Give a reason so the customer knows what to fix');
    // Claim atomically so two admins cannot act on the same request.
    const r = await PaymentRequest.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'rejected', reviewedAt: new Date(), reviewedBy: admin.email, reviewNote: note.trim() } });
    if (!r.modifiedCount) throw new HttpError(409, 'This payment was already reviewed');
    await auditForOrg(admin, p.orgId, 'payment.rejected', 'PaymentRequest', String(p._id), { utr: p.utr, reason: note.trim() });
    return { status: 'rejected' };
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
