/**
 * A webhook's own key. A workflow that fires on a call-in gets an address a
 * third-party service can hold (GitHub, a form tool, a Zap) without ever
 * holding Clem's console token: the key opens that one hook and nothing
 * else. It is derived from the installation's secret with a domain of its
 * own, so nothing is stored and every key rotates with the secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DOMAIN = 'clementine-workflow-hook:v1:';

export function workflowHookKey(secret: string, hookPath: string): string | null {
  const path = hookPath.trim();
  if (!secret || !path) return null;
  return createHmac('sha256', secret).update(`${DOMAIN}${path}`).digest('base64url');
}

/** True when the presented key is this hook's, compared in constant time. */
export function workflowHookKeyMatches(secret: string, hookPath: string, presented: unknown): boolean {
  const expected = workflowHookKey(secret, hookPath);
  if (!expected || typeof presented !== 'string' || !presented) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The key a request presents: `?key=` or the `x-clementine-hook-key` header. */
export function presentedHookKey(req: { query?: Record<string, unknown>; headers?: Record<string, unknown> }): string | null {
  const fromQuery = req.query?.key;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const fromHeader = req.headers?.['x-clementine-hook-key'];
  return typeof fromHeader === 'string' && fromHeader ? fromHeader : null;
}

/** The address to hand a service: base + path + the hook's key. */
export function workflowHookAddress(base: string, hookPath: string, key: string | null): string {
  return key ? `${base}${hookPath}?key=${key}` : `${base}${hookPath}`;
}
