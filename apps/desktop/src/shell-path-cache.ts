import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * On-disk cache for the user's extracted shell PATH.
 *
 * v0.5.21 Phase 2.5 — without this, the supervisor would have to run
 * `zsh -lic` on every boot, blocking the daemon spawn for 10ms-2s
 * depending on the user's shell rc complexity. With it, the cache is
 * read instantly at boot and the async re-extraction happens in the
 * background to catch new installs. The daemon picks up the refreshed
 * cache at the next restart (no IPC required).
 *
 * Cache schema (intentionally minimal):
 *   { "path": "/usr/local/bin:...", "extractedAt": "2026-05-25T17:00:00Z" }
 */

export interface ShellPathCacheEntry {
  path: string;
  extractedAt: string;
}

/** Resolve the cache file path, honoring CLEMENTINE_HOME for tests. */
function cacheFilePath(): string {
  const home = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return path.join(home, 'state', 'shell-path.json');
}

/** Beyond this age the cache is treated as missing — forces a fresh
 *  extraction even if the file exists. 7 days catches the case where
 *  a user reorganizes their shell rc and forgets to manually refresh. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Read the cache. Returns null if missing, corrupted, or stale. */
export function readCache(now: number = Date.now()): ShellPathCacheEntry | null {
  const file = cacheFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ShellPathCacheEntry>;
    if (
      typeof parsed.path !== 'string'
      || (!parsed.path.includes('/') && !parsed.path.includes('\\') && !parsed.path.includes(path.delimiter))
    ) return null;
    if (typeof parsed.extractedAt !== 'string') return null;
    const extractedTs = Date.parse(parsed.extractedAt);
    if (!Number.isFinite(extractedTs)) return null;
    if (now - extractedTs > STALE_AFTER_MS) return null;
    return { path: parsed.path, extractedAt: parsed.extractedAt };
  } catch {
    return null;
  }
}

/** Write the cache atomically (write-then-rename). */
export function writeCache(extractedPath: string, now: Date = new Date()): void {
  const file = cacheFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const entry: ShellPathCacheEntry = {
    path: extractedPath,
    extractedAt: now.toISOString(),
  };
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  // renameSync is atomic on the same filesystem — readers either see
  // the old file or the new file, never a partial write.
  renameSync(tmp, file);
}

/**
 * Merge a freshly-extracted shell PATH into the supervisor's
 * augmented PATH. Returns the merged colon-delimited string with
 * duplicates removed (preserving first occurrence order).
 *
 * Order: curated COMMON_USER_BIN_DIRS first (so a critical homebrew
 * binary still wins if the user shadowed it in their shell rc),
 * THEN the extracted shell PATH, THEN whatever process.env.PATH had
 * (the launchd default). De-dup as we go.
 */
export function mergePaths(...sources: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    for (const dir of src.split(path.delimiter)) {
      if (!dir) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}
