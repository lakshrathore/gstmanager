import { NextResponse, type NextRequest } from 'next/server';

/** Optimistic redirect only – real authorization happens in every route handler (src/server/http.ts). */
export function proxy(req: NextRequest) {
  if (!req.cookies.get('gst_app_session')) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|login|register|favicon.ico).*)'] };
