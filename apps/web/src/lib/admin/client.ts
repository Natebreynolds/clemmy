"use client";

/**
 * Browser-side calls to the admin proxy. Never talks to the license server
 * directly — it has no token to talk to it with, by design.
 */

export class AdminRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

export async function adminRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; search?: Record<string, string> } = {},
): Promise<T> {
  const query = init.search ? `?${new URLSearchParams(init.search).toString()}` : "";
  const res = await fetch(`/api/admin/${path.replace(/^\/+/, "")}${query}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // Same-origin only; the session cookie is SameSite=Strict anyway.
    credentials: "same-origin",
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      `Request failed (${res.status}).`;
    if (res.status === 401) {
      // The session died under us. Bounce to login rather than leaving a dead
      // page that fails every action.
      window.location.href = "/admin/login";
    }
    throw new AdminRequestError(res.status, message);
  }

  return parsed as T;
}
