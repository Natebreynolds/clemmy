/**
 * Fetch wrapper for the Clementine console SPA. All requests go
 * same-origin to the daemon that serves the app at /console, so the
 * HttpOnly session cookie authorizes them automatically (same model as
 * apps/mobile-web). In `vite dev` a token is appended from the bootstrap
 * / VITE_CLEM_TOKEN because the cross-port cookie isn't sent.
 *
 * A 401 dispatches a global `clem:needs-login` event; the app shell can
 * surface a reconnect/relaunch hint.
 */
import { getAuthToken } from './bootstrap';

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

function makeError(status: number, body?: unknown, message?: string): ApiError {
  const error = new Error(message ?? `HTTP ${status}`) as ApiError;
  error.status = status;
  error.body = body;
  return error;
}

function withToken(path: string): string {
  const token = getAuthToken();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function isJsonBody(init?: RequestInit): boolean {
  if (!init?.body) return false;
  if (init.body instanceof FormData || init.body instanceof Blob || init.body instanceof ArrayBuffer) return false;
  const headers = init.headers as Record<string, string> | undefined;
  return !headers?.['content-type'] && !headers?.['Content-Type'];
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const opts: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(isJsonBody(init) ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  };
  const res = await fetch(withToken(path), opts);
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (res.status === 401) {
    window.dispatchEvent(new Event('clem:needs-login'));
    throw makeError(401, body, 'Not authenticated');
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && body !== null && 'error' in body
        && typeof (body as Record<string, unknown>).error === 'string'
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${res.status}`;
    throw makeError(res.status, body, message);
  }
  return body as T;
}

/** Convenience helpers. */
export const apiGet = <T = unknown>(path: string): Promise<T> => api<T>(path);
export const apiPost = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T = unknown>(path: string): Promise<T> =>
  api<T>(path, { method: 'DELETE' });
