/**
 * Durable connection→mailbox identity cache.
 *
 * Composio's account listing often carries NO usable identity for a connection
 * (Microsoft tokens expose no email in the listing), so identity-based
 * resolution can't merge same-mailbox re-auths or honor "use my scorpion
 * email" until each connection's REAL mailbox is learned. The gateway learns
 * it once per connection via a pinned profile probe (OUTLOOK_GET_PROFILE etc.)
 * and records it here; the snapshot mapper then serves it as the connection's
 * accountEmail forever after (a connection's mailbox never changes — a re-auth
 * mints a NEW connection id).
 *
 * Negative results are cached too (email: null) so an unprobeable toolkit
 * isn't re-probed on every ambiguous encounter.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

interface IdentityCacheEntry {
  email: string | null;
  probedAt: string;
}

interface IdentityCacheFile {
  connections?: Record<string, IdentityCacheEntry>;
}

const CACHE_REL = ['state', 'composio-account-identities.json'] as const;

let cache: Record<string, IdentityCacheEntry> | null = null;

function cachePath(): string {
  return path.join(BASE_DIR, ...CACHE_REL);
}

function load(): Record<string, IdentityCacheEntry> {
  if (cache) return cache;
  try {
    if (existsSync(cachePath())) {
      const parsed = JSON.parse(readFileSync(cachePath(), 'utf-8')) as IdentityCacheFile;
      cache = parsed.connections ?? {};
      return cache;
    }
  } catch { /* corrupted cache → start fresh */ }
  cache = {};
  return cache;
}

function persist(): void {
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify({ connections: load() }, null, 1)}\n`, 'utf-8');
  } catch { /* best-effort — an unwritable cache only costs re-probes */ }
}

/** The learned mailbox for a connection, if a probe ever succeeded. */
export function cachedIdentityEmail(connectionId: string): string | undefined {
  const entry = load()[connectionId];
  return entry?.email ?? undefined;
}

/** Has this connection been probed before (successfully OR not)? */
export function identityProbeAttempted(connectionId: string): boolean {
  return Boolean(load()[connectionId]);
}

/** Record a probe result. email=null records "probed, nothing learned". */
export function recordIdentityProbe(connectionId: string, email: string | null): void {
  if (!connectionId) return;
  const normalized = email ? email.trim().toLowerCase().replace(/^smtp:/, '') : null;
  load()[connectionId] = {
    email: normalized && normalized.includes('@') ? normalized : null,
    probedAt: new Date().toISOString(),
  };
  persist();
}

/** Test seam. */
export function resetIdentityCacheForTest(): void {
  cache = null;
}
