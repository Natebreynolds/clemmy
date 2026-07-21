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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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

export function readWorkflowState(workflowName: string): WorkflowDurableState {
  const file = stateFile(workflowName);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WorkflowDurableState>;
    return {
      values: parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values) ? parsed.values : {},
      processed: parsed.processed && typeof parsed.processed === 'object' && !Array.isArray(parsed.processed) ? parsed.processed : {},
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (err) {
    // Quarantine, never silently reset: losing the processed-ledger means the
    // next run re-duplicates everything the ledger existed to prevent.
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, quarantine); } catch { /* keep the original */ }
    logger.warn({ err: err instanceof Error ? err.message : String(err), workflowName, quarantine },
      'workflow state corrupt — quarantined; the next run starts from empty state and may redo work');
    return emptyState();
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
    if (!existsSync(stateFile(workflowName))) return null;
    const state = readWorkflowState(workflowName);
    const valueKeys = Object.keys(state.values);
    const processedCount = Object.keys(state.processed).length;
    if (valueKeys.length === 0 && processedCount === 0) return null;
    const valuePart = valueKeys.length > 0
      ? `values: ${valueKeys.slice(0, 8).join(', ')}${valueKeys.length > 8 ? ` (+${valueKeys.length - 8} more)` : ''}`
      : 'no values';
    return `Durable workflow state exists (persists across runs; last updated ${state.updatedAt}): ${valuePart}; ${processedCount} processed item key${processedCount === 1 ? '' : 's'}. `
      + 'Use workflow_state action:"filter_unprocessed" with your candidate item ids BEFORE handling them (skip the seen ones — they were completed in prior runs), read cursors with action:"get", and finish by action:"mark_processed" + updating your watermark.';
  } catch {
    return null;
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
