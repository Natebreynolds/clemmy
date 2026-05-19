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
import { HarnessSession } from '../runtime/harness/session.js';
import { runConversation, runConversationFromResume } from '../runtime/harness/loop.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';

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

// Per-step wall-clock budget. forEach items use the same per-call cap
// (each item is its own assistant call) and the surrounding step gets
// the cap multiplied by item count, capped by RUNNER_CONCURRENCY — but
// we just hand each invocation the same value and let the runtime
// abort individual stuck items. Synthesis sees a smaller cap because
// it should be a tight rollup, not exploration.
const WORKFLOW_STEP_WALL_CLOCK_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_STEP_WALL_MS ?? `${15 * 60_000}`, 10);
const WORKFLOW_SYNTHESIS_WALL_CLOCK_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_SYNTHESIS_WALL_MS ?? `${5 * 60_000}`, 10);

// Workflow run heartbeats — same pattern as cron. A 30-min fan-out
// over 50 items shouldn't go silent between "started" and "completed".
const WORKFLOW_HEARTBEAT_FIRST_MS = 5 * 60_000;
const WORKFLOW_HEARTBEAT_INTERVAL_MS = 10 * 60_000;

function startWorkflowHeartbeat(workflowName: string, runId: string, startMs: number): () => void {
  let count = 0;
  const fire = () => {
    count += 1;
    const elapsedMin = Math.max(1, Math.round((Date.now() - startMs) / 60_000));
    addNotification({
      id: `workflow-heartbeat-${runId}-${count}`,
      kind: 'workflow',
      title: `Workflow still running: ${workflowName}`,
      body: `Run ${runId} has been working for ${elapsedMin} min. Will notify on completion or failure. Open Console → Activity for live status.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { workflow: workflowName, runId, heartbeat: true, elapsedMin },
    });
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    fire();
    interval = setInterval(fire, WORKFLOW_HEARTBEAT_INTERVAL_MS);
    interval.unref?.();
  }, WORKFLOW_HEARTBEAT_FIRST_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

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
  // Shared accumulator for per-item forEach failures so the surrounding
  // workflow run can surface "completed with N/M failures" instead of
  // reporting an all-green success when fan-out items quietly errored.
  forEachFailures: Array<{ stepId: string; itemKey: string; error: string }>;
}

/**
 * T-WF-1/2: run a workflow step through the harness loop instead of
 * the legacy `assistant.respond()` path.
 *
 * Why this exists: the old path goes through `assistant.respond` →
 * `CodexNativeRuntime.run` → the OLD `ApprovalStore` (UUID-style ids,
 * not surfaced to the user). When a step needed approval (`sf` shell,
 * `composio_execute_tool`, anything with side effects), the runtime
 * paused, the step returned the ASSISTANT_PAUSED_PLACEHOLDER, and the
 * workflow runner happily moved on with the placeholder as the "step
 * output." Downstream steps got garbage. Observed live in run
 * 1779207370680-18e60f: all 5 steps "completed" but only the final
 * step generated any real work; the rest had no Salesforce data /
 * sheet writes / drafts.
 *
 * New path: every step is a full harness conversation. The harness
 * owns the addressable approval registry (apr-xxxx), runtime.failed
 * action-bus events, and the runConversationFromResume entry point.
 * When the step pauses on approval, the workflow runner waits — by
 * polling `pending_approvals` table — until the user approves OR the
 * approval expires (TTL is per-row, default 24h). On approve, the
 * runner calls runConversationFromResume; the next loop iteration
 * either completes or pauses again on the next interrupted tool.
 *
 * Gated behind `WORKFLOW_USE_HARNESS=on` so legacy workflows that
 * relied on the old quasi-broken behavior aren't surprised.
 */
const WORKFLOW_HARNESS_POLL_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS ?? '5000', 10,
);
// 24h aligns with approval-registry's DEFAULT_APPROVAL_TTL_MS so the workflow
// step waits exactly as long as the approval itself is alive. The reaper will
// expire the approval at 24h; we time out the workflow step on the same beat.
const WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS ?? `${24 * 60 * 60_000}`, 10,
);

function workflowHarnessEnabled(step: WorkflowStepInput): boolean {
  // Per-step opt-in OR global flag. Default: opt-in only.
  if ((step as unknown as { useHarness?: boolean }).useHarness === true) return true;
  return process.env.WORKFLOW_USE_HARNESS === 'on';
}

interface HarnessStepResult {
  output: string;
  /** True if any pauses-and-resumes happened during the step. */
  hadApprovals: boolean;
  approvalIds: string[];
}

async function runStepViaHarness(
  step: WorkflowStepInput,
  sessionIdSuffix: string,
  promptBody: string,
  workflowName: string,
): Promise<HarnessStepResult> {
  // T-WF-1 — configure the codex OAuth bridge BEFORE the SDK runner
  // touches the model. Discord + chat-dock paths do this at every
  // entry; the workflow runner is a fresh entry too and the codex
  // model provider is registered lazily — without this, the first
  // model call inside runConversation fails with "Missing credentials.
  // Please pass an `apiKey`".
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    throw new Error(
      `Codex auth not configured for workflow step "${step.id}": ${auth.reason ?? 'unknown'}`,
    );
  }
  // Create a per-step harness session. The session id is namespaced
  // by workflow run + step id so resume across daemon restarts is
  // possible (the registry rows survive; the session row survives;
  // the next runner can pick up).
  const sessionId = `workflow:${sessionIdSuffix}`;
  const session = HarnessSession.create({
    kind: 'workflow',
    channel: 'workflow',
    title: `${workflowName}::${step.id}`,
    metadata: {
      source: 'workflow',
      workflowName,
      stepId: step.id,
    },
  });
  // ↑ HarnessSession.create generates its own session.id; we use that
  // rather than the suffix-derived one. The suffix is informational.
  const realSessionId = session.id;

  const approvalIds: string[] = [];
  let hadApprovals = false;
  const startedAt = Date.now();

  // Build a fresh orchestrator each call so it picks up current memory
  // context + connected toolkit list.
  const agent = await buildOrchestratorAgent();

  // Initial turn.
  const message = `Workflow: ${workflowName}\nStep: ${step.id}\n\n${promptBody}`;
  let result = await runConversation({
    agent,
    sessionId: realSessionId,
    input: message,
  });

  // Loop until terminal (completed / failed / awaiting_user_input).
  while (result.status === 'awaiting_approval') {
    hadApprovals = true;
    if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
      throw new Error(
        `workflow step "${step.id}" timed out waiting for approval after ${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS / 1000}s`,
      );
    }

    // Find the pending registry row(s) for this session and surface a
    // user notification. The harness already registered the approval
    // via registerAndEmitApprovals on the SDK interrupt; here we
    // re-post a Discord-friendly nudge so the user sees the apr-xxxx
    // code from their main channel, not just the audit log.
    const pending = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
    for (const row of pending) {
      if (!approvalIds.includes(row.approvalId)) {
        approvalIds.push(row.approvalId);
        try {
          addNotification({
            id: `wf-approval-${row.approvalId}-${Date.now()}`,
            kind: 'approval',
            title: `Workflow ${workflowName} · ${step.id} needs approval`,
            body: `**${row.subject}**\n\nReply \`approve ${row.approvalId}\` (or \`reject ${row.approvalId}\`) to continue. The workflow is parked on step \`${step.id}\` until you respond.`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: {
              approvalId: row.approvalId,
              sessionId: realSessionId,
              subject: row.subject,
              tool: row.tool,
              workflowName,
              stepId: step.id,
            },
          });
        } catch {
          /* notification is best-effort; the apr-xxxx is still
             discoverable via the dashboard + sessions table */
        }
      }
    }

    // Poll for resolution. The reaper might expire stale rows; the
    // user might approve/reject; or all pending rows might clear via
    // a /cancel command. Loop until the session has no more pending.
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, WORKFLOW_HARNESS_POLL_MS));
      const stillPending = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
      if (stillPending.length === 0) break;
      if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
        throw new Error(
          `workflow step "${step.id}" exceeded approval wait budget (${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS}ms)`,
        );
      }
    }

    // At this point at least one approval has been resolved. The most
    // recent resolution defines whether we approve or reject the SDK
    // interrupt — if any was rejected/cancelled, we reject; otherwise
    // approve. Mirror the same channel-side logic from
    // tryHandleHarnessApprovalReply.
    const resolved = approvalRegistry.listPending({ sessionId: realSessionId, status: 'any' });
    const anyRejected = resolved.some((r) => r.resolution === 'rejected' || r.resolution === 'cancelled_by_user');
    const anyExpired = resolved.some((r) => r.resolution === 'expired');
    const decision: 'approve' | 'reject' = (anyRejected || anyExpired) ? 'reject' : 'approve';

    result = await runConversationFromResume({
      agent,
      sessionId: realSessionId,
      decision,
    });
  }

  if (result.status === 'failed') {
    throw new Error(
      `workflow step "${step.id}" failed via harness: ${result.error ?? 'unknown error'}`,
    );
  }

  // Pull the user-visible output from the most recent
  // conversation_completed event for this session. The harness writes
  // `summary` (or `reply` when present) as the user-facing text.
  const { listEvents: listHarnessEvents } = await import('../runtime/harness/eventlog.js');
  const completed = listHarnessEvents(realSessionId, { types: ['conversation_completed'] });
  const lastCompletion = completed[completed.length - 1];
  const lastDecision = result.lastDecision;
  const output = (lastDecision?.reply && lastDecision.reply.trim())
    || (lastDecision?.summary)
    || (lastCompletion?.data?.summary as string | undefined)
    || '';

  return { output, hadApprovals, approvalIds };
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
          maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
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
    // Record failures on the shared accumulator so the outer run
    // notification can flag partial-success runs that previously read
    // as "completed" with no hint that items dropped.
    for (let i = 0; i < itemResults.length; i++) {
      const r = itemResults[i];
      if (r.ok) continue;
      const key = itemKey(items[i], i);
      ctx.forEachFailures.push({ stepId: step.id, itemKey: key, error: r.error });
    }
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_completed',
      stepId: step.id,
      output: aggregate,
      meta: { mode: 'forEach', completed: successes.length, failed },
    });
    return aggregate;
  }

  // 3. Plain LLM step. Two paths:
  //   - HARNESS path (T-WF-1/2): use runConversation, wait for any
  //     pending approvals, surface a Discord notification with the
  //     apr-xxxx code. Real tool outputs flow into stepOutputs.
  //   - LEGACY path: original assistant.respond — preserved for
  //     workflows authored before the harness existed.
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_started',
    stepId: step.id,
  });
  const prompt = renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs);
  let output: string;
  if (workflowHarnessEnabled(step)) {
    try {
      const result = await runStepViaHarness(
        step,
        `${ctx.runId}:${step.id}`,
        prompt,
        ctx.workflow.name,
      );
      output = result.output;
      if (result.hadApprovals) {
        logger.info(
          { stepId: step.id, approvalIds: result.approvalIds, count: result.approvalIds.length },
          'workflow step paused on approvals and resumed',
        );
      }
    } catch (err) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } else {
    const response = await ctx.assistant.respond({
      sessionId: `workflow:${ctx.runId}:${step.id}`,
      channel: 'workflow',
      message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\n\n${prompt}`,
      model: step.model || MODELS.primary,
      maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
    });
    output = response.text;
  }
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_completed',
    stepId: step.id,
    output,
  });
  return output;
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
): Promise<{ finalOutput: string; forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> }> {
  const resume = computeResumeState(workflowSlug, runId);
  const stepOutputs: Record<string, unknown> = Object.fromEntries(resume.completedSteps);
  const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];

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
      workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems, forEachFailures,
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
      maxWallClockMs: WORKFLOW_SYNTHESIS_WALL_CLOCK_MS,
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
  return { finalOutput, forEachFailures };
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

    const stopHeartbeat = startWorkflowHeartbeat(workflow.data.name, run.id, Date.now());
    try {
      const { finalOutput, forEachFailures } = await executeWorkflow(workflow.data, workflow.name, run.id, inputs, assistant, run.targetStepId);
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
      // Partial-success surfacing: if any forEach items errored, lift
      // them into the user-visible notification so a "completed" run
      // can't masquerade as all-green when items quietly dropped.
      const hasFailures = forEachFailures.length > 0;
      const failureSummary = hasFailures
        ? `\n\n⚠️ ${forEachFailures.length} item${forEachFailures.length === 1 ? '' : 's'} failed:\n${forEachFailures
            .slice(0, 5)
            .map((f) => `- ${f.stepId} · ${f.itemKey}: ${f.error.slice(0, 200)}`)
            .join('\n')}${forEachFailures.length > 5 ? `\n(+${forEachFailures.length - 5} more)` : ''}`
        : '';
      addNotification({
        id: `${Date.now()}-workflow-${run.id}`,
        kind: 'workflow',
        title: hasFailures
          ? `Workflow completed with ${forEachFailures.length} failure${forEachFailures.length === 1 ? '' : 's'}: ${workflow.data.name}`
          : `Workflow completed: ${workflow.data.name}`,
        // Send the full body. Discord delivery splits long content into
        // multiple messages; previous 2000-char slice cut off workflow
        // results above that length with no continuation.
        body: `${finalOutput}${failureSummary}`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          workflow: workflow.data.name,
          runId: run.id,
          forEachFailures: hasFailures ? forEachFailures : undefined,
        },
      });
      logger.info({ workflow: workflow.data.name, runId: run.id, partialFailures: forEachFailures.length }, 'Workflow run completed');
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
    } finally {
      stopHeartbeat();
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
