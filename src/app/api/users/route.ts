import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit } from '@/server/gst/gst-audit';
import { api, HttpError } from '@/server/http';
import { assertWithinLimit } from '@/server/license';
import { oid, ROLES, User } from '@/server/models';

export const GET = api('org:manage', async (_req, { auth }) => ({
  users: await User.find({ orgId: oid(auth.orgId) }).select({ email: 1, name: 1, role: 1, active: 1, companyIds: 1 }).lean(),
}));

const Body = z.object({
  name: z.string().min(2).max(80),
  email: z.email(),
  password: z.string().min(10).max(128),
  role: z.enum(ROLES).exclude(['owner']),
  companyIds: z.array(z.string()).default([]),
});

export const POST = api('org:manage', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  if (await User.exists({ email: b.email.toLowerCase() })) throw new HttpError(409, 'Email already registered');
  await assertWithinLimit(auth.orgId, 'users');
  const u = await User.create({ ...b, orgId: oid(auth.orgId), companyIds: b.companyIds.map(oid).filter(Boolean), passwordHash: await bcrypt.hash(b.password, 12) });
  await audit(auth, 'user.create', 'User', String(u._id), { email: u.email, role: u.role });
  return { user: { _id: u._id, email: u.email, name: u.name, role: u.role } };
});
