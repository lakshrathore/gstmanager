import { NextResponse } from 'next/server';
import { clearAdminSession } from '@/server/superadmin';

export async function POST() {
  await clearAdminSession();
  return NextResponse.json({ ok: true });
}
