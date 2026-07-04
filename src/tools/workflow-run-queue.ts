import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from './shared.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from '../execution/workflow-inputs.js';
import { listFinalFailedItems } from '../execution/workflow-events.js';

/**
 * Shared workflow-run queueing — the single place that writes a run request
 * to local workflow state. Used by the `workflow_run` MCP tool AND by the
 * plan-continuity resume path (ask-then-resume for missing inputs), so both
 * surfaces queue identically and the dedupe / messaging never drifts.
 */

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

export function findDuplicateQueuedWorkflowRun(
  workflowName: string,
  inputs: Record<string, string>,
  excludeRunId?: string,
): { id: string; status: string } | null {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return null;
  // Normalize BOTH sides so dedupe is correct regardless of whether the
  // caller pre-normalized (url/website aliases must compare equal).
  const wanted = stableJson(normalizeWorkflowRunInputs(inputs));
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        id?: unknown;
        workflow?: unknown;
        inputs?: unknown;
        status?: unknown;
      };
      const status = typeof parsed.status === 'string' ? parsed.status : 'queued';
      if (status !== 'queued' && status !== 'running') continue;
      if (parsed.workflow !== workflowName) continue;
      // A requeue-from-run must never see its own SOURCE run as the duplicate
      // (the source is still status:'running' on disk when a goal re-pursuit
      // queues the next attempt mid-completion).
      if (excludeRunId && parsed.id === excludeRunId) continue;
      const existingInputs = normalizeWorkflowRunInputs(
        parsed.inputs && typeof parsed.inputs === 'object' && !Array.isArray(parsed.inputs)
          ? parsed.inputs as Record<string, string>
          : {},
      );
      if (stableJson(existingInputs) !== wanted) continue;
      const id = typeof parsed.id === 'string' ? parsed.id : path.basename(file, '.json');
      return { id, status };
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeOriginSessionIds(...values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    }
  };
  for (const value of values) add(value);
  return out;
}

function attachOriginSessionIdsToRun(runId: string, origins: string[]): void {
  if (origins.length === 0) return;
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!existsSync(file)) return;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const merged = normalizeOriginSessionIds(rec.originSessionId, rec.originSessionIds, origins);
  if (merged.length === 0) return;
  rec.originSessionId = merged[0];
  if (merged.length > 1) rec.originSessionIds = merged;
  else delete rec.originSessionIds;
  writeFileSync(file, JSON.stringify(rec, null, 2), 'utf-8');
}

export interface QueueWorkflowRunResult {
  status: 'queued' | 'duplicate';
  id?: string;
  message: string;
}

/**
 * Write a queued run request for a workflow with already-normalized inputs.
 * Caller is responsible for validating required inputs first (this is the
 * raw queue primitive). Returns a duplicate result without queueing when an
 * identical run is already queued/running.
 */
export interface QueueWorkflowRunOptions {
  /** Gap E: the chat/agent session that should hear the outcome in-context.
   *  Written into the run record so the runner re-enters it on a terminal
   *  state. Omit for scheduled/cron/dashboard/webhook runs (notification-only). */
  originSessionId?: string;
  /** Additional origin chats that requested/observed the same queued/running
   *  work. Backwards-compatible with originSessionId; used only when duplicate
   *  queue requests should also report back to the current chat. */
  originSessionIds?: string[];
  /** Self-heal lineage: how many times this run has already been auto-healed +
   *  re-queued. Carried run→run so the runner can bound auto-heal attempts. */
  selfHealAttempt?: number;
  /** T3.2: the reversible backup snapshotted when the heal was auto-applied.
   *  Carried into the healed re-run so the runner can AUTO-REVERT the fix if
   *  the re-run still fails (a heal that didn't stick must not survive). */
  selfHealBackupId?: string;
  /** Run-goal lineage: how many goal re-pursuits already happened (0 = the
   *  original run). Carried run→run so the runner can bound re-pursuits. */
  goalAttempt?: number;
  /** Validation evidence from the prior unmet attempt — folded into every LLM
   *  step prompt of the re-pursuit so attempt N+1 is targeted, not blind. */
  goalFeedback?: string;
  /** Requeue-from-run: the source run's id, excluded from same-inputs dedupe
   *  (the source is still status:'running' on disk during a mid-completion
   *  re-pursuit queue, and must not count as "already queued"). */
  excludeRunId?: string;
  /** Failed-item retry lineage: queue a targeted workflow run that inherits
   *  completed upstream work from `fromRunId`, then reprocesses only these
   *  failed forEach item keys for `stepId`. */
  retryFailedItems?: {
    fromRunId: string;
    stepId: string;
    itemKeys: string[];
  };
}

export function queueWorkflowRun(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const duplicate = findDuplicateQueuedWorkflowRun(name, normalizedInputs, opts?.excludeRunId);
  const origins = normalizeOriginSessionIds(opts?.originSessionId, opts?.originSessionIds);
  if (duplicate) {
    attachOriginSessionIdsToRun(duplicate.id, origins);
    return {
      status: 'duplicate',
      id: duplicate.id,
      message: `Workflow "${name}" is already ${duplicate.status} as run ${duplicate.id} with the same inputs — it's running in the background and will report back here when it finishes. No duplicate was queued; just tell the user it's already on it. (Only call workflow_run_status if the user explicitly asks for a progress check.)`,
    };
  }
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const origin = origins[0];
  const selfHealAttempt = typeof opts?.selfHealAttempt === 'number' && opts.selfHealAttempt > 0
    ? opts.selfHealAttempt
    : undefined;
  const goalAttempt = typeof opts?.goalAttempt === 'number' && opts.goalAttempt > 0
    ? opts.goalAttempt
    : undefined;
  const goalFeedback = opts?.goalFeedback?.trim() || undefined;
  const retryFailedItems = opts?.retryFailedItems
    && opts.retryFailedItems.fromRunId.trim()
    && opts.retryFailedItems.stepId.trim()
    && opts.retryFailedItems.itemKeys.length > 0
    ? {
        retryFailedItemsFromRunId: opts.retryFailedItems.fromRunId.trim(),
        retryFailedItemsStepId: opts.retryFailedItems.stepId.trim(),
        retryFailedItemKeys: Array.from(new Set(opts.retryFailedItems.itemKeys.map((k) => k.trim()).filter(Boolean))),
      }
    : undefined;
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({
      id,
      workflow: name,
      inputs: normalizedInputs,
      status: 'queued',
      createdAt: new Date().toISOString(),
      // Only written when present → scheduled/dashboard/webhook records are
      // byte-identical to before (no origin → notification-only).
      ...(origin ? { originSessionId: origin } : {}),
      ...(origins.length > 1 ? { originSessionIds: origins } : {}),
      ...(selfHealAttempt ? { selfHealAttempt } : {}),
      ...(selfHealAttempt && opts?.selfHealBackupId?.trim() ? { selfHealBackupId: opts.selfHealBackupId.trim() } : {}),
      ...(goalAttempt ? { goalAttempt } : {}),
      ...(goalFeedback ? { goalFeedback } : {}),
      ...(retryFailedItems ? retryFailedItems : {}),
    }, null, 2),
    'utf-8',
  );
  return {
    status: 'queued',
    id,
    message:
      `Queued "${name}" (run ${id}) — it is now running in the BACKGROUND. `
      + `Tell the user it's running and that you'll report back here when it finishes; the outcome is delivered to this chat automatically on completion. `
      + `Do NOT wait, poll, or call workflow_run_status, and do NOT do the workflow's work yourself — you're free to take the user's next request right now. `
      + `(Only call workflow_run_status later if the user explicitly asks how it's going.)`,
  };
}

/**
 * Queue a CREATION TEST run — the real read-only validation that runs once at
 * authoring time (Part B). The runner walks the steps in dependency order,
 * actually EXECUTES the read-only/critical steps (scrape/fetch/query) against
 * the real tools with the run's inputs, and PREVIEWS (does not execute)
 * mutating steps. On pass it auto-enables the workflow; on fail the workflow
 * stays disabled with a one-line reason. Distinct status so the drain loop and
 * report-back can treat it differently from a normal run or a dry_run.
 */
export function queueWorkflowCreationTest(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const origin = opts?.originSessionId?.trim();
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({
      id,
      workflow: name,
      inputs: normalizedInputs,
      status: 'creation_test',
      createdAt: new Date().toISOString(),
      ...(origin ? { originSessionId: origin } : {}),
    }, null, 2),
    'utf-8',
  );
  return {
    status: 'queued',
    id,
    message:
      `Saved "${name}" as DISABLED and started a creation test (run ${id}) — `
      + `it's running the read-only steps now against the real tools to confirm they return data, `
      + `and previewing (not executing) any send/write steps. `
      + `Tell the user it's being tested and that it will auto-enable here on pass (or report what to fix on fail). `
      + `Do NOT wait, poll, or do the work yourself.`,
  };
}

export interface ResumeWorkflowRunResult {
  status: 'queued' | 'duplicate' | 'missing_inputs' | 'not_found' | 'disabled';
  id?: string;
  missing?: string[];
  message: string;
}

/**
 * Resume a workflow run from accumulated inputs (the ask-then-resume path).
 * Looks the workflow up by name, normalizes + validates required inputs, and
 * either queues it or reports exactly which inputs are still missing — so the
 * caller can re-ask without ever falling back into a model-driven retry loop.
 */
export function resumeWorkflowRun(
  name: string,
  rawInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): ResumeWorkflowRunResult {
  const workflow = listWorkflows().find((entry) => entry.data.name === name);
  if (!workflow) return { status: 'not_found', message: `Workflow "${name}" not found.` };
  if (!workflow.data.enabled) return { status: 'disabled', message: `Workflow "${name}" is disabled.` };
  const normalized = normalizeWorkflowRunInputs(rawInputs);
  const missing = missingWorkflowRunInputs(workflow.data, normalized);
  if (missing.length > 0) {
    return { status: 'missing_inputs', missing, message: `Still missing: ${missing.join(', ')}.` };
  }
  const queued = queueWorkflowRun(name, normalized, opts);
  return { status: queued.status, id: queued.id, message: queued.message };
}

export interface RequeueResult {
  status: 'queued' | 'duplicate' | 'not_found' | 'no_failed_items' | 'ambiguous';
  id?: string;
  failedItems?: Array<{ stepId: string; itemKey: string; error: string }>;
  message: string;
}

/**
 * Re-queue a workflow from a PRIOR run's record — the build→fail→fix→re-run
 * loop: after an approved Doctor fix is applied to the workflow definition, run
 * it again with the SAME inputs so the fix is exercised immediately. Reads the
 * prior run file by id; returns not_found if it's gone (best-effort, never
 * throws into the caller — the fix is already applied either way).
 */
export function requeueWorkflowFromRun(
  originalRunId: string,
  opts: QueueWorkflowRunOptions = {},
): RequeueResult {
  const safe = originalRunId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!existsSync(file)) {
    return { status: 'not_found', message: `Original run "${originalRunId}" not found; nothing to re-queue.` };
  }
  let rec: { workflow?: unknown; inputs?: unknown; originSessionId?: unknown; originSessionIds?: unknown };
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as { workflow?: unknown; inputs?: unknown; originSessionId?: unknown; originSessionIds?: unknown };
  } catch {
    return { status: 'not_found', message: 'Original run record unreadable; nothing to re-queue.' };
  }
  const workflow = typeof rec.workflow === 'string' ? rec.workflow : undefined;
  if (!workflow) return { status: 'not_found', message: 'Original run record has no workflow name.' };
  const inputs = normalizeWorkflowRunInputs(
    rec.inputs && typeof rec.inputs === 'object' && !Array.isArray(rec.inputs)
      ? (rec.inputs as Record<string, string>)
      : {},
  );
  // Carry the original run's chat-origin so the re-run reports back into the
  // SAME chat (closes the deferred report-back gap), unless the caller overrides.
  const originSessionIds = opts.originSessionId || opts.originSessionIds
    ? normalizeOriginSessionIds(opts.originSessionId, opts.originSessionIds)
    : normalizeOriginSessionIds(rec.originSessionId, rec.originSessionIds);
  const queued = queueWorkflowRun(workflow, inputs, {
    originSessionId: originSessionIds[0],
    originSessionIds,
    selfHealAttempt: opts.selfHealAttempt,
    selfHealBackupId: opts.selfHealBackupId,
    goalAttempt: opts.goalAttempt,
    goalFeedback: opts.goalFeedback,
    excludeRunId: originalRunId,
  });
  return { status: queued.status, id: queued.id, message: queued.message };
}

export function requeueWorkflowFailedItemsFromRun(
  originalRunId: string,
  opts: QueueWorkflowRunOptions & { stepId?: string } = {},
): RequeueResult {
  const safe = originalRunId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!existsSync(file)) {
    return { status: 'not_found', message: `Original run "${originalRunId}" not found; no failed items to re-queue.` };
  }
  let rec: { workflow?: unknown; inputs?: unknown; originSessionId?: unknown; originSessionIds?: unknown };
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as { workflow?: unknown; inputs?: unknown; originSessionId?: unknown; originSessionIds?: unknown };
  } catch {
    return { status: 'not_found', message: 'Original run record unreadable; no failed items to re-queue.' };
  }
  const workflow = typeof rec.workflow === 'string' ? rec.workflow : undefined;
  if (!workflow) return { status: 'not_found', message: 'Original run record has no workflow name.' };

  const workflowEntry = listWorkflows().find((entry) => entry.data.name === workflow || entry.name === workflow);
  const workflowSlug = workflowEntry?.name ?? workflow;
  const allFailures = listFinalFailedItems(workflowSlug, originalRunId);
  const requestedStep = opts.stepId?.trim();
  const failures = requestedStep ? allFailures.filter((f) => f.stepId === requestedStep) : allFailures;
  if (failures.length === 0) {
    return {
      status: 'no_failed_items',
      message: requestedStep
        ? `Run "${originalRunId}" has no failed forEach items for step "${requestedStep}".`
        : `Run "${originalRunId}" has no failed forEach items to re-run.`,
    };
  }
  const stepIds = Array.from(new Set(failures.map((f) => f.stepId)));
  if (stepIds.length !== 1) {
    return {
      status: 'ambiguous',
      failedItems: failures.map(({ stepId, itemKey, error }) => ({ stepId, itemKey, error })),
      message:
        `Run "${originalRunId}" has failed items in more than one step: ${stepIds.join(', ')}. `
        + `Call again with stepId set to one of those steps so Clementine can re-run that fan-out safely.`,
    };
  }
  const stepId = stepIds[0];
  const inputs = normalizeWorkflowRunInputs(
    rec.inputs && typeof rec.inputs === 'object' && !Array.isArray(rec.inputs)
      ? (rec.inputs as Record<string, string>)
      : {},
  );
  const originSessionIds = opts.originSessionId || opts.originSessionIds
    ? normalizeOriginSessionIds(opts.originSessionId, opts.originSessionIds)
    : normalizeOriginSessionIds(rec.originSessionId, rec.originSessionIds);
  const queued = queueWorkflowRun(workflow, inputs, {
    originSessionId: originSessionIds[0],
    originSessionIds,
    selfHealAttempt: opts.selfHealAttempt,
    goalAttempt: opts.goalAttempt,
    goalFeedback: opts.goalFeedback,
    excludeRunId: originalRunId,
    retryFailedItems: {
      fromRunId: originalRunId,
      stepId,
      itemKeys: failures.map((f) => f.itemKey),
    },
  });
  const failedItems = failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error }));
  return {
    status: queued.status,
    id: queued.id,
    failedItems,
    message: queued.status === 'queued'
      ? `Queued failed-item retry for "${workflow}" step "${stepId}" (${failedItems.length} item${failedItems.length === 1 ? '' : 's'}) as run ${queued.id}. It will reuse completed upstream work and reprocess only the failed items.`
      : queued.message,
  };
}
