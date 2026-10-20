import { slimWorkflowRunRecord } from './workflow-run-inventory-data.js';
/**
 * One lightweight inventory of workflow run records for status and history
 * reads.
 *
 * Run records carry heavy parts (every step's output, the admitted definition,
 * the final output). Status and history need none of them, yet each reader
 * parsed every record on every request, and a page cache keyed on a
 * workflow's newest run id missed an existing run finishing. The inventory
 * keeps each record's light fields, re-reads a file only when its filesystem
 * generation changes, and gives readers a signature that changes
 * whenever any of a workflow's runs does.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type BigIntStats } from 'node:fs';
import path from 'node:path';

import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

export interface WorkflowRunInventoryEntry {
  /** The run file's basename. */
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
  /**
   * The record without its heavy parts. `stepOutputKeys` names the steps that
   * produced output; the definition snapshot keeps only its identity fields;
   * the report keeps only its outcome.
   */
  readonly record: Readonly<Record<string, unknown>>;
}

export interface WorkflowRunInventorySnapshot {
  /** The light projections from one metadata scan, newest first. */
  readonly entries: readonly WorkflowRunInventoryEntry[];
  /** Pure over this capture: no later filesystem or shared-cache lookups. */
  signatureFor(workflowNames: readonly string[]): string;
}

/** A selected file's display projection. Empty decoded values are distinct
 * from an unreadable generation so observers can retain their read accounting. */
export type WorkflowRunInventoryFileResult =
  | { kind: 'record'; entry: WorkflowRunInventoryEntry }
  | { kind: 'empty' }
  | { kind: 'failed' };

interface CachedEntry {
  entry: WorkflowRunInventoryEntry;
  generation: string;
}

const cache = new Map<string, CachedEntry>();
let cacheDir = '';

function generation(stat: BigIntStats): string {
  // Atomic publication may replace a record with same-sized bytes and preserve
  // its mtime. The file identity and change time still belong to the new value.
  return `${stat.dev}\0${stat.ino}\0${stat.ctimeNs}\0${stat.mtimeNs}\0${stat.size}`;
}

function createdKey(entry: WorkflowRunInventoryEntry): string {
  const record = entry.record;
  return String(record.createdAt ?? record.startedAt ?? '');
}

function ensureCacheDirectory(): void {
  if (cacheDir !== WORKFLOW_RUNS_DIR) {
    cache.clear();
    cacheDir = WORKFLOW_RUNS_DIR;
  }
}

function refreshFile(file: string): WorkflowRunInventoryFileResult {
  try {
    const fullPath = path.join(WORKFLOW_RUNS_DIR, file);
    const before = statSync(fullPath, { bigint: true });
    if (!before.isFile()) { cache.delete(file); return { kind: 'failed' }; }
    const revision = generation(before);
    const known = cache.get(file);
    if (known?.generation === revision) return { kind: 'record', entry: known.entry };
    const bytes = readFileSync(fullPath, 'utf-8');
    const after = statSync(fullPath, { bigint: true });
    if (generation(after) !== revision) { cache.delete(file); return { kind: 'failed' }; }
    const raw = JSON.parse(bytes) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      cache.delete(file);
      // The legacy observer counted a null record as a failed read, while
      // other decoded primitives/arrays simply had no workflow or status.
      return { kind: raw === null ? 'failed' : 'empty' };
    }
    const entry = Object.freeze({
      file,
      mtimeMs: Number(before.mtimeNs) / 1_000_000,
      size: Number(before.size),
      record: Object.freeze(slimWorkflowRunRecord(raw as Record<string, unknown>)),
    });
    cache.set(file, { generation: revision, entry });
    return { kind: 'record', entry };
  } catch {
    cache.delete(file);
    return { kind: 'failed' };
  }
}

/** Refresh only an already-selected basename, without scanning other runs or
 * changing its caller's window/order. This is not execution authority. */
export function readWorkflowRunInventoryFile(file: string): WorkflowRunInventoryFileResult {
  if (!file.endsWith('.json') || path.basename(file) !== file || file.includes('\0')) {
    return { kind: 'failed' };
  }
  ensureCacheDirectory();
  return refreshFile(file);
}

/** A single status projection. It never enumerates other runs or grants authority. */
export function workflowRunInventoryEntry(runId: string): WorkflowRunInventoryEntry | null {
  if (!runId || !/^[a-zA-Z0-9_.:-]+$/.test(runId)) return null;
  ensureCacheDirectory();
  const result = refreshFile(`${runId}.json`);
  return result.kind === 'record' ? result.entry : null;
}

/**
 * Every run record's light fields, newest first. A file is parsed again only
 * when its filesystem generation changed; a record caught mid-write is
 * left out this time and read on the next call.
 */
export function workflowRunInventory(options: { throwOnDirectoryReadError?: boolean } = {}): readonly WorkflowRunInventoryEntry[] {
  ensureCacheDirectory();
  let files: string[];
  try { files = readdirSync(WORKFLOW_RUNS_DIR); } catch (error) {
    cache.clear();
    // History routes distinguish an unreadable directory from an empty one.
    // Existing best-effort status readers retain their prior empty projection.
    if (options.throwOnDirectoryReadError) throw error;
    return [];
  }
  const present = new Set<string>();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    present.add(file);
    refreshFile(file);
  }
  for (const file of [...cache.keys()]) {
    if (!present.has(file)) cache.delete(file);
  }
  return [...cache.values()].map(({ entry }) => entry)
    .sort((a, b) => createdKey(b).localeCompare(createdKey(a)) || b.file.localeCompare(a.file));
}

/**
 * Capture once per status/history request. The records and their memo identity
 * must describe the same scan, even when another reader refreshes the shared
 * cache while this capture is still in use. Group each workflow's generations
 * once so deriving W workflow signatures does not scan R runs W times.
 * This is a display projection, never execution or mutation authority.
 */
export function captureWorkflowRunInventory(): WorkflowRunInventorySnapshot {
  const entries = Object.freeze([...workflowRunInventory()]);
  const grouped = new Map<string, ReturnType<typeof createHash>>();
  for (const entry of entries) {
    const workflow = String(entry.record.workflow ?? '');
    let hash = grouped.get(workflow);
    if (!hash) { hash = createHash('sha256'); grouped.set(workflow, hash); }
    hash.update(JSON.stringify([entry.file, cache.get(entry.file)!.generation]));
  }
  const groupDigests = new Map([...grouped].map(([workflow, hash]) => [workflow, hash.digest('hex')]));
  return Object.freeze({
    entries,
    signatureFor(workflowNames: readonly string[]): string {
      const hash = createHash('sha256').update('workflow-run-inventory:v2\0');
      for (const workflow of [...new Set(workflowNames)].sort()) {
        hash.update(JSON.stringify([workflow, groupDigests.get(workflow) ?? null]));
      }
      return `v2:${hash.digest('hex').slice(0, 24)}`;
    },
  });
}

/** Changes whenever any run of these workflow names is added, changes or goes away. */
export function workflowRunInventorySignature(workflowNames: readonly string[]): string {
  return captureWorkflowRunInventory().signatureFor(workflowNames);
}

/** Tests only. */
export function _resetWorkflowRunInventoryForTests(): void {
  cache.clear();
  cacheDir = '';
}
