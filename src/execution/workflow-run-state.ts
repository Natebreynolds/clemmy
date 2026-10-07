/**
 * Durable per-workflow state (2026-07-21) — the "employee memory" primitive.
 *
 * A recurring workflow used to be born amnesiac every run: an hourly
 * inbox-scrape re-downloaded the same attachments, re-filed the same Drive
 * documents, and re-appended the same sheet rows, because nothing persisted
 * "what have I already processed" across runs (the duplicate-send wall is
 * session-scoped and only guards irreversible sends). A real employee
 * remembers. This store gives every workflow NAME two durable things:
 *
 *  - `values`: a small key/value scratch space (watermarks, cursors, running
 *    tallies — "last processed message id", "sheet row count").
 *  - `processed`: a bounded ledger of item keys already handled (message ids,
 *    file ids), with `filterUnprocessed` as the deterministic "skip what I've
 *    done" primitive — the model asks which of N candidate keys are new
 *    instead of re-deciding from prose.
 *
 * Keyed by WORKFLOW NAME (recurring runs share it; ad-hoc chat can use any
 * stable name). Atomic writes (tmp+rename); corrupt files quarantine +
 * surface rather than silently resetting (the schedules-audit posture);
 * bounded (values ≤64KB JSON, processed ≤5000 keys pruned oldest-first).
 */

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.workflow-run-state' });

export const WORKFLOW_STATE_DIR = path.join(BASE_DIR, 'state', 'workflow-state');

const MAX_VALUES_JSON_BYTES = 64 * 1024;
const MAX_PROCESSED_KEYS = 5000;
const MAX_KEY_LENGTH = 500;

export interface WorkflowDurableState {
  /** Small key/value scratch space. */
  values: Record<string, unknown>;
  /** Item key → ISO timestamp it was marked processed. */
  processed: Record<string, string>;
  updatedAt: string;
}

function emptyState(): WorkflowDurableState {
  return { values: {}, processed: {}, updatedAt: new Date(0).toISOString() };
}

function stateSlug(workflowName: string): string {
  const slug = workflowName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return slug || '_unnamed';
}

function stateFile(workflowName: string): string {
  return path.join(WORKFLOW_STATE_DIR, `${stateSlug(workflowName)}.json`);
}

export class WorkflowStateUnavailableError extends Error {
  constructor(workflowName: string, detail: string) {
    super(`Durable workflow state for "${workflowName}" is unavailable (${detail}). Pause this workflow and restore a valid saved ledger before handling candidate items; completed work must not be treated as new.`);
    this.name = 'WorkflowStateUnavailableError';
  }
}

function validState(value: unknown): value is WorkflowDurableState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<WorkflowDurableState>;
  return Boolean(state.values && typeof state.values === 'object' && !Array.isArray(state.values)
    && state.processed && typeof state.processed === 'object' && !Array.isArray(state.processed)
    && Object.values(state.processed).every(at => typeof at === 'string' && Number.isFinite(Date.parse(at)))
    && typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.updatedAt)));
}

function readStateNode(file: string, workflowName: string) {
  try { return lstatSync(file); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
    throw new WorkflowStateUnavailableError(workflowName, `ledger evidence cannot be read: ${code}`);
  }
}

/** Install the fixed tombstone before moving the unreadable ledger. A failed
 * marker write leaves the original in place; a failed rename still refuses. */
function retainUnavailableState(file: string): void {
  const marker = `${file}.unavailable`;
  if (existsSync(marker)) return;
  let fd: number | undefined;
  try {
    fd = openSync(marker, 'wx', 0o600);
    writeFileSync(fd, 'Workflow ledger unavailable. Restore a valid saved state file explicitly; do not reset it.\n', 'utf8');
    fsyncSync(fd);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const directory = openSync(path.dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readWorkflowState(workflowName: string): WorkflowDurableState {
  const file = stateFile(workflowName);
  const node = readStateNode(file, workflowName);
  if (!node) {
    if (readStateNode(`${file}.unavailable`, workflowName)) throw new WorkflowStateUnavailableError(workflowName, 'a previous ledger could not be verified');
    // Older builds quarantined corrupt files without a marker. Inspect only
    // this missing-state path, then retain one fixed marker for future reads.
    try {
      if (readStateNode(WORKFLOW_STATE_DIR, workflowName) && readdirSync(WORKFLOW_STATE_DIR)
        .some(name => name.startsWith(`${path.basename(file)}.corrupt-`))) {
        retainUnavailableState(file);
        throw new WorkflowStateUnavailableError(workflowName, 'a quarantined ledger requires restoration');
      }
    } catch (error) {
      if (error instanceof WorkflowStateUnavailableError) throw error;
      throw new WorkflowStateUnavailableError(workflowName, 'the retained ledger evidence is unreadable');
    }
    return emptyState();
  }
  try {
    if (!node.isFile() || node.isSymbolicLink()) throw new Error('ledger is not a direct regular file');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!validState(parsed)) throw new Error('invalid ledger structure');
    // A valid file installed explicitly by the owner is a restoration. The
    // internal mutators cannot create it while the tombstone is active. Keep
    // the tombstone so removing this restored file cannot invent empty state.
    return parsed;
  } catch (err) {
    const quarantine = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    let evidenceRetained = false;
    try { retainUnavailableState(file); evidenceRetained = true; } catch { /* original remains */ }
    if (evidenceRetained) {
      try { renameSync(file, quarantine); } catch { /* original remains; still unavailable */ }
    }
    const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
    logger.warn({ workflowName, quarantine: evidenceRetained ? quarantine : undefined, code },
      'workflow state unavailable — preserved for explicit restoration; workflow must pause');
    throw new WorkflowStateUnavailableError(workflowName, code ? `ledger read failed: ${code}` : 'the saved ledger is corrupt or malformed');
  }
}

function writeWorkflowState(workflowName: string, state: WorkflowDurableState): void {
  mkdirSync(WORKFLOW_STATE_DIR, { recursive: true });
  const file = stateFile(workflowName);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, file);
}

/** Merge a patch into `values`. A null value DELETES the key. Throws a
 *  friendly error when the merged values would exceed the size cap. */
export function setWorkflowStateValues(workflowName: string, patch: Record<string, unknown>): WorkflowDurableState {
  const state = readWorkflowState(workflowName);
  for (const [key, value] of Object.entries(patch)) {
    const k = key.slice(0, MAX_KEY_LENGTH);
    if (value === null) delete state.values[k];
    else state.values[k] = value;
  }
  const bytes = Buffer.byteLength(JSON.stringify(state.values), 'utf-8');
  if (bytes > MAX_VALUES_JSON_BYTES) {
    throw new Error(
      `workflow state values for "${workflowName}" would be ${Math.round(bytes / 1024)}KB (cap ${MAX_VALUES_JSON_BYTES / 1024}KB). `
      + 'Keep state small — store watermarks/cursors/ids here, and park large data in files or the memory vault.',
    );
  }
  state.updatedAt = new Date().toISOString();
  writeWorkflowState(workflowName, state);
  return state;
}

/** Mark item keys processed. Bounded: oldest entries prune past the cap. */
export function markProcessed(workflowName: string, keys: string[]): WorkflowDurableState {
  const state = readWorkflowState(workflowName);
  const now = new Date().toISOString();
  for (const raw of keys) {
    const key = String(raw).trim().slice(0, MAX_KEY_LENGTH);
    if (key) state.processed[key] = now;
  }
  const entries = Object.entries(state.processed);
  if (entries.length > MAX_PROCESSED_KEYS) {
    entries.sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    state.processed = Object.fromEntries(entries.slice(entries.length - MAX_PROCESSED_KEYS));
  }
  state.updatedAt = now;
  writeWorkflowState(workflowName, state);
  return state;
}

/** The deterministic "skip what I've already done" primitive. */
export function filterUnprocessed(workflowName: string, keys: string[]): { fresh: string[]; seen: string[] } {
  const state = readWorkflowState(workflowName);
  const fresh: string[] = [];
  const seen: string[] = [];
  const dedupe = new Set<string>();
  for (const raw of keys) {
    const key = String(raw).trim().slice(0, MAX_KEY_LENGTH);
    if (!key || dedupe.has(key)) continue;
    dedupe.add(key);
    (key in state.processed ? seen : fresh).push(key);
  }
  return { fresh, seen };
}

/** One-line summary for run priming, or null when no state exists yet. */
export function workflowStateSummaryLine(workflowName: string): string | null {
  try {
    const state = readWorkflowState(workflowName);
    const valueKeys = Object.keys(state.values);
    const processedCount = Object.keys(state.processed).length;
    if (valueKeys.length === 0 && processedCount === 0) return null;
    const valuePart = valueKeys.length > 0
      ? `values: ${valueKeys.slice(0, 8).join(', ')}${valueKeys.length > 8 ? ` (+${valueKeys.length - 8} more)` : ''}`
      : 'no values';
    return `Durable workflow state exists (persists across runs; last updated ${state.updatedAt}): ${valuePart}; ${processedCount} processed item key${processedCount === 1 ? '' : 's'}. `
      + 'Use workflow_state action:"filter_unprocessed" with your candidate item ids BEFORE handling them (skip the seen ones — they were completed in prior runs), read cursors with action:"get", and finish by action:"mark_processed" + updating your watermark.';
  } catch (error) {
    return error instanceof WorkflowStateUnavailableError ? error.message
      : `Durable workflow state for "${workflowName}" could not be verified. Pause and restore the saved ledger before handling candidate items.`;
  }
}

/** Test hook / maintenance: list existing state files. */
export function listWorkflowStateFiles(): string[] {
  try {
    if (!existsSync(WORKFLOW_STATE_DIR)) return [];
    return readdirSync(WORKFLOW_STATE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
