import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { MODELS, getRuntimeEnv } from '../config.js';
import { runBoundedPool } from './bounded-pool.js';
import { bindStepInputs } from './step-binding.js';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { addRunEvent, startRun, finishRun } from '../runtime/run-events.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import {
  listWorkflows,
  type WorkflowDefinition,
  type WorkflowStepInput,
  type WorkflowStepOutputContract,
} from '../memory/workflow-store.js';
import { loadSkill } from '../memory/skill-store.js';
import {
  appendWorkflowEvent,
  computeResumeState,
  listPendingRuns,
  readWorkflowEvents,
  type WorkflowEvent,
} from './workflow-events.js';
import { HarnessSession } from '../runtime/harness/session.js';
import {
  runConversation,
  runConversationFromResume,
  type RunConversationResult,
} from '../runtime/harness/loop.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { buildWorkflowStepAgent } from '../agents/workflow-step-agent.js';
import {
  detectBlockedSteps,
  diagnoseWorkflowBlock,
  recordProposedFix,
  applyProposedFix,
  renderLegibleOutcome,
  renderSuccessBody,
  selfHealEnabled,
  type WorkflowDiagnosis,
  type ProposedFix,
  type BlockedStep,
} from './workflow-diagnosis.js';
import { requeueWorkflowFromRun } from '../tools/workflow-run-queue.js';
import { stepLooksLikeIrreversibleSend } from './workflow-enforce.js';
import { takeStepResult } from '../tools/step-result-tool.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import { closePlanScope, openPlanScope } from '../agents/plan-scope.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from './workflow-inputs.js';
import { verifyStepOutput } from './step-output-verify.js';
import { judgeWorkflowTarget, type WorkflowTargetVerdict } from './workflow-objective-judge.js';
import { judgeStepSkillExecution } from './workflow-step-judge.js';
import { SessionStore } from '../memory/session-store.js';
import { reportedBackRunIdsFrom } from './workflow-watchdog.js';

const logger = pino({ name: 'clementine-next.workflow-runner' });

/**
 * Decide whether the runner's SUCCESS completion notification should be
 * recorded dashboard-only (silent) instead of delivered. A self-notifying
 * workflow (a step that called notify_user) already surfaced a user-facing
 * message for this run; delivering the runner completion too would double-post
 * to Discord. Correlation is strictly by runId (race-safe across concurrent
 * drains). A needs-attention run ALWAYS delivers — reports-back is never silenced.
 */
export function shouldSilenceCompletionEcho(opts: {
  needsAttention: boolean;
  runId: string;
  notifications: Array<{ metadata?: Record<string, unknown> }>;
}): boolean {
  if (opts.needsAttention) return false;
  return opts.notifications.some(
    (n) =>
      n.metadata?.source === 'notify_user_tool' &&
      n.metadata?.workflowRunId === opts.runId,
  );
}

/**
 * Process queued workflow runs.
 *
 * This is the new execution path — replaces the inline runner that
 * used to live in src/daemon/runner.ts. It splits per-step work three
 * ways based on the step's shape:
 *
 *   1. **deterministic step** — `step.deterministic.runner` is set.
 *      Bypass the LLM and execute a named helper from this workflow's
 *      scripts/ directory with structured JSON on stdin. The runner is
 *      constrained to bundled scripts so imported frameworks can use
 *      deterministic helpers without opening a generic shell surface.
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
const WORKFLOW_DETERMINISTIC_TIMEOUT_MS = parseInt(process.env.CLEMENTINE_WORKFLOW_DETERMINISTIC_TIMEOUT_MS ?? `${5 * 60_000}`, 10);

// Workflow run heartbeats — same pattern as cron. A 30-min fan-out
// over 50 items shouldn't go silent between "started" and "completed".
const WORKFLOW_HEARTBEAT_FIRST_MS = 5 * 60_000;
const WORKFLOW_HEARTBEAT_INTERVAL_MS = 10 * 60_000;

/**
 * Module-level set of workflow run IDs that are currently parked on a
 * human approval. The deep approval loop in `runStepViaHarness`
 * adds the runId on entry and removes it on exit; the top-level
 * heartbeat checks this set each tick and stays silent while the run
 * is parked. Avoids prop-drilling state through 4 function layers
 * (runQueuedWorkflow → executeWorkflow → executeStep → runStepViaHarness).
 * Without this gate, a workflow waiting 20 min for a human to click
 * Approve fired "still running" notifications every 10 min — confusing
 * because the workflow wasn't running, it was parked (seen 2026-05-21
 * with daily-prospect-outreach).
 */
const runsParkedOnApproval = new Set<string>();

/**
 * Current-step tracker per active workflow run. The for-step loop in
 * executeWorkflow updates this before each executeStep call so the
 * heartbeat can say "step 5 of 9 · enrich_missing_seo_once" instead of
 * the previous generic "still running" — which left users staring at a
 * 5-minute-old message with no signal whether the workflow was making
 * progress or stuck. Cleared on workflow completion/failure.
 */
const runCurrentStep = new Map<string, { stepId: string; index: number; total: number }>();

export function setWorkflowRunCurrentStep(
  runId: string,
  step: { stepId: string; index: number; total: number },
): void {
  runCurrentStep.set(runId, step);
}

export function clearWorkflowRunCurrentStep(runId: string): void {
  runCurrentStep.delete(runId);
}

export function markWorkflowRunPausedForApproval(runId: string): void {
  runsParkedOnApproval.add(runId);
}

export function clearWorkflowRunPausedForApproval(runId: string): void {
  runsParkedOnApproval.delete(runId);
}

function startWorkflowHeartbeat(
  workflowName: string,
  runId: string,
  startMs: number,
): () => void {
  let count = 0;
  const fire = () => {
    // Suppress heartbeat while parked on an approval. The workflow run
    // is *waiting* on a human, not doing work; "still running" is the
    // wrong status copy and conditions the user to ignore the channel.
    if (runsParkedOnApproval.has(runId)) return;
    count += 1;
    const elapsedMin = Math.max(1, Math.round((Date.now() - startMs) / 60_000));
    // v0.5.6: enrich the heartbeat with current step context so the
    // user knows what's happening, not just that something is. Falls
    // back to the old generic message when the step tracker is empty
    // (e.g. during the synthesis pass or post-step cleanup).
    const cur = runCurrentStep.get(runId);
    const stepLabel = cur ? ` · step ${cur.index} of ${cur.total} · ${cur.stepId}` : '';
    const stepBody = cur ? `Currently: \`${cur.stepId}\` (step ${cur.index}/${cur.total}). ` : '';
    addNotification({
      id: `workflow-heartbeat-${runId}-${count}`,
      kind: 'workflow',
      title: `Workflow still running: ${workflowName}${stepLabel}`,
      body: `${stepBody}Run ${runId} has been working for ${elapsedMin} min. Will notify on completion or failure. Open Console → Activity for live status.`,
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
  /**
   * Gap E — chat re-entry. Set ONLY when a workflow run was triggered from a
   * chat/agent session that should hear the outcome in-context. On a terminal
   * state the runner appends a synthetic turn to this session (mirrors
   * background-task report-back). Absent for scheduled/cron/dashboard/webhook
   * runs → those stay notification-only (the global notification still fires
   * for ALL runs regardless).
   */
  originSessionId?: string;
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
  /**
   * Self-heal: a run can "complete" with steps that cleanly blocked. These
   * mark it as needing attention and link the proposed fix (if diagnosed).
   */
  needsAttention?: boolean;
  blockedSteps?: Array<{ stepId: string; reason: string }>;
  proposedFixId?: string | null;
  /**
   * Bounded autonomous self-heal: how many times this run has already been
   * auto-healed (a safe edit_step fix applied) + re-queued. Carried run→run via
   * requeueWorkflowFromRun so the runner can stop after
   * CLEMENTINE_WORKFLOW_SELF_HEAL_MAX_ATTEMPTS and escalate instead of looping.
   */
  selfHealAttempt?: number;
  /**
   * P0 event-driven approval parking (flag WORKFLOW_APPROVAL_PARKING).
   * When a step pauses on a human approval, the runner records the
   * resume coordinates here, sets status='parked', and RETURNS — freeing
   * the bounded-pool slot instead of holding it through the (up-to-24h)
   * approval wait. `reapResolvedParkedRuns` flips status back to
   * 'running' once every watched approval clears; the next drain pass
   * resumes from the parked step (no completed step re-runs — resume is
   * driven by events.jsonl / computeResumeState).
   */
  parked?: ParkedRunState;
  /**
   * Report-back backstop (north star: REPORTS BACK WITHOUT FAIL). Set
   * once the terminal (completed/error) user notification has been
   * delivered. A terminal run that reaches its finishedAt but never gets
   * this marker — because the process crashed between the status write and
   * the notify, or addNotification threw — is surfaced by the watchdog so
   * the result never dies silently.
   */
  notifiedAt?: string;
}

interface ParkedStepRef {
  stepId: string;
  /** 'gate' = declarative requiresApproval gate; 'sdk' = per-tool SDK interrupt. */
  kind: 'gate' | 'sdk';
  /** Approval rows this parked step waits on (watched by the reaper scan). */
  approvalIds: string[];
  /** SDK-interrupt sessions key by the deterministic harness session id. */
  sessionId?: string;
}

interface ParkedRunState {
  parkedSteps: ParkedStepRef[];
  parkedAt: string;
}

function readRunRecord(filePath: string): QueuedRunRecord | null {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as QueuedRunRecord; }
  catch { return null; }
}

/** A run fired by the TIME-BASED scheduler (no human present to approve). The
 *  legacy cron path and the workflow scheduler both stamp these sources. A
 *  manual/chat/dashboard run is NOT unattended (a person is there to approve). */
function isUnattendedScheduledRun(runId: string): boolean {
  const rec = readRunRecord(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`));
  return rec?.source === 'schedule' || rec?.source === 'cron';
}

function writeRunRecord(filePath: string, record: QueuedRunRecord): void {
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * Stamp `notifiedAt` on a terminal run AFTER its user notification has been
 * delivered. Call immediately after the terminal addNotification — if the
 * notify throws or the process dies before this runs, the marker stays unset
 * and the watchdog re-surfaces the run. Best-effort: a failed marker write is
 * the same failure mode the watchdog already covers, so never let it throw.
 */
function markRunNotified(filePath: string): void {
  try {
    const rec = readRunRecord(filePath);
    if (rec) writeRunRecord(filePath, { ...rec, notifiedAt: new Date().toISOString() });
  } catch { /* best-effort; watchdog backstops an unmarked terminal run */ }
}

class WorkflowRunCancelledError extends Error {
  constructor() {
    super('Workflow run cancelled by user.');
    this.name = 'WorkflowRunCancelledError';
  }
}

/**
 * Thrown when a step pauses on a human approval and parking is enabled.
 * Unwinds cleanly up to `processOneRunFile`, which checkpoints the run as
 * 'parked' and returns (releasing the bounded-pool slot) instead of
 * treating it as a failure. Carries the resume coordinates the reaper
 * scan needs to know which approvals to watch.
 */
class ParkRunSignal extends Error {
  readonly parkedSteps: ParkedStepRef[];
  constructor(parkedSteps: ParkedStepRef[]) {
    super('Workflow run parked on approval.');
    this.name = 'ParkRunSignal';
    this.parkedSteps = parkedSteps;
  }
}


/**
 * P0 flag: event-driven approval parking. Default OFF → the in-place
 * poll loop (today's exact behavior) holds the worker until the approval
 * resolves. ON → a parked step releases its slot and is resumed by the
 * reaper scan once the approval clears.
 */
function parkingEnabled(): boolean {
  return (getRuntimeEnv('WORKFLOW_APPROVAL_PARKING', 'off') ?? 'off').toLowerCase() === 'on';
}

function isWorkflowRunCancelled(runId: string): boolean {
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const record = readRunRecord(filePath);
  return record?.status === 'cancelled';
}

function throwIfWorkflowRunCancelled(runId: string): void {
  if (isWorkflowRunCancelled(runId)) throw new WorkflowRunCancelledError();
}

/**
 * Plain-language reason for a step that ended in any harness terminal status
 * OTHER than `completed`. A workflow step is only "done" when the harness
 * reports `completed`; every other terminal status means the step did NOT
 * finish its job and must be reported back honestly (north-star: reports back
 * without fail), never captured as prose-success. Exported for tests.
 */
export function describeStepNonCompletion(status: string, error?: string): string {
  if (error && error.trim()) return error.trim();
  switch (status) {
    case 'limit_exceeded':
      return 'the step hit a tool-call / loop guardrail or budget limit before finishing';
    case 'killed':
      return 'the step run was aborted before finishing';
    case 'awaiting_user_input':
      return 'the step is waiting for user input, which a background workflow cannot provide — make it a requiresApproval step or supply the value as an input';
    case 'failed':
      return 'the step failed with an unhandled error';
    default:
      return `the step ended in a non-completed state (${status})`;
  }
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
/**
 * When the step declares `usesSkill`, load the skill's SKILL.md body
 * and prepend it to the rendered prompt with explicit delimiters so the
 * model can distinguish HOW (the skill instructions) from WHAT (the
 * step task).
 *
 * FAIL LOUD (no silent downgrade): when a step declares `usesSkill` but the
 * skill isn't installed at run time, throw so the step fails with a clear
 * error and reports back — never run the raw prompt without the declared
 * instructions, which produces unpredictable output. Author/enable-time
 * `checkSkillReference` already blocks unknown skills at create/enable; this
 * closes the run-time window (skill removed or unsynced after authoring).
 */
export function applySkillToPrompt(step: WorkflowStepInput, rendered: string): string {
  const skillName = step.usesSkill?.trim();
  if (!skillName) return rendered;
  const skill = loadSkill(skillName);
  if (!skill) {
    logger.error({ stepId: step.id, usesSkill: skillName }, 'workflow step references skill that is not installed; failing step');
    throw new Error(
      `Step "${step.id}" declares usesSkill "${skillName}" but that skill is not installed `
      + '— refusing to run the step without its instructions. Install/sync the skill, or remove '
      + 'the usesSkill reference from the step.',
    );
  }
  const skillBody = (skill.body || '').trim();
  if (!skillBody) return rendered;
  return [
    `=== SKILL: ${skill.name} ===`,
    skill.frontmatter.description ? `Purpose: ${skill.frontmatter.description}` : '',
    '',
    skillBody,
    '=== END SKILL ===',
    '',
    // Same execution-contract framing skill_read applies in chat/workers, so a
    // workflow step that uses a skill RUNS it as a procedure rather than
    // treating it as background reading (global "run skills as designed" fix).
    'The skill above is a PROCEDURE to EXECUTE for this step — carry out every step it prescribes and produce every deliverable it specifies (the file, image, URL, record), not a description. Do not skip its phases. The step is complete only when the skill\'s deliverables actually exist.',
    '',
    '=== STEP TASK ===',
    rendered,
  ].filter(Boolean).join('\n');
}

/**
 * When a step declares an output contract, append an explicit instruction so
 * the step agent KNOWS the exact structured shape to emit — otherwise it
 * guesses and the deterministic verifier fails it after the fact (the live
 * "missing required output key" failure). Pairs with coerceOutputForContract
 * (parses a JSON-text emission) + verifyStepOutput (enforces it). No contract →
 * prompt unchanged. Exported for tests.
 */
export function applyContractToPrompt(step: WorkflowStepInput, rendered: string): string {
  const c = step.output;
  if (!c) return rendered;
  const keys = c.required_keys ?? [];
  if (keys.length === 0 && !c.verify && !c.type) return rendered;
  const lines: string[] = ['', '=== REQUIRED OUTPUT (this step is NOT complete until you return EXACTLY this) ==='];
  if (keys.length > 0) {
    lines.push(
      `Return your result as a JSON object with these EXACT top-level keys: ${keys.map((k) => `"${k}"`).join(', ')}.`,
      'Emit ONLY that JSON object as the step result (if a workflow_step_result tool is available, call it with this object) — no surrounding prose.',
    );
  } else if (c.type) {
    lines.push(`Return your result as type: ${c.type}.`);
  }
  if (c.verify?.url_present?.length) {
    lines.push(`These keys MUST hold a real, non-empty https:// URL (verified): ${c.verify.url_present.join(', ')}.`);
  }
  if (c.verify?.path_exists?.length) {
    lines.push(`These keys MUST hold a real, existing file path (verified): ${c.verify.path_exists.join(', ')}.`);
  }
  return [rendered, ...lines].join('\n');
}

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

interface DeterministicStepPayload {
  workflow: string;
  workflowSlug: string;
  runId: string;
  stepId: string;
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
}

function redactProcessOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 11)}...REDACTED`)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

function resolveDeterministicRunner(workflowSlug: string, runner: string): { command: string; args: string[]; cwd: string; target: string } {
  const raw = runner.trim();
  if (!raw) throw new Error('deterministic runner is empty');
  if (/\s/.test(raw)) {
    throw new Error('deterministic runner must be a script path under scripts/ without inline arguments');
  }
  if (path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    throw new Error('deterministic runner must stay inside the workflow scripts/ directory');
  }

  const workflowDir = path.resolve(WORKFLOWS_DIR, workflowSlug);
  const scriptsDir = path.resolve(workflowDir, 'scripts');
  const rel = raw.startsWith('scripts/') || raw.startsWith('scripts\\') ? raw : path.join('scripts', raw);
  const target = path.resolve(workflowDir, rel);
  if (target !== scriptsDir && !target.startsWith(`${scriptsDir}${path.sep}`)) {
    throw new Error('deterministic runner resolved outside scripts/');
  }
  if (!existsSync(target)) {
    throw new Error(`deterministic runner not found: ${rel}`);
  }

  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [target], cwd: workflowDir, target };
  }
  if (ext === '.py') {
    return { command: 'python3', args: [target], cwd: workflowDir, target };
  }
  if (ext === '.sh' || ext === '.bash') {
    return { command: 'bash', args: [target], cwd: workflowDir, target };
  }

  const mode = statSync(target).mode;
  if ((mode & 0o111) !== 0) {
    return { command: target, args: [], cwd: workflowDir, target };
  }
  throw new Error(`unsupported deterministic runner extension for ${rel}; use .js, .mjs, .cjs, .py, .sh, or an executable file`);
}

export async function runDeterministicWorkflowStepForTest(
  runner: string,
  payload: DeterministicStepPayload,
): Promise<unknown> {
  return runDeterministicWorkflowStep(runner, payload);
}

/**
 * Turn a raw child-process spawn failure into an actionable message.
 * The important case: on the PACKAGED macOS app, child scripts spawned
 * by the Electron daemon get EPERM on uv_cwd (TCC sandbox) — a cryptic
 * failure that looks like a bug. Name it so the user knows the fix is
 * entitlements, not the workflow. Pure + exported for tests.
 */
export function explainDeterministicSpawnError(err: unknown, target: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EPERM' || code === 'EACCES' || /\bEPERM\b|uv_cwd|operation not permitted/i.test(msg)) {
    return new Error(
      `deterministic runner could not launch (${code ?? 'permission denied'}): ${target}. ` +
      'On the packaged macOS app, child scripts are blocked by the app sandbox (TCC) until Clementine has ' +
      'filesystem entitlements / a launchd context. Run this workflow from the dev build, or grant the ' +
      `entitlement, then retry. (original: ${msg})`,
    );
  }
  if (code === 'ENOENT') {
    return new Error(
      `deterministic runner not launchable — interpreter or script missing for ${target}: ${msg}`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function runDeterministicWorkflowStep(
  runner: string,
  payload: DeterministicStepPayload,
): Promise<unknown> {
  const resolved = resolveDeterministicRunner(payload.workflowSlug, runner);
  const input = JSON.stringify(payload);
  const startedAt = Date.now();
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        CLEMENTINE_HOME: process.env.CLEMENTINE_HOME ?? '',
        CLEMENTINE_WORKFLOW_RUN_ID: payload.runId,
        CLEMENTINE_WORKFLOW_STEP_ID: payload.stepId,
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, WORKFLOW_DETERMINISTIC_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(explainDeterministicSpawnError(err, resolved.target));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const cleanStdout = redactProcessOutput(stdout.trim());
      const cleanStderr = redactProcessOutput(stderr.trim());
      if (timedOut) {
        reject(new Error(`deterministic runner timed out after ${WORKFLOW_DETERMINISTIC_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`deterministic runner failed (${signal ?? `exit ${code}`}): ${cleanStderr || cleanStdout || 'no output'}`));
        return;
      }
      logger.info({
        workflow: payload.workflow,
        runId: payload.runId,
        stepId: payload.stepId,
        runner,
        durationMs: Date.now() - startedAt,
      }, 'deterministic workflow step completed');
      if (!cleanStdout) {
        resolve({ ok: true, stdout: '', stderr: cleanStderr || undefined });
        return;
      }
      try {
        resolve(JSON.parse(cleanStdout));
      } catch {
        resolve(cleanStdout);
      }
    });
    child.stdin.end(input);
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
  // Shared accumulator for NON-FAILING quality advisories (skill-execution
  // judge misses). These NEVER fail a step or run — they ride along with the
  // delivered output as a "review this" heads-up so a confident-but-wrong
  // judge can never break a workflow that actually succeeded.
  qualityAdvisories: WorkflowQualityAdvisory[];
}

/** A non-blocking quality heads-up attached to a COMPLETED run. The deliverable
 *  is still produced + delivered; this only adds a "review this" note. */
export interface WorkflowQualityAdvisory {
  stepId: string;
  itemKey?: string;
  kind: 'skill_not_executed' | 'target_missed';
  note: string;
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
 * The harness is now the default workflow path. Set
 * WORKFLOW_USE_HARNESS=off or step.useHarness=false only for deliberate
 * legacy/simple text-only debugging.
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
  if ((step as unknown as { useHarness?: boolean }).useHarness === false) return false;
  return process.env.WORKFLOW_USE_HARNESS !== 'off';
}

function workflowAutoApprovalTools(workflow: WorkflowDefinition, step: WorkflowStepInput): string[] {
  if (step.allowedTools && step.allowedTools.length > 0) {
    return step.allowedTools;
  }

  const allowed = (workflow.allowedTools ?? [])
    .flatMap((tool) => {
      if (typeof tool === 'string') return [tool];
      if (!tool || typeof tool.name !== 'string') return [];
      return tool.approval === 'required' ? [] : [tool.name];
    })
    .filter((tool) => tool.trim().length > 0);

  // Enabled workflows are already user-approved automation. A wildcard
  // plan scope removes per-tool approval churn while the shared taxonomy
  // still gates admin/destructive calls before plan-scope is consulted.
  return allowed.length > 0 ? [...new Set(allowed)] : ['*'];
}

interface HarnessStepResult {
  /** Structured when the step emitted workflow_step_result; the agent's
   *  prose reply/summary otherwise (backward-compat fallback). */
  output: unknown;
  /** True if any pauses-and-resumes happened during the step. */
  hadApprovals: boolean;
  approvalIds: string[];
  /** True when `output` came from an explicit workflow_step_result call
   *  rather than the prose fallback (telemetry / migration signal). */
  usedStructuredResult?: boolean;
  /** The real harness session id the step ran in — used by the per-step
   *  skill-execution judge to read this step's tool-call evidence. */
  sessionId: string;
}

function workflowHarnessMetadataMatches(
  session: HarnessSession,
  workflowName: string,
  stepId: string,
): boolean {
  const metadata = session.sessionRow.metadata;
  return session.sessionRow.kind === 'workflow'
    && metadata.source === 'workflow'
    && metadata.workflowName === workflowName
    && metadata.stepId === stepId;
}

function findParkedWorkflowHarnessSession(
  workflowName: string,
  stepId: string,
  workflowRunId: string,
): HarnessSession | null {
  const pending = approvalRegistry.listPending({ status: 'pending' });
  let fallback: HarnessSession | null = null;

  for (const row of pending) {
    const session = HarnessSession.load(row.sessionId);
    if (!session || !workflowHarnessMetadataMatches(session, workflowName, stepId)) continue;

    const metadata = session.sessionRow.metadata;
    if (metadata.workflowRunId === workflowRunId) return session;

    // Sessions created before workflowRunId was persisted still need to
    // resume cleanly after a daemon restart. Pick the newest pending
    // legacy session as a fallback; listPending is ordered newest first.
    if (metadata.workflowRunId === undefined && fallback === null) {
      fallback = session;
    }
  }

  return fallback;
}

function getWorkflowHarnessSession(
  workflowName: string,
  stepId: string,
  workflowRunId: string,
  sessionIdSuffix: string,
): HarnessSession {
  const deterministicSessionId = `workflow:${sessionIdSuffix}`;
  const existing = HarnessSession.load(deterministicSessionId);
  if (existing) return existing;

  const parked = findParkedWorkflowHarnessSession(workflowName, stepId, workflowRunId);
  if (parked) return parked;

  return HarnessSession.create({
    id: deterministicSessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: `${workflowName}::${stepId}`,
    metadata: {
      source: 'workflow',
      workflowName,
      workflowRunId,
      stepId,
      sessionIdSuffix,
    },
  });
}

export const workflowRunnerInternalsForTest = {
  findParkedWorkflowHarnessSession,
  getWorkflowHarnessSession,
  awaitDeclarativeStepApproval,
  bindStepContext,
  renderStepContextBlock,
  hasCompletedUpstreamMutation: (steps: WorkflowStepInput[], blockedStepId: string, completedStepIds: Set<string>) =>
    hasCompletedUpstreamMutation(steps, blockedStepId, completedStepIds),
  tryAutoHealAndRequeue,
  selfHealAutoMaxAttempts,
};

async function runStepViaHarness(
  step: WorkflowStepInput,
  sessionIdSuffix: string,
  promptBody: string,
  workflowName: string,
  allowedTools: string[],
  workflowRunId: string,
  stepContext?: { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown },
  // P0 parking: true only at call sites where a thrown ParkRunSignal can
  // unwind to processOneRunFile (plain step + synthesis). forEach items
  // run inside a per-item try/catch that would swallow the signal as an
  // item failure, so those pass false and keep the in-place poll.
  canPark = false,
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
  // Per-step harness sessions must be stable across daemon restarts.
  // If the prior process parked on approval, reusing the same session
  // is what prevents a second approval from being minted for the same
  // workflow step.
  const session = getWorkflowHarnessSession(
    workflowName,
    step.id,
    workflowRunId,
    sessionIdSuffix,
  );
  const realSessionId = session.id;
  openPlanScope({
    sessionId: realSessionId,
    planProposalId: `workflow:${workflowName}:${sessionIdSuffix}`,
    approvedPlanObjective: `Approved workflow "${workflowName}" step "${step.id}"`,
    ttlMs: WORKFLOW_STEP_WALL_CLOCK_MS + 60_000,
    allowedTools,
  });

  const approvalIds: string[] = [];
  let hadApprovals = false;
  const startedAt = Date.now();

  try {
    // Build a fresh orchestrator each call so it picks up current memory
    // context + connected toolkit list.
    // Initial turn.
    const proseMessage = `Workflow: ${workflowName}\nStep: ${step.id}\n\n${promptBody}`;
    // Typed-contract delivery (P1): when the step declared inputs and the
    // contract flag + step agent are on, append the BOUND inputs/upstream
    // as a structured block AFTER the prose (never replacing it). This is
    // authoritative data the step can use even if a template token typo
    // dropped a value from the prose — it cannot be falsely starved.
    const message = useWorkflowStepAgent() && stepContext
      ? `${proseMessage}\n\n${renderStepContextBlock(stepContext)}`
      : proseMessage;
    // Flag-gated (WORKFLOW_STEP_AGENT): the constrained step agent emits
    // structured output via workflow_step_result and CANNOT re-trigger
    // workflows (no recursion). Default off → the full orchestrator +
    // prose capture, byte-identical to prior behavior.
    const agent = useWorkflowStepAgent()
      ? await buildWorkflowStepAgent({ userInput: message, sessionId: realSessionId, lockTools: step.allowedTools })
      : await buildOrchestratorAgent({ userInput: message, sessionId: realSessionId });
    let result: RunConversationResult;
    if (session.loadInterruptState() || approvalRegistry.hasPending(realSessionId)) {
      result = {
        sessionId: realSessionId,
        status: 'awaiting_approval',
        steps: 0,
        lastTurn: 0,
      };
    } else {
      result = await runConversation({
        agent,
        sessionId: realSessionId,
        input: message,
      });
    }

    // Loop until terminal (completed / failed / awaiting_user_input).
    while (result.status === 'awaiting_approval') {
      hadApprovals = true;
      // Tell the heartbeat we're parked — it'll suppress "still running"
      // notifications until we clear the flag below.
      markWorkflowRunPausedForApproval(workflowRunId);
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
              // Same stable ID as the harness approval notification.
              // addNotification dedupes by id, so workflow parking
              // enriches the dashboard/runtime state without creating
              // a second Discord/mobile card for the same decision.
              id: `approval-${row.approvalId}`,
              kind: 'approval',
              title: `Workflow ${workflowName} · ${step.id} needs approval`,
              body: `**${row.subject}**\n\nTap **Approve**, **Edit**, or **Reject** below — or reply \`approve ${row.approvalId}\` / \`reject ${row.approvalId}\` if you prefer. The workflow is parked on step \`${step.id}\` until you respond.`,
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

      // P0 parking (flag on + parkable call site): if approvals are still
      // pending, release the slot instead of polling — unwind via
      // ParkRunSignal; `reapResolvedParkedRuns` resumes this run once they
      // clear. On re-entry after resume the pending set is empty, so we
      // skip the poll and fall through to the decision + resume below.
      // Flag-off (or a non-parkable forEach item) keeps the in-place poll
      // byte-identical to today.
      const stillPendingNow = approvalRegistry.listPending({ sessionId: realSessionId, status: 'pending' });
      if (parkingEnabled() && canPark && stillPendingNow.length > 0) {
        throw new ParkRunSignal([{ stepId: step.id, kind: 'sdk', approvalIds: [...approvalIds], sessionId: realSessionId }]);
      }
      if (stillPendingNow.length > 0) {
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
        resolver: 'workflow-runner',
      });
      // Resume returned — the run is moving again. Clear the heartbeat
      // gate so the next "still running" interval can fire normally
      // (the loop will re-mark if another approval surfaces).
      clearWorkflowRunPausedForApproval(workflowRunId);
    }

    // Pull the user-visible output from the most recent
    // conversation_completed event for this session. The harness writes
    // `summary` (or `reply` when present) as the user-facing text.
    const { listEvents: listHarnessEvents } = await import('../runtime/harness/eventlog.js');
    const completed = listHarnessEvents(realSessionId, { types: ['conversation_completed'] });
    const lastCompletion = completed[completed.length - 1];
    const lastDecision = result.lastDecision;
    const prose = (lastDecision?.reply && lastDecision.reply.trim())
      || (lastDecision?.summary)
      || (lastCompletion?.data?.reply as string | undefined)
      || (lastCompletion?.data?.summary as string | undefined)
      || '';

    // The explicit structured result the step emitted via workflow_step_result
    // (captured full, unclipped, keyed by session). Taken once.
    const captured = takeStepResult(realSessionId);

    // A step is "done" only when the harness reports `completed`. The
    // awaiting_approval while-loop above guarantees a terminal status here.
    //   - `failed` = a real harness error → always throw (prior behavior).
    //   - A step that EXPLICITLY emitted its deliverable via
    //     workflow_step_result delivers it even on a SOFT non-completion
    //     (limit_exceeded / killed / awaiting_user_input): the step did its
    //     job and emitted the result before the limit/kill, so discarding that
    //     real partial would be a regression.
    //   - Otherwise (no explicit deliverable AND not `completed`) only the
    //     harness apology prose remains → throw so a guardrail-killed /
    //     limit-hit run can't masquerade as success. The throw unwinds to
    //     processOneRunFile, which classifies cancel-vs-error and reports back
    //     loudly (north-star: reports back without fail).
    if (result.status === 'failed') {
      throw new Error(
        `workflow step "${step.id}" failed via harness: ${result.error ?? describeStepNonCompletion('failed')}`,
      );
    }
    if (captured.found) {
      return { output: captured.value, hadApprovals, approvalIds, usedStructuredResult: true, sessionId: realSessionId };
    }
    if (result.status !== 'completed') {
      throw new Error(
        `workflow step "${step.id}" did not complete (status: ${result.status}): ${describeStepNonCompletion(result.status, result.error)}`,
      );
    }
    return { output: prose, hadApprovals, approvalIds, usedStructuredResult: false, sessionId: realSessionId };
  } finally {
    // Belt + suspenders: clear the heartbeat gate in finally so a throw
    // mid-resume doesn't leave the heartbeat permanently suppressed
    // for the rest of the workflow run.
    clearWorkflowRunPausedForApproval(workflowRunId);
    closePlanScope(realSessionId, 'workflow-step-finished');
  }
}

/**
 * Run a single workflow step. Picks the right execution shape based
 * on the step's frontmatter hints (deterministic / forEach / plain).
 * Returns the step's output for downstream template rendering and the
 * final synthesis. Throws on irrecoverable errors.
 */
/**
 * Declarative approval gate (autonomous-by-default workflow model). The
 * runner — not the agent — owns the pause: it registers ONE approval for
 * (runId, stepId), surfaces a single notification, and polls until the
 * user resolves it. Resume-safe: the registry row is keyed by a stable
 * gate session id, so a daemon restart re-finds the pending/resolved
 * approval instead of re-prompting. Approved → return (step proceeds);
 * rejected/expired → throw (the run fails loudly and reports back).
 */
async function awaitDeclarativeStepApproval(
  ctx: StepExecutionContext,
  step: WorkflowStepInput,
): Promise<void> {
  const gateSessionId = `workflow-gate:${ctx.runId}:${step.id}`;
  const startedAt = Date.now();

  const settledResolution = (): string | undefined =>
    approvalRegistry
      .listPending({ sessionId: gateSessionId, status: 'any' })
      .find((r) => r.resolution)?.resolution ?? undefined;

  // Already resolved on a prior pass (resume) — honor it without re-prompting.
  const prior = settledResolution();
  if (prior) {
    if (prior === 'approved') return;
    throw new Error(`workflow step "${step.id}" was not approved (${prior})`);
  }

  // Unattended scheduled run: there is no human at 8am to click "approve", so a
  // declarative gate would PARK FOREVER (deadlock) — the run never completes and
  // the daily promise silently fails. For a scheduler-fired run of an ENABLED
  // workflow, the human's consent WAS the enable + the schedule, so auto-approve
  // the gate (logged for audit) and proceed. Manual/chat/dashboard runs (a person
  // is present) still register the gate and wait, exactly as before.
  if (ctx.workflow.enabled !== false && isUnattendedScheduledRun(ctx.runId)) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { gate: 'auto_approved_unattended', reason: 'enabled scheduled run — consent was enable + schedule' },
    });
    logger.info(
      { workflow: ctx.workflow.name, runId: ctx.runId, step: step.id },
      'declarative approval gate auto-approved for unattended scheduled run (enable was the consent)',
    );
    return;
  }

  // Register the gate once (idempotent across resumes: only if none pending).
  const pending = approvalRegistry.listPending({ sessionId: gateSessionId, status: 'pending' });
  let row = pending[0];
  if (!row) {
    const subject = (step.approvalPreview && step.approvalPreview.trim())
      || `Approve "${ctx.workflow.name}" step "${step.id}" before it runs`;
    // The approvals table has `session_id REFERENCES sessions(id)` with
    // foreign_keys=ON, so a gate approval can only be registered once a
    // sessions row exists for the gate id. The declarative gate uses its
    // OWN synthetic session id (workflow-gate:<runId>:<stepId>) that no
    // other path creates — so ensure it here (load-or-create, idempotent
    // across resume) before register(), exactly as getWorkflowHarnessSession
    // does for the step session. Without this, register() throws
    // "FOREIGN KEY constraint failed" and the run fails before it can park.
    if (!HarnessSession.load(gateSessionId)) {
      HarnessSession.create({
        id: gateSessionId,
        kind: 'workflow',
        channel: 'workflow',
        title: `${ctx.workflow.name}::${step.id} (approval gate)`,
        metadata: {
          source: 'workflow',
          workflowName: ctx.workflow.name,
          workflowRunId: ctx.runId,
          stepId: step.id,
          gate: true,
        },
      });
    }
    row = approvalRegistry.register({
      sessionId: gateSessionId,
      subject,
      tool: 'workflow_approval_gate',
      ttlMs: WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS,
    });
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { gate: 'awaiting_approval', approvalId: row.approvalId },
    });
    try {
      addNotification({
        id: `approval-${row.approvalId}`,
        kind: 'approval',
        title: `Workflow ${ctx.workflow.name} · ${step.id} needs approval`,
        body: `**${subject}**\n\nApprove to let the workflow continue, or reject to stop it — reply \`approve ${row.approvalId}\` / \`reject ${row.approvalId}\`. The run is parked on \`${step.id}\` until you respond.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { approvalId: row.approvalId, workflowName: ctx.workflow.name, stepId: step.id, gate: true },
      });
    } catch { /* notification best-effort; apr id is in the dashboard */ }
  }

  // P0 parking (flag on): the gate is registered + the user notified, so
  // there is nothing left to do but wait on a human. Release the slot —
  // unwind via ParkRunSignal; `reapResolvedParkedRuns` resumes this run
  // once the approval clears, and the `prior` check at the top of this
  // function honors the resolution on re-entry. Flag-off keeps the
  // in-place poll below byte-identical to today.
  if (parkingEnabled()) {
    markWorkflowRunPausedForApproval(ctx.runId);
    throw new ParkRunSignal([{ stepId: step.id, kind: 'gate', approvalIds: [row.approvalId] }]);
  }

  markWorkflowRunPausedForApproval(ctx.runId);
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, WORKFLOW_HARNESS_POLL_MS));
      throwIfWorkflowRunCancelled(ctx.runId);
      const resolution = settledResolution();
      if (resolution) {
        if (resolution === 'approved') return;
        throw new Error(`workflow step "${step.id}" was not approved (${resolution})`);
      }
      if (Date.now() - startedAt > WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS) {
        throw new Error(`workflow step "${step.id}" exceeded approval wait budget (${WORKFLOW_HARNESS_APPROVAL_MAX_WAIT_MS}ms)`);
      }
    }
  } finally {
    clearWorkflowRunPausedForApproval(ctx.runId);
  }
}

/**
 * Bind a step's declared inputs plus dependency outputs. `dependsOn`
 * always carries upstream data into the structured step context; explicit
 * `inputs` remain the typed contract for named values and missing-required
 * fast-fail behavior.
 */
function bindStepContext(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
  item?: unknown,
): { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown } | undefined {
  const bound = bindStepInputs(step, ctx.inputs, ctx.stepOutputs, item);
  if (bound.missing.length > 0) {
    const message =
      `Step "${step.id}" missing required input(s): ${bound.missing.join(', ')}`
      + ` — expected from input.<key> or steps.<dep>.output. Fix the step's \`inputs\` bindings or the run inputs.`;
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_failed',
      stepId: step.id,
      error: message,
      meta: { reason: 'unbound_required_input', missing: bound.missing },
    });
    throw new Error(message);
  }
  const hasValues = Object.keys(bound.values).length > 0;
  const hasUpstream = Object.keys(bound.upstream).length > 0;
  const hasItem = item !== undefined;
  if (!hasValues && !hasUpstream && !hasItem) return undefined;
  return { values: bound.values, upstream: bound.upstream, item };
}

/**
 * Typed-contract EXIT half — now UNCONDITIONAL (the WORKFLOW_CONTRACT_OUTPUT
 * rollout flag was removed per feedback_no_rollout_flags; validated behavior
 * is the default). When a step declares an `output` contract, the runner
 * verifies the emitted value actually matches it (type / required_keys /
 * verify.path_exists / verify.url_present) BEFORE recording step_completed. A
 * contract failure is a real failure: emit step_failed + throw so the run
 * reports back loudly instead of feeding malformed or fabricated data
 * downstream (the revill "claimed success, no URL" class). A step with NO
 * declared contract is unverified — byte-identical to before — so existing
 * workflows are unaffected; the contract IS the per-step opt-in.
 *
 * Step retry is likewise unconditional (WORKFLOW_STEP_RETRY removed): a step
 * that fails with a TRANSIENT error (network blip, timeout, 5xx, rate-limit)
 * is retried up to its declared `retryBudget` with exponential backoff, so a
 * momentary hiccup doesn't halt a long-running workflow. Deterministic
 * failures (bad input, contract mismatch, approval rejection) are NEVER
 * retried. retryBudget defaults to 0 → no retry unless the step opts in.
 */
const RETRY_BACKOFF_BASE_MS = parseInt(
  process.env.CLEMENTINE_WORKFLOW_RETRY_BASE_MS ?? '2000', 10,
);

/**
 * Classify an error as transient (worth retrying) vs deterministic. Pure
 * + exported for tests. Conservative: only well-known transient signals
 * match; anything else is treated as deterministic so we never loop on a
 * real bug. ParkRunSignal / cancellation are handled by the caller before
 * this is consulted.
 */
// Transient SIGNALS matched against the error message (network/infra hiccups).
// Bare HTTP status NUMBERS are deliberately NOT matched here — a message that
// merely contains "500" (e.g. "expected 500 rows") must not be retried. HTTP
// status is only honored via the structured `err.status` field below.
// NB: `fetch failed` is the undici/Node fetch TOP-LEVEL message — the real
// network code (ECONNRESET/ENOTFOUND) lives on err.cause, which the classifier
// inspects below. A daily unattended workflow that hit a one-off `fetch failed`
// (observed live 2026-06-02) must not be treated as a deterministic bug.
const TRANSIENT_RE = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network error|fetch failed|connection (?:error|closed|reset)|timed? ?out|timeout|rate.?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway timeout)\b/i;
// Deterministic workflow failures that must NEVER be retried even though their
// message text can contain a transient token (e.g. "timed out waiting for
// approval" contains "timed out"). This override wins over TRANSIENT_RE.
const NON_RETRYABLE_RE = /(waiting for approval|exceeded approval wait budget|was not approved|missing required input|failed its contract|deterministic runner)/i;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export function isTransientStepError(err: unknown, depth = 0): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (NON_RETRYABLE_RE.test(msg)) return false;
  const code = (err as { code?: string; status?: number; cause?: unknown } | null);
  if (code?.code && TRANSIENT_RE.test(code.code)) return true;
  if (typeof code?.status === 'number' && TRANSIENT_STATUS.has(code.status)) return true;
  if (TRANSIENT_RE.test(msg)) return true;
  // undici fetch / aggregate errors wrap the real transient cause one level down
  // (a `fetch failed` whose cause is ECONNRESET). Recurse, bounded, on the cause.
  if (depth < 3 && code?.cause && code.cause !== err) return isTransientStepError(code.cause, depth + 1);
  return false;
}

/**
 * Pure retry harness around an execution thunk. Retries on a transient
 * error up to `budget` times with exponential backoff. `isRetryable`
 * lets the caller veto (park/cancel signals must propagate immediately).
 * `onRetry` is the side-effect hook (event log). Exported for tests so
 * the loop logic is verified without the full step machinery.
 */
export async function runWithStepRetry<T>(
  run: () => Promise<T>,
  opts: {
    budget: number;
    backoffBaseMs: number;
    isRetryable: (err: unknown) => boolean;
    onRetry?: (info: { attempt: number; budget: number; delayMs: number; err: unknown }) => void;
    sleep?: (ms: number) => Promise<void>;
    afterBackoff?: () => void;
  },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= opts.budget || !opts.isRetryable(err)) throw err;
      attempt += 1;
      const delayMs = opts.backoffBaseMs * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, budget: opts.budget, delayMs, err });
      await sleep(delayMs);
      opts.afterBackoff?.();
    }
  }
}

/** A TRANSIENT-only retry floor: even a step that declared no retryBudget gets
 *  this many automatic retries on a network/infra blip (the retry harness gates
 *  on isTransientStepError, so a real deterministic failure still fails on
 *  attempt 1). Default 1 so a daily unattended run survives a one-off `fetch
 *  failed`/5xx; set CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR=0 to restore the
 *  old fail-fast-on-transient behavior. */
function transientRetryFloor(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR', '1') || '1', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

async function executeStepVerified(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  const declared = step.retryBudget && step.retryBudget > 0 ? step.retryBudget : 0;
  const budget = Math.max(declared, transientRetryFloor());
  // Retry loop wraps EXECUTION only. Verification (below) is deterministic
  // and never retried. Park/cancel signals propagate immediately (they are
  // not "retryable").
  const output = await runWithStepRetry(() => executeStep(step, ctx), {
    budget,
    backoffBaseMs: RETRY_BACKOFF_BASE_MS,
    isRetryable: (err) =>
      !(err instanceof ParkRunSignal) &&
      !(err instanceof WorkflowRunCancelledError) &&
      isTransientStepError(err),
    onRetry: ({ attempt, budget: b, delayMs, err }) => {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_retry',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
        meta: { attempt, budget: b, delayMs, reason: 'transient' },
      });
      logger.warn(
        { stepId: step.id, attempt, budget: b, delayMs, err: err instanceof Error ? err.message : String(err) },
        'workflow step failed transiently — retrying after backoff',
      );
    },
    afterBackoff: () => throwIfWorkflowRunCancelled(ctx.runId),
  });
  return output;
}

/**
 * Single chokepoint for "this step finished with this output". Verifies the
 * output against its declared contract BEFORE recording step_completed, then
 * emits step_completed. Verifying first guarantees a contract-rejected output
 * is NEVER written as a completed step — otherwise computeResumeState (and any
 * re-queue) would treat the bad value as a valid done step and feed it
 * downstream. On contract failure: emit step_failed + throw (a deterministic
 * error, so the retry wrapper won't re-run it). Flag-off / no contract → a
 * straight step_completed emit, byte-identical to before. Every step shape
 * (deterministic / forEach / plain / synthesis) routes through this.
 */
/**
 * Contract BINDING: when a step declares an output contract but its agent
 * returned the result as a STRING (prose, or a fenced ```json block) instead of
 * a structured object, parse that string into the object so the contract can
 * bind to it. A step that emits the right JSON as text now satisfies the
 * contract, and downstream steps + forEach receive the real object (not a
 * string). Conservative + additive: only touches a STRING output when a
 * contract is declared; if nothing parses to an object/array the original is
 * returned and the verifier fails loudly exactly as before. Exported for tests.
 */
export function coerceOutputForContract(
  output: unknown,
  contract: WorkflowStepOutputContract | undefined,
): unknown {
  if (!contract) return output;
  // Only a STRUCTURED contract can be satisfied by a parsed object/array. A
  // scalar contract (string/number/boolean with no keys/verify) must NOT be
  // coerced — a valid string output that happens to be JSON-looking would
  // otherwise flip into a failing object (review regression #1).
  const structured =
    contract.type === 'object' ||
    contract.type === 'array' ||
    (contract.required_keys?.length ?? 0) > 0 ||
    Boolean(contract.verify);
  if (!structured) return output;
  if (typeof output !== 'string') return output;
  const text = output.trim();
  if (!text) return output;
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(text);
  // Last resort: pull the outermost {...} or [...] block so leading/trailing
  // prose around the JSON doesn't defeat the parse.
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      // ACCEPT a parsed candidate ONLY if it actually SATISFIES the contract.
      // This makes coercion provably unable to turn a fail into a wrong-pass or
      // a pass into a fail (review regression #2): a non-conformant parse (e.g.
      // an incidental [3] from prose, or an object for a string contract) is
      // rejected, the original is returned, and the verifier fails loudly.
      if (parsed !== null && typeof parsed === 'object' && verifyStepOutput(contract, parsed).ok) {
        return parsed;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return output;
}

/** Compact, safe description of an output's actual shape — for a contract
 *  failure message so we can see WHAT was produced vs what was required
 *  (e.g. "object with keys: reply, summary" when the contract wanted
 *  proposed_prospects). Never throws. */
export function describeOutputShape(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const t = value.trim();
    return `string (${t.length} chars)${t ? `: "${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"` : ''}`;
  }
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object with keys: ${keys.length ? keys.slice(0, 12).join(', ') : '(none)'}`;
  }
  return typeof value;
}

export function finalizeStepOutput(
  workflowSlug: string,
  runId: string,
  step: WorkflowStepInput,
  output: unknown,
  meta?: Record<string, unknown>,
): unknown {
  // Bind a JSON-text output to the declared contract shape BEFORE verifying, so
  // a step that emitted the right keys as text (not a structured object) passes
  // and downstream steps receive the real object. No contract → unchanged.
  const bound = step.output ? coerceOutputForContract(output, step.output) : output;
  // A step that legitimately BLOCKED (returns {blocked:true, reason}) is
  // signaling it couldn't produce its deliverable — surface that block + its
  // REASON via the success-path self-heal (detectBlockedSteps reports
  // "needs attention: <reason>") instead of MASKING it as a cryptic contract
  // failure ("missing required key X"). So skip contract verification for a
  // blocked output; it flows through as step_completed and the run reports the
  // real reason. (Live: add_to_airtable blocked "no prospects — Salesforce
  // expired" but the user saw "missing required output key created_records".)
  const isBlockedOutput =
    bound !== null && typeof bound === 'object' && !Array.isArray(bound) &&
    (bound as { blocked?: unknown }).blocked === true;
  if (step.output && !isBlockedOutput) {
    const result = verifyStepOutput(step.output, bound);
    if (!result.ok) {
      const got = describeOutputShape(bound);
      // Include the ACTUAL produced shape so the failure is diagnosable (the
      // step ran but emitted the wrong shape — e.g. its decision object instead
      // of the contracted keys) instead of only "missing key X".
      const message = `Step "${step.id}" output failed its contract: ${result.problems.join('; ')} — the step produced ${got}.`;
      appendWorkflowEvent(workflowSlug, runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: message,
        meta: { reason: 'output_contract', problems: result.problems, got },
      });
      throw new Error(message);
    }
  }
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_completed',
    stepId: step.id,
    output: bound,
    ...(meta ? { meta } : {}),
  });
  return bound;
}

/**
 * Find the step that FAILED its declared output contract from a run's events
 * (most recent first). Contract violations THROW (vs the {blocked:true}
 * channel), so they land in the run's error path and never reach the
 * success-with-blocked diagnosis. The error path uses this to route the
 * violation into the Doctor for an approval-gated fix. Pure + exported for tests.
 */
export function findContractViolationStep(
  events: WorkflowEvent[],
): { stepId: string; problems: string[] } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'step_failed') continue;
    const meta = (e as { meta?: { reason?: unknown; problems?: unknown } }).meta;
    if (!meta || meta.reason !== 'output_contract') continue;
    const stepId = typeof e.stepId === 'string' ? e.stepId : undefined;
    if (!stepId) continue;
    const problems = Array.isArray(meta.problems)
      ? meta.problems.filter((p): p is string => typeof p === 'string')
      : [];
    return { stepId, problems };
  }
  return null;
}

export async function executeStep(
  step: WorkflowStepInput,
  ctx: StepExecutionContext,
): Promise<unknown> {
  // 0. Opt-in approval gate (autonomous-by-default model). When a step
  //    declares requiresApproval, the RUNNER surfaces ONE batch approval
  //    and holds the run here until the user resolves it — then the rest
  //    of the workflow proceeds autonomously. Declarative + runner-owned,
  //    so the constrained step agent never needs request_approval and a
  //    workflow pauses at most where it explicitly opts in.
  if (step.requiresApproval) {
    await awaitDeclarativeStepApproval(ctx, step);
  }

  // 1. Deterministic helper — skip the LLM entirely and run a bundled
  //    script from this workflow's scripts/ directory. The runner
  //    receives structured JSON on stdin and emits stdout that is
  //    parsed as JSON when possible.
  if (step.deterministic?.runner) {
    appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
      kind: 'step_started',
      stepId: step.id,
      meta: { mode: 'deterministic', runner: step.deterministic.runner },
    });
    let detOutput: unknown;
    try {
      detOutput = await runDeterministicWorkflowStep(step.deterministic.runner, {
        workflow: ctx.workflow.name,
        workflowSlug: ctx.workflowSlug,
        runId: ctx.runId,
        stepId: step.id,
        inputs: ctx.inputs,
        stepOutputs: ctx.stepOutputs,
      });
    } catch (err) {
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_failed',
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
        meta: { mode: 'deterministic', runner: step.deterministic.runner },
      });
      throw err;
    }
    // Route through the SAME verification chokepoint as forEach/plain/synthesis
    // so a deterministic step's declared output contract is enforced BEFORE
    // step_completed is recorded — never silently bypassed. (finalizeStepOutput
    // emits step_failed + throws on a contract violation; the throw is a
    // deterministic error so the retry wrapper above won't re-run it.)
    return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, detOutput, {
      mode: 'deterministic',
      runner: step.deterministic.runner,
    });
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
        // Bind this item's declared inputs + fast-fail on missing (no-op
        // when the step declares no `inputs`). `item` is in scope here.
        const itemContext = bindStepContext(step, ctx, item);
        const itemIntent = renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs, item);
        const prompt = applyContractToPrompt(step, applySkillToPrompt(step, itemIntent));
        let output: unknown;
        let itemSessionId = `workflow:${ctx.runId}:${step.id}:${key}`;
        if (workflowHarnessEnabled(step)) {
          const r = await runStepViaHarness(
            step,
            `${ctx.runId}:${step.id}:${key}`,
            `Item: ${key}\n\n${prompt}`,
            ctx.workflow.name,
            workflowAutoApprovalTools(ctx.workflow, step),
            ctx.runId,
            itemContext,
          );
          output = r.output;
          itemSessionId = r.sessionId;
        } else {
          output = (await ctx.assistant.respond({
            sessionId: `workflow:${ctx.runId}:${step.id}:${key}`,
            channel: 'workflow',
            message: `Workflow: ${ctx.workflow.name}\nStep: ${step.id}\nItem: ${key}\n\n${prompt}`,
            model: step.model || MODELS.primary,
            maxWallClockMs: WORKFLOW_STEP_WALL_CLOCK_MS,
          })).text;
        }
        // Per-item skill-execution check (forEach): advisory, DETECTION-ONLY —
        // a `usesSkill` item that couldn't be confirmed to produce the skill's
        // deliverables records a non-failing quality advisory. The item still
        // completes + contributes its output; it never becomes an item failure
        // on a judge verdict (a confident-but-wrong judge can't drop a good
        // item). Fail-open; no-op for items without usesSkill.
        await noteStepSkillAdvisory(step, itemSessionId, output, itemIntent, ctx, key);
        appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
          kind: 'item_completed',
          stepId: step.id,
          itemKey: key,
          output,
        });
        return { itemKey: key, output };
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
    return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, aggregate, {
      mode: 'forEach', completed: successes.length, failed,
    });
  }

  // 3. Plain LLM step. Two paths:
  //   - HARNESS path (T-WF-1/2): use runConversation, wait for any
  //     pending approvals, surface a Discord notification with the
  //     apr-xxxx code. Real tool outputs flow into stepOutputs.
  //   - LEGACY path: original assistant.respond — preserved for
  //     workflows authored before the harness existed.
  // Bind declared inputs + fast-fail on a missing required input (no-op
  // when the step declares no `inputs`).
  const stepContext = bindStepContext(step, ctx);
  appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
    kind: 'step_started',
    stepId: step.id,
  });
  const prompt = applyContractToPrompt(step, applySkillToPrompt(step, renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs)));
  let output: unknown;
  let stepSessionId = `workflow:${ctx.runId}:${step.id}`;
  if (workflowHarnessEnabled(step)) {
    try {
      const result = await runStepViaHarness(
        step,
        `${ctx.runId}:${step.id}`,
        prompt,
        ctx.workflow.name,
        workflowAutoApprovalTools(ctx.workflow, step),
        ctx.runId,
        stepContext,
        true, // canPark: plain step unwinds cleanly to processOneRunFile
      );
      output = result.output;
      stepSessionId = result.sessionId;
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

  // Skill-execution check (advisory, DETECTION-ONLY). Engages ONLY for
  // `usesSkill` steps; fail-open. A confident miss records a non-failing
  // quality advisory that rides along with the delivered output — it never
  // fails the step or run, so it can't break a workflow that actually
  // succeeded.
  await noteStepSkillAdvisory(step, stepSessionId, output, renderTemplate(step.prompt, ctx.inputs, ctx.stepOutputs), ctx);

  return finalizeStepOutput(ctx.workflowSlug, ctx.runId, step, output);
}

/**
 * Run the per-step skill-execution judge and, on a confident miss, record a
 * NON-FAILING quality advisory (the step still completed + delivered its
 * output). DETECTION-ONLY: it never throws / never fails the step or run — a
 * confident-but-wrong judge can therefore never break a workflow that actually
 * succeeded (the owner's #1 bar). No-op for steps without `usesSkill`, and
 * wholly fail-open (any error is swallowed). `itemKey` set for forEach items.
 */
async function noteStepSkillAdvisory(
  step: WorkflowStepInput,
  sessionId: string,
  output: unknown,
  stepIntent: string,
  ctx: StepExecutionContext,
  itemKey?: string,
): Promise<void> {
  if (!step.usesSkill?.trim()) return;
  try {
    const verdict = await judgeStepSkillExecution({ step, sessionId, output, stepIntent });
    if (verdict.judged && !verdict.executed) {
      ctx.qualityAdvisories.push({
        stepId: step.id,
        itemKey,
        kind: 'skill_not_executed',
        note: `step "${step.id}"${itemKey ? ` · item ${itemKey}` : ''} used skill "${step.usesSkill}" — couldn't confirm it produced the skill's deliverables: ${verdict.reason}`,
      });
      appendWorkflowEvent(ctx.workflowSlug, ctx.runId, {
        kind: 'step_advisory',
        stepId: step.id,
        meta: { reason: 'skill_not_executed', skill: step.usesSkill, note: verdict.reason, itemKey },
      });
    }
  } catch {
    /* advisory is best-effort — a judge hiccup must never affect the step */
  }
}

export function planWorkflowExecutionBatches(
  steps: WorkflowStepInput[],
  completedStepIds: Set<string> = new Set(),
): WorkflowStepInput[][] {
  const stepIds = new Set(steps.map((step) => step.id));
  const pending = new Map(steps
    .filter((step) => !completedStepIds.has(step.id))
    .map((step) => [step.id, step]));
  const batches: WorkflowStepInput[][] = [];
  const completed = new Set(completedStepIds);

  while (pending.size > 0) {
    const ready = Array.from(pending.values()).filter((step) =>
      (step.dependsOn ?? []).every((dep) => {
        if (!stepIds.has(dep)) {
          throw new Error(`Workflow step "${step.id}" depends on unknown step "${dep}".`);
        }
        return completed.has(dep);
      }));

    if (ready.length === 0) {
      const blocked = Array.from(pending.values())
        .map((step) => `${step.id} waits for ${(step.dependsOn ?? []).filter((dep) => !completed.has(dep)).join(', ') || '(unknown)'}`)
        .join('; ');
      throw new Error(`Workflow dependency graph is blocked or cyclic: ${blocked}`);
    }

    batches.push(ready);
    for (const step of ready) {
      pending.delete(step.id);
      completed.add(step.id);
    }
  }

  return batches;
}

function formatStepOutputs(steps: WorkflowStepInput[], stepOutputs: Record<string, unknown>): string {
  return steps
    .filter((step) => stepOutputs[step.id] !== undefined)
    .map((step) => {
      const out = stepOutputs[step.id];
      return `## ${step.id}\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`;
    })
    .join('\n\n');
}

function parallelStepLabel(steps: WorkflowStepInput[]): string {
  if (steps.length === 1) return steps[0].id;
  const labels = steps.map((step) => step.id);
  const preview = labels.slice(0, 3).join(' + ');
  return labels.length > 3 ? `parallel: ${preview} + ${labels.length - 3} more` : `parallel: ${preview}`;
}

/**
 * Run the full step DAG to completion. Steps whose dependencies are
 * already satisfied run in the same batch, capped by
 * CLEMENTINE_WORKFLOW_CONCURRENCY. This is what makes workflow
 * frameworks fast: normalize once, fan out independent research
 * branches, then aggregate when all parents complete.
 */
async function executeWorkflow(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  runId: string,
  inputs: Record<string, string>,
  assistant: ClementineAssistant,
  targetStepId?: string,
): Promise<{ finalOutput: string; forEachFailures: Array<{ stepId: string; itemKey: string; error: string }>; qualityAdvisories: WorkflowQualityAdvisory[] }> {
  const resume = computeResumeState(workflowSlug, runId);
  const stepOutputs: Record<string, unknown> = Object.fromEntries(resume.completedSteps);
  const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
  const qualityAdvisories: WorkflowQualityAdvisory[] = [];

  // Single-step "TRY" mode: execute only the named step. Upstream
  // references in the prompt resolve to empty strings — the user is
  // explicitly asking to see this step in isolation. Synthesis is
  // skipped too; the step output is the final output.
  const steps = targetStepId
    ? workflow.steps.filter((s) => s.id === targetStepId)
    : workflow.steps;

  if (targetStepId) {
    const step = steps[0];
    if (!step) {
      throw new Error(`Workflow step "${targetStepId}" not found.`);
    }
    throwIfWorkflowRunCancelled(runId);
    if (stepOutputs[step.id] !== undefined) {
      // Already completed in a prior pass — use the cached output.
    } else {
      setWorkflowRunCurrentStep(runId, {
        stepId: step.id,
        index: 1,
        total: 1,
      });
      const completedItems = resume.completedItems.get(step.id) ?? new Map();
      const output = await executeStepVerified(step, {
        workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems, forEachFailures, qualityAdvisories,
      });
      throwIfWorkflowRunCancelled(runId);
      stepOutputs[step.id] = output;
    }
  } else {
    let completedStepIds = new Set(Object.keys(stepOutputs));
    while (completedStepIds.size < steps.length) {
      const readyBatch = planWorkflowExecutionBatches(steps, completedStepIds)[0] ?? [];
      const batch = readyBatch.slice(0, Math.max(1, RUNNER_CONCURRENCY));
      const batchIndex = completedStepIds.size + 1;
      setWorkflowRunCurrentStep(runId, {
        stepId: parallelStepLabel(batch),
        index: batchIndex,
        total: steps.length,
      });

      const settled = await Promise.allSettled(batch.map(async (step) => {
        throwIfWorkflowRunCancelled(runId);
        const completedItems = resume.completedItems.get(step.id) ?? new Map();
        const output = await executeStepVerified(step, {
          workflow, workflowSlug, runId, inputs, stepOutputs, assistant, completedItems, forEachFailures, qualityAdvisories,
        });
        return { step, output };
      }));

      const errors: string[] = [];
      const parkedSteps: ParkedStepRef[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          stepOutputs[result.value.step.id] = result.value.output;
          completedStepIds.add(result.value.step.id);
        } else if (result.reason instanceof ParkRunSignal) {
          parkedSteps.push(...result.reason.parkedSteps);
        } else {
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }
      throwIfWorkflowRunCancelled(runId);
      // A genuine error fails the run even if a sibling parked. Before failing,
      // CLEAN UP any sibling that parked: its approval row + heartbeat flag were
      // registered, and the run is about to go terminal (error). Cancel those
      // pending approvals (else the user sees an approval card for a dead run the
      // reaper can never re-admit) and clear the heartbeat flag.
      if (errors.length > 0) {
        if (parkedSteps.length > 0) {
          for (const id of parkedSteps.flatMap((s) => s.approvalIds)) {
            try { approvalRegistry.resolve(id, 'cancelled_by_user', 'batch-sibling-failed'); } catch { /* best-effort */ }
          }
          clearWorkflowRunPausedForApproval(runId);
        }
        throw new Error(errors.length === 1 ? errors[0] : `Workflow batch failed: ${errors.join('; ')}`);
      }
      // No genuine error. If any sibling parked, park the whole run: completed
      // siblings are already durable in events.jsonl, so resume re-runs only the
      // parked and not-yet-started steps.
      if (parkedSteps.length > 0) {
        throw new ParkRunSignal(parkedSteps);
      }
      completedStepIds = new Set(Object.keys(stepOutputs));
    }
  }
  // Clear the step tracker before the synthesis pass + final cleanup
  // so the heartbeat doesn't keep showing the LAST step name after
  // the per-step loop is done.
  clearWorkflowRunCurrentStep(runId);

  // Synthesis step (optional final pass over all step outputs). Skipped
  // when TRY is running a single step in isolation — the step's own
  // output is the user-facing result.
  let finalOutput: string;
  if (workflow.synthesis?.prompt && !targetStepId) {
    throwIfWorkflowRunCancelled(runId);
    appendWorkflowEvent(workflowSlug, runId, {
      kind: 'step_started',
      stepId: '__synthesis__',
    });
    const stepOutputsAsText = formatStepOutputs(workflow.steps, stepOutputs);
    const synthesisPrompt = renderTemplate(workflow.synthesis.prompt, inputs, stepOutputs);
    const synthesisStep: WorkflowStepInput = {
      id: '__synthesis__',
      prompt: synthesisPrompt,
      model: MODELS.primary,
      maxTurns: 8,
    };
    const synthesisResult = await runStepViaHarness(
      synthesisStep,
      `${runId}:synthesis`,
      [
        'Workflow synthesis pass. Produce the final user-facing result from the completed step outputs.',
        'Do not start new external research or mutate external systems during synthesis unless the user explicitly asked for that in the workflow synthesis prompt.',
        '',
        synthesisPrompt,
        '',
        'Step outputs:',
        '',
        stepOutputsAsText,
      ].join('\n'),
      workflow.name,
      [],
      runId,
      undefined,
      true, // canPark: synthesis runs outside any batch/forEach
    );
    // Synthesis output is the final user-facing report (a string). The
    // step result is `unknown` now, so coerce: keep strings as-is,
    // JSON-render an (unexpected) structured synthesis result.
    const synthesisText = typeof synthesisResult.output === 'string'
      ? synthesisResult.output
      : synthesisResult.output != null
        ? JSON.stringify(synthesisResult.output, null, 2)
        : '';
    finalOutput = synthesisText || formatStepOutputs(workflow.steps, stepOutputs);
    throwIfWorkflowRunCancelled(runId);
    finalizeStepOutput(workflowSlug, runId, synthesisStep, finalOutput);
  } else {
    finalOutput = formatStepOutputs(workflow.steps, stepOutputs);
  }

  // Record string-coerced step outputs on the run record for the
  // dashboard's recent-runs display (which expects strings).
  return { finalOutput, forEachFailures, qualityAdvisories };
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
// Single-flight guard. When the drain runs on its own daemon timer
// (CLEMMY_WORKFLOW_RUN_LANE), the interval can re-fire while a previous
// drain is still awaiting a long run. This boolean keeps exactly one
// drain pass in flight at a time so the same run file is never picked
// up twice concurrently. (True run-level parallelism — draining several
// runs at once — is a separate, test-gated change; see the work-scheduler
// follow-up.)
let workflowDrainInFlight = false;

export async function processWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return;
  if (workflowDrainInFlight) return;
  workflowDrainInFlight = true;
  try {
    await drainWorkflowRuns(assistant);
  } finally {
    workflowDrainInFlight = false;
  }
}

/**
 * P0 event-driven approval parking — the resolution scan. Runs on the
 * workflow-run lane tick (and on boot). For each run checkpointed as
 * 'parked', re-admit it (flip status -> 'running') once EVERY approval it
 * was waiting on has cleared (approved / rejected / expired / cancelled).
 * The two-phase flip guarantees a still-pending parked run is never
 * handed a bounded-pool slot. `processOneRunFile` sees status==='running'
 * and resumes from the parked step (run_resumed event + computeResumeState
 * skip of completed steps). No-op when the flag is off — under flag-off no
 * run is ever written as 'parked', so this scan finds nothing.
 */
export function reapResolvedParkedRuns(): void {
  if (!parkingEnabled()) return;
  if (!existsSync(WORKFLOW_RUNS_DIR)) return;
  let approvalsById: Map<string, approvalRegistry.PendingApprovalRow>;
  try {
    approvalsById = new Map(
      approvalRegistry.listPending({ status: 'any' }).map((row) => [row.approvalId, row]),
    );
  } catch {
    return; // registry unavailable this tick — try again next tick
  }
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    const run = readRunRecord(filePath);
    if (!run || run.status !== 'parked' || !run.parked) continue;
    const watched = run.parked.parkedSteps.flatMap((s) => s.approvalIds).filter((id) => id.trim().length > 0);
    if (watched.length === 0) continue; // malformed parked checkpoint; watchdog should surface it
    const rows = watched.map((id) => approvalsById.get(id));
    if (rows.some((row) => !row)) continue; // lost registry row: never auto-approve by absence
    if (rows.some((row) => row?.status === 'pending')) continue; // still waiting on a human
    // The run is about to resume, so it is no longer "parked on approval".
    // Clear the in-memory heartbeat-suppression flag here so an in-process
    // resume (approval resolved without a daemon restart) doesn't inherit a
    // stale flag that silences the resumed run's heartbeats. Covers every
    // park path (declarative gate throws before its own finally can clear).
    clearWorkflowRunPausedForApproval(run.id);
    writeRunRecord(filePath, { ...run, status: 'running' });
    try {
      addRunEvent(run.id, {
        type: 'run_resumed',
        status: 'running',
        message: 'Workflow approval resolved. Resuming the run.',
        data: {
          workflow: run.workflow,
          parkedSteps: run.parked.parkedSteps.map((s) => s.stepId),
          approvalIds: watched,
        },
      });
    } catch { /* run-events is best-effort; never block resume */ }
    logger.info(
      { workflow: run.workflow, runId: run.id, parkedSteps: run.parked.parkedSteps.map((s) => s.stepId) },
      'Parked workflow run re-admitted — approval(s) resolved',
    );
  }
}

// Per-runId guard so the same run file is never processed by two
// concurrent slots (or two overlapping drain passes). Module-scoped so
// it persists across passes.
const inFlightRunIds = new Set<string>();

// How many queued runs may execute at once. Read at call time so it's
// runtime-configurable and testable. Default 1 = today's sequential
// behavior (forward-only: no behavior change until explicitly raised);
// set CLEMENTINE_WORKFLOW_RUN_CONCURRENCY=3 (etc.) to let independent
// runs progress in parallel once you've soaked it.
function runDrainConcurrency(): number {
  const raw = parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_RUN_CONCURRENCY', '1') || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

// Flag-gate for the constrained, structured-output step agent. Default
// OFF so this lands dark (no behavior change) until verified + soaked;
// flip to 'on' to make workflow steps deterministic units that emit
// structured results and cannot re-trigger their own workflow.
function useWorkflowStepAgent(): boolean {
  return (getRuntimeEnv('WORKFLOW_STEP_AGENT', 'on') ?? 'on').toLowerCase() === 'on';
}

// Render the bound inputs + upstream outputs as an authoritative
// structured block appended after the prose. Each value is clipped to
// keep the prompt within budget (token-efficiency north star). If a workflow
// needs a precise large subfield, declare an explicit `inputs.from` binding
// or split the upstream step output into smaller structured values.
const STEP_CONTEXT_VALUE_CLIP = 8000;
function clipForContext(value: unknown): unknown {
  let json: string;
  try { json = JSON.stringify(value); } catch { return '[unserializable]'; }
  if (json.length <= STEP_CONTEXT_VALUE_CLIP) return value;
  return `[clipped ${json.length} chars — use explicit inputs.from binding for precise large subfields]`;
}
function renderStepContextBlock(ctx: { values: Record<string, unknown>; upstream: Record<string, unknown>; item?: unknown }): string {
  const payload: Record<string, unknown> = {
    input: Object.fromEntries(Object.entries(ctx.values).map(([k, v]) => [k, clipForContext(v)])),
    upstream: Object.fromEntries(Object.entries(ctx.upstream).map(([k, v]) => [k, clipForContext(v)])),
  };
  if (ctx.item !== undefined) payload.item = clipForContext(ctx.item);
  return [
    '=== STEP CONTEXT (structured, authoritative) ===',
    'This is real workflow data. `input` contains declared step inputs; `upstream` contains outputs from every completed dependsOn step. Use it over prose. If a value you need is empty/absent here, call workflow_step_result({"blocked":true,"reason":"<what is missing>"}) instead of guessing or fabricating.',
    JSON.stringify(payload, null, 2),
    '=== END STEP CONTEXT ===',
  ].join('\n');
}

/**
 * A run cancelled while still queued (or a mid-flight cancel whose notification
 * was lost to a crash) is skipped by the drain status filter and would never
 * report back. Surface it ONCE — north-star: reports back without fail.
 * markRunNotified + the !notifiedAt guard make it idempotent; best-effort so a
 * notify hiccup never breaks the drain (the watchdog backstops an unmarked one).
 */
/**
 * Gap E — re-enter the origin chat on a terminal state. Mirrors
 * enqueueBackgroundTaskOutcomeTurn: appends ONE synthetic role:'user' turn to
 * the triggering chat session so Clementine continues in-context (read via
 * recentTranscript on the session's next turn). This is IN ADDITION to the
 * global notification — it never replaces it. No-op when the run carries no
 * originSessionId (scheduled/cron/dashboard/webhook → notification-only).
 * Idempotent (id-prefix scan survives drain retries / restarts) and fully
 * best-effort: a session-write hiccup can NEVER fail a completed run or its
 * notification.
 */
export function enqueueWorkflowOutcomeTurn(
  run: QueuedRunRecord,
  workflowName: string,
  outcome: 'done' | 'blocked' | 'failed',
  detail: string,
): void {
  try {
    const sessionId = run.originSessionId;
    if (!sessionId) return;
    const idPrefix = `[workflow run ${run.id} `;
    const store = new SessionStore();
    const existing = store.get(sessionId);
    if (existing.turns.some((t) => typeof t.text === 'string' && t.text.startsWith(idPrefix))) {
      return; // already reported — idempotent across retries / daemon restarts
    }
    const head =
      outcome === 'done' ? `${idPrefix}completed]`
        : outcome === 'failed' ? `${idPrefix}FAILED]`
          : `${idPrefix}needs attention]`;
    const guidance =
      outcome === 'done'
        ? `The workflow you started ran in the background and just finished — continue from here. Full result via workflow_run_status run_id="${run.id}".`
        : outcome === 'failed'
          ? `The workflow you started FAILED — it did NOT complete. Decide whether to retry or tell the user; do not assume success. Details via workflow_run_status run_id="${run.id}".`
          : `The workflow you started completed but NEEDS ATTENTION (a step blocked or the target check flagged a gap). Review and decide next steps. Details via workflow_run_status run_id="${run.id}".`;
    const preview = detail.length > 1500 ? `${detail.slice(0, 1500)}\n…[truncated]` : detail;
    const text = `${head} ${workflowName}\n\n${preview}\n\n(${guidance})`;
    store.appendTurn(sessionId, { role: 'user', text, createdAt: new Date().toISOString() });
    // ALSO stage it into the harness conversation snapshot: the desktop/Discord
    // orchestrator replays the harness snapshot (toInputItems), NOT the PWA
    // SessionStore above — without this, Clem's reasoning never sees the outcome
    // and she reports a finished run as still "running." Best-effort + idempotent.
    try {
      const hs = HarnessSession.load(sessionId);
      if (hs) hs.injectSyntheticUserTurn(idPrefix, text);
    } catch { /* best-effort: a harness-store write must never fail a completed run */ }
    logger.info({ runId: run.id, sessionId, outcome }, 'Workflow outcome enqueued into origin chat session');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, runId: run.id },
      'enqueueWorkflowOutcomeTurn failed (best-effort; run + notification unaffected)',
    );
  }
}

// A daemon restart drains EVERY run file, so the cancelled-notify path must not
// re-ping the backlog: skip a STALE cancel (older than this window) or one that
// already reported back, mirroring the watchdog's two guards. Matches
// DEFAULT_TERMINAL_UNNOTIFIED_MAX_MS so the drain path + watchdog agree.
const CANCEL_NOTIFY_MAX_AGE_MS = 12 * 60 * 60_000;

/** Pure: should the drain path post a cancelled-run notification? NO for a
 *  STALE cancel (older than the window — e.g. a backlog file swept on restart)
 *  or one that already reported back. Exported for tests. */
export function shouldNotifyCancelledRun(
  run: { id: string; finishedAt?: string; createdAt?: string },
  nowMs: number,
  reportedBackRunIds: Set<string>,
): boolean {
  const ts = Date.parse(run.finishedAt ?? run.createdAt ?? '');
  const stale = Number.isFinite(ts) && nowMs - ts > CANCEL_NOTIFY_MAX_AGE_MS;
  return !stale && !reportedBackRunIds.has(run.id);
}

function notifyCancelledRunOnce(filePath: string, run: QueuedRunRecord): void {
  try {
    let reported = new Set<string>();
    try {
      reported = reportedBackRunIdsFrom(loadNotifications());
    } catch { /* best-effort: a bad notification log must not block the cancel notify */ }
    if (shouldNotifyCancelledRun(run, Date.now(), reported)) {
      addNotification({
        // Stable id → addNotification id-dedup makes this at-most-once even if
        // the drain re-reads the file or the catch-handler also posts a cancel
        // card for the same run.
        id: `workflow-${run.id}-cancelled`,
        kind: 'workflow',
        title: `Workflow cancelled: ${run.workflow}`,
        body: 'This workflow run was cancelled.',
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: run.workflow, runId: run.id, status: 'cancelled' },
      });
    }
    // Stamp the marker either way so a stale/already-reported file isn't
    // re-checked every drain tick (and the watchdog skips it too).
    markRunNotified(filePath);
  } catch { /* best-effort; the watchdog backstops an unmarked terminal run */ }
}

async function drainWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  const workflows = listWorkflows();
  const eligible: Array<{ file: string; filePath: string; run: QueuedRunRecord }> = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    const run = readRunRecord(filePath);
    if (!run) continue;
    // A cancelled run never enters processOneRunFile (skipped just below), so
    // notify it here once before dropping it — otherwise a queued-then-cancelled
    // run (or a mid-flight cancel whose notify was lost) goes silent.
    if (run.status === 'cancelled' && !run.notifiedAt) {
      notifyCancelledRunOnce(filePath, run);
    }
    // Pick up queued runs and runs marked as running but never
    // completed (resume after daemon restart).
    if (run.status && run.status !== 'queued' && run.status !== 'running') continue;
    if (inFlightRunIds.has(run.id)) continue; // already draining in another slot
    eligible.push({ file, filePath, run });
  }
  if (eligible.length === 0) return;

  await runBoundedPool(
    eligible,
    runDrainConcurrency(),
    async (item) => {
      if (inFlightRunIds.has(item.run.id)) return;
      inFlightRunIds.add(item.run.id);
      try {
        await processOneRunFile(item.file, item.filePath, item.run, workflows, assistant);
      } finally {
        inFlightRunIds.delete(item.run.id);
      }
    },
    (err, item) => logger.error({ err, file: item.file }, 'Workflow run drain task crashed'),
  );
}

// ── Bounded autonomous self-heal ────────────────────────────────────
//
// Owner directive: "on 1 failure workflows can run again until clem self heals
// them." When a step blocks with a diagnosable, AUTO-APPLICABLE prompt-rewrite
// fix, apply it and re-run automatically — bounded, side-effect-guarded, and
// reported every time. Reuses the EXACT path `apply fix` already runs (the
// user-approved Doctor flow): applyProposedFix → requeueWorkflowFromRun. So this
// introduces no new execution machinery and no side-effect class beyond what
// shipping `apply fix` already does — only it's automatic, counted, and capped.
// Gated by the existing WORKFLOW_SELF_HEAL switch (default on); no new flag.

function selfHealAutoMaxAttempts(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMENTINE_WORKFLOW_SELF_HEAL_MAX_ATTEMPTS', '2') || '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

/** Side-effect guard: a FRESH re-run re-executes every step, so it's only safe
 *  when no OTHER mutating step already completed before the blocked one — else
 *  the re-run could double an irreversible write. A step counts as mutating if
 *  it's approval-gated (the author's own "this writes" signal) OR its prompt
 *  reads as an irreversible send/publish (reusing the send-gate heuristic) — so
 *  an unmarked "send the emails" step still blocks auto-heal. Conservative: if
 *  any such step completed, escalate instead of auto-running. */
function hasCompletedUpstreamMutation(
  steps: WorkflowStepInput[],
  blockedStepId: string,
  completedStepIds: Set<string>,
): boolean {
  return steps.some((s) =>
    s.id !== blockedStepId
    && completedStepIds.has(s.id)
    && (s.requiresApproval === true
      || (s as { requires_approval?: boolean }).requires_approval === true
      || stepLooksLikeIrreversibleSend(s.prompt ?? '')));
}

interface AutoHealOutcome { attempt: number; max: number; stepId: string; message: string; }

/**
 * Decide + perform an automatic heal for a run that just completed with a
 * diagnosable block. Returns the heal outcome (so the caller reports it +
 * suppresses the "apply this fix" offer) or null to fall through to today's
 * escalation (needs-attention + fix offer). Never throws.
 */
function tryAutoHealAndRequeue(args: {
  run: QueuedRunRecord;
  workflowSlug: string;
  steps: WorkflowStepInput[];
  diagnosis: WorkflowDiagnosis | null;
  proposedFix: ProposedFix | null;
  completedStepIds: Set<string>;
}): AutoHealOutcome | null {
  const { run, workflowSlug, steps, diagnosis, proposedFix, completedStepIds } = args;
  if (!selfHealEnabled() || !diagnosis || !proposedFix) return null;
  const fix = diagnosis.fix;
  if (fix.kind !== 'edit_step' || !fix.autoApplicable || !fix.newStepPrompt) return null; // only safe prompt rewrites
  const max = selfHealAutoMaxAttempts();
  const prior = run.selfHealAttempt ?? 0;
  if (max <= 0 || prior >= max) return null; // at cap → escalate (today's offer)
  if (hasCompletedUpstreamMutation(steps, fix.stepId, completedStepIds)) {
    logger.info(
      { runId: run.id, step: fix.stepId },
      'self-heal: an upstream mutating step already completed — escalating instead of auto re-running (avoids double side effects)',
    );
    return null;
  }
  let applied: { ok: boolean; message: string };
  try {
    applied = applyProposedFix(proposedFix.id);
  } catch (err) {
    logger.warn({ runId: run.id, err: err instanceof Error ? err.message : err }, 'self-heal: applyProposedFix threw; escalating');
    return null;
  }
  if (!applied.ok) {
    logger.info({ runId: run.id, fixId: proposedFix.id, msg: applied.message }, 'self-heal: fix not auto-applicable; escalating');
    return null;
  }
  const attempt = prior + 1;
  try {
    appendWorkflowEvent(workflowSlug, run.id, { kind: 'step_retry', stepId: fix.stepId, meta: { selfHeal: true, attempt } });
  } catch { /* heal log is best-effort */ }
  const requeued = requeueWorkflowFromRun(run.id, { originSessionId: run.originSessionId, selfHealAttempt: attempt });
  if (requeued.status === 'not_found') {
    // Fix is applied but we couldn't re-queue — report it so it's never silent.
    logger.warn({ runId: run.id }, 'self-heal: applied fix but could not re-queue; surfacing for manual re-run');
    return { attempt, max, stepId: fix.stepId, message: `I auto-applied a fix to step "${fix.stepId}" (${fix.description}), but couldn't re-run automatically — please run the workflow again.` };
  }
  logger.info({ runId: run.id, newRunId: requeued.id, step: fix.stepId, attempt, max }, 'self-heal: applied fix + re-queued a fresh run');
  return {
    attempt,
    max,
    stepId: fix.stepId,
    message: `Step "${fix.stepId}" blocked, so I auto-applied a fix (${fix.description}) and re-ran the workflow — attempt ${attempt} of ${max}. It's running in the background and will report back here when it finishes.`,
  };
}

async function processOneRunFile(
  file: string,
  filePath: string,
  run: QueuedRunRecord,
  workflows: ReturnType<typeof listWorkflows>,
  assistant: ClementineAssistant,
): Promise<void> {
    const workflow = workflows.find((entry) => entry.data.name === run.workflow);
    if (!workflow) {
      const message = `Workflow not found: "${run.workflow}". It may have been renamed or deleted.`;
      writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      // Reports-back: a run that can't even resolve its workflow must not
      // die silently (the user queued it and is waiting).
      addNotification({
        id: `workflow-${run.id}-not-found`,
        kind: 'workflow',
        title: `Workflow failed before start: ${run.workflow}`,
        body: `${message} Check the workflow name in Console → Workflows, then re-run.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: run.workflow, runId: run.id },
      });
      markRunNotified(filePath);
      return;
    }
    // TRY (single-step) runs bypass the workflow enabled gate — they're
    // explicit dashboard actions on a draft. Full runs still require
    // the workflow to be approved.
    if (!run.targetStepId && !workflow.data.enabled) {
      const message = `Workflow "${workflow.data.name}" is disabled — approve/enable it before it can run.`;
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_failed', error: message });
      writeRunRecord(filePath, {
        ...run,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      addNotification({
        id: `workflow-${run.id}-disabled`,
        kind: 'workflow',
        title: `Workflow not run: ${workflow.data.name}`,
        body: `${message} Enable it in Console → Workflows, then re-run.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id },
      });
      markRunNotified(filePath);
      return;
    }

    const inputs: Record<string, string> = normalizeWorkflowRunInputs({
      ...Object.fromEntries(Object.entries(workflow.data.inputs ?? {}).map(([key, meta]) => [key, meta.default ?? ''])),
      ...(run.inputs ?? {}),
    });
    const missingInputs = missingWorkflowRunInputs(workflow.data, inputs);
    if (missingInputs.length > 0) {
      const message = `Missing required workflow input${missingInputs.length === 1 ? '' : 's'}: ${missingInputs.join(', ')}`;
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_failed', error: message });
      writeRunRecord(filePath, {
        ...run,
        inputs,
        status: 'error',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      addNotification({
        id: `${Date.now()}-workflow-${run.id}-missing-inputs`,
        kind: 'workflow',
        title: `Workflow failed before start: ${workflow.data.name}`,
        body: `${message}. Re-run the workflow with the missing input values.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id, status: 'error' },
      });
      markRunNotified(filePath);
      logger.warn({ workflow: workflow.data.name, runId: run.id, missingInputs }, 'Workflow run rejected before start: missing required inputs');
      return;
    }

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
    // Reports-back: surface this workflow run in the unified Activity feed
    // (run-events / listRuns) so it shows alongside chat + background tasks,
    // not only on the Workflows page. startRun upserts (id = run.id), so any
    // trigger source (chat, scheduler, dashboard, API) lands here.
    try {
      startRun({
        id: run.id,
        sessionId: `workflow:${run.id}`,
        channel: 'workflow',
        source: 'workflow',
        title: `Workflow: ${workflow.data.name}`,
        message: `${isResume ? 'Resuming' : 'Running'} workflow "${workflow.data.name}"${run.targetStepId ? ` · step ${run.targetStepId}` : ''}`,
      });
    } catch { /* run-events is best-effort; never block the run */ }

    const stopHeartbeat = startWorkflowHeartbeat(workflow.data.name, run.id, Date.now());
    try {
      const { finalOutput, forEachFailures, qualityAdvisories } = await executeWorkflow(workflow.data, workflow.name, run.id, inputs, assistant, run.targetStepId);
      throwIfWorkflowRunCancelled(run.id);
      const resume = computeResumeState(workflow.name, run.id);
      const stepOutputs = stringifyOutputs(Object.fromEntries(resume.completedSteps));
      appendWorkflowEvent(workflow.name, run.id, { kind: 'run_completed' });

      // Self-heal: a step that returned {blocked:true} ran cleanly but
      // could not finish its job. Today that still marks "completed" and
      // dumps raw JSON. Detect it, diagnose the root cause, and offer a
      // fix — instead of silently reporting a misleading success.
      const blockedSteps = detectBlockedSteps(stepOutputs, workflow.data.steps.map((s) => s.id));

      // Workflow-level "did we reach the target?" judge (fail-open,
      // conservative, DETECTION-ONLY, ADVISORY). A background workflow is only
      // valuable if its final deliverable is exactly what the user needs — so
      // audit the deliverable against the workflow's declared target + this
      // run's inputs. A CONFIDENT miss records a NON-FAILING quality advisory
      // that rides along with the delivered output: the run still completes and
      // DELIVERS its result, but honestly flags "couldn't confirm the target."
      // It NEVER fails the run, NEVER hides the deliverable, and NEVER re-runs
      // the workflow (a blind re-run could double irreversible side effects) —
      // so a confident-but-wrong verdict can never break a workflow that
      // actually succeeded. Skipped for partial single-step re-runs and runs
      // with no deliverable; fully fail-open.
      const baseSuccessBody = renderSuccessBody({
        steps: workflow.data.steps,
        stepOutputs,
        finalOutput,
        hasSynthesis: Boolean(workflow.data.synthesis?.prompt) && !run.targetStepId,
      });
      let targetVerdict: WorkflowTargetVerdict | null = null;
      try {
        targetVerdict = await judgeWorkflowTarget({
          workflow: workflow.data,
          inputs,
          finalOutput,
          fallbackBody: baseSuccessBody,
          isPartialRun: Boolean(run.targetStepId),
        });
      } catch { /* fail-open: a target-judge error never affects a completed run */ }
      if (targetVerdict && targetVerdict.judged && !targetVerdict.reached) {
        qualityAdvisories.push({
          stepId: '(workflow target)',
          kind: 'target_missed',
          note: `couldn't confirm this run reached the workflow's target: ${targetVerdict.gap}`,
        });
        logger.info(
          { workflow: workflow.data.name, runId: run.id, gap: targetVerdict.gap },
          'Workflow target check flagged a possible miss — surfacing as a non-failing advisory',
        );
      }

      // Only GENUINE blocks (explicit {blocked:true} / prose) are routed to the
      // Doctor — its remedies (rewrite the prompt, reconnect a service, fix an
      // input) presume a prompt/connection/input cause. A step that RAN but
      // self-reported a failure (validationStatus:"fail", ok:false — usually
      // missing data or an unprovisioned provider) is a real outcome, not a bad
      // prompt; diagnosing it would auto-propose a bogus prompt rewrite. Such
      // steps still mark the run needs-attention (reports-back), just without a
      // fix offer.
      const diagnosableBlocks = blockedSteps.filter((b) => b.kind === 'blocked');
      let diagnosis: WorkflowDiagnosis | null = null;
      let proposedFix: ProposedFix | null = null;
      if (diagnosableBlocks.length > 0 && selfHealEnabled()) {
        diagnosis = await diagnoseWorkflowBlock({
          workflow: workflow.data,
          blockedSteps: diagnosableBlocks,
          // The step's blocked reason usually carries the real tool error.
          toolErrors: diagnosableBlocks.map((b) => b.reason),
        });
        if (diagnosis) {
          proposedFix = recordProposedFix(workflow.name, run.id, diagnosis);
        }
      }
      const needsAttention = blockedSteps.length > 0;

      writeRunRecord(filePath, {
        ...run,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        stepOutputs,
        output: finalOutput,
        ...(needsAttention
          ? { needsAttention: true, blockedSteps, proposedFixId: proposedFix?.id ?? null }
          : {}),
      });

      // Bounded autonomous self-heal: a step blocked with an auto-applicable
      // prompt-rewrite fix → apply it and re-run automatically (bounded +
      // side-effect-guarded). When it fires, report the heal + re-run and STOP
      // here: the original run is terminal (above), and the FRESH re-run reports
      // its own outcome (and re-enters the origin chat via carried origin). We
      // skip the normal needs-attention notification/offer to avoid double-msging.
      if (needsAttention) {
        const healed = tryAutoHealAndRequeue({
          run,
          workflowSlug: workflow.name,
          steps: workflow.data.steps,
          diagnosis,
          proposedFix,
          completedStepIds: new Set(resume.completedSteps.keys()),
        });
        if (healed) {
          addNotification({
            id: `workflow-${run.id}-selfheal`,
            kind: 'workflow',
            title: `Auto-healing workflow: ${workflow.data.name}`,
            body: `🔧 ${healed.message}`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { workflow: workflow.data.name, runId: run.id, selfHeal: true, attempt: healed.attempt },
          });
          markRunNotified(filePath);
          try {
            finishRun(run.id, {
              status: 'completed',
              message: `Auto-healing — re-running (attempt ${healed.attempt}/${healed.max})`,
              outputPreview: healed.message.slice(0, 800),
            });
          } catch { /* best-effort */ }
          // Gap E: also tell the origin chat in-context that we're healing +
          // re-running (the fresh run carries originSessionId and will report its
          // own final outcome). No-op for scheduled/cron runs.
          enqueueWorkflowOutcomeTurn(run, workflow.data.name, 'blocked', healed.message);
          logger.info({ workflow: workflow.data.name, runId: run.id, attempt: healed.attempt }, 'Workflow run auto-healed and re-queued');
          return;
        }
      }

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

      // Legible reporting: when steps blocked, say "needs attention" (not
      // "completed") and explain in plain language — with the diagnosis +
      // fix offer when self-heal produced one. Otherwise today's body.
      // Success body: human-readable (synthesis prose or humanized step
      // results), never a raw JSON dump of the step bookkeeping.
      const successBody = `${baseSuccessBody}${failureSummary}`;
      // Non-failing quality advisories (skill-execution misses + target-miss):
      // appended to whichever body we send so the deliverable is ALWAYS shown,
      // with a clear "review this" heads-up after it. Never replaces the body.
      const hasAdvisories = qualityAdvisories.length > 0;
      const advisorySummary = hasAdvisories
        ? `\n\n⚠️ Quality check (the result above is delivered — please review):\n${qualityAdvisories
            .slice(0, 5)
            .map((a) => `- ${a.note}`)
            .join('\n')}${qualityAdvisories.length > 5 ? `\n(+${qualityAdvisories.length - 5} more)` : ''}`
        : '';
      const outcome = renderLegibleOutcome({
        workflowName: workflow.data.name,
        blockedSteps,
        diagnosis,
        fixId: proposedFix?.id ?? null,
        fallbackBody: successBody,
      });
      // A self-notifying workflow (a step called notify_user) would otherwise
      // double-post to Discord: once from the step, once from this runner
      // completion. When the run SUCCEEDED and a step already surfaced a
      // user-facing notification for THIS run, make the runner's completion
      // dashboard-only (silent) to avoid the duplicate. A needs-attention run
      // ALWAYS delivers — reports-back must never be silenced.
      const stepAlreadyNotified = shouldSilenceCompletionEcho({
        needsAttention,
        runId: run.id,
        notifications: loadNotifications(),
      });
      addNotification({
        id: `${Date.now()}-workflow-${run.id}`,
        kind: 'workflow',
        title: hasFailures && !needsAttention
          ? `Workflow completed with ${forEachFailures.length} failure${forEachFailures.length === 1 ? '' : 's'}: ${workflow.data.name}`
          : outcome.title,
        // Send the full body. Discord delivery splits long content into
        // multiple messages; previous 2000-char slice cut off workflow
        // results above that length with no continuation. Quality advisories
        // are appended to whichever body we send (never replace the deliverable).
        body: `${needsAttention ? outcome.body : successBody}${advisorySummary}`,
        createdAt: new Date().toISOString(),
        read: false,
        // Advisories must reach the user — never silence a run that has one.
        silent: stepAlreadyNotified && !hasAdvisories,
        metadata: {
          workflow: workflow.data.name,
          runId: run.id,
          forEachFailures: hasFailures ? forEachFailures : undefined,
          needsAttention: needsAttention || undefined,
          proposedFixId: proposedFix?.id,
          qualityAdvisories: hasAdvisories ? qualityAdvisories : undefined,
        },
      });
      markRunNotified(filePath);
      try {
        finishRun(run.id, {
          status: 'completed',
          message: needsAttention
            ? `Needs attention — ${blockedSteps.length} step${blockedSteps.length === 1 ? '' : 's'} blocked`
            : `Completed${hasFailures ? ` with ${forEachFailures.length} item failure${forEachFailures.length === 1 ? '' : 's'}` : ''}${hasAdvisories ? ` · ${qualityAdvisories.length} quality advisory${qualityAdvisories.length === 1 ? '' : 'ies'}` : ''}`,
          outputPreview: `${(needsAttention ? outcome.body : successBody)}${advisorySummary}`.slice(0, 800),
        });
      } catch { /* best-effort */ }
      // Gap E: re-enter the origin chat in-context (no-op for scheduled/cron).
      // needs-attention OR a quality advisory → 'blocked' so Clem knows to
      // review; a clean run → 'done'.
      enqueueWorkflowOutcomeTurn(
        run,
        workflow.data.name,
        needsAttention || hasAdvisories ? 'blocked' : 'done',
        `${needsAttention ? outcome.body : successBody}${advisorySummary}`,
      );
      logger.info({ workflow: workflow.data.name, runId: run.id, partialFailures: forEachFailures.length, blockedSteps: blockedSteps.length, advisories: qualityAdvisories.length, diagnosed: !!diagnosis }, 'Workflow run completed');
    } catch (error) {
      // P0 parking: the run paused on a human approval. Checkpoint the
      // resume coordinates as status='parked' and RETURN — this is NOT a
      // failure. processOneRunFile returning frees the bounded-pool slot;
      // `reapResolvedParkedRuns` flips the run back to 'running' once every
      // watched approval clears, and the next drain resumes from the
      // parked step (events.jsonl drives resume, so completed steps are
      // never re-run). The heartbeat is torn down in the finally below.
      if (error instanceof ParkRunSignal) {
        const parkedAt = new Date().toISOString();
        const approvalIds = error.parkedSteps.flatMap((step) => step.approvalIds);
        writeRunRecord(filePath, {
          ...run,
          status: 'parked',
          startedAt: run.startedAt ?? new Date().toISOString(),
          parked: { parkedSteps: error.parkedSteps, parkedAt },
        });
        // Belt-and-suspenders: the user-facing approval ask is normally posted
        // upstream in runStepViaHarness, but that post is gated + best-effort.
        // Re-emit it here with the SAME stable id `approval-<approvalId>` so
        // addNotification dedupes to a no-op when the upstream card landed, and
        // a RECOVERY post when it didn't — so a parked run never goes silent
        // until the 1h watchdog floor. (Not markRunNotified: parked isn't
        // terminal; the run resumes and reports back on completion.)
        for (const approvalId of approvalIds) {
          try {
            addNotification({
              id: `approval-${approvalId}`,
              kind: 'approval',
              title: `Workflow ${workflow.data.name} needs approval`,
              body: `This workflow is parked until you respond. Reply \`approve ${approvalId}\` or \`reject ${approvalId}\`.`,
              createdAt: new Date().toISOString(),
              read: false,
              metadata: { approvalId, runId: run.id, workflowName: workflow.data.name },
            });
          } catch { /* best-effort recovery card — never block parking */ }
        }
        try {
          finishRun(run.id, {
            status: 'awaiting_approval',
            message: `Workflow is waiting for approval: ${error.parkedSteps.map((step) => step.stepId).join(', ') || 'approval step'}`,
            pendingApprovalId: approvalIds[0],
            outputPreview: 'This workflow is parked until you approve or reject the pending approval.',
          });
        } catch {
          try {
            addRunEvent(run.id, {
              type: 'approval_required',
              status: 'awaiting_approval',
              message: 'Workflow is waiting for approval.',
              data: {
                workflow: workflow.data.name,
                parkedSteps: error.parkedSteps.map((step) => step.stepId),
                approvalIds,
              },
            });
          } catch { /* run-events is best-effort; never block parking */ }
        }
        logger.info(
          { workflow: workflow.data.name, runId: run.id, parkedSteps: error.parkedSteps.map((p) => p.stepId) },
          'Workflow run parked on approval — bounded-pool slot released',
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof WorkflowRunCancelledError || isWorkflowRunCancelled(run.id);
      logger[cancelled ? 'info' : 'error']({ err: error, file }, cancelled ? 'Workflow run cancelled' : 'Workflow run failed');
      appendWorkflowEvent(workflow.name, run.id, { kind: cancelled ? 'run_cancelled' : 'run_failed', error: message });
      writeRunRecord(filePath, {
        ...run,
        status: cancelled ? 'cancelled' : 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      // Contract-aware self-heal: a step that FAILED its declared output
      // contract throws to here (contract failures throw, so they bypass the
      // success-with-blocked diagnosis above). Route it to the Doctor for an
      // approval-gated fix offer + a legible message. Additive + gated: only
      // when self-heal is on AND a real contract violation is found, so
      // non-contract / cancelled failures are byte-identical to before.
      let healTitle: string | undefined;
      let healBody: string | undefined;
      let healFixId: string | null = null;
      if (!cancelled && selfHealEnabled()) {
        try {
          const cv = findContractViolationStep(readWorkflowEvents(workflow.name, run.id));
          if (cv) {
            const blocked: BlockedStep[] = [{
              stepId: cv.stepId,
              reason: `output contract violation: ${cv.problems.join('; ') || message}`,
              kind: 'blocked',
            }];
            const diagnosis = await diagnoseWorkflowBlock({
              workflow: workflow.data,
              blockedSteps: blocked,
              toolErrors: cv.problems.length ? cv.problems : [message],
            });
            if (diagnosis) {
              healFixId = recordProposedFix(workflow.name, run.id, diagnosis)?.id ?? null;
              const outcome = renderLegibleOutcome({
                workflowName: run.workflow,
                blockedSteps: blocked,
                diagnosis,
                fixId: healFixId,
                fallbackBody: message,
              });
              healTitle = outcome.title;
              healBody = outcome.body;
            }
          }
        } catch (healErr) {
          logger.warn({ err: healErr, runId: run.id }, 'contract-violation self-heal failed (best-effort)');
        }
      }
      addNotification({
        // Stable id (terminal state fires once per run): addNotification
        // id-dedup makes this at-most-once and shares the cancelled id with the
        // drain-path helper so the two can never double-post the same cancel.
        id: `workflow-${run.id}-${cancelled ? 'cancelled' : 'error'}`,
        kind: 'workflow',
        title: healTitle ?? (cancelled ? `Workflow cancelled: ${run.workflow}` : `Workflow failed: ${run.workflow}`),
        body: healBody ?? message,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          workflow: run.workflow,
          runId: run.id,
          status: cancelled ? 'cancelled' : 'error',
          ...(healFixId ? { proposedFixId: healFixId, needsAttention: true } : {}),
        },
      });
      markRunNotified(filePath);
      // Gap E: re-enter the origin chat on a genuine FAILURE (no-op for
      // scheduled/cron). Skip a user-initiated CANCEL — the user already knows
      // (mirrors background-tasks skipping aborted).
      if (!cancelled) {
        enqueueWorkflowOutcomeTurn(run, run.workflow, 'failed', healBody ?? message);
      }
      try {
        finishRun(run.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Workflow run cancelled' : `Workflow failed: ${message}`,
          error: cancelled ? undefined : message,
        });
      } catch { /* best-effort */ }
    } finally {
      stopHeartbeat();
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
