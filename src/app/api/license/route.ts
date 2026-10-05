import { z } from 'zod';
import { audit } from '@/server/gst/gst-audit';
import { api } from '@/server/http';
import { activateKey, FEATURES, licenseState, LIMITS, usage } from '@/server/license';

/** The workspace's license, plan limits and current usage. */
export const GET = api('return:view', async (_req, { auth }) => ({
  license: await licenseState(auth.orgId),
  usage: await usage(auth.orgId),
  limitLabels: LIMITS,
  featureLabels: FEATURES,
}));

const Body = z.object({ key: z.string().min(10).max(40) });

/** Activates (or renews with) a license key. Works without a current license, by design. */
export const POST = api('org:manage', async (req, { auth }) => {
  const lic = await activateKey(auth.orgId, Body.parse(await req.json()).key);
  await audit(auth, 'license.activated', 'License', String(lic._id), { key: lic.key, expiresAt: lic.expiresAt });
  return { license: await licenseState(auth.orgId) };
}, { unlicensed: true, rateLimit: { key: 'license-activate', max: 10, windowMs: 10 * 60_000 } });
