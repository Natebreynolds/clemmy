/**
 * Reads the bootstrap object the daemon injects into index.html
 * (see src/dashboard/console-spa.ts). In `vite dev` nothing is injected,
 * so this returns defaults and auth falls back to VITE_CLEM_TOKEN.
 */
export interface Bootstrap {
  token: string;
  version: string;
  flags: { memory3d: boolean };
}

let cached: Bootstrap | null = null;

export function getBootstrap(): Bootstrap {
  if (cached) return cached;
  const raw = (typeof window !== 'undefined' ? window.__CLEM_BOOTSTRAP__ : undefined) ?? {};
  cached = {
    token: typeof raw.token === 'string' ? raw.token : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    flags: { memory3d: raw.flags?.memory3d === true },
  };
  return cached;
}

/**
 * The auth token to append to requests, if any. In the packaged app the
 * session cookie does the work and this is usually empty; in dev it
 * comes from VITE_CLEM_TOKEN.
 */
export function getAuthToken(): string {
  const fromBootstrap = getBootstrap().token;
  if (fromBootstrap) return fromBootstrap;
  if (import.meta.env.DEV && import.meta.env.VITE_CLEM_TOKEN) {
    return import.meta.env.VITE_CLEM_TOKEN;
  }
  return '';
}
