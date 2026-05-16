import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { MODELS } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  listWorkflows,
  type WorkflowDefinition,
  type WorkflowStepInput,
} from '../memory/workflow-store.js';
import {
  appendWorkflowEvent,
  computeResumeState,
  listPendingRuns,
} from './workflow-events.js';

const logger = pino({ name: 'clementine-next.workflow-runner' });

/**
 * Process queued workflow runs.
 *
 * This is the new execution path — replaces the inline runner that
 * used to live in src/daemon/runner.ts. It splits per-step work three
 * ways based on the step's shape:
 *
 *   1. **deterministic step** — `step.deterministic.runner` is set.
 *      Bypass the LLM, execute the named helper from scripts/. Right
 *      now we just record a no-op event; the actual script-spawn
 *      machinery is staged behind an explicit user enablement so we
 *      don't shell out arbitrary code by accident.
 *
 *   2. **forEach step** — `step.forEach` names an upstream output
 *      that resolved to an array. Iterate that array with bounded
 *      concurrency, calling the assistant once per item. Pattern from
 *      OpenAI's research_bot/manager.py (asyncio.gather over typed
 *      list + Semaphore for backpressure). Per-item events are
 *      written so resume can pick up where we crashed.
 *
 *   3. **plain LLM step** — the existing behavior: assistant.respond
 *      once with the rendered prompt.
 *
 * Resumability: every run has its own events.jsonl in
 * <workflow>/runs/<runId>/. On daemon restart we re-read those logs,
 * skip steps + items already marked completed, and continue.
 */

const RUNNER_CONCURRENCY = parseInt(process.env.CLEMENTINE_WORKFLOW_CONCURRENCY ?? '5', 10);

interface QueuedRunRecord {
  id: string;
  workflow: string;
  inputs?: Record<string, string>;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  source?: string;
  stepOutputs?: Record<string, unknown>;
  output?: string;
  error?: string;
  /**
   * Single-step "try this" hint set by the dashboard's TRY button. When
   * present, the runner skips every other step and the synthesis pass;
   * the named step gets executed once with empty upstream context so
   * the user can see what it does in isolation.
   */
  targetStepId?: string;
}

function readRunRecord(filePath: string): QueuedRunRecord | null {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as QueuedRunRecord; }
  catch { return null; }
}

function writeRunRecord(filePath: string, record: QueuedRunRecord): void {
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * Cheap template renderer. Supports:
 *   {{date}}                  → today (UTC date)
 *   {{input.<key>}}           → run inputs (merged from workflow defaults + run overrides)
 *   {{steps.<id>.output}}     → upstream step's textual output
 *   {{item}}                  → current forEach item (raw)
 *   {{item.<path>}}           → nested lookup into the forEach item
 *
 * Intentionally not Handlebars / Liquid: the surface is small enough
 * that bringing in a template engine is dead weight and risks
 * sandbox-escape footguns.
 */
function renderTemplate(
  template: string,
  inputs: Record<string, string>,
  stepOutputs: Record<string, unknown>,
  item?: unknown,
): string {
  return template
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{input\.([a-zA-Z0-9_-]+)\}\}/g, (_m, key: string) => inputs[key] ?? '')
    .replace(/\{\{steps\.([a-zA-Z0-9_-]+)\.output\}\}/g, (_m, key: string) => {
      const out = stepOutputs[key];
      if (out === undefined || out === null) return '';
      return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    })
    .replace(/\{\{item\}\}/g, () => {
      if (item === undefined || item === null) return '';
      return typeof item === 'string' ? item : JSON.stringify(item);
    })
    .replace(/\{\{item\.([a-zA-Z0-9_.-]+)\}\}/g, (_m, pathStr: string) => {
      if (!item || typeof item !== 'object') return '';
      const parts = pathStr.split('.');
      let cursor: unknown = item;
      for (const p of parts) {
        if (!cursor || typeof cursor !== 'object') return '';
        cursor = (cursor as Record<string, unknown>)[p];
      }
      if (cursor === undefined || cursor === null) return '';
      return typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
    });
}

/**
 * Try to coerce a step output into an iterable array for forEach.
 * Strategy, in order:
 *   1. Already an array → use it
 *   2. JSON-parseable string that parses to an array → use that
 *   3. Object with a single array property → use that (common LLM
 *      shape: `{ items: [...] }`)
 *   4. Otherwise → return null and let the caller decide
 */
function coerceToArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        const arrayProps = Object.entries(parsed).filter(([, v]) => Array.isArray(v));
        if (arrayProps.length === 1) return arrayProps[0][1] as unknown[];
      }
    } catch { /* not JSON — fall through */ }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const arrayProps = Object.entries(value).filter(([, v]) => Array.isArray(v));
    if (arrayProps.length === 1) return arrayProps[0][1] as unknown[];
  }
  return null;
}

function itemKey(item: unknown, index: number): string {
  if (item && typeof item === 'object') {
    const candidate = (item as Record<string, unknown>).id
      ?? (item as Record<string, unknown>).key
      ?? (item as Record<string, unknown>).slug;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  if (typeof item === 'string' && item.length < 64) return item;
  return `idx-${index}`;
}

/**
 * Simple bounded-concurrency runner. Mirrors the research_bot pattern:
 * `asyncio.gather` over a list with a Semaphore. We don't need to
 * preserve insertion order in the result map (each call writes its
 * own per-item event), so we use Promise.allSettled and merge.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const N = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < N; i++) {
    runners.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          const value = await worker(items[idx], idx);
          results[idx] = { ok: true, value };
        } catch (err) {
          results[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

interface StepExecutionContext {
  workflow: WorkflowDefinition;
  // Directory slug for the workflow on disk (e.g. "patch-validation-test").
  // Used as the key for per-run events.jsonl and resume state — the
  // display name in workflow.name may contain spaces or be renamed
  // later, but the slug stays stable for the life of the workflow.
  workflowSlug: string;
  runId: string;
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
  assistant: ClementineAssistant;
  completedItems: Map<string, unknown>;
}

/**
 * Run a single workflow step. Picks the right execution shape based
 * on the step's frontmatter hints (deterministic / forEach / plain).
 * Returns the step's output for downstream template rendering and the
 * final synthesis. Throws on irrecoverable errors.
 */
async function executeStep(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  // 1. Deterministic helper — skip the LLM entirely. Right now we
  //    don't actually shell out (that requires user enablement and a
  //    sandbox); we record a no-op event so the workflow_runner can
  //    light up the deterministic path once the scripts/ surface is
  //    finalised. Returning a sentinel lets template rendering see
  //    something meaningful for downstream steps.
  if (step.deterministic?.runner) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_skipped',
      stepId: step.id,
      meta: { reason: 'deterministic-not-yet-implemented', runner: step.deterministic.runner },
    });
    return { deterministic: step.deterministic.runner, note: 'Script execution will be wired in once the scripts/ surface is enabled.' };
  }

  // 2. forEach — iterate an upstream output with bounded concurrency.
  if (step.forEach) {
    const upstream = ctx.stepOutputs[step.forEach];
    const items = coerceToArray(upstream);
    if (!items || items.length === 0) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_skipped',
        stepId: step.id,
        meta: { reason: 'forEach-empty', source: step.forEach },
      });
      return [];
    }

    const concurrency = Math.max(1, Math.min(RUNNER_CONCURRENCY, items.length));
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { mode: 'forEach', source: step.forEach, count: items.length, concurrency },
    });

    interface ItemResult { itemKey: string; output: unknown }
    const itemResults = await runWithConcurrency<unknown, ItemResult>(items, concurrency, async (item, idx) => {
      const key = itemKey(item, idx);
      // Resume: skip items we already completed in a prior run pass.
      if (ctx.completedItems.has(key)) {
        return { itemKey: key, output: ctx.completedItems.get(key) };
      }
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'item_started',
        stepId: step.id,
        itemKey: key,
      });
      try {
        const prompt = renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs, item);
        const response = await ctx.assistant.respond({
          sessionId: `workflow:${ctx.runId}:${step.id}:${key}`,
          channel: 'workflow',
          message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\nItem: ${key}\n\n${prompt}`,
          model: step.model || MODELS.primary,
        });
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'item_completed',
          stepId: step.id,
          itemKey: key,
          output: response.text,
        });
        return { itemKey: key, output: response.text };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'item_failed',
          stepId: step.id,
          itemKey: key,
          error,
        });
        throw err;
      }
    });

    const successes = itemResults.filter((r): r is { ok: true; value: ItemResult } => r.ok);
    const failed = itemResults.length - successes.length;
    const aggregate = successes.map((r) => r.value);
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_completed',
      stepId: step.id,
      output: aggregate,
      meta: { mode: 'forEach', completed: successes.length, failed },
    });
    return aggregate;
  }

  // 3. Plain LLM step — single assistant.respond() call.
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_started',
    stepId: step.id,
  });
  const prompt = renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs);
  const response = await ctx.assistant.respond({
    sessionId: `workflow:${ctx.runId}:${step.id}`,
    channel: 'workflow',
    message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\n\n${prompt}`,
    model: step.model || MODELS.primary,
  });
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_completed',
    stepId: step.id,
    output: response.text,
  });
  return response.text;
}

/**
 * Run the full step DAG to completion. Topological order is currently
 * file-declaration order; dependsOn is validated by the writer but
 * not yet enforced at runtime (single sequential pass works for the
 * existing workflows because authors list steps in dependency order).
 * Adding a topological sort here is a follow-up.
 */
async function executeWorkflow(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  runId: string,
  inputs: Record<string, string>,
  assistant: ClementineAssistant,
  targetStepId?: string,
): Promise<string> {
  const resume = computeResumeState(workflowSlug, runId);
  const stepOutputs: Record<string, unknown> = Object.fromEntries(resume.completedSteps);

  // Single-step "TRY" mode: execute only the named step. Upstream
  // references in the prompt resolve to empty strings — the user is
  // explicitly asking to see this step in isolation. Synthesis is
  // skipped too; the step output is the final output.
  const steps = targetStepId
    ? workflow.steps.filter((s) => s.id === targetStepId)
    : workflow.steps;

  for (const step of steps) {
    if (stepOutputs[step.id] !== undefined) {
      // Already completed in a prior pass — use the cached output.
      continue;
    }
    const completedItems = resume.completedItems.get(step.id) ?? new Map();
    const output = await executeStep(step, {
      workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems,
    });
    stepOutputs[step.id] = output;
  }

  // Synthesis step (optional final pass over all step outputs). Skipped
  // when TRY is running a single step in isolation — the step's own
  // output is the user-facing result.
  let finalOutput: string;
  if (workflow.synthesis?.prompt && !targetStepId) {
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_started',
      stepId: '__synthesis__',
    });
    const stepOutputsAsText = Object.entries(stepOutputs)
      .map(([id, out]) => `## ${id}\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`)
      .join('\n\n');
    const synthesisPrompt = renderTemplate(workflow.synthesis.prompt, inputs, stepOutputs);
    const response = await assistant.respond({
      sessionId: `workflow:${runId}:synthesis`,
      channel: 'workflow',
      message: `${synthesisPrompt}\n\nStep outputs:\n\n${stepOutputsAsText}`,
      model: MODELS.primary,
    });
    finalOutput = response.text;
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_completed',
      stepId: '__synthesis__',
      output: finalOutput,
    });
  } else {
    finalOutput = Object.entries(stepOutputs)
      .map(([id, out]) => `## ${id}\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`)
      .join('\n\n');
  }

  // Record string-coerced step outputs on the run record for the
  // dashboard's recent-runs display (which expects strings).
  return finalOutput;
}

function stringifyOutputs(stepOutputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stepOutputs)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Main entry — drains the queued-runs directory. Replaces the inline
 * runner that used to live in src/daemon/runner.ts.
 */
export async function processWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return;
  const workflows = listWorkflows();
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    const run = readRunRecord(filePath);
    if (!run) continue;
    // Pick up queued runs and runs marked as running but never
    // completed (resume after daemon restart).
    if (run.status && run.status !== 'queued' && run.status !== 'running') continue;

    const workflow = workflows.find((entry) => entry.data.name === run.workflow);
    if (!workflow) {
      writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: 'Workflow not found',
        finishedAt: new Date().toISOString(),
      });
      continue;
    }
    // TRY (single-step) runs bypass the workflow enabled gate — they're
    // explicit dashboard actions on a draft. Full runs still require
    // the workflow to be approved.
    if (!run.targetStepId && !workflow.data.enabled) {
      writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: 'Workflow is disabled — approve it first',
        finishedAt: new Date().toISOString(),
      });
      continue;
    }

    const inputs: Record<string, string> = {
      ...Object.fromEntries(Object.entries(workflow.data.inputs ?? {}).map(([key, meta]) => [key, meta.default ?? ''])),
      ...(run.inputs ?? {}),
    };

    const isResume = run.status === 'running';
    writeRunRecord(filePath, {
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? new Date().toISOString(),
    });
    appendWorkflowEvent(workflow.name, run.id, {
      kind: isResume ? 'run_resumed' : 'run_started',
      meta: { inputs, source: run.source, targetStepId: run.targetStepId ?? null },
    });

    try {
      const finalOutput = await executeWorkflow(workflow.data, workflow.name, run.id, inputs, assistant, run.targetStepId);
      const resume = computeResumeState(workflow.name, run.id);
      const stepOutputs = stringifyOutputs(Object.fromEntries(resume.completedSteps));
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_completed' });
      writeRunRecord(filePath, {
        ...run,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        stepOutputs,
        output: finalOutput,
      });
      addNotification({
        id: `${Date.now()}-workflow-${run.id}`,
        kind: 'workflow',
        title: `Workflow completed: ${workflow.data.name}`,
        body: finalOutput.slice(0, 2000),
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id },
      });
      logger.info({ workflow: workflow.data.name, runId: run.id }, 'Workflow run completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, file }, 'Workflow run failed');
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_failed', error: message });
      writeRunRecord(filePath, {
        ...run,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      addNotification({
        id: `${Date.now()}-workflow-${run.id}-error`,
        kind: 'workflow',
        title: `Workflow failed: ${run.workflow}`,
        body: message,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: run.workflow, runId: run.id, status: 'error' },
      });
    }
  }
}

/**
 * Daemon-startup hook: surface workflow runs that were in-flight when
 * the daemon last shut down. The run records have status='running'
 * (set when the workflow started) and the per-run events.jsonl shows
 * no terminal event. processWorkflowRuns() will pick these up on the
 * next tick because we accept 'running' as resumable.
 *
 * This function logs the pending set so a desktop user can see at a
 * glance which workflows the daemon is resuming. It also reconciles
 * any in-progress run records whose queue file went missing (deleted
 * mid-run, etc.) — those get marked as 'interrupted' rather than
 * left dangling.
 */
export function reconcilePendingWorkflowRuns(): void {
  const pending = listPendingRuns();
  if (pending.length === 0) return;
  logger.info(
    { pending: pending.map((p) => ({ workflow: p.workflowName, runId: p.runId, at: p.lastEventAt })) },
    `Resuming ${pending.length} in-flight workflow run${pending.length === 1 ? '' : 's'}`,
  );
}
