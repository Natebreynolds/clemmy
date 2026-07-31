import { NextRequest, NextResponse } from "next/server";

/**
 * Cheap early bounce for /admin/* when no session cookie is present at all.
 *
 * This is NOT the authorization boundary — middleware runs on the Edge runtime
 * and cannot see the server-side session store, so it can only tell "no cookie"
 * from "some cookie". The real check is the server-side lookup in
 * app/admin/(protected)/layout.tsx, which every protected page renders through.
 */
const SESSION_COOKIE = "clem_admin_session";

export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything under /admin except the login page itself. The API proxy is
  // excluded on purpose: it must answer 401 JSON, not redirect to HTML.
  matcher: ["/admin/((?!login).*)", "/admin"],
};
