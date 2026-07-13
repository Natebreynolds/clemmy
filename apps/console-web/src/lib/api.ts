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
import { clemmy } from './clemmy';

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

interface SupervisorStatus {
  running?: boolean;
  port?: number;
  url?: string;
}

const SESSION_REFRESH_MESSAGE = 'Clementine refreshed its local session. Try that action again.';
const DAEMON_UNAVAILABLE_MESSAGE = 'Clementine\'s local service is restarting or unavailable. Wait a few seconds, then try again.';

/** Resolve the supervisor's dashboard URL, correcting a stale URL with its
 * live port. The desktop shell can restart the daemon on a new port while the
 * already-rendered SPA is still sitting on the old origin. */
function resolveSupervisorDashboardUrl(status: unknown): string | null {
  if (!status || typeof status !== 'object') return null;
  const raw = status as SupervisorStatus;
  if (raw.running !== true || typeof raw.url !== 'string' || !raw.url.trim()) return null;
  try {
    // The preload contract returns an absolute loopback URL. Reject relative
    // strings rather than resolving them against a stale renderer origin.
    const target = new URL(raw.url);
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]')) return null;
    if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65_535) {
      target.port = String(raw.port);
    }
    return target.href;
  } catch {
    return null;
  }
}

async function reloadDesktopBootstrap(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const bridge = clemmy();
  if (!bridge?.supervisorStatus) return false;
  let status: unknown;
  try { status = await bridge.supervisorStatus(); }
  catch { return false; }
  const targetHref = resolveSupervisorDashboardUrl(status);
  if (!targetHref) return false;
  try {
    // Cross-port recovery belongs to Electron's main process: it waits for the
    // replacement daemon's readiness probe and updates the navigation guard
    // before loading the new origin. A renderer navigation here would be
    // blocked as external (and could expose the token URL in the browser).
    if (!shouldNavigateForBootstrap(targetHref, window.location.href)) return false;
    window.location.assign(targetHref);
    return true;
  } catch {
    return false;
  }
}

function responseErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message']) {
      if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
    }
  }
  return `HTTP ${status}`;
}

function shouldNavigateForBootstrap(targetHref: string, currentHref: string): boolean {
  try {
    const target = new URL(targetHref);
    const current = new URL(currentHref);
    return target.origin === current.origin && target.href !== current.href;
  } catch {
    return false;
  }
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
  let res: Response;
  try {
    res = await fetch(withToken(path), opts);
  } catch (cause) {
    throw makeError(0, { cause }, DAEMON_UNAVAILABLE_MESSAGE);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (res.status === 401) {
    if (!getAuthToken() && await reloadDesktopBootstrap()) {
      throw makeError(401, body, SESSION_REFRESH_MESSAGE);
    }
    window.dispatchEvent(new Event('clem:needs-login'));
    throw makeError(401, body, 'Not authenticated');
  }
  if (!res.ok) {
    throw makeError(res.status, body, responseErrorMessage(res.status, body));
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

export const __test__ = { resolveSupervisorDashboardUrl, responseErrorMessage, shouldNavigateForBootstrap };
