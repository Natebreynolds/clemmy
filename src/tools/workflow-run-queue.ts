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
export function queueWorkflowRun(name: string, normalizedInputs: Record<string, string>): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const duplicate = findDuplicateQueuedWorkflowRun(name, normalizedInputs);
  if (duplicate) {
    return {
      status: 'duplicate',
      id: duplicate.id,
      message: `Workflow "${name}" is already ${duplicate.status} as run ${duplicate.id} with the same inputs. No duplicate was queued. Use workflow_run_status with run_id="${duplicate.id}" to check progress.`,
    };
  }
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({
      id,
      workflow: name,
      inputs: normalizedInputs,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }, null, 2),
    'utf-8',
  );
  return { status: 'queued', id, message: `Queued workflow "${name}" (run ${id}).` };
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
export function resumeWorkflowRun(name: string, rawInputs: Record<string, string>): ResumeWorkflowRunResult {
  const workflow = listWorkflows().find((entry) => entry.data.name === name);
  if (!workflow) return { status: 'not_found', message: `Workflow "${name}" not found.` };
  if (!workflow.data.enabled) return { status: 'disabled', message: `Workflow "${name}" is disabled.` };
  const normalized = normalizeWorkflowRunInputs(rawInputs);
  const missing = missingWorkflowRunInputs(workflow.data, normalized);
  if (missing.length > 0) {
    return { status: 'missing_inputs', missing, message: `Still missing: ${missing.join(', ')}.` };
  }
  const queued = queueWorkflowRun(name, normalized);
  return { status: queued.status, id: queued.id, message: queued.message };
}
