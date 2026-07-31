/**
 * Admin login: email + password + TOTP.
 *
 * Deliberately not mounted under /api/admin/* so it can never be shadowed by,
 * or shadow, the license-API proxy's catch-all.
 *
 * The credential lives in env (ADMIN_EMAIL / ADMIN_PASSWORD_HASH /
 * ADMIN_TOTP_SECRET) rather than a user table: there is exactly one operator,
 * and a table would be one more thing to breach for no added capability.
 */
import { NextRequest, NextResponse } from "next/server";
import { safeEqualString, verifyPassword, verifyTotp } from "@/lib/admin/crypto";
import { clearLoginFailures, clientIpFrom, loginRateStatus, recordLoginFailure } from "@/lib/admin/rate-limit";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One message for every failure mode. Telling an attacker which factor was
// wrong turns two unknowns into one.
const GENERIC_FAILURE = "That email, password, or code was not right.";

function fail(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: "login_failed", message, ...extra }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const ip = clientIpFrom(req.headers);

  const rate = loginRateStatus(ip);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Too many attempts. Try again in ${Math.ceil(rate.retryAfterSeconds / 60)} minute(s).`,
      },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }

  let payload: { email?: unknown; password?: unknown; code?: unknown };
  try {
    payload = await req.json();
  } catch {
    return fail(400, "Malformed request.");
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const code = typeof payload.code === "string" ? payload.code : "";

  const expectedEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;
  const totpSecret = process.env.ADMIN_TOTP_SECRET;

  if (!expectedEmail || !expectedHash || !totpSecret) {
    // Fail closed and say so plainly — a half-configured admin panel that let
    // anyone in would be far worse than one that refuses every login.
    return fail(503, "Admin credentials are not configured on this deployment.");
  }
  if (!process.env.ADMIN_SESSION_SECRET) {
    return fail(503, "ADMIN_SESSION_SECRET is not configured on this deployment.");
  }

  // Every factor is evaluated even once one has failed, so response time does
  // not reveal how far a guess got.
  const emailOk = safeEqualString(email, expectedEmail);
  const passwordOk = await verifyPassword(password, expectedHash);
  const codeOk = verifyTotp(totpSecret, code);

  if (!emailOk || !passwordOk || !codeOk) {
    recordLoginFailure(ip);
    return fail(401, GENERIC_FAILURE);
  }

  clearLoginFailures(ip);
  const { token, expiresAt } = createSession({ email: expectedEmail, ip });

  const res = NextResponse.json({ ok: true, expiresAt }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
  return res;
}
