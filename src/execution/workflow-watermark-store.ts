/**
 * T2.2 — cross-run forEach watermark.
 *
 * A `forEach` step iterates a list materialized inside the CURRENT run; before
 * this store there was no engine-level notion of "items already processed by a
 * PRIOR run", so recurring workflows pushed novelty detection into the LLM
 * prompt ("only process new leads") — the exact prompt-over-code pattern the
 * house rules forbid. This store persists the set of completed item keys per
 * (workflow, step) so a step declaring `forEachNewOnly: true` fans out over
 * genuinely new items only.
 *
 * Semantics:
 *  - Keys are the SAME stable itemKey the runner uses for per-run resume
 *    (item.id/key/slug, else the short string item) — one keying scheme.
 *  - The watermark advances ONLY when an item completes (per window), so a
 *    failed item is retried by the next run instead of silently skipped.
 *  - Bounded: keeps the most recent MAX_SEEN_KEYS per step (by seen date);
 *    a feed larger than the cap re-sees ancient items rather than growing
 *    without bound — acceptable for "process new arrivals" feeds.
 *
 * Storage: one JSON file per workflow under state/workflow-watermarks/,
 * written atomically (tmp + rename). Single-writer by construction: the
 * daemon's run drain is the only caller.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

const MAX_SEEN_KEYS = 5000;

interface WorkflowWatermarkFile {
  steps: Record<string, { seen: Record<string, string> }>;
}

function watermarkDir(): string {
  return path.join(BASE_DIR, 'state', 'workflow-watermarks');
}

function watermarkPath(workflowSlug: string): string {
  const safe = workflowSlug.replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(watermarkDir(), `${safe}.json`);
}

function readWatermarkFile(workflowSlug: string): WorkflowWatermarkFile {
  try {
    const parsed = JSON.parse(readFileSync(watermarkPath(workflowSlug), 'utf-8')) as WorkflowWatermarkFile;
    if (parsed && typeof parsed === 'object' && parsed.steps && typeof parsed.steps === 'object') return parsed;
  } catch { /* missing or corrupt → start fresh */ }
  return { steps: {} };
}

/** The set of item keys already completed by prior runs of (workflow, step). */
export function readSeenItemKeys(workflowSlug: string, stepId: string): Set<string> {
  const file = readWatermarkFile(workflowSlug);
  return new Set(Object.keys(file.steps[stepId]?.seen ?? {}));
}

/** Advance the watermark: record `keys` as completed. Idempotent; caps the
 *  per-step set at MAX_SEEN_KEYS most recent. */
export function markItemsSeen(workflowSlug: string, stepId: string, keys: string[]): void {
  const cleaned = keys.map((k) => k?.trim()).filter((k): k is string => Boolean(k));
  if (cleaned.length === 0) return;
  const file = readWatermarkFile(workflowSlug);
  const step = file.steps[stepId] ?? { seen: {} };
  const now = new Date().toISOString();
  for (const key of cleaned) {
    step.seen[key] = step.seen[key] ?? now;
  }
  const entries = Object.entries(step.seen);
  if (entries.length > MAX_SEEN_KEYS) {
    entries.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)); // newest first
    step.seen = Object.fromEntries(entries.slice(0, MAX_SEEN_KEYS));
  }
  file.steps[stepId] = step;
  mkdirSync(watermarkDir(), { recursive: true });
  const target = watermarkPath(workflowSlug);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, target);
}

/** Forget a step's watermark (e.g. the user asks to reprocess everything). */
export function clearStepWatermark(workflowSlug: string, stepId: string): void {
  const file = readWatermarkFile(workflowSlug);
  if (!file.steps[stepId]) return;
  delete file.steps[stepId];
  mkdirSync(watermarkDir(), { recursive: true });
  const target = watermarkPath(workflowSlug);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, target);
}
