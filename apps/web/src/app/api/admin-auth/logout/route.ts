import { NextRequest, NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      // Drop the server-side record too: clearing the cookie alone would leave
      // a still-valid token in whatever captured it.
      destroySession(token);
    } catch {
      // A missing ADMIN_SESSION_SECRET means no session could exist anyway.
    }
  }

  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(Date.now()), expires: new Date(0) });
  return res;
}
