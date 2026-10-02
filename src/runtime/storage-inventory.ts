/** Read-only file-size inventory. No SQLite history scans, payload decryption or model
 * calls: opening Settings must not compete with an executing conversation. */
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASE_DIR } from '../config.js';
import { readStorageDatabaseStatus } from './storage-database-status.js';
import type { StorageCategory, StorageInventory } from '../shared/storage-inventory.js';
export type { StorageCategory, StorageInventory } from '../shared/storage-inventory.js';
const CATEGORIES: StorageCategory[] = ['conversations', 'execution', 'learning', 'backups', 'software', 'files'];

function categoryFor(relative: string): StorageCategory {
  const parts = relative.split(path.sep);
  if (parts[0] === 'state' && /^harness\.db(?:-wal|-shm)?$/.test(parts[1] ?? '')) return 'conversations';
  if (parts[0] === 'state' && parts[1] === 'authority-payloads') return 'execution';
  if (parts[0] === 'memory' || parts[0] === 'working-memory'
    || (parts[0] === 'state' && (/^memory\.db(?:-wal|-shm)?$/.test(parts[1] ?? '') || parts[1] === 'run-strategies.json'))) return 'learning';
  if (parts[0] === 'backups' || (parts[0] === 'state'
    && /^(backups|dev-backups|pre-migration-backups|backup-pre.*|pre-v\d+.*)$/.test(parts[1] ?? ''))) return 'backups';
  if (parts[0] === 'runtime' || parts[0] === 'cache' || (parts[0] === 'state' && parts[1] === 'mcp-npx-cache')) return 'software';
  return 'files';
}

/** One shared in-flight scan and a two-minute cache, including partial scans.
 * The endpoint accepts no path or budget from the caller. Budgets bound work
 * on arbitrarily large homes; partial totals are explicitly lower bounds. */
export function createStorageInventoryReader(options: {
  baseDir: string;
  maxEntries?: number;
  maxDurationMs?: number;
  cacheMs?: number;
  clock?: () => number;
}) {
  const root = path.resolve(options.baseDir);
  const maxEntries = options.maxEntries ?? 100_000;
  const maxDurationMs = options.maxDurationMs ?? 8_000;
  const cacheMs = options.cacheMs ?? 120_000;
  const clock = options.clock ?? (() => performance.now());
  if (![maxEntries, maxDurationMs, cacheMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid inventory budget');
  let cached: StorageInventory | null = null;
  let cachedAt = 0;
  let pending: Promise<StorageInventory> | null = null;

  async function scan(): Promise<StorageInventory> {
    const started = clock();
    const result: StorageInventory = { measuredAt: new Date().toISOString(), durationMs: 0, complete: true,
      stopReason: null, unreadableEntries: 0, skippedLinks: 0, totalBytes: 0,
      categories: CATEGORIES.map(id => ({ id, bytes: 0, files: 0 })) };
    const rows = new Map(result.categories.map(row => [row.id, row]));
    const seenFiles = new Set<string>();
    const queues: string[][] = Array.from({ length: 6 }, () => []);
    const priority = (relative: string) => relative === '' || relative === 'state' ? 0
      : ({ conversations: 0, execution: 1, learning: 2, backups: 3, files: 4, software: 5 })[categoryFor(relative)];
    queues[0]!.push('');
    let queued = 1;
    let entries = 0;
    let canonicalRoot = root;
    try { canonicalRoot = await realpath(root); } catch { /* visit reports unavailable */ }
    const budgetAvailable = () => {
      if (result.stopReason) return false;
      if (entries >= maxEntries) result.stopReason = 'entry_limit';
      else if (clock() - started >= maxDurationMs) result.stopReason = 'time_limit';
      return !result.stopReason;
    };
    async function visit(relative: string): Promise<void> {
      if (!budgetAvailable()) return;
      entries += 1;
      const target = path.join(canonicalRoot, relative);
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) { result.skippedLinks += 1; return; }
        if (stat.isFile()) {
          const identity = `${stat.dev}:${stat.ino}`;
          if (seenFiles.has(identity)) return;
          seenFiles.add(identity);
          const row = rows.get(categoryFor(relative))!;
          row.bytes += stat.size;
          row.files += 1;
          result.totalBytes += stat.size;
        } else if (stat.isDirectory()) {
          // Refuse a directory redirected outside the home while traversing.
          if (await realpath(target) !== target) { result.skippedLinks += 1; return; }
          const dir = await opendir(target);
          for await (const entry of dir) {
            if (!budgetAvailable()) return;
            if (queued + entries >= maxEntries) { result.stopReason = 'entry_limit'; return; }
            const child = path.join(relative, entry.name);
            queues[priority(child)]!.push(child);
            queued += 1;
          }
        }
      } catch (error) {
        // Files may disappear during a live scan. Permission and I/O failures
        // are unavailable data, never a truthful zero-byte measurement.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadableEntries += 1;
        if (relative === '') result.stopReason = 'unavailable';
      }
    }
    // Global priority (rather than recursive directory order) measures the
    // database, execution evidence and learning before large software caches.
    while (queued > 0 && budgetAvailable()) {
      const batch: string[] = [];
      // A small bounded I/O batch avoids paying a filesystem round-trip per
      // file, without an unbounded Promise fan-out on large dependency trees.
      while (queued > 0 && batch.length < 8) {
        const queue = queues.find(items => items.length > 0)!;
        queued -= 1;
        batch.push(queue.pop()!);
      }
      await Promise.all(batch.map(visit));
    }
    result.database = await readStorageDatabaseStatus(root);
    result.complete = result.stopReason === null && result.unreadableEntries === 0;
    result.durationMs = Math.round(Math.max(0, clock() - started));
    result.measuredAt = new Date().toISOString();
    return result;
  }
  return function getStorageInventory(): Promise<StorageInventory> {
    if (cached && clock() - cachedAt < cacheMs) return Promise.resolve(cached);
    if (pending) return pending;
    pending = scan().then(result => { cached = result; cachedAt = clock(); return result; }).finally(() => { pending = null; });
    return pending;
  };
}

export const getStorageInventory = createStorageInventoryReader({ baseDir: BASE_DIR });
