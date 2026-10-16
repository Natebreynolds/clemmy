/**
 * One lightweight inventory of workflow run records for status and history
 * reads.
 *
 * Run records carry heavy parts (every step's output, the admitted definition,
 * the final output). Status and history need none of them, yet each reader
 * parsed every record on every request, and a page cache keyed on a
 * workflow's newest run id missed an existing run finishing. The inventory
 * keeps each record's light fields, re-reads a file only when its size or
 * modification time changes, and gives readers a signature that changes
 * whenever any of a workflow's runs does.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

const HEAVY_FIELDS = new Set(['stepOutputs', 'workflowDefinitionSnapshot', 'output', 'reportBack', 'mutationContractSnapshot']);
const SNAPSHOT_IDENTITY_FIELDS = ['version', 'scope', 'compilerId', 'definitionHash', 'workflowSlug', 'codeRevision'];

const cache = new Map<string, WorkflowRunInventoryEntry>();
let cacheDir = '';

function slim(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!HEAVY_FIELDS.has(key)) out[key] = value;
  }
  const outputs = raw.stepOutputs;
  out.stepOutputKeys = outputs && typeof outputs === 'object' && !Array.isArray(outputs) ? Object.keys(outputs) : [];
  const snapshot = raw.workflowDefinitionSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const identity: Record<string, unknown> = {};
    for (const key of SNAPSHOT_IDENTITY_FIELDS) {
      if (key in snapshot) identity[key] = (snapshot as Record<string, unknown>)[key];
    }
    out.workflowDefinitionSnapshot = identity;
  }
  const report = raw.reportBack;
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    out.reportBack = { outcome: (report as Record<string, unknown>).outcome };
  }
  return out;
}

function createdKey(entry: WorkflowRunInventoryEntry): string {
  const record = entry.record;
  return String(record.createdAt ?? record.startedAt ?? '');
}

/**
 * Every run record's light fields, newest first. A file is parsed again only
 * when its size or modification time changed; a record caught mid-write is
 * left out this time and read on the next call.
 */
export function workflowRunInventory(): readonly WorkflowRunInventoryEntry[] {
  if (cacheDir !== WORKFLOW_RUNS_DIR) {
    cache.clear();
    cacheDir = WORKFLOW_RUNS_DIR;
  }
  if (!existsSync(WORKFLOW_RUNS_DIR)) {
    cache.clear();
    return [];
  }
  const present = new Set<string>();
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    present.add(file);
    let stat: { mtimeMs: number; size: number };
    try { stat = statSync(path.join(WORKFLOW_RUNS_DIR, file)); } catch { continue; }
    const known = cache.get(file);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { cache.delete(file); continue; }
      cache.set(file, Object.freeze({ file, mtimeMs: stat.mtimeMs, size: stat.size, record: Object.freeze(slim(raw as Record<string, unknown>)) }));
    } catch {
      cache.delete(file);
    }
  }
  for (const file of [...cache.keys()]) {
    if (!present.has(file)) cache.delete(file);
  }
  return [...cache.values()].sort((a, b) => createdKey(b).localeCompare(createdKey(a)) || b.file.localeCompare(a.file));
}

/** Changes whenever any run of these workflow names is added, changes or goes away. */
export function workflowRunInventorySignature(workflowNames: readonly string[]): string {
  const names = new Set(workflowNames);
  const hash = createHash('sha256');
  for (const entry of workflowRunInventory()) {
    if (!names.has(String(entry.record.workflow ?? ''))) continue;
    hash.update(`${entry.file}\0${entry.mtimeMs}\0${entry.size}\n`);
  }
  return hash.digest('hex').slice(0, 24);
}

/** Tests only. */
export function _resetWorkflowRunInventoryForTests(): void {
  cache.clear();
  cacheDir = '';
}
