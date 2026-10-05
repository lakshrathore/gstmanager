import 'server-only';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from './db';
import { errorResponse, HttpError } from './http';
import { SuperAdmin } from './models';

/**
 * Super admin (software owner) authentication. Separate account collection, cookie and JWT audience
 * from org users, so an org session can never reach /api/admin and vice versa.
 *
 * The first account is created from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD the first time someone
 * signs in at /admin/login. After that, email and password are changed from /admin/account.
 * SUPER_ADMIN_RESET=true resets that account's password to SUPER_ADMIN_PASSWORD on the next sign-in
 * (recovery if it is forgotten) – remove the flag afterwards.
 */

export const ADMIN_COOKIE = 'gst_admin_session';
const AUDIENCE = 'superadmin';
const TTL_HOURS = 4;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
  return new TextEncoder().encode(s);
}

export interface AdminAuth {
  adminId: string;
  email: string;
  name: string;
}

/** Creates the bootstrap account from env when none exists (or resets it when SUPER_ADMIN_RESET=true). */
export async function ensureSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (process.env.SUPER_ADMIN_RESET === 'true') {
    await SuperAdmin.updateOne({ email }, { $set: { passwordHash: await bcrypt.hash(password, 12), active: true } }, { upsert: true });
    return;
  }
  if ((await SuperAdmin.estimatedDocumentCount()) === 0) {
    await SuperAdmin.create({ email, passwordHash: await bcrypt.hash(password, 12) });
  }
}

export async function issueAdminSession(adminId: string) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_HOURS}h`)
    .sign(secret());
  (await cookies()).set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: TTL_HOURS * 3600,
  });
}

export async function clearAdminSession() {
  (await cookies()).delete(ADMIN_COOKIE);
}

export async function getSuperAdmin(): Promise<AdminAuth | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'], audience: AUDIENCE });
    await db();
    const a = await SuperAdmin.findById(payload.sub).lean();
    if (!a || !a.active) return null;
    return { adminId: String(a._id), email: a.email, name: a.name ?? 'Super Admin' };
  } catch {
    return null;
  }
}

type Params = Record<string, string>;
type Handler = (req: NextRequest, ctx: { admin: AdminAuth; params: Params }) => Promise<unknown>;

/** Route wrapper for /api/admin/*: DB connect, super admin session, error mapping. */
export function adminApi(fn: Handler) {
  return async (req: NextRequest, ctx: { params: Promise<Params> }) => {
    try {
      await db();
      const admin = await getSuperAdmin();
      if (!admin) throw new HttpError(401, 'Not signed in as super admin');
      const result = await fn(req, { admin, params: (await ctx.params) ?? {} });
      return result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
