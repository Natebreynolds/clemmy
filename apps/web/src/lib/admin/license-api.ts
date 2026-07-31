/**
 * Server-side client for the license server's admin API.
 *
 * LICENSE_ADMIN_TOKEN is read here and nowhere else that can reach a bundle:
 * this module is imported only by route handlers and server components. If it
 * ever appears in a "use client" import chain the build will fail loudly, which
 * is the point.
 */
import type { AuditEntry, Tenant } from "./types";

export class LicenseApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "LicenseApiError";
    this.status = status;
    this.body = body;
  }
}

function config(): { base: string; token: string } {
  const base = process.env.LICENSE_API_URL?.replace(/\/+$/, "");
  const token = process.env.LICENSE_ADMIN_TOKEN;
  if (!base) throw new LicenseApiError(500, "LICENSE_API_URL is not configured.");
  if (!token) throw new LicenseApiError(500, "LICENSE_ADMIN_TOKEN is not configured.");
  return { base, token };
}

export function adminUrl(path: string, search?: URLSearchParams): string {
  const { base } = config();
  const clean = path.replace(/^\/+/, "");
  const query = search && [...search.keys()].length ? `?${search.toString()}` : "";
  return `${base}/v1/admin/${clean}${query}`;
}

export function adminAuthHeader(): string {
  return `Bearer ${config().token}`;
}

/** A hosted Postgres round-trip should never hold a page render open for long. */
const TIMEOUT_MS = 15_000;

export async function licenseFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; search?: URLSearchParams } = {},
): Promise<T> {
  const url = adminUrl(path, init.search);
  const method = init.method ?? "GET";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: adminAuthHeader(),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Licensing state is authoritative and changes under us; never serve a
      // cached view of who is revoked.
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new LicenseApiError(502, `Could not reach the license server (${reason}).`);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: "bad_response", message: text.slice(0, 400) };
    }
  }

  if (!res.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      `License API returned ${res.status}.`;
    throw new LicenseApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export function listTenants(): Promise<{ tenants: Tenant[] }> {
  return licenseFetch<{ tenants: Tenant[] }>("tenants");
}

export function listAudit(): Promise<{ entries: AuditEntry[] }> {
  return licenseFetch<{ entries: AuditEntry[] }>("audit");
}

/** Turns any thrown value into something safe to show on a page. */
export function describeApiError(err: unknown): string {
  if (err instanceof LicenseApiError) {
    if (err.status === 401) return "The license server rejected LICENSE_ADMIN_TOKEN (401).";
    return err.message;
  }
  return err instanceof Error ? err.message : "Unexpected error.";
}
