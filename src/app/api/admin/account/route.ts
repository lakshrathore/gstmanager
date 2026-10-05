import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { HttpError } from '@/server/http';
import { SuperAdmin } from '@/server/models';
import { adminApi } from '@/server/superadmin';

export const GET = adminApi(async (_req, { admin }) => ({ admin }));

const Body = z.object({
  currentPassword: z.string().min(1).max(128),
  name: z.string().min(2).max(80).optional(),
  email: z.email().optional(),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(128).optional(),
});

/** Change the super admin's name, email and/or password. Always needs the current password. */
export const PATCH = adminApi(async (req, { admin }) => {
  const b = Body.parse(await req.json());
  const a = await SuperAdmin.findById(admin.adminId).select('+passwordHash');
  if (!a || !(await bcrypt.compare(b.currentPassword, a.passwordHash))) throw new HttpError(403, 'Current password is incorrect');
  if (b.email && b.email.toLowerCase() !== a.email) {
    if (await SuperAdmin.exists({ email: b.email.toLowerCase() })) throw new HttpError(409, 'That email is already used');
    a.email = b.email.toLowerCase();
  }
  if (b.name) a.name = b.name;
  if (b.newPassword) a.passwordHash = await bcrypt.hash(b.newPassword, 12);
  await a.save();
  return { admin: { adminId: String(a._id), email: a.email, name: a.name } };
});
