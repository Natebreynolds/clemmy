/**
 * Durable connection→mailbox identity cache.
 *
 * Composio's account listing often carries NO usable identity for a connection
 * (Microsoft tokens expose no email in the listing), so identity-based
 * resolution can't merge same-mailbox re-auths or honor "use my acme
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
  /** The Composio entity (user_id) that owns this connection — learned from the
   *  raw v3 listing and persisted so a later transient v3 outage (SDK fallback
   *  strips user_id) still pairs the correct owner at dispatch. */
  ownerUserId?: string;
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

/** Record a probe result. email=null records "probed, nothing learned".
 *  Preserves any previously-cached ownerUserId. */
export function recordIdentityProbe(connectionId: string, email: string | null): void {
  if (!connectionId) return;
  const normalized = email ? email.trim().toLowerCase().replace(/^smtp:/, '') : null;
  const prev = load()[connectionId];
  load()[connectionId] = {
    email: normalized && normalized.includes('@') ? normalized : null,
    probedAt: new Date().toISOString(),
    ownerUserId: prev?.ownerUserId,
  };
  persist();
}

/** The owning entity for a connection, if ever learned from the raw v3 listing. */
export function cachedConnectionOwner(connectionId: string): string | undefined {
  const owner = load()[connectionId]?.ownerUserId;
  return owner && owner.trim() ? owner : undefined;
}

/** Persist a connection's owning entity (raw v3 exposes it; the SDK strips it).
 *  Durable so a later v3 outage still pairs the right owner at dispatch. */
export function recordConnectionOwner(connectionId: string, ownerUserId: string | undefined): void {
  if (!connectionId || !ownerUserId || !ownerUserId.trim()) return;
  const prev = load()[connectionId];
  if (prev?.ownerUserId === ownerUserId) return; // no-op, avoid churny writes
  load()[connectionId] = {
    email: prev?.email ?? null,
    probedAt: prev?.probedAt ?? new Date().toISOString(),
    ownerUserId: ownerUserId.trim(),
  };
  persist();
}

/** Test seam. */
export function resetIdentityCacheForTest(): void {
  cache = null;
}
