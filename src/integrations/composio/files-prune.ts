/**
 * Staging-dir hygiene for the file pipeline (2026-07-21): tool-downloaded
 * files land in BASE_DIR/files (see client.ts composioFilesDir) so they can
 * be chained into uploads. They are TRANSIENT — once the run that fetched
 * them finishes, the durable copy lives wherever the workflow put it (Drive,
 * a workspace, an email). Prune past the TTL so an hourly attachment
 * workflow can't grow the disk unbounded. Standalone module (fs/path only)
 * so nightly maintenance can import it without dragging the Composio SDK.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

const DEFAULT_TTL_DAYS = 7;

export function pruneComposioFilesDir(opts: { ttlDays?: number; nowMs?: number } = {}): { pruned: number } {
  const dir = path.join(BASE_DIR, 'files');
  const ttlMs = (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60_000;
  const now = opts.nowMs ?? Date.now();
  let pruned = 0;
  try {
    if (!existsSync(dir)) return { pruned };
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const stat = statSync(full);
        if (now - stat.mtimeMs > ttlMs) {
          rmSync(full, { recursive: true, force: true });
          pruned += 1;
        }
      } catch { /* a vanished/locked entry is fine — next pass */ }
    }
  } catch { /* hygiene is best-effort */ }
  return { pruned };
}
