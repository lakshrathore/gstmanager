import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { can, getAuth, type Auth, type Permission } from './auth';
import { db } from './db';
import { requireLicense } from './license';
import type { FeatureKey } from './models';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

type Params = Record<string, string>;
type Handler = (req: NextRequest, ctx: { auth: Auth; params: Params }) => Promise<unknown>;

interface ApiOptions {
  rateLimit?: { key: string; max: number; windowMs: number };
  /** Plan feature the route needs (checked on every method). */
  feature?: FeatureKey;
  /** Let this write through without an active license (license activation, data reset). */
  unlicensed?: boolean;
}

/**
 * Wraps a route handler with DB connect, authentication, RBAC, licensing, rate limiting and error
 * mapping. Without an active license the workspace is read-only: only GET requests pass.
 */
export function api(permission: Permission, fn: Handler, opts: ApiOptions = {}) {
  return async (req: NextRequest, ctx: { params: Promise<Params> }) => {
    try {
      await db();
      const auth = await getAuth();
      if (!auth) throw new HttpError(401, 'Not signed in');
      if (!can(auth, permission)) throw new HttpError(403, 'You do not have permission for this action');
      if (opts.feature) await requireLicense(auth.orgId, opts.feature);
      else if (req.method !== 'GET' && !opts.unlicensed) await requireLicense(auth.orgId);
      if (opts.rateLimit) rateLimit(`${opts.rateLimit.key}:${auth.userId}`, opts.rateLimit.max, opts.rateLimit.windowMs);
      const result = await fn(req, { auth, params: (await ctx.params) ?? {} });
      return result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message, details: e.details }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: 'Invalid input', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, { status: 400 });
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[api]', msg);
  // Setup problems are safe and useful to show; other details only outside production.
  const setup = /MONGODB_URI|AUTH_SECRET|DATA_ENCRYPTION_KEYS|ECONNREFUSED|Server selection timed out|querySrv|getaddrinfo/i.test(msg);
  const hint = /ECONNREFUSED|Server selection timed out/i.test(msg)
    ? 'Cannot reach MongoDB. Is it running, and is MONGODB_URI in .env.local correct?'
    : msg;
  return NextResponse.json(
    { error: setup || process.env.NODE_ENV !== 'production' ? `Server error: ${hint}` : 'Internal error' },
    { status: 500 },
  );
}

/* Simple fixed-window limiter. Per-instance; use Redis for multi-instance deployments. */
const buckets = new Map<string, { count: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  if (++b.count > max) throw new HttpError(429, `Too many requests – retry in ${Math.ceil((b.reset - now) / 1000)}s`);
}
