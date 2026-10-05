import { NextResponse, type NextRequest } from 'next/server';

/** Optimistic redirect only – real authorization happens in every route handler (src/server/http.ts, src/server/superadmin.ts). */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/admin/login') return NextResponse.next();
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (!req.cookies.get('gst_admin_session')) return NextResponse.redirect(new URL('/admin/login', req.url));
    return NextResponse.next();
  }
  if (!req.cookies.get('gst_app_session')) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|login|register|favicon.ico).*)'] };
