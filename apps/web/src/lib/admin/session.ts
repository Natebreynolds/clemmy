/**
 * Admin session handling.
 *
 * The cookie carries a random 32-byte token and nothing else — no identity, no
 * claims, nothing an attacker can read or tamper with. The server keeps only a
 * keyed digest of that token, so a memory dump or log leak of the session table
 * still does not yield a usable cookie value.
 */
import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "clem_admin_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type AdminSession = {
  email: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __clemAdminSessions: Map<string, AdminSession> | undefined;
}

// Module-level state is re-created on hot reload; hang it off globalThis so a
// dev-mode edit does not log Nathan out mid-task.
const sessions: Map<string, AdminSession> = (globalThis.__clemAdminSessions ??= new Map());

function sessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("ADMIN_SESSION_SECRET is missing or too short (need >= 16 chars).");
  }
  return secret;
}

/**
 * Keyed rather than bare SHA-256: without ADMIN_SESSION_SECRET an attacker who
 * somehow reads the stored digests still cannot derive or verify guesses at the
 * cookie value offline.
 */
function digest(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}

function sweep(now: number) {
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key);
  }
}

export function createSession({ email, ip }: { email: string; ip: string }): {
  token: string;
  expiresAt: number;
} {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  sessions.set(digest(token), { email, ip, createdAt: now, expiresAt });
  return { token, expiresAt };
}

export function lookupSession(token: string): AdminSession | null {
  if (!token) return null;
  const now = Date.now();
  sweep(now);

  const wanted = Buffer.from(digest(token), "hex");
  // Constant-time scan: never index the Map by attacker-supplied material.
  let found: AdminSession | null = null;
  for (const [key, session] of sessions) {
    const candidate = Buffer.from(key, "hex");
    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) found = session;
  }
  if (!found || found.expiresAt <= now) return null;
  return found;
}

export function destroySession(token: string): void {
  if (!token) return;
  sessions.delete(digest(token));
}

/** Reads and validates the session cookie. Safe to call from server components. */
export async function getCurrentSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return lookupSession(token);
  } catch {
    // A missing ADMIN_SESSION_SECRET must read as "logged out", never as a 500
    // that exposes a stack trace on a public route.
    return null;
  }
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    // Secure would make the cookie unstorable over plain http on localhost,
    // which would break local development entirely.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}
