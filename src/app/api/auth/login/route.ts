import bcrypt from 'bcryptjs';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/gst/gst-audit';
import { issueSession } from '@/server/auth';
import { db } from '@/server/db';
import { errorResponse, HttpError, rateLimit } from '@/server/http';
import { User } from '@/server/models';

const Body = z.object({ email: z.email(), password: z.string().min(1).max(128) });

export async function POST(req: NextRequest) {
  try {
    const b = Body.parse(await req.json());
    rateLimit(`login:${b.email.toLowerCase()}`, 8, 5 * 60_000);
    await db();
    const user = await User.findOne({ email: b.email.toLowerCase(), active: true }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(b.password, user.passwordHash))) throw new HttpError(401, 'Invalid email or password');
    await issueSession(String(user._id));
    await audit({ orgId: String(user.orgId), userId: String(user._id), email: user.email }, 'user.login', 'User', String(user._id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
