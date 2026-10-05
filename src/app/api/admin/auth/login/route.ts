import bcrypt from 'bcryptjs';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db';
import { errorResponse, HttpError, rateLimit } from '@/server/http';
import { SuperAdmin } from '@/server/models';
import { ensureSuperAdmin, issueAdminSession } from '@/server/superadmin';

const Body = z.object({ email: z.email(), password: z.string().min(1).max(128) });

export async function POST(req: NextRequest) {
  try {
    const b = Body.parse(await req.json());
    rateLimit(`admin-login:${req.headers.get('x-forwarded-for') ?? 'local'}`, 6, 10 * 60_000);
    await db();
    await ensureSuperAdmin();
    const a = await SuperAdmin.findOne({ email: b.email.toLowerCase(), active: true }).select('+passwordHash');
    if (!a || !(await bcrypt.compare(b.password, a.passwordHash))) throw new HttpError(401, 'Invalid email or password');
    a.lastLoginAt = new Date();
    await a.save();
    await issueAdminSession(String(a._id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
