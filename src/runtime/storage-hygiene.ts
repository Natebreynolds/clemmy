import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { slugifyServerName } from './mcp-namespace-shim.js';

export type StorageHygieneKind =
  | 'codex_diagnostic'
  | 'inactive_mcp_cache'
  | 'mcp_temp'
  | 'mcp_log'
  | 'legacy_hotpatch_backup';

export interface StorageHygieneRemoval {
  kind: StorageHygieneKind;
  path: string;
  bytes: number;
}

export interface StorageHygieneResult {
  scanned: number;
  removed: number;
  bytesFreed: number;
  byKind: Partial<Record<StorageHygieneKind, { removed: number; bytes: number }>>;
  removals: StorageHygieneRemoval[];
}

export interface StorageHygieneOptions {
  baseDir?: string;
  activeMcpServerNames?: Iterable<string>;
  nowMs?: number;
  dryRun?: boolean;
  diagnosticMaxAgeDays?: number;
  inactiveMcpCacheMaxAgeDays?: number;
  hotpatchBackupMaxAgeDays?: number;
  newestHotpatchBackupMaxAgeDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function boundedDays(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.min(3650, Math.floor(Number(value))))
    : fallback;
}

function entryAgeMs(file: string, nowMs: number): number {
  try { return Math.max(0, nowMs - statSync(file).mtimeMs); } catch { return 0; }
}

function directoryBytes(root: string): number {
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  } catch {
    return 0;
  }
  let bytes = 0;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return 0; }
  for (const entry of entries) bytes += directoryBytes(path.join(root, entry));
  return bytes;
}

function childPaths(root: string): string[] {
  try { return readdirSync(root).map((entry) => path.join(root, entry)); } catch { return []; }
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of childPaths(root)) {
    try {
      const info = lstatSync(entry);
      if (info.isDirectory() && !info.isSymbolicLink()) out.push(...collectFiles(entry));
      else out.push(entry);
    } catch { /* concurrent cleanup; skip */ }
  }
  return out;
}

function mcpCacheLastUsedAt(cacheDir: string): number {
  const marker = path.join(cacheDir, '.last-used.json');
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { at?: string };
    const at = Date.parse(parsed.at ?? '');
    if (Number.isFinite(at)) return at;
  } catch { /* old caches have no marker */ }
  try { return statSync(cacheDir).mtimeMs; } catch { return 0; }
}

/**
 * Reap only rebuildable or diagnostic runtime artifacts. Canonical memory,
 * vault files, recordings, attachments, active MCP caches, session history,
 * workflows, and user-authored output are deliberately outside this policy.
 */
export function reapDisposableRuntimeArtifacts(options: StorageHygieneOptions = {}): StorageHygieneResult {
  const baseDir = path.resolve(options.baseDir ?? BASE_DIR);
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun === true;
  const diagnosticAge = boundedDays(options.diagnosticMaxAgeDays, 30) * DAY_MS;
  const inactiveMcpAge = boundedDays(options.inactiveMcpCacheMaxAgeDays, 30) * DAY_MS;
  const hotpatchAge = boundedDays(options.hotpatchBackupMaxAgeDays, 30) * DAY_MS;
  const newestHotpatchAge = boundedDays(options.newestHotpatchBackupMaxAgeDays, 90) * DAY_MS;
  const activeMcpCaches = new Set(
    [...(options.activeMcpServerNames ?? [])].map((name) => slugifyServerName(name)),
  );
  const result: StorageHygieneResult = { scanned: 0, removed: 0, bytesFreed: 0, byKind: {}, removals: [] };

  const remove = (target: string, kind: StorageHygieneKind): void => {
    if (!existsSync(target)) return;
    const bytes = directoryBytes(target);
    if (!dryRun) {
      try { rmSync(target, { recursive: true, force: true }); } catch { return; }
    }
    result.removed += 1;
    result.bytesFreed += bytes;
    const kindStats = result.byKind[kind] ?? { removed: 0, bytes: 0 };
    kindStats.removed += 1;
    kindStats.bytes += bytes;
    result.byKind[kind] = kindStats;
    if (result.removals.length < 100) result.removals.push({ kind, path: target, bytes });
  };

  // Provider SSE payloads are bounded diagnostics for debugging truncated model
  // responses. They are not replay state and have no product dependency.
  const diagnosticsRoot = path.join(baseDir, 'state', 'codex-sse-truncated');
  for (const file of collectFiles(diagnosticsRoot)) {
    result.scanned += 1;
    if (entryAgeMs(file, nowMs) > diagnosticAge) remove(file, 'codex_diagnostic');
  }

  // Keep caches for currently configured servers indefinitely. A cache whose
  // server is gone/disabled is rebuildable through npx if re-enabled later.
  const mcpRoot = path.join(baseDir, 'state', 'mcp-npx-cache');
  for (const cacheDir of childPaths(mcpRoot)) {
    let isDirectory = false;
    try { isDirectory = lstatSync(cacheDir).isDirectory(); } catch { /* skip */ }
    if (!isDirectory) continue;
    result.scanned += 1;
    const slug = path.basename(cacheDir);
    if (!activeMcpCaches.has(slug) && nowMs - mcpCacheLastUsedAt(cacheDir) > inactiveMcpAge) {
      remove(cacheDir, 'inactive_mcp_cache');
      continue;
    }
    for (const file of collectFiles(path.join(cacheDir, '_logs'))) {
      result.scanned += 1;
      if (entryAgeMs(file, nowMs) > 14 * DAY_MS) remove(file, 'mcp_log');
    }
    for (const file of collectFiles(path.join(cacheDir, '_cacache', 'tmp'))) {
      result.scanned += 1;
      if (entryAgeMs(file, nowMs) > DAY_MS) remove(file, 'mcp_temp');
    }
  }

  // In-place hotpatching is no longer supported; signed candidate releases are
  // the canonical test path. Keep recent legacy rollback copies for a generous
  // window, but do not let abandoned full app bundles live forever.
  const hotpatchDirs = childPaths(path.join(baseDir, 'hotpatch-backups'))
    .filter((entry) => {
      try { return lstatSync(entry).isDirectory(); } catch { return false; }
    })
    .sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
    });
  hotpatchDirs.forEach((entry, index) => {
    result.scanned += 1;
    const maxAge = index === 0 ? newestHotpatchAge : hotpatchAge;
    if (entryAgeMs(entry, nowMs) > maxAge) remove(entry, 'legacy_hotpatch_backup');
  });

  // NOTE: logs/ is deliberately NOT reaped. daemon.log is append-only with no
  // rotation today, so there is no archived-log shape to age out; when
  // rotation exists, add its exact naming here with a test that pins it.

  return result;
}
