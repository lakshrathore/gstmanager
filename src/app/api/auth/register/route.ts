import bcrypt from 'bcryptjs';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/gst/gst-audit';
import { issueSession } from '@/server/auth';
import { db } from '@/server/db';
import { errorResponse, HttpError, rateLimit } from '@/server/http';
import { grantTrial } from '@/server/license';
import { Organization, User } from '@/server/models';

const Body = z.object({
  orgName: z.string().min(2).max(120),
  name: z.string().min(2).max(80),
  email: z.email(),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
});

/** Creates a new organisation with its owner. Disabled after the first org unless ALLOW_SIGNUP=true. */
export async function POST(req: NextRequest) {
  try {
    rateLimit(`register:${req.headers.get('x-forwarded-for') ?? 'local'}`, 5, 60_000);
    await db();
    if (process.env.ALLOW_SIGNUP !== 'true' && (await User.estimatedDocumentCount()) > 0) throw new HttpError(403, 'Sign-up is disabled. Ask your admin for an account.');
    const b = Body.parse(await req.json());
    if (await User.exists({ email: b.email.toLowerCase() })) throw new HttpError(409, 'Email already registered');
    const org = await Organization.create({ name: b.orgName });
    const user = await User.create({ orgId: org._id, email: b.email, name: b.name, role: 'owner', passwordHash: await bcrypt.hash(b.password, 12) });
    const trial = await grantTrial(org._id);
    await issueSession(String(user._id));
    const actor = { orgId: String(org._id), userId: String(user._id), email: user.email };
    await audit(actor, 'org.create', 'Organization', String(org._id), { name: b.orgName });
    if (trial) await audit(actor, 'license.trial_started', 'License', String(trial._id), { expiresAt: trial.expiresAt });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
