import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from './shared.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from '../execution/workflow-inputs.js';

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
  /** Self-heal lineage: how many times this run has already been auto-healed +
   *  re-queued. Carried run→run so the runner can bound auto-heal attempts. */
  selfHealAttempt?: number;
}

export function queueWorkflowRun(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const duplicate = findDuplicateQueuedWorkflowRun(name, normalizedInputs);
  if (duplicate) {
    return {
      status: 'duplicate',
      id: duplicate.id,
      message: `Workflow "${name}" is already ${duplicate.status} as run ${duplicate.id} with the same inputs — it's running in the background and will report back here when it finishes. No duplicate was queued; just tell the user it's already on it. (Only call workflow_run_status if the user explicitly asks for a progress check.)`,
    };
  }
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const origin = opts?.originSessionId?.trim();
  const selfHealAttempt = typeof opts?.selfHealAttempt === 'number' && opts.selfHealAttempt > 0
    ? opts.selfHealAttempt
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
      ...(selfHealAttempt ? { selfHealAttempt } : {}),
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
  status: 'queued' | 'duplicate' | 'not_found';
  id?: string;
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
  let rec: { workflow?: unknown; inputs?: unknown; originSessionId?: unknown };
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as { workflow?: unknown; inputs?: unknown; originSessionId?: unknown };
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
  const originSessionId = opts.originSessionId
    ?? (typeof rec.originSessionId === 'string' ? rec.originSessionId : undefined);
  const queued = queueWorkflowRun(workflow, inputs, { originSessionId, selfHealAttempt: opts.selfHealAttempt });
  return { status: queued.status, id: queued.id, message: queued.message };
}
