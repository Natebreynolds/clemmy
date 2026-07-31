/**
 * Authenticated pass-through to the license server's /v1/admin API.
 *
 * The browser never sees LICENSE_ADMIN_TOKEN — it presents only the session
 * cookie, and this handler swaps that for the bearer token server-side. Any
 * request without a live session is rejected before the upstream is touched.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthHeader, adminUrl, LicenseApiError } from "@/lib/admin/license-api";
import { getCurrentSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * SameSite=Strict already keeps the session cookie off cross-site requests;
 * this is the belt to that suspenders, and it also catches a same-site
 * subdomain that should not be driving the admin API.
 */
function originIsSelf(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // browsers always send Origin on state-changing fetches
  try {
    return new URL(origin).host === (req.headers.get("host") ?? "");
  } catch {
    return false;
  }
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const session = await getCurrentSession();
  if (!session) return json(401, { error: "unauthorized", message: "Session expired. Sign in again." });

  if (MUTATING.has(req.method) && !originIsSelf(req)) {
    return json(403, { error: "bad_origin", message: "Cross-origin admin writes are refused." });
  }

  const { path } = await ctx.params;
  const segments = path ?? [];
  // Nothing may climb out of /v1/admin/ — the license server also exposes the
  // public activation endpoints, and this proxy is not a door to them.
  if (!segments.length || segments.some((s) => !s || s === "." || s === ".." || s.includes("/"))) {
    return json(400, { error: "bad_path" });
  }

  const target = adminUrl(segments.map(encodeURIComponent).join("/"), req.nextUrl.searchParams);
  const body = MUTATING.has(req.method) ? await req.text() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: adminAuthHeader(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body || undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (err instanceof LicenseApiError) return json(err.status, { error: "config", message: err.message });
    const reason = err instanceof Error ? err.message : String(err);
    return json(502, { error: "upstream_unreachable", message: `License server unreachable (${reason}).` });
  }

  const text = await upstream.text();
  return new NextResponse(text || null, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      // Responses can carry a freshly minted license key. Nothing caches this.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
