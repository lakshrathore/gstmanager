import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';
import { User, type Role } from './models';

export const SESSION_COOKIE = 'gst_app_session';
const TTL_HOURS = 8;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
  return new TextEncoder().encode(s);
}

export interface Auth {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  companyIds: string[];
}

export async function issueSession(userId: string) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${TTL_HOURS}h`)
    .sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_HOURS * 3600,
  });
}

export async function clearSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Verifies the cookie and re-loads the user (so deactivation/role changes apply immediately). */
export async function getAuth(): Promise<Auth | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    await db();
    const u = await User.findById(payload.sub).lean();
    if (!u || !u.active) return null;
    return {
      userId: String(u._id), orgId: String(u.orgId), email: u.email, name: u.name, role: u.role as Role,
      companyIds: (u.companyIds ?? []).map(String),
    };
  } catch {
    return null;
  }
}

/* RBAC */

export const PERMISSIONS = {
  'org:manage': ['owner', 'admin'],
  'company:manage': ['owner', 'admin'],
  'return:view': ['owner', 'admin', 'preparer', 'reviewer', 'viewer'],
  'return:edit': ['owner', 'admin', 'preparer'],
  'portal:operate': ['owner', 'admin', 'reviewer'],
  /** Submitting the return to GSTN (EVC OTP + file) through an API integration. */
  'return:file': ['owner', 'admin'],
  'audit:view': ['owner', 'admin', 'reviewer'],
  /** Delete all of the organisation's data and start fresh (Settings → Danger zone). */
  'org:reset': ['owner'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (auth: Pick<Auth, 'role'>, p: Permission) => (PERMISSIONS[p] as readonly Role[]).includes(auth.role);
export const canAccessCompany = (auth: Auth, companyId: string) => auth.companyIds.length === 0 || auth.companyIds.includes(companyId);
