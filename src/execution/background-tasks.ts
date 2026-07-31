import { randomBytes } from 'node:crypto';
import { getSavedClis } from '../runtime/saved-clis.js';
import { readConnectedClis } from '../integrations/cli-catalog/catalog.js';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  BASE_DIR,
  MODELS,
  DISCORD_BOT_TOKEN,
  DISCORD_DM_ALLOWED_USERS,
  DISCORD_ENABLED,
  SLACK_ALLOWED_USERS,
  SLACK_BOT_TOKEN,
  SLACK_ENABLED,
} from '../config.js';
import { addNotification, markNotificationsReadByQuestionId } from '../runtime/notifications.js';
import {
  deliverOutcome,
  type Outcome,
  type OutcomeEvidence,
} from '../runtime/outcome.js';
import { humanizeReportBody } from '../runtime/report-voice.js';
import { redactSensitiveText } from '../runtime/security.js';
import { getGoalPinForDelegation, getActiveGoalForSession } from '../agents/plan-proposals.js';
import { deliverableProbesEnabled, extractDeliverables, probeSessionDeliverables } from './deliverable-probe.js';
import { ExecutionStore } from './store.js';
import type { AssistantResponse, RunStoppedReason } from '../types.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { addRunEvent, finishRun as persistFinishRun, getRun, startRun } from '../runtime/run-events.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { getBackgroundCheckInMs, loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { openPlanScope } from '../agents/plan-scope.js';
import { fanoutLedgerEnabled, summarizeFanoutCoverage, clearLedger } from '../runtime/harness/fanout-ledger.js';
import { listRunArtifacts } from '../runtime/harness/artifact-ledger.js';
import { resetFanoutWindow, sweepFanoutReduce } from '../runtime/harness/fanout-reduce.js';
import { classifyBlocker, matchesBlockedText, type BlockerType } from '../runtime/harness/verify-delivered.js';
import { verifyFanoutItems, fanoutItemVerifyEnabled, verifyInlineRecovery } from '../runtime/harness/fanout-item-verify.js';
import { isPromiseShapedReply, judgeRunProgress } from '../runtime/harness/objective-judge.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { emitApprovalRequestedCard } from '../runtime/harness/approval-card.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { renderSessionHistoryForModel } from '../runtime/harness/session-transcript.js';
import { resolveWriteEvidence } from '../runtime/harness/work-report.js';
import { classifyTurnText } from '../runtime/harness/turn-decision.js';
import { getSession as getHarnessSessionRow, createSession as createHarnessSession, appendEvent, listEvents as listHarnessEventsForRefute, getSessionTokensUsed } from '../runtime/harness/eventlog.js';
import { getHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { budgetLineFor, resolveRunTokenCeiling, runTokenBudgetEnforcementEnabled } from '../runtime/harness/run-token-budget.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import { recordOperationalEvent, type OperationalEventSeverity } from '../runtime/operational-telemetry.js';
import { getWorkspaceDirs } from '../tools/shared.js';
import { classifyModelError } from '../runtime/harness/resilient-model.js';
import { capacityAdvice } from '../runtime/harness/capacity-advisor.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { recordRunStrategy } from '../memory/run-strategy-store.js';
import { updateLinkedFocusAction } from '../memory/focus.js';
import {
  evaluateLearningCandidate,
  recordLearningDecision,
} from '../memory/learning-receipt.js';
import { stepLooksLikeIrreversibleSend } from './workflow-enforce.js';
import { detectStructuredToolFailure } from '../runtime/harness/tool-error-corrective.js';
import {
  reviseWorkContract,
  summarizeWorkManifests,
  type WorkManifestSummary,
} from '../runtime/harness/work-manifest.js';
import { backgroundProspectiveDefinition } from '../runtime/prospective-adapters.js';
import {
  cancelProspectiveIntention,
  prospectiveIntentionId,
  recordProspectiveOutcome,
  upsertProspectiveIntention,
} from '../runtime/prospective-intentions.js';

const logger = pino({ name: 'clementine-next.background-tasks' });

/** A worker has one terminal owner. Verification/report-back failures after a
 * terminal write must not append a second contradictory completion event. */
function finishRun(
  runId: Parameters<typeof persistFinishRun>[0],
  input: Parameters<typeof persistFinishRun>[1],
): ReturnType<typeof persistFinishRun> {
  if (runId) {
    const existing = getRun(runId);
    if (existing && (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled')) {
      return existing;
    }
  }
  return persistFinishRun(runId, input);
}

let backgroundCompletionVerificationPauseForTests: (() => Promise<void>) | null = null;
export function _setBackgroundCompletionVerificationPauseForTests(fn: (() => Promise<void>) | null): void {
  backgroundCompletionVerificationPauseForTests = fn;
}

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'awaiting_approval'
  | 'done'
  // 'blocked' = the run stopped because it could NOT finish the objective
  // (missing data, missing access, an unmet prerequisite) — distinct from
  // 'done' (succeeded), 'failed' (errored), and 'awaiting_approval'
  // (paused on a decision it can resume from). A blocked task must report
  // honestly and wait for the user; it is NEVER reported as done and is
  // NOT auto-resumed. Added 2026-05-30 after a task shipped an empty
  // Google Sheet because the Salesforce pull came back empty yet the run
  // still marked itself 'done'.
  | 'blocked'
  // 'awaiting_continue' = the worker hit an INTERNAL run/turn budget after
  // bounded automatic continuations. This is not a true external blocker and
  // not a completed result; the same task can be resumed with a continuation
  // prompt from the board or originating chat.
  | 'awaiting_continue'
  // 'awaiting_input' = the run paused to ask the user a CLARIFYING QUESTION
  // (ask_user_question, e.g. a judge/gate decided it needs validation) — it can
  // RESUME from the answer, like 'awaiting_approval' but carrying freeform text
  // instead of approve/reject. Distinct so a needed question is never swallowed
  // as 'done' (the 2026-06-21 "tasks get lost" root cause). Not terminal; not
  // auto-resumed until the user answers.
  | 'awaiting_input'
  | 'failed'
  | 'aborted'
  | 'interrupted';

export interface BackgroundTaskOutcomeSnapshot {
  version: 1;
  capturedAt: string;
  evidence?: OutcomeEvidence;
  blocker?: string;
  nextAction?: string;
  resumable?: boolean;
}

export interface BackgroundTaskRecord {
  id: string;
  title: string;
  prompt: string;
  status: BackgroundTaskStatus;
  originSessionId?: string;
  /** Durable provenance for a user-initiated foreground → background handoff.
   * The exact attempt id is also the idempotency key: transport replays and
   * double-clicks must rejoin this task instead of starting a second worker. */
  foregroundHandoff?: {
    sessionId: string;
    attemptId: string;
    runId?: string;
    sourceUserSeq: number;
    /** Inclusive event-log boundary captured when the user requested the
     * handoff. Later turns in the reusable origin chat are not worker input. */
    throughSeq: number;
  };
  runSessionId: string;
  /** User-visible, monotonic task contract. The original prompt is v1; later
   * revisions are appended instead of rewriting history. A run that finishes
   * against an older version is superseded and re-queued on the same session. */
  contractVersion?: number;
  contractRevisions?: BackgroundTaskContractRevision[];
  pendingContractRevision?: BackgroundTaskContractRevision;
  userId?: string;
  channel?: string;
  reportBackTarget?: BackgroundReportBackTarget;
  /** Requested model at enqueue/drain time. `model` is the legacy requested slot;
   *  these explicit fields make fallback/fallover diagnostics legible. */
  requestedModel?: string;
  model?: string;
  effectiveModel?: string;
  modelProvider?: string;
  modelRouteKind?: string;
  modelTransport?: string;
  modelRouteFalloverFrom?: string;
  /** A brain-infrastructure outage (429/529/quota) is a property of the
   *  PROVIDER, not the task — when the routing mode leaves no brain to fall
   *  over to (all_in isolation), the task waits it out and retries instead of
   *  terminal-failing (live 2026-07-22: an approved send died as "failed" on a
   *  BYO 429). Bounded: attempts caps the requeues; notBefore holds the drain
   *  off until the limit plausibly cleared. */
  transientRetry?: { attempts: number; notBefore: string; lastError: string };
  maxMinutes: number;
  /** Stage 4 — optional per-task run token budget (UNCACHED tokens, soft
   *  ceiling; parks awaiting_continue when the window is exhausted). Absent
   *  ⇒ the preset/env default applies. */
  maxTokens?: number;
  source: 'discord' | 'slack' | 'webhook' | 'cli' | 'gateway' | 'daemon' | 'mobile' | 'workflow' | 'desktop';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  resultPath?: string;
  error?: string;
  /** Evidence-first report-back captured at the latest settle/park boundary.
   * This is runtime-owned execution truth, not a second model verdict. It
   * survives replay, daemon restart, and weak final prose. */
  outcomeSnapshot?: BackgroundTaskOutcomeSnapshot;
  pendingApprovalId?: string;
  /** One-shot guard: set when the settle auto-queued a continuation because a
   *  completion lacked deliverable evidence (2026-07-23). A second artifact-less
   *  completion blocks honestly instead of looping. */
  deliverableContinueQueuedAt?: string;
  approvalResolution?: {
    approvalId: string;
    approved: boolean;
    queuedAt: string;
  };
  /** Parked clarifying question (status 'awaiting_input'), twin of
   *  pendingApprovalId/approvalResolution but carrying freeform Q&A. */
  pendingQuestionId?: string;
  /** Structured auth-recovery tag: the ROSTER CLI command whose auth/absence
   * parked this task. Set only at park time from a permission-classified
   * blocker naming a roster CLI — never inferred later from free text. The
   * auth-recovery sweep resumes ONLY tagged tasks. */
  blockedOnCli?: string;
  pendingQuestion?: string;
  inputResolution?: {
    questionId: string;
    answer: string;
    queuedAt: string;
  };
  continueResolution?: {
    queuedAt: string;
    reason?: string;
    auto?: boolean;
  };
  resumedFromTaskId?: string;
  resumeCount?: number;
  /** Set on a resumed-from task once a resume has been spawned, so the
   *  boot-time auto-resumer never re-spawns the same interrupted task on
   *  every restart. */
  resumedIntoTaskId?: string;
  /** Durable recovery decision. Interrupted, failed, and aborted retries keep
   * their original runSessionId so the external-write/receipt ledger remains
   * visible. Boot may only resume a session whose durable history proves it
   * never reached an external-write boundary; every other shape is parked for
   * human verification and can be resumed explicitly, still in place. */
  restartRecovery?: {
    disposition: 'auto_resumed_in_place' | 'parked_for_verification' | 'manual_resumed_in_place';
    reason: 'safe_no_external_write' | 'external_write_history' | 'ambiguous_external_write' | 'receipt_history_unavailable';
    decidedAt: string;
    externalWriteCount: number;
    ambiguousWriteCount: number;
  };
  lastCheckInAt?: string;
  lastCheckInMessage?: string;
  progressCheckIns?: number;
  cancellationRequestedAt?: string;
  cancellationReason?: string;
  /** Soft-delete: an archived task drops off the active board and out of every
   *  active sweep (drain/resume/watchdog) but its record is KEPT and restorable.
   *  Recoverable by design — a misclick or a wrong heartbeat call never loses a
   *  task. Set by archiveBackgroundTask, cleared by restoreBackgroundTask. */
  archived?: boolean;
  archivedAt?: string;
  /** WHY it was archived when the user didn't do it themselves (the auto-expiry
   *  sweep records itself here) — surfaced in the task detail so nothing ever
   *  just silently vanishes. Cleared on restore. */
  archiveReason?: string;
}

export interface BackgroundTaskContractRevision {
  version: number;
  instruction: string;
  evidencePolicy: 'preserve' | 'revalidate' | 'invalidate';
  queuedAt: string;
  appliedAt?: string;
}

export interface CreateBackgroundTaskInput {
  title: string;
  prompt: string;
  /**
   * The CHAT session that spawned this task, if any. On completion the task's
   * result is fed back into THIS session's transcript (see
   * enqueueBackgroundTaskResultTurn) so Clementine resumes from it. Pass it
   * whenever a task is kicked off from an interactive session. Leave undefined
   * for autonomous/cron spawns (meeting analysis, maintenance) that have no
   * session to wake — those report back only via notification.
   */
  originSessionId?: string;
  foregroundHandoff?: BackgroundTaskRecord['foregroundHandoff'];
  userId?: string;
  channel?: string;
  reportBackTarget?: BackgroundReportBackTarget;
  model?: string;
  maxMinutes?: number;
  /** Stage 4 — per-task run token budget override (UNCACHED tokens). */
  maxTokens?: number;
  source?: BackgroundTaskRecord['source'];
  resumedFromTaskId?: string;
  resumeCount?: number;
}

export type BackgroundReportBackTarget =
  // The in-app chat that spawned the task (desktop/console/mobile). Report-back
  // is delivered INTO that session's transcript (enqueueBackgroundTaskOutcomeTurn)
  // — there is NO external push, so this must never fall through to a Discord/Slack
  // DM (the live 2026-07-08 "cockpit says no target but it went to Discord" defect).
  | { type: 'origin_chat' }
  | { type: 'discord_user'; userId: string }
  | { type: 'discord_channel'; channelId: string }
  | { type: 'slack_user'; userId: string }
  | { type: 'slack_channel'; channelId: string; threadTs?: string };

const BACKGROUND_TASK_DIR = path.join(BASE_DIR, 'state', 'background-tasks');
const RESULT_TRUNCATE_CHARS = 4000;
const PROGRESS_CHECKIN_TOOL_INTERVAL = 5;

// P0-B — per-call wall-clock for a background worker turn. Without this the
// worker inherits the 120s chat default and a legitimate >2-min synthesis turn
// is guillotined (the 2026-06-04 email-audit abort). Env-tunable, floored 60s.
const BACKGROUND_STEP_WALL_CLOCK_MS = (() => {
  const raw = parseInt(process.env.CLEMENTINE_BACKGROUND_STEP_WALL_MS || '', 10);
  return Number.isNaN(raw) ? 10 * 60_000 : Math.max(60_000, raw);
})();
const BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP = (() => {
  const raw = parseInt(process.env.CLEMENTINE_BACKGROUND_TURN_AUTO_CONTINUES || '', 10);
  if (Number.isNaN(raw)) return 4;
  return Math.max(0, Math.min(24, raw));
})();
// Wave 3 Move A: past the free auto-continue cap, a run that is VERIFIABLY
// PROGRESSING (independent cross-family progress judge) may self-resume up to this
// HARD ceiling instead of parking awaiting_continue — so a genuinely-advancing
// 60-min task finishes unattended. Absolute bounds remain: the 240-min wall clock
// (shouldCancel) and this ceiling; the judge FAILS CLOSED (park) on any doubt.
// Kill-switch CLEMMY_BACKGROUND_SELF_RESUME=off restores hard-park at the cap.
const BACKGROUND_SELF_RESUME_HARD_CAP = (() => {
  const raw = parseInt(process.env.CLEMMY_BACKGROUND_SELF_RESUME_CAP || '', 10);
  if (Number.isNaN(raw)) return 24;
  return Math.max(BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP, Math.min(200, raw));
})();
function backgroundSelfResumeEnabled(): boolean {
  return (process.env.CLEMMY_BACKGROUND_SELF_RESUME ?? 'on').toLowerCase() !== 'off';
}

/** PURE decision for whether a budget-exhausted background run should self-resume,
 *  BEFORE the (expensive, network) progress judge. Returns a concrete resume/park
 *  verdict for the cheap cases, or {needJudge:true} when only an independent
 *  progress judge can decide. Fail-safe by construction: disabled, at the hard
 *  ceiling, or a cycle with no new tool activity all → park. Exported + tested. */
export function selfResumeDecision(p: {
  /** Stage 4 — the run's aggregate token window is exhausted: park
   *  unconditionally (a user continue is the only re-arm; checked FIRST so
   *  neither the hard cap nor the progress judge can override it). */
  budgetExhausted?: boolean;
} & {
  enabled: boolean;
  autoContinueAttempts: number;
  hardCap: number;
  cycleToolCalls: number;
}): { resume?: boolean; needJudge?: boolean; reason: string } {
  if (p.budgetExhausted) return { resume: false, reason: 'run token budget exhausted — user continue required' };
  if (!p.enabled) return { resume: false, reason: 'self-resume disabled' };
  if (p.autoContinueAttempts >= p.hardCap) return { resume: false, reason: `hard self-resume ceiling reached (${p.hardCap})` };
  if (p.cycleToolCalls <= 0) return { resume: false, reason: 'no new tool activity this cycle' };
  return { needJudge: true, reason: 'progress check required' };
}

/** Test seam for the progress judge (a real cross-family model call in prod). */
type RunProgressJudgeFn = typeof judgeRunProgress;
let runProgressJudgeImpl: RunProgressJudgeFn = judgeRunProgress;
export function _setRunProgressJudgeForTests(fn: RunProgressJudgeFn | null): void {
  runProgressJudgeImpl = fn ?? judgeRunProgress;
}
const DAEMON_RESTART_INTERRUPT_REASON = 'Daemon restarted while task was running.';
const RESTART_VERIFICATION_ERROR =
  'Daemon restarted after this task reached or may have reached an external-write boundary. Verify the external outcome before resuming; recovery will continue on the original receipt-bearing run session.';
let backgroundProcessorInFlight = false;

// ── Immediate drain kick ──────────────────────────────────────────────────────
// A newly enqueued background task used to fire ONLY on the daemon's 15s tick (or
// never, if the daemon loop isn't running in-process), so "run in the background"
// left a `pending` record that never executed, never turned RUNNING on the board,
// and had no harness session to expand (2026-06-30 live). The daemon owns the
// `assistant` handle, so it registers a kick here on boot; the enqueue choke point
// (enqueueDurableChatTask) requests an immediate drain. Best-effort: if no daemon
// loop registered a kick (e.g. a dashboard-only process), the task still drains on
// the next tick / restart — never worse than before. Kill-switch CLEMMY_BG_DRAIN_KICK.
let backgroundDrainKick: ((limit?: number) => void) | null = null;

/** Called once by the daemon runner (which owns `assistant`) to wire the immediate
 *  drain path. */
export function registerBackgroundDrainKick(fn: (limit?: number) => void): void {
  backgroundDrainKick = fn;
}

/** Request an immediate single-task drain right after enqueue, instead of waiting
 *  for the daemon's 15s tick. No-op when no kick is registered. */
export function requestBackgroundDrain(limit = 1): void {
  if ((process.env.CLEMMY_BG_DRAIN_KICK ?? 'on').toLowerCase() === 'off') return;
  const fn = backgroundDrainKick;
  if (!fn) return;
  try {
    fn(limit);
  } catch {
    /* the 15s tick remains the backstop */
  }
}

function ensureTaskDir(): void {
  mkdirSync(BACKGROUND_TASK_DIR, { recursive: true });
  if (process.platform !== 'win32') {
    // Persist the whole fresh-tree chain. Fsyncing only background-tasks/ and
    // state/ still lets a power loss forget state/'s entry in BASE_DIR.
    let cursor = BACKGROUND_TASK_DIR;
    while (true) {
      const dirFd = openSync(cursor, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      if (cursor === path.dirname(BASE_DIR)) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Mirror a background-task lifecycle transition into the operational-telemetry
 * store so the dashboard / Slack / Discord can show background work in flight,
 * parked, and finished — the eventlog is dark for these standalone tasks. The
 * `created` event correlates to the ORIGIN chat session; every later transition
 * correlates to the task's own run session (`background:<id>`). Fail-open.
 */
type BackgroundTaskOperationalType =
  | 'background_task_created'
  | 'background_task_started'
  | 'background_task_finished'
  | 'background_task_parked'
  | 'background_self_resume_check';

function emitBackgroundTaskOperational(
  type: BackgroundTaskOperationalType,
  task: BackgroundTaskRecord,
  payload: Record<string, unknown> = {},
  severity: OperationalEventSeverity = 'info',
): void {
  try {
    recordOperationalEvent({
      source: 'harness',
      type,
      severity,
      sessionId: type === 'background_task_created' ? task.originSessionId : task.runSessionId,
      actor: 'background-task',
      payload: { taskId: task.id, title: task.title, ...payload },
    });
  } catch {
    /* telemetry is best-effort — never break a task transition */
  }
}

function makeTaskId(now = new Date()): string {
  return `bg-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function clean(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Bound a result preview for the completion notification body — cutting at a
 * paragraph/sentence/word boundary (never mid-word) and marking the cut with
 * an ellipsis. The raw `.slice(0, N)` chopped mid-word and read like broken
 * output. Newlines are preserved (unlike `clean`) so a multi-paragraph report
 * keeps its shape. The full result is saved to disk (writeFullResultFile) and
 * the channel splitters fan long bodies across messages, so this is purely a
 * clean preview cap.
 */
export function truncateResultBody(result: string, max = RESULT_TRUNCATE_CHARS): string {
  if (result.length <= max) return result;
  const window = result.slice(0, max);
  let cut = window.lastIndexOf('\n\n');
  if (cut < max / 2) cut = window.lastIndexOf('\n');
  if (cut < max / 2) {
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (sentence > max / 2) cut = sentence + 1;
  }
  if (cut < max / 2) cut = window.lastIndexOf(' ');
  if (cut < max / 2) cut = max;
  return result.slice(0, cut).trimEnd() + ' …';
}

function taskFilePath(id: string): string {
  return path.join(BACKGROUND_TASK_DIR, `${id}.json`);
}

type BackgroundTaskPatch = Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>>;

/**
 * Task records use atomic rename for durability, but rename alone is not a CAS:
 * two daemon processes could both read `pending`, then a stale starter could
 * overwrite a cancellation with `running`. Serialize state transitions through
 * a per-task directory lease. `mkdir` is the cross-process compare-and-swap;
 * the token-scoped owner file prevents an old releaser/reclaimer from deleting a
 * newer lease generation (ABA).
 *
 * A live owner is waited on briefly because task transitions are synchronous and
 * tiny. An unreadable/ownerless lease fails closed. A dead, well-formed owner can
 * be reclaimed without weakening ownership.
 */
function taskTransitionLockDir(id: string): string {
  return `${taskFilePath(id)}.transition-lock`;
}

function transitionOwnerIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryReclaimDeadTaskTransitionOwner(lockDir: string): boolean {
  try {
    const owners = readdirSync(lockDir).filter((entry) => /^owner-[0-9]+-[a-f0-9]+\.json$/.test(entry));
    if (owners.length !== 1) return false;
    const ownerPath = path.join(lockDir, owners[0]);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf-8')) as { pid?: unknown; token?: unknown };
    if (typeof owner.pid !== 'number' || typeof owner.token !== 'string') return false;
    if (owners[0] !== `owner-${owner.pid}-${owner.token}.json`) return false;
    if (transitionOwnerIsAlive(owner.pid)) return false;
    // Only the reclaimer that successfully removes the exact observed token may
    // remove the directory. A competing stale reader gets ENOENT and stops,
    // rather than touching a successor's generation.
    unlinkSync(ownerPath);
    rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function acquireTaskTransitionLock(id: string): (() => void) | null {
  ensureTaskDir();
  const lockDir = taskTransitionLockDir(id);
  const deadline = Date.now() + 2_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(lockDir);
      const token = randomBytes(16).toString('hex');
      const ownerPath = path.join(lockDir, `owner-${process.pid}-${token}.json`);
      try {
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        try { rmdirSync(lockDir); } catch { /* fail closed on a partial lease */ }
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(readFileSync(ownerPath, 'utf-8')) as { pid?: unknown; token?: unknown };
          if (owner.pid !== process.pid || owner.token !== token) return;
          unlinkSync(ownerPath);
          rmdirSync(lockDir);
        } catch {
          // A missing/malformed owner fails closed; never remove an unverified
          // directory that might now belong to a successor.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (tryReclaimDeadTaskTransitionOwner(lockDir)) continue;
      if (Date.now() >= deadline) return null;
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
}

function withTaskTransitionLock<T>(id: string, fn: () => T): T | null {
  const release = acquireTaskTransitionLock(id);
  if (!release) return null;
  try {
    return fn();
  } finally {
    release();
  }
}

function writeTask(task: BackgroundTaskRecord): void {
  ensureTaskDir();
  const filePath = taskFilePath(task.id);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(task, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
    if (process.platform !== 'win32') {
      const dirFd = openSync(BACKGROUND_TASK_DIR, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
    syncBackgroundProspectiveIntention(task);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Mirror the authoritative task record into the rebuildable prospective index.
 * This is deliberately best-effort and runs only AFTER the task file is durable:
 * an indexing failure can never roll back, invent, or veto task execution.
 */
function syncBackgroundProspectiveIntention(task: BackgroundTaskRecord): void {
  try {
    const id = prospectiveIntentionId('background', task.id);
    const definition = backgroundProspectiveDefinition(task);
    if (definition) {
      upsertProspectiveIntention(definition);
      if (task.status === 'blocked') {
        recordProspectiveOutcome(id, 'blocked', {
          taskStatus: task.status,
          reason: task.error ?? 'background_task_blocked',
          resultPath: task.resultPath ?? null,
        });
      }
      return;
    }
    if (task.status === 'done') {
      recordProspectiveOutcome(id, 'completed', {
        taskStatus: task.status,
        success: true,
        resultPath: task.resultPath ?? null,
      });
    } else if (task.status === 'failed') {
      // The future commitment is to report back. A reported task failure
      // fulfills that commitment while preserving failure evidence.
      recordProspectiveOutcome(id, 'completed', {
        taskStatus: task.status,
        success: false,
        error: task.error ?? null,
      });
    } else if (task.status === 'aborted') {
      cancelProspectiveIntention(id, task.error ?? 'background_task_aborted');
    }
  } catch {
    // Materialized control-plane state is never task-persistence authority.
  }
}

function loadTaskFile(filePath: string): BackgroundTaskRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as BackgroundTaskRecord;
  } catch {
    return null;
  }
}

function parseTaskChannelForNotification(channel?: string): {
  discordChannelId?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
} {
  const parts = channel?.split(':') ?? [];
  if (parts[0] === 'discord') {
    return { discordChannelId: parts.length >= 2 ? parts[parts.length - 1] : undefined };
  }
  if (parts[0] === 'slack') {
    return {
      slackChannelId: parts[1],
      slackThreadTs: parts.length >= 3 ? parts.slice(2).join(':') : undefined,
    };
  }
  return {};
}

function normalizeReportBackTarget(target: BackgroundReportBackTarget | undefined): BackgroundReportBackTarget | undefined {
  if (!target) return undefined;
  if (target.type === 'origin_chat') return { type: 'origin_chat' };
  if (target.type === 'discord_user') {
    const userId = target.userId.trim();
    return userId ? { type: 'discord_user', userId } : undefined;
  }
  if (target.type === 'discord_channel') {
    const channelId = target.channelId.trim();
    return channelId ? { type: 'discord_channel', channelId } : undefined;
  }
  if (target.type === 'slack_user') {
    const userId = target.userId.trim();
    return userId ? { type: 'slack_user', userId } : undefined;
  }
  const channelId = target.channelId.trim();
  const threadTs = target.threadTs?.trim();
  return channelId ? { type: 'slack_channel', channelId, ...(threadTs ? { threadTs } : {}) } : undefined;
}

function defaultReportBackTarget(input: { source?: BackgroundTaskRecord['source']; userId?: string; channel?: string; originSessionId?: string }): BackgroundReportBackTarget | undefined {
  const source = input.source;
  const userId = input.userId?.trim();
  const channel = parseTaskChannelForNotification(input.channel);

  // Slack background work should report to the requester by default. A Slack
  // channel/thread route can bury a long-running task's completion where the
  // user does not get a clear unread DM.
  if (source === 'slack') {
    if (userId) return { type: 'slack_user', userId };
    if (channel.slackChannelId) {
      return {
        type: 'slack_channel',
        channelId: channel.slackChannelId,
        ...(channel.slackThreadTs ? { threadTs: channel.slackThreadTs } : {}),
      };
    }
  }

  // Discord background work reports back to the channel/DM it was started in.
  if (source === 'discord') {
    if (channel.discordChannelId) return { type: 'discord_channel', channelId: channel.discordChannelId };
    if (userId) return { type: 'discord_user', userId };
  }

  // Default = the origin channel of the session it was born from. An in-app chat
  // (desktop/console/mobile/gateway) reports back INTO that chat, so a desktop
  // task no longer resolves to "no explicit target" and silently leaks to a
  // Discord DM. Only tasks with a real origin session get this; a headless
  // cron/workflow spawn (no origin session) still returns undefined and falls to
  // the configured Discord/Slack fallback, which is the desired "you set the cron
  // from Discord, output shows in Discord" behavior.
  if (input.originSessionId && input.originSessionId.trim()) {
    return { type: 'origin_chat' };
  }

  return undefined;
}

function reportBackTargetMetadata(target: BackgroundReportBackTarget | undefined): Record<string, unknown> {
  if (!target) return {};
  if (target.type === 'origin_chat') {
    // In-app report-back: tag the type only. Deliberately NO discord/slack ids,
    // so notification routing resolves ZERO external destinations and the delivery
    // record settles terminal ("sent to origin chat") instead of queued forever.
    return { reportBackTargetType: target.type, reportBackTargetId: 'origin-chat' };
  }
  if (target.type === 'discord_user') {
    return {
      reportBackTargetType: target.type,
      reportBackTargetId: target.userId,
      discordUserId: target.userId,
    };
  }
  if (target.type === 'discord_channel') {
    return {
      reportBackTargetType: target.type,
      reportBackTargetId: target.channelId,
      discordChannelId: target.channelId,
    };
  }
  if (target.type === 'slack_user') {
    return {
      reportBackTargetType: target.type,
      reportBackTargetId: target.userId,
      slackUserId: target.userId,
    };
  }
  return {
    reportBackTargetType: target.type,
    reportBackTargetId: target.threadTs ? `${target.channelId}:${target.threadTs}` : target.channelId,
    slackChannelId: target.channelId,
    slackThreadTs: target.threadTs,
  };
}

function taskNotificationMetadata(task: BackgroundTaskRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const channel = parseTaskChannelForNotification(task.channel);
  const allowDiscordCheckIns = loadProactivityPolicy().allowDiscordCheckIns;
  const reportBackTarget = normalizeReportBackTarget(task.reportBackTarget)
    ?? defaultReportBackTarget({ source: task.source, userId: task.userId, channel: task.channel, originSessionId: task.originSessionId });
  const targetMetadata = reportBackTargetMetadata(reportBackTarget);
  return {
    backgroundTaskId: task.id,
    sessionId: task.originSessionId,
    runSessionId: task.runSessionId,
    userId: task.userId,
    channel: task.channel,
    originDiscordChannelId: channel.discordChannelId,
    originSlackChannelId: channel.slackChannelId,
    originSlackThreadTs: channel.slackThreadTs,
    discordUserId: targetMetadata.discordUserId ?? (allowDiscordCheckIns && task.channel?.startsWith('discord:') ? task.userId : undefined),
    discordChannelId: targetMetadata.discordChannelId ?? (allowDiscordCheckIns ? channel.discordChannelId : undefined),
    slackUserId: targetMetadata.slackUserId,
    slackChannelId: targetMetadata.slackChannelId ?? (!reportBackTarget ? channel.slackChannelId : undefined),
    slackThreadTs: targetMetadata.slackThreadTs ?? (!reportBackTarget ? channel.slackThreadTs : undefined),
    reportBackTargetType: targetMetadata.reportBackTargetType,
    reportBackTargetId: targetMetadata.reportBackTargetId,
    ...extra,
  };
}

export function backgroundTaskNotificationMetadata(
  task: BackgroundTaskRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return taskNotificationMetadata(task, extra);
}

export function setBackgroundTaskReportBackTarget(
  id: string,
  target: BackgroundReportBackTarget,
): BackgroundTaskRecord | null {
  const normalized = normalizeReportBackTarget(target);
  if (!normalized) return null;
  return updateBackgroundTask(id, { reportBackTarget: normalized });
}

/** Stable key for a report-back target — the value the console picker sends and
 *  the identity used to mark the current selection. */
export function reportBackTargetKey(target: BackgroundReportBackTarget): string {
  switch (target.type) {
    case 'origin_chat': return 'origin_chat';
    case 'discord_user': return `discord_user:${target.userId}`;
    case 'discord_channel': return `discord_channel:${target.channelId}`;
    case 'slack_user': return `slack_user:${target.userId}`;
    case 'slack_channel': return target.threadTs ? `slack_channel:${target.channelId}:${target.threadTs}` : `slack_channel:${target.channelId}`;
  }
}

/** Human label for a report-back target, for the cockpit display. */
export function describeReportBackTarget(target: BackgroundReportBackTarget): string {
  switch (target.type) {
    case 'origin_chat': return 'Originating chat';
    case 'discord_user': return 'Discord DM';
    case 'discord_channel': return `Discord channel ${target.channelId}`;
    case 'slack_user': return 'Slack DM';
    case 'slack_channel': return `Slack channel ${target.channelId}`;
  }
}

/** The EFFECTIVE report-back target for a task: its explicit target if set,
 *  otherwise the resolved default for its source/origin. Never guesses ids the
 *  task doesn't carry. */
export function resolveReportBackTarget(
  task: Pick<BackgroundTaskRecord, 'reportBackTarget' | 'source' | 'userId' | 'channel' | 'originSessionId'>,
): BackgroundReportBackTarget | undefined {
  return normalizeReportBackTarget(task.reportBackTarget)
    ?? defaultReportBackTarget({ source: task.source, userId: task.userId, channel: task.channel, originSessionId: task.originSessionId });
}

export interface ReportBackChannelOption {
  /** Stable key the /report-back-target POST accepts. */
  key: string;
  type: BackgroundReportBackTarget['type'];
  /** Human label for the picker. */
  label: string;
  /** Only connected/available channels are enumerated, so this is always true —
   *  emitted explicitly for the console picker's contract. */
  connected: boolean;
  /** True when this option is the task's current/effective target. */
  isDefault: boolean;
  /** The concrete target this option sets. */
  target: BackgroundReportBackTarget;
}

/**
 * Enumerate the report-back channels available as targets, discovered at RUNTIME
 * (never hardcoded ids): the originating chat is always available; a Discord or
 * Slack DM only when that surface is connected AND we know a user id to DM. When
 * a task is supplied, its effective target is flagged `selected`. This is the
 * source of truth for GET /api/console/report-back/channels.
 */
export function listReportBackChannelOptions(
  task?: Pick<BackgroundTaskRecord, 'reportBackTarget' | 'source' | 'userId' | 'channel' | 'originSessionId'>,
): ReportBackChannelOption[] {
  const options: ReportBackChannelOption[] = [
    { key: 'origin_chat', type: 'origin_chat', label: 'Originating chat', connected: true, isDefault: false, target: { type: 'origin_chat' } },
  ];
  if (DISCORD_ENABLED && DISCORD_BOT_TOKEN && DISCORD_DM_ALLOWED_USERS.length > 0) {
    const userId = DISCORD_DM_ALLOWED_USERS[0];
    options.push({ key: `discord_user:${userId}`, type: 'discord_user', label: 'Discord DM', connected: true, isDefault: false, target: { type: 'discord_user', userId } });
  }
  if (SLACK_ENABLED && SLACK_BOT_TOKEN && SLACK_ALLOWED_USERS.length > 0) {
    const userId = SLACK_ALLOWED_USERS[0];
    options.push({ key: `slack_user:${userId}`, type: 'slack_user', label: 'Slack DM', connected: true, isDefault: false, target: { type: 'slack_user', userId } });
  }
  const effective = task ? resolveReportBackTarget(task) : undefined;
  if (effective) {
    const effectiveKey = reportBackTargetKey(effective);
    let matched = false;
    for (const option of options) {
      if (reportBackTargetKey(option.target) === effectiveKey) { option.isDefault = true; matched = true; }
    }
    // A configured explicit target that isn't one of the runtime-discovered
    // options (e.g. a specific channel) is still surfaced as the current one.
    if (!matched) {
      options.push({ key: effectiveKey, type: effective.type, label: describeReportBackTarget(effective), connected: true, isDefault: true, target: effective });
    }
  }
  return options;
}

function emitBackgroundTaskCheckIn(
  task: BackgroundTaskRecord,
  input: {
    title: string;
    body: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  },
): BackgroundTaskRecord {
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    lastCheckInAt: now,
    lastCheckInMessage: clean(input.body, 700),
    progressCheckIns: (task.progressCheckIns ?? 0) + 1,
  }) ?? task;

  // All check-ins — task started, tool-progress heartbeats, cancellation
  // pings — are dashboard-only. The completed notification (which carries
  // the actual analysis result) is dispatched separately and stays loud
  // so Discord/email get the actually-useful signal without the burst
  // of lifecycle pings for every tool call along the way.
  addNotification({
    id: `${Date.now()}-background-${task.id}-checkin-${updated.progressCheckIns ?? 1}`,
    kind: 'execution',
    title: input.title,
    body: input.body,
    createdAt: now,
    read: false,
    silent: true,
    metadata: taskNotificationMetadata(updated, {
      runId: input.runId,
      ...(input.metadata ?? {}),
    }),
  });

  return updated;
}

// Loud progress heartbeats: the time-based check-in cadence (checkInMinutes)
// is delivered to the task's report-back channel — the same destination a
// terminal notification uses — so a long-running task's "still working"
// signal actually reaches the user instead of dying in the dashboard feed.

/** Human-readable elapsed duration for a heartbeat body: "45s", "12m",
 *  "1h 5m". Kept intentionally terse so the channel line stays scannable. */
function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Pure decision for the time-based heartbeat timer: given the task's current
 * status and how long since the last heartbeat, should we emit one this tick,
 * and should it be loud (channel-delivered) or a quiet dashboard ping?
 *
 *   - terminal / awaiting states → no heartbeat at all (the completion or
 *     awaiting notification is the signal; a loud "still working" after the
 *     task settled would be a wrong, confusing double-message).
 *   - not yet one interval since the last heartbeat → skip (rate-limit: at
 *     most one heartbeat per checkInMinutes interval per task).
 *   - cancelling → quiet dashboard ping only (the loud signal is the imminent
 *     abort notification; don't double-message the channel).
 *   - running → loud (channel-delivered).
 */
function decideHeartbeat(input: {
  status: BackgroundTaskStatus;
  nowMs: number;
  lastHeartbeatAtMs: number;
  intervalMs: number;
}): { emit: boolean; loud: boolean } {
  if (input.status !== 'running' && input.status !== 'cancelling') return { emit: false, loud: false };
  if (input.nowMs - input.lastHeartbeatAtMs < input.intervalMs) return { emit: false, loud: false };
  if (input.status === 'cancelling') return { emit: true, loud: false };
  return { emit: true, loud: true };
}

/** Build the substance of a running-task heartbeat: elapsed time, tool-call
 *  count, and the most recent activity (or the task label as a fallback) so
 *  the channel line reads like "Still working on <goal> — 12m in, 23 tool
 *  calls. Currently: <latest activity>." */
function buildProgressCheckInBody(input: {
  task: BackgroundTaskRecord;
  elapsedMs: number;
  toolCount: number;
  latestActivitySummary?: string;
  runId?: string;
}): string {
  const activity = (input.latestActivitySummary ?? '').trim() || input.task.title;
  const calls = `${input.toolCount} tool call${input.toolCount === 1 ? '' : 's'}`;
  const lines = [
    `Still working on ${input.task.title} — ${formatElapsedDuration(input.elapsedMs)} in, ${calls}.`,
  ];
  if (activity) lines.push(`Currently: ${activity}`);
  if (input.runId) lines.push(`Run: ${input.runId}`);
  return lines.join('\n');
}

/**
 * Twin of emitBackgroundTaskCheckIn for the time-based progress heartbeat.
 * Records the dashboard check-in exactly like a silent check-in (same fields,
 * same feed entry — silent only gates BOT delivery, not the dashboard), but
 * when `loud` it emits a non-silent notification routed to the task's
 * report-back target via taskNotificationMetadata (which already honors
 * allowDiscordCheckIns and the rest of the proactivity policy). Fail-open on
 * delivery is the queue's job; recording never throws here.
 */
function emitBackgroundTaskProgressUpdate(
  task: BackgroundTaskRecord,
  input: {
    loud: boolean;
    title: string;
    body: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  },
): BackgroundTaskRecord {
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    lastCheckInAt: now,
    lastCheckInMessage: clean(input.body, 700),
    progressCheckIns: (task.progressCheckIns ?? 0) + 1,
  }) ?? task;

  addNotification({
    id: `${Date.now()}-background-${task.id}-checkin-${updated.progressCheckIns ?? 1}`,
    kind: 'execution',
    title: input.title,
    body: input.body,
    createdAt: now,
    read: false,
    silent: !input.loud,
    metadata: taskNotificationMetadata(updated, {
      runId: input.runId,
      ...(input.metadata ?? {}),
    }),
  });

  return updated;
}

export const backgroundHeartbeatInternalsForTest = {
  formatElapsedDuration,
  decideHeartbeat,
  buildProgressCheckInBody,
};

function writeFullResultFile(task: BackgroundTaskRecord, result: string): string | undefined {
  if (result.length <= RESULT_TRUNCATE_CHARS) return undefined;
  const filePath = path.join(BACKGROUND_TASK_DIR, `${task.id}.result.md`);
  writeFileSync(filePath, result, 'utf-8');
  return filePath;
}

function renderOriginLineageBlock(
  task: Pick<BackgroundTaskRecord, 'originSessionId' | 'foregroundHandoff'>,
): string {
  const originSessionId = task.originSessionId;
  if (!originSessionId) return '';
  const throughSeq = task.foregroundHandoff?.throughSeq;
  let history = '';
  try { history = renderSessionHistoryForModel(originSessionId, 8, 6_000, throughSeq); } catch { history = ''; }
  return [
    '## Origin Session Lineage',
    `This task was spawned from session "${originSessionId}"${throughSeq ? ` at event boundary ${throughSeq}` : ''}. Treat the bounded origin history as authoritative for user decisions, constraints, resource ids, and already-completed external actions.`,
    'Do not redo completed external writes unless the user explicitly asked to do them again.',
    throughSeq
      ? `If you need more history, call session_history with session_id="${originSessionId}" and through_seq=${throughSeq}. Never read later turns from this reusable chat into this task.`
      : 'If you need more than the bounded history below, call session_history with the origin session id before acting.',
    history,
  ].filter(Boolean).join('\n');
}

function renderWorkspaceRootsBlock(): string {
  const roots = getWorkspaceDirs().slice(0, 12);
  if (roots.length === 0) return '';
  const primary = roots[0];
  return [
    '## Workspace Roots',
    `Primary workspace root: ${primary}`,
    'Clementine\'s data directory is not the user workspace. When the task says "Clementine workspace", "this repo", "the project", "workspace", or "worktree", use the primary workspace root unless the user named a different root.',
    'For local file tools, pass an explicit directory/path from these roots: list_files(directory=...), read_file(path=...), and run_shell_command(cwd=...). Do not rely on default cwd/path behavior for workspace tasks.',
    ...roots.map((root) => `- ${root}`),
  ].join('\n');
}

function buildWorkerPrompt(task: BackgroundTaskRecord): string {
  const policy = loadProactivityPolicy();
  // Carry the spawning chat session's parked GOAL into this delegated worker
  // (goal-contract P3 — replaced the Active Task pin) so it works toward the
  // EXACT objective the user blessed instead of re-deriving it. Keyed by the
  // ORIGIN session id only — never a global — so no other session's goal can
  // leak in. Empty (byte-identical prompt) for spawns with no origin/goal.
  const pinned = task.originSessionId ? getGoalPinForDelegation(task.originSessionId) : undefined;
  return [
    'You are running a durable Clementine background task.',
    `Autonomy mode: ${policy.mode}.`,
    'Work autonomously through the request. Use available tools when useful.',
    'For independent batch enrichment, resolve shared tools/credentials once, then use run_worker fan-out in bounded waves instead of doing every item serially in this context.',
    'For batch external writes, gather and verify source data first, then request one batch approval before writing; never ship placeholder or partial records as complete.',
    'If you are blocked by missing credentials, missing approvals, or ambiguity that could cause damage, stop and explain the blocker.',
    policy.allowComputerActions ? '' : 'Policy: do not modify local files, run shell commands, or operate the computer unless the user explicitly re-enables computer actions.',
    policy.allowComposioActions ? '' : 'Policy: do not use connected-app or Composio actions unless the user explicitly re-enables connected-app actions.',
    // FLOOR, not FORM. Prescribing `## Completed` first forced a run that MISSED its
    // objective to open with wins and bury the blocker — live 2026-07-24, the Railway
    // run led with four completed items and put "authenticate with `railway login`" in
    // section three of four. A fixed shape also cannot fit both outcomes, which is why
    // a downstream module (runtime/report-voice.ts) exists purely to strip these headings
    // back off for humans. Name the facts the report must carry; let the model pick the
    // shape that fits the outcome it actually got.
    'Keep a concise task ledger in your reasoning.',
    'Finish with a short report the user can act on. However you lay it out, it must answer: '
      + 'whether you met the objective — say so plainly if you did not; the concrete evidence for what you claim; '
      + 'anything still blocked, with exactly what you need from the user to clear it; and what happens next. '
      + 'Lead with whatever matters most for THIS outcome — if you were blocked, that is the blocker, not the parts that went well.',
    '',
    `Task ID: ${task.id}`,
    renderTaskContractBlock(task),
    task.originSessionId ? `Origin session: ${task.originSessionId}` : '',
    `Soft max runtime: ${task.maxMinutes} minutes`,
    '',
    renderOriginLineageBlock(task),
    renderWorkspaceRootsBlock(),
    '',
    pinned
      ? `## Pinned Constraint (from the session that started this task — act on EXACTLY this target; do NOT re-discover or substitute a different list)\n${pinned}\n`
      : '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

function renderTaskContractBlock(task: BackgroundTaskRecord): string {
  const contractVersion = task.contractVersion ?? 1;
  const revisions = (task.contractRevisions ?? []).slice(-8);
  return [
    '## Durable Task Contract',
    `Active contract version: ${contractVersion}.`,
    revisions.length === 0
      ? 'Version 1 is the original request below.'
      : 'The revisions below are authoritative and cumulative. Reconcile durable work against them before retrying; do not discard compatible completed evidence.',
    ...revisions.map((revision) => (
      `- v${revision.version} (${revision.evidencePolicy} prior evidence): ${revision.instruction}`
    )),
  ].join('\n');
}

// Wave 4 Stage 1 (finding H): the background/goal lane self-resumes unattended
// after a restart/continue, so — unlike the chat lane's AUTO_RESUME_DIRECTIVE — its
// continuation prompts must carry the same anti-re-send caution, or a resumed
// swarm can re-issue a send a completed worker already made. The duplicate-send
// wall is the hard backstop; this keeps the model from trying in the first place.
const RESUME_NO_RESEND_DIRECTIVE =
  'DO NOT REPEAT COMPLETED SIDE EFFECTS: if any worker/step before the interruption already sent an email or message, posted, or made another irreversible external write, do NOT re-issue it — treat already-completed work as done and continue from there. (A duplicate-send wall also refuses an exact repeat, but do not rely on it.)';

function buildWorkerContinuePrompt(task: BackgroundTaskRecord, previousText?: string): string {
  const restartVerification = task.restartRecovery
    && task.restartRecovery.reason !== 'safe_no_external_write'
    ? [
      'RECOVERY-SAFETY CHECK REQUIRED: this task was explicitly resumed after an interrupted, failed, or aborted turn with external-write risk.',
      `Recovery reason: ${task.restartRecovery.reason}; recorded writes: ${task.restartRecovery.externalWriteCount}; ambiguous writes: ${task.restartRecovery.ambiguousWriteCount}.`,
      'Inspect the durable external_write, external_write_failed, external_write_orphaned, tool_called, and tool_returned events in THIS SAME run session before doing another mutation. Verify the destination first when the prior outcome is uncertain; never recreate work merely because the prior provider response is missing.',
    ].join('\n')
    : '';
  return [
    `Continue background task ${task.id}.`,
    'The previous worker turn ended before the objective was safely complete, or this task was explicitly queued for continuation.',
    'Pick up from the prior session state and finish the original request. Do not restart from scratch unless the prior state is unusable.',
    RESUME_NO_RESEND_DIRECTIVE,
    renderTaskContractBlock(task),
    restartVerification,
    renderOriginLineageBlock(task),
    previousText ? `Previous partial result / continuation note:\n${previousText.slice(0, RESULT_TRUNCATE_CHARS)}` : '',
    '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

function buildWorkerInputResumePrompt(task: BackgroundTaskRecord, answer: string): string {
  return [
    `The user answered your question: "${answer}". Continue the task with this answer.`,
    'Resume THIS SAME task from its saved progress. Do not restart completed work merely because the dependency pause opened a new model turn.',
    RESUME_NO_RESEND_DIRECTIVE,
    renderTaskContractBlock(task),
    task.result?.trim()
      ? `Saved progress report from before the pause:\n${task.result.slice(0, RESULT_TRUNCATE_CHARS)}`
      : '',
    'Use the prior run session state, but preserve the origin session facts below if the continuation is picked up by a different model/backend.',
    renderOriginLineageBlock(task),
    '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

const RESUME_PROMPT_UNWRAP_LIMIT = 8;

function parseResumePromptLayer(prompt: string): { taskId?: string; originalRequest: string } | null {
  const text = prompt.trim();
  if (!/^Resume background task\s+bg-[a-z0-9]+-[a-f0-9]+/i.test(text)) return null;
  const marker = /(?:^|\n)\s*Original request:\s*\n/i.exec(text);
  if (!marker) return null;
  const originalRequest = text.slice(marker.index + marker[0].length).trim();
  if (!originalRequest) return null;
  const taskId = /^Resume background task\s+([^\s.]+)/i.exec(text)?.[1];
  return { taskId, originalRequest };
}

export function rootBackgroundTaskPromptForTests(prompt: string): string {
  let current = prompt.trim();
  for (let i = 0; i < RESUME_PROMPT_UNWRAP_LIMIT; i++) {
    const layer = parseResumePromptLayer(current);
    if (!layer || layer.originalRequest === current) break;
    current = layer.originalRequest;
  }
  return current;
}

function recordBackgroundTaskRoute(
  task: BackgroundTaskRecord,
  runId: string | undefined,
  response: AssistantResponse,
  requestedModel: string,
): BackgroundTaskRecord {
  const route = routeDiagnosticsFromResponse(response);
  const patch: Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>> = {
    requestedModel: route?.requestedModel ?? requestedModel,
    effectiveModel: route?.effectiveModel,
    modelProvider: route?.provider,
    modelRouteKind: route?.routeKind,
    modelTransport: route?.transport,
    modelRouteFalloverFrom: route?.falloverFrom,
  };
  const updated = updateBackgroundTask(task.id, patch) ?? task;
  if (route) {
    addRunEvent(runId, {
      type: 'status',
      message: `Model route: ${route.routeKind}${route.provider ? `/${route.provider}` : ''}${route.effectiveModel ? ` ${route.effectiveModel}` : ''}.`,
      data: {
        routeKind: route.routeKind,
        requestedModel: route.requestedModel ?? requestedModel,
        effectiveModel: route.effectiveModel,
        provider: route.provider,
        transport: route.transport,
        falloverFrom: route.falloverFrom,
      },
    });
  }
  return updated;
}

/** Derive a clean human title from a raw prompt/title. Live 2026-07-22: board
 *  cards read "this fully autonomously in the background: research these 6…"
 *  and "Great. Now in the background: take the 3…" — raw directive scaffolding
 *  stored verbatim. Strip the scaffolding iteratively, keep the first
 *  objective clause, cap the length. Already-clean titles pass through. */
export function deriveTaskTitle(raw: string): string {
  let t = (raw ?? '').replace(/\s+/g, ' ').trim();
  const LEAD = /^(?:okay[,.!]?\s+|ok[,.!]?\s+|great[,.!]?\s*(?:now)?\s*|new task:\s*|task:\s*|background task:\s*|run\s+this\s+|please[:,]?\s*|let'?s\s+try\s+this[,.!]?\s*|this\s+fully\s+autonomously(?:\s+in\s+the\s+background)?[:,]?\s*|(?:in|to)\s+the\s+background[:,]?\s*|i\s+(?:want|need)\s+you\s+to\s+|can\s+you\s+|now\s+)/i;
  for (let i = 0; i < 8; i += 1) {
    const next = t.replace(LEAD, '');
    if (next === t) break;
    t = next;
  }
  t = (t.split(/(?<=[.!?])\s+/)[0] ?? t).trim();
  if (t.length > 72) t = `${t.slice(0, 71).trimEnd()}…`;
  if (!t) return 'Background task';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function createBackgroundTask(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const createdAt = nowIso();
  const id = makeTaskId(new Date(createdAt));
  const task: BackgroundTaskRecord = {
    id,
    title: deriveTaskTitle(clean(input.title || input.prompt, 200)),
    prompt: input.prompt.trim(),
    status: 'pending',
    originSessionId: input.originSessionId,
    foregroundHandoff: input.foregroundHandoff,
    runSessionId: `background:${id}`,
    contractVersion: 1,
    contractRevisions: [],
    userId: input.userId,
    channel: input.channel,
    reportBackTarget: normalizeReportBackTarget(input.reportBackTarget)
      ?? defaultReportBackTarget({ source: input.source ?? 'gateway', userId: input.userId, channel: input.channel, originSessionId: input.originSessionId }),
    requestedModel: input.model,
    model: input.model,
    maxMinutes: Math.max(1, Math.min(240, Math.floor(input.maxMinutes ?? 60))),
    ...(typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? { maxTokens: Math.max(100_000, Math.min(1_000_000_000, Math.trunc(input.maxTokens))) }
      : {}),
    source: input.source ?? 'gateway',
    createdAt,
    updatedAt: createdAt,
    resumedFromTaskId: input.resumedFromTaskId,
    resumeCount: input.resumeCount,
  };
  writeTask(task);
  // Dashboard-only — the queued ping is useful in the Activity panel
  // but pushes pure noise to Discord since the task hasn't done
  // anything yet. The "completed" notification (which has the actual
  // result) is the one external destinations should see.
  addNotification({
    id: `${Date.now()}-background-${task.id}-queued`,
    kind: 'execution',
    title: `Background task queued: ${task.title}`,
    body: `Task ${task.id} is queued and will run in the daemon loop.`,
    createdAt,
    read: false,
    silent: true,
    metadata: taskNotificationMetadata(task),
  });
  emitBackgroundTaskOperational('background_task_created', task, { runSessionId: task.runSessionId });
  return task;
}

export function getBackgroundTask(id: string): BackgroundTaskRecord | null {
  const filePath = taskFilePath(id);
  if (!existsSync(filePath)) return null;
  return loadTaskFile(filePath);
}

export function listBackgroundTasks(filter: { status?: BackgroundTaskStatus; userId?: string; channel?: string; includeArchived?: boolean } = {}): BackgroundTaskRecord[] {
  ensureTaskDir();
  return readdirSync(BACKGROUND_TASK_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskFile(path.join(BACKGROUND_TASK_DIR, entry)))
    .filter((task): task is BackgroundTaskRecord => Boolean(task))
    // Archived tasks are soft-removed from ALL active consideration (board,
    // drain, resume, watchdog) unless a caller explicitly asks for them.
    .filter((task) => filter.includeArchived || !task.archived)
    .filter((task) => !filter.status || task.status === filter.status)
    .filter((task) => !filter.userId || task.userId === filter.userId)
    .filter((task) => !filter.channel || task.channel === filter.channel)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Age threshold past which an idle finished/parked task is flagged STALE and the
 *  heartbeat offers to archive it. 7 days = a week of no activity. */
export const STALE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STALE_FINISHED_STATUSES: readonly BackgroundTaskStatus[] = ['done', 'failed', 'aborted', 'blocked', 'interrupted'];
const STALE_PARKED_STATUSES: readonly BackgroundTaskStatus[] = ['awaiting_input', 'awaiting_approval', 'awaiting_continue'];

/** 'finished' = a terminal task lingering on the board; 'parked' = a task that
 *  has waited on the user (input/approval) and gone unanswered. */
export type StaleTaskKind = 'finished' | 'parked';

/** Classify a task's staleness, or null when it is NOT stale. Age is measured
 *  from updatedAt (last activity), so a live task that keeps moving never trips
 *  this. Archived tasks are never stale (already cleared). Active states
 *  (pending/running/cancelling) are never stale — only finished clutter and
 *  forgotten-parked tasks. Shared by the board flag AND the heartbeat so "stale"
 *  has exactly ONE definition. */
export function staleTaskKind(task: BackgroundTaskRecord, now: number = Date.now(), thresholdMs: number = STALE_TASK_AGE_MS): StaleTaskKind | null {
  if (task.archived) return null;
  const ageMs = now - Date.parse(task.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < thresholdMs) return null;
  if (STALE_FINISHED_STATUSES.includes(task.status)) return 'finished';
  if (STALE_PARKED_STATUSES.includes(task.status)) return 'parked';
  return null;
}

/** Every stale (non-archived) task with its kind, newest first. Powers both the
 *  board's STALE flag and the heartbeat's "archive these?" prompt. */
export function findStaleBackgroundTasks(now: number = Date.now(), thresholdMs: number = STALE_TASK_AGE_MS): Array<{ task: BackgroundTaskRecord; kind: StaleTaskKind }> {
  return listBackgroundTasks()
    .map((task) => { const kind = staleTaskKind(task, now, thresholdMs); return kind ? { task, kind } : null; })
    .filter((entry): entry is { task: BackgroundTaskRecord; kind: StaleTaskKind } => entry !== null);
}

function storedResultTextForIntegrityCheck(task: BackgroundTaskRecord): string {
  if (task.resultPath) {
    try {
      if (existsSync(task.resultPath)) {
        return readFileSync(task.resultPath, 'utf8').slice(0, RESULT_TRUNCATE_CHARS * 4);
      }
    } catch {
      // Fall through to the inline preview; integrity repair is best-effort.
    }
  }
  return typeof task.result === 'string' ? task.result : '';
}

/**
 * Self-heal false-positive completions left behind before the current completion
 * classifier existed. This is deliberately cheap and deterministic: no judge call,
 * no artifact probing, only the same text/structured signals used at finish time.
 */
export function sweepInvalidDoneBackgroundTasks(
  opts: { now?: number; maxAgeMs?: number; limit?: number } = {},
): { scanned: number; repaired: number; ids: string[] } {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? STALE_TASK_AGE_MS;
  const limit = opts.limit ?? 100;
  let scanned = 0;
  let repaired = 0;
  const ids: string[] = [];

  for (const task of listBackgroundTasks({ status: 'done' })) {
    if (scanned >= limit) break;
    const refMs = Date.parse(task.completedAt ?? task.updatedAt);
    if (Number.isFinite(refMs) && maxAgeMs > 0 && now - refMs > maxAgeMs) continue;
    scanned += 1;

    const resultText = storedResultTextForIntegrityCheck(task).trim();
    // Reclassify a settled `done` only on a positive/structural non-deliverable
    // signal — never on the self-reported-blocked TEXT heuristic, which is
    // past-tense-blind and would flip a genuine success whose report merely
    // recounts a blocker it overcame (finding A). No saved result, a blocked
    // execution row, or a fabricated transcript still reclassify.
    const outcome = resultText
      ? classifyBackgroundTaskOutcome(task, resultText, undefined, {
        ignoreFanoutCoverage: true,
        ignoreSelfReportedBlockedText: true,
      })
      : { outcome: 'blocked' as const, reason: 'Completed task has no saved result.' };
    if (outcome.outcome !== 'blocked') continue;

    const updated = markBackgroundTaskBlocked(
      task.id,
      `Integrity sweep reclassified a prior false completion: ${outcome.reason ?? 'result was not a verifiable deliverable'}`,
      resultText || task.result || '',
    );
    if (updated) {
      repaired += 1;
      ids.push(task.id);
    }
  }

  return { scanned, repaired, ids };
}

/** Soft-delete a task: drop it off the active board + every sweep, keep the
 *  record (restorable). The single irreversible-feeling action made reversible.
 *  `reason` is recorded when the archive wasn't the user's own click (the
 *  auto-expiry sweep) so the record explains its own disappearance. */
export function archiveBackgroundTask(id: string, reason?: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.archived) return task; // idempotent — re-archiving is a no-op
  return updateBackgroundTask(id, {
    archived: true,
    archivedAt: nowIso(),
    ...(reason ? { archiveReason: reason } : {}),
  });
}

/** Restore an archived task back onto the board. Its updatedAt is bumped (by
 *  updateBackgroundTask) so it does not immediately re-flag as stale. */
export function restoreBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  if (!task.archived) return task;
  return updateBackgroundTask(id, { archived: false, archivedAt: undefined, archiveReason: undefined });
}

/**
 * Auto-expire stale tasks (2026-07-30 declutter): the 7-day stale flag was
 * purely cosmetic — it unlocked an archive button and a prompt but never
 * cleared anything, so week-old parked tasks haunted every surface. The sweep
 * soft-archives them WITH a reason (nothing silently vanishes; restore from
 * Tasks brings any of them back and resets the clock). Runs on the daemon's
 * hourly reaper tick.
 */
export function reapStaleBackgroundTasks(now: number = Date.now()): Array<{ id: string; kind: StaleTaskKind }> {
  const out: Array<{ id: string; kind: StaleTaskKind }> = [];
  for (const { task, kind } of findStaleBackgroundTasks(now)) {
    const reason = kind === 'parked'
      ? 'Auto-archived: this task waited on an answer for over 7 days with no activity. Restore it from Tasks if it still matters.'
      : 'Auto-archived: finished over 7 days ago with no further activity. Restore it from Tasks if you still need it.';
    try {
      archiveBackgroundTask(task.id, reason);
      out.push({ id: task.id, kind });
    } catch {
      // One bad record must not stop the sweep; the next tick retries.
    }
  }
  return out;
}

export function getBackgroundTaskByApprovalId(approvalId: string): BackgroundTaskRecord | null {
  if (!approvalId) return null;
  return listBackgroundTasks().find((task) => task.pendingApprovalId === approvalId) ?? null;
}

export function getBackgroundTaskByQuestionId(questionId: string): BackgroundTaskRecord | null {
  if (!questionId) return null;
  return listBackgroundTasks().find((task) => task.pendingQuestionId === questionId) ?? null;
}

/** The single background task awaiting input on this origin chat session, if
 *  exactly one is parked there (so a freeform chat reply can be routed to it
 *  without an explicit questionId). Returns null when zero or >1 are parked —
 *  the caller must then disambiguate by questionId. */
export function findSoleAwaitingInputTaskForOrigin(originSessionId: string): BackgroundTaskRecord | null {
  if (!originSessionId) return null;
  const parked = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => task.originSessionId === originSessionId);
  return parked.length === 1 ? parked[0] : null;
}

export function findSoleAwaitingContinueTaskForOrigin(originSessionId: string): BackgroundTaskRecord | null {
  if (!originSessionId) return null;
  const parked = listBackgroundTasks({ status: 'awaiting_continue' })
    .filter((task) => task.originSessionId === originSessionId);
  return parked.length === 1 ? parked[0] : null;
}

function updateBackgroundTaskWhere(
  id: string,
  predicate: (task: BackgroundTaskRecord) => boolean,
  patch: BackgroundTaskPatch | ((task: BackgroundTaskRecord) => BackgroundTaskPatch),
): BackgroundTaskRecord | null {
  const transition = withTaskTransitionLock(id, () => {
    const task = getBackgroundTask(id);
    if (!task || !predicate(task)) return null;
    const resolvedPatch = typeof patch === 'function' ? patch(task) : patch;
    const updated: BackgroundTaskRecord = {
      ...task,
      ...resolvedPatch,
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: nowIso(),
    };
    writeTask(updated);
    return { task, updated };
  });
  if (!transition) return null;

  // A question card is actionable only while the task is actually parked on
  // that question. Any canonical state transition away from awaiting_input
  // clears the old Home/notification attention item, whether the user answered,
  // cancelled, or another terminal path closed the task.
  if (
    transition.task.status === 'awaiting_input'
    && transition.updated.status !== 'awaiting_input'
    && transition.task.pendingQuestionId
  ) {
    try {
      markNotificationsReadByQuestionId(transition.task.pendingQuestionId, {
        backgroundTaskStatus: transition.updated.status,
        backgroundTaskId: transition.updated.id,
      });
    } catch {
      // The task store is canonical; notification cleanup is best-effort and
      // must never prevent the actual task transition.
    }
  }
  return transition.updated;
}

export function updateBackgroundTask(id: string, patch: BackgroundTaskPatch): BackgroundTaskRecord | null {
  return updateBackgroundTaskWhere(id, () => true, patch);
}

/**
 * Append a user course-correction without rewriting the original task or
 * discarding progress. Running work is allowed to reach its current response
 * boundary, then the stale-contract response is preserved as partial evidence
 * and the same task/session is re-queued on the new version.
 */
export function reviseBackgroundTaskContract(
  id: string,
  input: {
    instruction: string;
    evidencePolicy?: BackgroundTaskContractRevision['evidencePolicy'];
  },
): BackgroundTaskRecord | null {
  const instruction = clean(input.instruction ?? '', RESULT_TRUNCATE_CHARS);
  if (!instruction) return null;
  const evidencePolicy = input.evidencePolicy ?? 'revalidate';
  const queuedAt = nowIso();
  let supersededApprovalId: string | undefined;
  const updated = updateBackgroundTaskWhere(
    id,
    (task) => !task.archived
      && !['done', 'failed', 'aborted', 'interrupted', 'cancelling'].includes(task.status),
    (task) => {
      const nextVersion = (task.contractVersion ?? 1) + 1;
      const revision: BackgroundTaskContractRevision = {
        version: nextVersion,
        instruction,
        evidencePolicy,
        queuedAt,
      };
      const requeueParked = ['blocked', 'awaiting_approval', 'awaiting_input', 'awaiting_continue']
        .includes(task.status);
      if (task.status === 'awaiting_approval') supersededApprovalId = task.pendingApprovalId;
      return {
        ...(requeueParked
          ? {
              ...clearParkedBackgroundState(),
              status: 'pending' as const,
              error: undefined,
              completedAt: undefined,
              continueResolution: {
                queuedAt,
                reason: `Resume under corrected contract v${nextVersion}; reconcile saved progress before new execution.`,
                auto: false,
              },
            }
          : {}),
        contractVersion: nextVersion,
        contractRevisions: [...(task.contractRevisions ?? []), revision].slice(-50),
        pendingContractRevision: revision,
        lastCheckInAt: queuedAt,
        lastCheckInMessage: `Course correction queued as contract v${nextVersion}; current work will reconcile at the next model boundary.`,
      };
    },
  );
  if (!updated) return null;
  if (supersededApprovalId) {
    try {
      approvalRegistry.resolve(
        supersededApprovalId,
        'cancelled_by_user',
        'background-contract-revision',
      );
    } catch { /* task revision remains canonical if approval cleanup fails */ }
  }

  // Pre-register a pending task's trace so the revision is visible immediately.
  try {
    if (!getHarnessSessionRow(updated.runSessionId)) {
      createHarnessSession({
        id: updated.runSessionId,
        kind: 'execution',
        title: updated.title,
      });
    }
    appendEvent({
      sessionId: updated.runSessionId,
      turn: 0,
      role: 'user',
      type: 'background_contract_revised',
      data: {
        taskId: updated.id,
        contractVersion: updated.contractVersion ?? 1,
        instruction,
        evidencePolicy,
        queuedAt,
      },
    });
  } catch { /* task record remains canonical */ }

  // Apply the compatibility decision to every declared logical manifest now.
  // Any old-version worker result that lands after this point is kept as stale
  // evidence and cannot silently clear the revised contract.
  for (const manifest of summarizeWorkManifests(updated.runSessionId)) {
    try {
      reviseWorkContract({
        sessionId: updated.runSessionId,
        manifestId: manifest.manifestId,
        fromVersion: manifest.contractVersion,
        toVersion: String(updated.contractVersion ?? 1),
        instruction,
        evidencePolicy,
      });
    } catch { /* one malformed manifest cannot hide the task revision */ }
  }
  if (updated.status === 'pending') requestBackgroundDrain(1);
  return updated;
}

function tryMarkPendingContractRevisionApplied(task: BackgroundTaskRecord): BackgroundTaskRecord | null {
  const pending = task.pendingContractRevision;
  if (!pending) return task;
  return updateBackgroundTaskWhere(
    task.id,
    (latest) => latest.status === 'running'
      && (latest.contractVersion ?? 1) === pending.version
      && latest.pendingContractRevision?.version === pending.version,
    (latest) => ({
      pendingContractRevision: undefined,
      contractRevisions: (latest.contractRevisions ?? []).map((revision) => (
        revision.version <= pending.version && !revision.appliedAt
          ? { ...revision, appliedAt: nowIso() }
          : revision
      )),
      lastCheckInAt: nowIso(),
      lastCheckInMessage: `Contract v${pending.version} applied; reconciling saved work before new execution.`,
    }),
  );
}

function markPendingContractRevisionApplied(task: BackgroundTaskRecord): BackgroundTaskRecord {
  return tryMarkPendingContractRevisionApplied(task) ?? task;
}

/**
 * A course correction can arrive while one harness call is still progressing
 * through its own bounded continuation turns. If that same call emits complete
 * checkpoints for the new contract, scheduling another background turn only
 * re-reads receipts (and often calls run_worker just to be told nothing ran).
 *
 * Preserve-policy revisions are intentionally excluded: an old complete
 * manifest can remain complete without proving the model saw the new wording.
 * Revalidate/invalidate revisions make prior checkpoints incomplete first, so
 * an exact-version complete manifest is deterministic evidence that the new
 * contract was actually processed.
 */
function pendingContractRevisionSatisfiedByDurableManifest(
  task: BackgroundTaskRecord,
): boolean {
  const pending = task.pendingContractRevision;
  if (!pending || pending.evidencePolicy === 'preserve') return false;
  if ((task.contractVersion ?? 1) !== pending.version) return false;
  try {
    const manifests = summarizeWorkManifests(task.runSessionId);
    const expectedVersion = String(pending.version);
    return manifests.length > 0
      && manifests.every((manifest) => (
        manifest.contractVersion === expectedVersion
        && manifest.total > 0
        && manifest.remaining === 0
      ));
  } catch {
    return false;
  }
}

function clearParkedBackgroundState(): Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>> {
  return {
    pendingApprovalId: undefined,
    approvalResolution: undefined,
    pendingQuestionId: undefined,
    pendingQuestion: undefined,
    inputResolution: undefined,
    continueResolution: undefined,
    outcomeSnapshot: undefined,
  };
}

let backgroundTaskStartCasHookForTests: (() => void) | null = null;
export function _setBackgroundTaskStartCasHookForTests(fn: (() => void) | null): void {
  backgroundTaskStartCasHookForTests = fn;
}

export function markBackgroundTaskRunning(id: string): BackgroundTaskRecord | null {
  // Adversarial test seam: pause after a candidate observed `pending` but before
  // the authoritative CAS. Production pays no extra read when the seam is off.
  if (backgroundTaskStartCasHookForTests) {
    const observed = getBackgroundTask(id);
    if (!observed || observed.status !== 'pending') return null;
    backgroundTaskStartCasHookForTests();
  }
  const updated = updateBackgroundTaskWhere(id, (task) => task.status === 'pending', {
    status: 'running',
    startedAt: nowIso(),
    error: undefined,
    outcomeSnapshot: undefined,
    pendingApprovalId: undefined,
    // Clear the parked-question MARKER but preserve inputResolution — the drain
    // reads inputResolution to resume with the answer (mirrors how
    // approvalResolution survives markBackgroundTaskRunning).
    pendingQuestionId: undefined,
    pendingQuestion: undefined,
  });
  // Pre-register the trace session the instant the card flips to RUNNING, so the board's
  // live-trace SSE (GET /api/sessions/background:<id>/events) never 404s during the startup
  // window. The worker otherwise creates background:<id> lazily on its FIRST
  // respondPreferHarness call — after markRunning/startRun/buildWorkerPrompt — and the
  // browser's EventSource does not recover from that 404. Both harness lanes use
  // get-or-create (if (!getSession) createSession), so this is safe; they see it and skip.
  try {
    const runSessionId = updated?.runSessionId ?? `background:${id}`;
    if (!getHarnessSessionRow(runSessionId)) {
      createHarnessSession({
        id: runSessionId,
        kind: 'execution',
        title: updated?.title ?? 'Background task',
        // Stage 4 — informational only (console display); the enforcement
        // ceiling is resolved from task/options/settings, never this column.
        // Gated on the kill-switch: enforcement off must not display a
        // ceiling nothing will apply (conditional-surface rule).
        tokenBudget: runTokenBudgetEnforcementEnabled()
          ? (resolveRunTokenCeiling({ override: updated?.maxTokens, budget: getHarnessBudgetSettings() }) || undefined)
          : undefined,
      });
    }
    // Wave 4 Stage 2: mark a run/continue boundary. A background task's runSessionId
    // is STABLE for its whole life, so worker_result events accumulate across every
    // run. summarizeFanoutCoverage counts only worker_results AFTER the latest
    // boundary, so a prior run's (or continue's) failures don't leak into THIS run's
    // authoritative coverage gate and permanently block a re-completed task.
    appendEvent({ sessionId: runSessionId, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { taskId: id } });
    // Stage 3: a new run boundary also resets the in-process fan-out reduce
    // window, so a prior run's digest-mode state never leaks into this run.
    resetFanoutWindow(runSessionId);
  } catch { /* trace pre-registration is best-effort; the worker creates it anyway */ }
  if (updated) emitBackgroundTaskOperational('background_task_started', updated);
  return updated;
}

/**
 * Async report-back. When a background task finishes, feed its result back
 * into the ORIGINATING session's transcript so Clementine re-enters that
 * context on her next turn and can keep working — instead of the result
 * dead-ending in a notification that never reaches her reasoning loop.
 *
 * No new MCP tool is needed: re-entry is via turn history (the model already
 * reads `recentTranscript`), and the embedded `background_task_status('<id>')`
 * hint lets her pull the FULL payload on demand if the inline preview is
 * clipped. The existing read tools are how she self-serves; this just makes
 * sure the completion is IN her context.
 *
 * Best-effort + idempotent: a completion must never fail on a session write,
 * and `markBackgroundTaskDone` is called from both the normal drain and the
 * post-approval path, so a retried/double completion must not append twice
 * (guarded by a content-marker scan — ConversationTurn has no id to dedup on).
 * Tasks with no `originSessionId` (cron / autonomous spawns with no session to
 * wake) are a no-op, by design.
 */
type BackgroundTaskOutcome = 'done' | 'failed' | 'blocked' | 'needs_input';

function enqueueBackgroundTaskOutcomeTurn(
  task: BackgroundTaskRecord,
  outcome: BackgroundTaskOutcome,
  detail: string,
): boolean {
  updateLinkedFocusAction(task.id, {
    status: outcome === 'done' ? 'done' : 'blocked',
    note: outcome === 'done'
      ? 'Completed and reported back.'
      : detail.replace(/\s+/g, ' ').trim().slice(0, 240),
  });
  // Unified report-back (Move 4): one mechanism for every lane. Preserves the
  // `[background task <id> …]` prefix (idempotency + UI detect); the body is the
  // shared Outcome card. See src/runtime/outcome.ts.
  const snapshot = task.outcomeSnapshot
    ?? buildBackgroundTaskOutcomeSnapshot(task, outcome, {
      blocker: task.error,
      nextAction: outcome === 'needs_input' ? task.pendingQuestion : undefined,
      resumable: outcome === 'needs_input',
    });
  const payload: Outcome = {
    status: outcome,
    detail,
    evidence: snapshot.evidence,
    blocker: snapshot.blocker,
    nextAction: snapshot.nextAction,
    resumable: snapshot.resumable,
  };
  return deliverOutcome(
    payload,
    {
      originSessionId: task.originSessionId,
      sourceLabel: 'background task',
      sourceId: task.id,
      title: task.title,
      statusHint: `background_task_status('${task.id}')`,
      maxDetailChars: RESULT_TRUNCATE_CHARS,
      // Every terminal outcome (and a clarifying question) surfaces in the
      // chat NOW instead of waiting for the user's next unrelated message —
      // desktop has no other visible delivery lane for a finished background
      // task (2026-07-21; Slack/Discord additionally get the notification
      // fan-out, desktop does not). The idle gate + defer queue in outcome.ts
      // keep this from colliding with a mid-conversation turn.
      proactiveTurn: true,
    },
  );
}

function backgroundTaskOutcomeForStatus(status: BackgroundTaskStatus): BackgroundTaskOutcome | null {
  if (status === 'done') return 'done';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  return null;
}

function storedBackgroundTaskReportText(task: BackgroundTaskRecord): string {
  const stored = storedResultTextForIntegrityCheck(task).trim();
  if (stored) {
    return task.status === 'blocked'
      ? progressPreservingPauseDetail(
        'Resolve the remaining blocker before starting another run.',
        { resultText: stored, blockerReason: task.error },
      )
      : stored;
  }
  if (task.error?.trim()) return task.error.trim();
  if (task.result?.trim()) return task.result.trim();
  return `Task ${task.id} finished with status ${task.status}, but no result text was saved.`;
}

export function replayBackgroundTaskReportBack(
  id: string,
  opts: { reason?: string; now?: string } = {},
): { ok: boolean; reason?: string; notificationId?: string; outcomeDelivered?: boolean } {
  const task = getBackgroundTask(id);
  if (!task) return { ok: false, reason: 'not-found' };
  const outcome = backgroundTaskOutcomeForStatus(task.status);
  if (!outcome) return { ok: false, reason: 'not-terminal-reporting-status' };

  const now = opts.now ?? nowIso();
  const detail = storedBackgroundTaskReportText(task);
  const notificationId = `bgtask-report-replay-${task.id}-${task.status}`;
  const replayReason = opts.reason ?? 'terminal_report_back_replay';

  addNotification({
    id: notificationId,
    kind: task.status === 'blocked' ? 'approval' : 'execution',
    title: `Background task report re-delivered: ${task.title}`,
    body: truncateResultBody(task.status === 'done' ? humanizeReportBody(detail) : detail),
    createdAt: now,
    read: false,
    metadata: taskNotificationMetadata(task, {
      status: task.status,
      reportBackReplay: true,
      replayReason,
      terminalReportBack: true,
    }),
  });

  const outcomeDelivered = enqueueBackgroundTaskOutcomeTurn(task, outcome, detail);
  return { ok: true, notificationId, outcomeDelivered };
}

/** A worker may park or complete from the ordinary lifecycle states, including
 * idempotent/report-repair transitions. It may never overwrite cancellation:
 * `cancelling` and `aborted` are owned by the user-stop path. Evaluated under
 * the per-task transition lease by updateBackgroundTaskWhere. */
function workerSettlementMayProceed(task: BackgroundTaskRecord): boolean {
  return task.status !== 'cancelling' && task.status !== 'aborted';
}

const WORKER_ACTIVE_OR_PARKED_STATUSES: readonly BackgroundTaskStatus[] = [
  'pending',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_continue',
];

function workerParkMayProceed(task: BackgroundTaskRecord): boolean {
  return WORKER_ACTIVE_OR_PARKED_STATUSES.includes(task.status);
}

function workerDoneMayProceed(task: BackgroundTaskRecord): boolean {
  return task.status === 'done' || WORKER_ACTIVE_OR_PARKED_STATUSES.includes(task.status);
}

function workerBlockedMayProceed(task: BackgroundTaskRecord): boolean {
  // `done` is accepted for the integrity sweep that repairs historical false
  // completions; `blocked` keeps the repair idempotent.
  return task.status === 'done'
    || task.status === 'blocked'
    || WORKER_ACTIVE_OR_PARKED_STATUSES.includes(task.status);
}

function workerFailureMayProceed(
  task: BackgroundTaskRecord,
  status: Extract<BackgroundTaskStatus, 'failed' | 'aborted' | 'interrupted'>,
): boolean {
  if (status === 'aborted') {
    return task.status !== 'done';
  }
  return task.status === status || WORKER_ACTIVE_OR_PARKED_STATUSES.includes(task.status);
}

let backgroundTaskSettlementCasHookForTests: (() => void) | null = null;
export function _setBackgroundTaskSettlementCasHookForTests(fn: (() => void) | null): void {
  backgroundTaskSettlementCasHookForTests = fn;
}

function prepareWorkerSettlementForCas(id: string): boolean {
  if (!backgroundTaskSettlementCasHookForTests) return true;
  const observed = getBackgroundTask(id);
  if (!observed || !workerSettlementMayProceed(observed)) return false;
  backgroundTaskSettlementCasHookForTests();
  return true;
}

/** Tools that are plumbing, not strategy — a run's SHAPE is its real work. */
const STRATEGY_META_TOOLS = new Set([
  'tool_choice_recall', 'recall_tool_result', 'tool_output_query', 'composio_search_tools',
  'composio_list_tools', 'local_cli_list', 'execution_list', 'execution_create',
  'execution_update_step', 'execution_complete', 'pending_action_queue', 'request_approval',
]);

function captureRunStrategyFromTrace(updated: BackgroundTaskRecord): void {
  const db = openEventLog();
  const toolRows = db.prepare(
    'SELECT tool, COUNT(*) AS n FROM tool_outputs WHERE session_id = ? GROUP BY tool ORDER BY n DESC LIMIT 24',
  ).all(updated.runSessionId) as Array<{ tool: string | null; n: number }>;
  const toolsUsed = toolRows.map((r) => r.tool ?? '').filter((t) => t && !STRATEGY_META_TOOLS.has(t));
  if (toolsUsed.length === 0) return;
  const workerCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'worker_result'",
  ).get(updated.runSessionId) as { n: number } | undefined)?.n ?? 0;
  const durationMs = updated.startedAt && updated.completedAt
    ? Math.max(0, Date.parse(updated.completedAt) - Date.parse(updated.startedAt))
    : 0;
  // WHERE the deliverable went: the latest exactly-settled external write's
  // first target(s) (file path, sheet, mailbox). A pre-dispatch reservation is
  // not a deliverable; a failed one must never replace the last confirmed
  // target in learned strategy memory.
  let deliverable: string | undefined;
  try {
    const evidence = listHarnessEventsForRefute(updated.runSessionId, {
      types: [
        'external_write',
        'external_write_succeeded',
        'external_write_failed',
        'external_write_orphaned',
      ],
    });
    const latestConfirmed = resolveWriteEvidence(evidence).confirmed
      .sort((left, right) => right.seq - left.seq)[0];
    if (latestConfirmed) {
      const data = latestConfirmed.data as { targets?: unknown };
      const targets = Array.isArray(data.targets) ? data.targets.filter((t): t is string => typeof t === 'string') : [];
      if (targets.length > 0) deliverable = targets.slice(0, 2).join(', ');
    }
  } catch { /* deliverable capture is best-effort */ }

  // A task record briefly said `done` during the old 120-account run even
  // though its latest durable terminal event was awaiting input with an
  // unverified Google Sheet binding. Read that terminal truth before allowing
  // the run's shape to steer a future objective.
  let awaitingUser = false;
  let needsAttention = false;
  let artifactVerificationPending = 0;
  try {
    const terminal = db.prepare(
      "SELECT data_json FROM events WHERE session_id = ? AND type = 'conversation_completed' ORDER BY seq DESC LIMIT 1",
    ).get(updated.runSessionId) as { data_json?: string } | undefined;
    if (terminal?.data_json) {
      const data = JSON.parse(terminal.data_json) as {
        reason?: unknown;
        awaitingUser?: unknown;
        blockedReason?: unknown;
        artifactVerification?: { status?: unknown; pending?: unknown; count?: unknown };
      };
      const reason = typeof data.reason === 'string' ? data.reason : '';
      awaitingUser = data.awaitingUser === true || /awaiting_(?:user_)?input/i.test(reason);
      needsAttention = Boolean(
        typeof data.blockedReason === 'string' && data.blockedReason.trim(),
      );
      if (data.artifactVerification?.status === 'pending') {
        const pending = Number(
          data.artifactVerification.pending ?? data.artifactVerification.count ?? 1,
        );
        artifactVerificationPending = Number.isFinite(pending) ? Math.max(1, pending) : 1;
      }
    }
  } catch {
    needsAttention = true; // unreadable terminal truth cannot authorize learning
  }

  const completion = backgroundCompletionEvidence(updated);
  const manifests = summarizeWorkManifests(updated.runSessionId);
  const learningInput = {
    target: 'strategy' as const,
    authority: 'background_delivery_verifier' as const,
    sessionId: updated.runSessionId,
    sourceId: updated.id,
    terminalSuccess: updated.status === 'done' && Boolean(updated.result?.trim()),
    controllerValidation: updated.status === 'done',
    awaitingUser,
    needsAttention,
    artifactVerificationPending,
    ambiguousExternalWrites: completion.ambiguousExternalWrites,
    manifestRemaining: manifests.reduce((sum, manifest) => sum + manifest.remaining, 0),
    manifestAnomalies: manifests.reduce((sum, manifest) => sum + manifest.anomalies.length, 0),
    manifestUntrackedCheckpoints: manifests.reduce(
      (sum, manifest) => sum + manifest.untrackedCheckpoints,
      0,
    ),
    externalWriteRequired: taskRequiresExternalSendReceipt(updated),
    externalWriteReceipts: completion.externalWriteReceipts,
  };
  const learningDecision = evaluateLearningCandidate(learningInput);
  recordLearningDecision(learningInput, learningDecision, {
    taskId: updated.id,
    workerCount,
    toolCount: toolsUsed.length,
  });
  if (!learningDecision.receipt) return;
  recordRunStrategy({
    objective: updated.title || updated.prompt,
    toolsUsed,
    workerCount,
    durationMs,
    deliverable,
    learningReceipt: learningDecision.receipt,
  });
}

export function markBackgroundTaskDone(
  id: string,
  result: string,
  opts?: { notificationBody?: string },
): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  // Cancellation is a terminal authority boundary. The result file and task
  // completion are created only after the latest record is checked while the
  // task transition lease is held, so a stale worker cannot complete after a
  // cross-process stop committed.
  const updated = updateBackgroundTaskWhere(id, workerDoneMayProceed, (task) => {
    const resultPath = writeFullResultFile(task, result);
    return {
      ...clearParkedBackgroundState(),
      status: 'done',
      completedAt: nowIso(),
      result: resultPath ? `${result.slice(0, RESULT_TRUNCATE_CHARS)}\n...[full result saved to ${resultPath}]` : result,
      resultPath,
      error: undefined,
      outcomeSnapshot: buildBackgroundTaskOutcomeSnapshot(task, 'done'),
    };
  });
  if (updated) {
    // The HUMAN sees a conversational body: a caller-supplied one when the raw
    // result is machine-shaped (e.g. the job-watcher's JSON), otherwise the
    // worker's text with its audit ledger stripped. The MODEL still gets the
    // full `result` (result file + `enqueueBackgroundTaskOutcomeTurn` below).
    const notificationBody = opts?.notificationBody ?? humanizeReportBody(result);
    addNotification({
      id: `${Date.now()}-background-${updated.id}-done`,
      kind: 'execution',
      title: `Background task completed: ${updated.title}`,
      body: truncateResultBody(notificationBody),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { terminalReportBack: true }),
    });
    // Async report-back: also feed the result into the origin session's
    // context so Clementine resumes from it, not just a notification.
    enqueueBackgroundTaskOutcomeTurn(updated, 'done', result);
    emitBackgroundTaskOperational('background_task_finished', updated, { status: 'done' });
    // Learning loop (DREAM): distill this run's SHAPE — real tools used,
    // fan-out width, wall time — into the strategy store so the next similar
    // objective plans from a proven approach. Deterministic trace summary.
    // SYNCHRONOUS on purpose: an async wrapper here left pending microtasks
    // that kept short-lived processes alive after their main script ended
    // (2026-07-22: every child-spawning test family hung on it). All the work
    // is sync (sqlite + fs), so there is nothing to await.
    try {
      captureRunStrategyFromTrace(updated);
    } catch { /* strategy capture is best-effort */ }
  }
  return updated;
}

/**
 * Park a background task that asked the user a CLARIFYING QUESTION (the
 * judge-gated check-in). Twin of markBackgroundTaskAwaitingApproval, but the
 * question is surfaced TWO ways: a needs-you notification (kind 'approval' so it
 * rides the loud delivery path) AND a synthetic turn in the ORIGIN chat via
 * deliverOutcome(needs_input) — so the user sees the question where they're
 * talking, and can just answer there (the answer is routed back to resume).
 */
interface BackgroundInputPauseOptions {
  /** The worker's complete model-authored report. A dependency question must
   * never replace the useful work that led up to it. */
  resultText?: string;
  /** Structured harness fact appended after the report, not substituted for it. */
  blockerReason?: string;
  blockerType?: BlockerType;
}

/**
 * Roster-bounded CLI attribution for an auth-shaped park. Deliberately
 * narrow: only PERMISSION-classified blockers qualify, and only commands
 * the user has actually connected/saved are candidates (word-boundary
 * match) — an arbitrary tool name in prose can never mint a tag, so the
 * recovery sweep can never resume a task on the strength of a guess.
 */
export function detectBlockedOnCli(
  blockerType: BlockerType | undefined,
  blockerText: string | undefined,
  rosterCommands: string[],
): string | undefined {
  if (blockerType !== 'permission' || !blockerText) return undefined;
  for (const command of rosterCommands) {
    if (!/^[A-Za-z0-9._+-]{1,60}$/.test(command)) continue;
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9._+-])${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9._+-])`);
    if (pattern.test(blockerText)) return command;
  }
  return undefined;
}

function rosterCliCommands(): string[] {
  try {
    const commands = new Set<string>();
    for (const command of getSavedClis()) commands.add(command);
    for (const record of Object.values(readConnectedClis())) commands.add(record.command);
    return [...commands];
  } catch {
    return [];
  }
}

function progressPreservingPauseDetail(
  question: string,
  opts: BackgroundInputPauseOptions = {},
  maxChars = RESULT_TRUNCATE_CHARS,
): string {
  const report = (opts.resultText ?? '').trim();
  const blocker = (opts.blockerReason ?? '').trim();
  const ask = question.trim();
  const suffixes: string[] = [];
  if (ask && !report.includes(ask)) suffixes.push(`To resume: ${ask}`);

  const fitReport = (): string => {
    if (!report) return '';
    const suffixLength = suffixes.length > 0 ? suffixes.join('\n\n').length + 2 : 0;
    return truncateResultBody(report, Math.max(160, maxChars - suffixLength));
  };

  let shownReport = fitReport();
  // A long report can contain the blocker only after the display cap. Test the
  // actual visible excerpt, not the unbounded source, so the dependency can
  // never be truncated away by the progress that preceded it.
  if (blocker && !shownReport.includes(blocker)) {
    suffixes.unshift(`Remaining dependency: ${clean(blocker, Math.max(120, Math.floor(maxChars / 2)))}`);
    shownReport = fitReport();
  }
  return [shownReport, ...suffixes].filter(Boolean).join('\n\n').slice(0, maxChars);
}

function isResumableUserDependency(blockerType?: BlockerType): boolean {
  return blockerType === 'permission' || blockerType === 'needs_user_input';
}

function dependencyResumeQuestion(blockerType: BlockerType): string {
  if (blockerType === 'permission') {
    return 'Authenticate or reconnect the required service described above, then reply `continue`. I’ll resume this same task from its saved progress.';
  }
  return 'Reply with the missing input described above. I’ll resume this same task from its saved progress.';
}

export function markBackgroundTaskAwaitingInput(
  id: string,
  questionId: string,
  question: string,
  opts: BackgroundInputPauseOptions = {},
): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const reportDetail = progressPreservingPauseDetail(question, opts);
  const notificationBody = progressPreservingPauseDetail(question, opts, 2000);
  const blockedOnCli = detectBlockedOnCli(opts.blockerType, opts.blockerReason, rosterCliCommands());
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, (task) => ({
    ...clearParkedBackgroundState(),
    status: 'awaiting_input',
    completedAt: undefined,
    error: opts.blockerReason ? clean(opts.blockerReason, 1000) : undefined,
    pendingQuestionId: questionId,
    ...(blockedOnCli ? { blockedOnCli } : {}),
    pendingQuestion: question.slice(0, RESULT_TRUNCATE_CHARS),
    result: (opts.resultText ?? question).slice(0, RESULT_TRUNCATE_CHARS),
    outcomeSnapshot: buildBackgroundTaskOutcomeSnapshot(task, 'needs_input', {
      blocker: opts.blockerReason,
      blockerType: opts.blockerType,
      nextAction: question,
      resumable: true,
    }),
  }));
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-needs-input`,
      kind: 'approval',
      title: `Background task needs your input: ${updated.title}`,
      body: notificationBody,
      createdAt: nowIso(),
      read: false,
      metadata: {
        ...taskNotificationMetadata(updated, {
          status: 'awaiting_input',
          blockerType: opts.blockerType,
          resumable: true,
        }),
        questionId,
        needsInput: true,
      },
    });
    // Surface the question into the origin chat too, so the user can answer in
    // the conversation (the answer is routed back via queueBackgroundTaskInputResolution).
    enqueueBackgroundTaskOutcomeTurn(updated, 'needs_input', reportDetail);
    emitBackgroundTaskOperational(
      'background_task_parked',
      updated,
      { reason: 'awaiting_input', blockerType: opts.blockerType },
      'warn',
    );
  }
  return updated;
}

export function markBackgroundTaskAwaitingApproval(id: string, approvalId: string, resultText: string): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, (task) => ({
    ...clearParkedBackgroundState(),
    status: 'awaiting_approval',
    pendingApprovalId: approvalId,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
    outcomeSnapshot: buildBackgroundTaskOutcomeSnapshot(task, 'needs_input', {
      blocker: `Approval ${approvalId} is required before the remaining action can run.`,
      nextAction: 'Review the queued approval. If you approve it, this same task resumes automatically.',
      resumable: true,
    }),
  }));
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-approval`,
      kind: 'approval',
      title: `Background task awaiting approval: ${updated.title}`,
      body: `Task ${updated.id} is paused on approval ${approvalId}.`,
      createdAt: nowIso(),
      read: false,
      metadata: {
        ...taskNotificationMetadata(updated),
        approvalId,
      },
    });
    // A2 (v2.3.0): the ACTIONABLE CARD lands in the chat that asked for the
    // work — same gap-fix as the workflow-runner park. A notification alone
    // left the user hunting the board while sitting in the origin
    // conversation (live 2026-07-23). Best-effort; the notification above
    // stays the baseline.
    if (updated.originSessionId) {
      emitApprovalRequestedCard({
        sessionId: updated.originSessionId,
        approvalId,
        extra: { taskId: updated.id, taskTitle: updated.title },
      });
      enqueueBackgroundTaskOutcomeTurn(
        updated,
        'needs_input',
        `Task ${updated.id} is paused on an approval — approve on the card above (or the Tasks board) and it resumes automatically.`,
      );
    }
  }
  return updated;
}

export function markBackgroundTaskAwaitingContinue(id: string, reason: string, resultText: string): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const reasonText = clean(reason || 'The task reached its internal run budget before finishing.', 1000);
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, (task) => ({
    ...clearParkedBackgroundState(),
    status: 'awaiting_continue',
    completedAt: undefined,
    error: reasonText,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
    outcomeSnapshot: buildBackgroundTaskOutcomeSnapshot(task, 'needs_input', {
      blocker: reasonText,
      blockerType: 'budget',
      nextAction: 'Reply `continue` or resume this task from the Tasks board. Clementine will continue from the saved run.',
      resumable: true,
    }),
  }));
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-awaiting-continue`,
      kind: 'approval',
      title: `Background task needs continue: ${updated.title}`,
      body: [
        `Task ${updated.id} reached its internal run budget before finishing.`,
        ``,
        `Reason: ${reasonText}`,
        ``,
        `Resume it from the Tasks board, or reply \`continue\` in the originating chat if this is the only parked background task there.`,
      ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'awaiting_continue' }),
    });
    enqueueBackgroundTaskOutcomeTurn(
      updated,
      'needs_input',
      `Task ${updated.id} reached its internal run budget before finishing. Reply \`continue\` to queue the next background turn, or resume it from the Tasks board.`,
    );
    emitBackgroundTaskOperational('background_task_parked', updated, { reason: 'awaiting_continue' }, 'warn');
  }
  return updated;
}

/**
 * Mark a task BLOCKED: it could not complete the objective because a
 * prerequisite was missing (no data, no access, an unmet dependency).
 * This is the honest terminal state for "I tried, I can't finish this
 * without X" — never silently a 'done'. The notification is `approval`
 * kind so it surfaces with attention; the body carries the concrete
 * blocker + what the user can do. The task is NOT auto-resumed (resume
 * would just re-block); the user explicitly resumes the same saved task once
 * the blocker is cleared.
 */
export function markBackgroundTaskBlocked(id: string, reason: string, resultText: string, knownBlockerType?: BlockerType): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const blockerType = knownBlockerType ?? classifyBlocker(reason);
  const updated = updateBackgroundTaskWhere(id, workerBlockedMayProceed, (task) => ({
    ...clearParkedBackgroundState(),
    status: 'blocked',
    completedAt: nowIso(),
    error: clean(reason, 1000),
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
    outcomeSnapshot: buildBackgroundTaskOutcomeSnapshot(task, 'blocked', {
      blocker: reason,
      blockerType,
    }),
  }));
  if (updated) {
    // Tag the blocker by KIND (deterministic, zero-token) so the dashboard /
    // proactive brief / future routing can act on the class, not just the prose.
    const reportDetail = progressPreservingPauseDetail(
      'Resolve the remaining blocker before starting another run.',
      { resultText, blockerReason: reason, blockerType },
    );
    const notificationBody = progressPreservingPauseDetail(
      'Resolve the remaining blocker before starting another run.',
      { resultText, blockerReason: reason, blockerType },
      2000,
    );
    addNotification({
      id: `${Date.now()}-background-${updated.id}-blocked`,
      kind: 'approval',
      title: `Background task blocked: ${updated.title}`,
      // 'unverified_completion' (Move 3) is the OPPOSITE situation from the
      // default copy: the run claims done and DID perform an irreversible
      // external action, but the refuters couldn't verify it. Telling the user
      // "I did NOT ship … re-run" here invites a manual DOUBLE-SEND (review
      // the check-first regression review). Say check-first instead.
      // Neutral system surface (owner feedback, 2026-07-24): notifications
      // state facts; Clem's VOICE on this outcome is the model-authored
      // report-back turn (enqueueBackgroundTaskOutcomeTurn below).
      body: blockerType === 'unverified_completion'
        ? [
          `The run reports this as done and it DID perform an irreversible external action — but the completion could not be independently verified.`,
          ``,
          `Unverified because: ${clean(reason, 600)}`,
          ``,
          `CHECK the actual outcome (sent messages / created records) BEFORE re-running — re-running may duplicate an irreversible send.`,
        ].join('\n')
        : [
          notificationBody,
        ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'blocked', blockerType, terminalReportBack: true }),
    });
    // Report-back without fail: a BLOCKED task must reach Clementine's context,
    // not just a notification — so she can surface the blocker or resolve it.
    enqueueBackgroundTaskOutcomeTurn(updated, 'blocked', reportDetail);
    emitBackgroundTaskOperational('background_task_parked', updated, { reason: 'blocked' }, 'warn');
  }
  return updated;
}

function emitBackgroundTaskFailedTransition(
  updated: BackgroundTaskRecord,
  error: string,
  status: Extract<BackgroundTaskStatus, 'failed' | 'aborted' | 'interrupted'>,
): void {
  addNotification({
    id: `${Date.now()}-background-${updated.id}-${status}`,
    kind: 'execution',
    title: `Background task ${status}: ${updated.title}`,
    body: updated.error ?? status,
    createdAt: nowIso(),
    read: false,
    metadata: taskNotificationMetadata(updated, { status, terminalReportBack: true }),
  });
  // Report-back without fail: a genuine FAILURE re-enters the origin session
  // so Clementine can retry/adjust or tell the user. Skip 'interrupted'
  // (a daemon-restart transient that is auto-resumed) and 'aborted' (the
  // user cancelled it — they already know).
  if (status === 'failed') {
    enqueueBackgroundTaskOutcomeTurn(updated, 'failed', updated.error ?? error);
  }
  emitBackgroundTaskOperational('background_task_finished', updated, { status }, 'error');
}

export function markBackgroundTaskFailed(id: string, error: string, status: Extract<BackgroundTaskStatus, 'failed' | 'aborted' | 'interrupted'> = 'failed'): BackgroundTaskRecord | null {
  if (status !== 'aborted' && !prepareWorkerSettlementForCas(id)) return null;
  const updated = updateBackgroundTaskWhere(
    id,
    (task) => workerFailureMayProceed(task, status),
    (task) => ({
      ...clearParkedBackgroundState(),
      status,
      completedAt: nowIso(),
      error: clean(error, 1000),
      outcomeSnapshot: status === 'failed'
        ? buildBackgroundTaskOutcomeSnapshot(task, 'failed', { blocker: error })
        : undefined,
    }),
  );
  if (updated) emitBackgroundTaskFailedTransition(updated, error, status);
  return updated;
}

/**
 * Decide the HONEST terminal state of a finished worker turn before we
 * stamp it 'done'. The runtime can return normally (no pending approval,
 * no thrown error) while the task did NOT actually achieve its objective
 * — it left a blocked execution, or its own final text says it's blocked
 * / waiting on input / produced nothing usable. Reporting that as 'done'
 * is the failure the owner hit: an empty Google Sheet shipped because the
 * Salesforce pull came back empty yet the run still "completed".
 *
 * Signals (any one ⇒ blocked):
 *  - the worker left an execution in `blocked` status for this session
 *    (it called execution_mark_blocked), or
 *  - its final text matches a blocked/needs-input/approval-pending shape.
 *
 * Deliberately conservative: we only divert to `blocked` on a positive
 * signal. A genuinely-complete run with no blocked markers stays 'done'.
 */
// Blocked-output classification now lives in runtime/harness/verify-delivered.ts
// so the cron/gateway/autonomy honesty chokepoint and this richer background-task
// classifier share one blocked-text vocabulary.

export function classifyBackgroundTaskOutcome(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
  opts: { ignoreFanoutCoverage?: boolean; ignoreSelfReportedBlockedText?: boolean } = {},
): { outcome: 'done' | 'blocked'; reason?: string; blockerType?: BlockerType } {
  // 1) Structured signal: did the worker explicitly mark an execution
  //    blocked in its own session? This is the strongest signal — it's
  //    the agent telling us, in code, that it could not proceed.
  try {
    const blockedExecution = new ExecutionStore()
      .list(40)
      .find((e) => e.sessionId === task.runSessionId && e.status === 'blocked');
    if (blockedExecution) {
      const reason = blockedExecution.blocker || 'Execution marked blocked by the agent.';
      return { outcome: 'blocked', reason, blockerType: classifyBlocker(reason) };
    }
  } catch {
    // store read is best-effort; fall through to text heuristics
  }

  // 2) The runtime stopped while still pending an approval but the caller
  //    didn't catch it (defense-in-depth; the explicit pendingApprovalId
  //    branch normally handles this first).
  if (stoppedReason === 'pending-approval') {
    return {
      outcome: 'blocked',
      reason: 'Stopped awaiting an approval that was not surfaced.',
      blockerType: 'needs_approval',
    };
  }

  // 2.5) P0-C — the runtime threw mid-turn and `respond()` converted it to a
  //      typed error result (a wall-clock abort that survived the P0-A in-loop
  //      retries, a 5xx burst, a transport timeout). That is NOT a finished
  //      deliverable; surface it as a non-completion so report-back is honest
  //      and the watchdog re-spawn isn't the only backstop.
  if (stoppedReason === 'error') {
    const text = (finalText || '').trim();
    return {
      outcome: 'blocked',
      reason: (text || 'The run hit a runtime error before finishing.').slice(0, 400),
      blockerType: classifyBlocker(text, 'error'),
    };
  }
  if (stoppedReason === 'max-turns-with-grace') {
    const text = (finalText || '').trim();
    return {
      outcome: 'blocked',
      reason: (text || 'The run hit its turn budget before finishing; continue is required.').slice(0, 400),
      blockerType: 'budget',
    };
  }

  // 3) Text heuristic: the agent's own final words say it's blocked.
  const text = (finalText || '').trim();
  if (text) {
    const turnText = classifyTurnText(text, { toolCalls: 0 });
    if (turnText.kind === 'fake_tool_transcript') {
      return {
        outcome: 'blocked',
        reason: `The worker wrote a fake tool call transcript instead of calling the tool: ${text.slice(0, 320)}`,
        blockerType: 'unknown',
      };
    }
    // The self-reported-blocked TEXT heuristic is negation-aware but still
    // past-tense-blind: a SUCCESS narrative that recounts a blocker it already
    // OVERCAME ("was blocked on X, then reconnected and finished") matches the
    // same phrase patterns as a live blocker. On the finish path that is paired
    // with the runtime stoppedReason + execution-store signals, so a stray match
    // self-corrects. The integrity SWEEP has neither — it runs over long-settled
    // done tasks with no stoppedReason — so it opts OUT of this heuristic and
    // reclassifies only on a positive/structural non-deliverable (no saved
    // result, a blocked execution row, a fabricated transcript, or a fan-out
    // coverage failure), never on the narrative alone. (Finding A false-positive.)
    if (!opts.ignoreSelfReportedBlockedText && matchesBlockedText(text)) {
      return {
        outcome: 'blocked',
        reason: text.slice(0, 400),
        blockerType: classifyBlocker(text),
      };
    }
  }

  // 4) FIX 7 — fan-out coverage: if this run fanned out workers and any item
  //    FAILED (worker returned ERROR:), report partial coverage honestly
  //    instead of a hollow "done". Flag-gated (CLEMMY_FANOUT_LEDGER).
  if (!opts.ignoreFanoutCoverage) {
    const coverageBlock = fanoutCoverageBlock(task.runSessionId);
    if (coverageBlock) return coverageBlock;
  }

  return { outcome: 'done' };
}

/** The objective string the deliverable probe checks a background run against.
 *  A GOAL-bound run uses its plan objective + success criteria (verbatim); an
 *  AD-HOC run (no goal contract) falls back to its own prompt/title so the probe
 *  still runs on every task, not just goal-bound ones (2026-07-13 Wave 1). Pure +
 *  exported for the gate test. */
export function probeObjectiveForTask(
  task: Pick<BackgroundTaskRecord, 'prompt' | 'title'>,
  goal: { approvedPlan?: { objective?: string; successCriteria?: string[] }; plan?: { objective?: string; successCriteria?: string[] } } | null | undefined,
): string {
  if (goal) {
    const plan = goal.approvedPlan ?? goal.plan;
    const fromPlan = [plan?.objective ?? '', ...((plan?.successCriteria ?? []) as string[])]
      .filter((s) => typeof s === 'string' && s.trim())
      .join('\n');
    if (fromPlan.trim()) return fromPlan;
  }
  return task.prompt || task.title || '';
}

/** Deliverable-evidence tripwire (live 2026-07-23): a resumed run concluded
 *  "## Completed — loaded the roster, confirmed access" TWICE and was stamped
 *  done, with the actual deliverable (a Google Sheet) never produced. When
 *  the task's own prompt commits to an external artifact, a completion with
 *  ZERO evidence of one — no artifact-ledger claim, no external_write, no
 *  session deliverable — is not a completion. Deterministic, zero-LLM. */
const ARTIFACT_INTENT_RE =
  /\b(?:write|create|build|save|put|produce|generate|make|draft)\b[\s\S]{0,60}\b(?:sheet|spreadsheet|workbook|google doc|document|docs?|file|\.md|csv|report|deck|slide)/i;
// Destination-cued draft promises ("draft 20 emails IN OUTLOOK", "create
// replies in my drafts folder") also commit to an external artifact. A bare
// "draft me some emails" is deliberately NOT gated — text-form drafts returned
// in the report-back are a legitimate deliverable with no external evidence.
const EXTERNAL_DRAFT_INTENT_RE =
  /\b(?:draft|create|prepare|write|make)\b[^.\n]{0,60}\b(?:emails?|messages?|repl(?:y|ies)|follow[- ]?ups?)\b[^.\n]{0,80}\b(?:in|into)\s+(?:outlook|gmail|my\s+drafts|the\s+drafts?\s+folder|drafts?\s+folder|salesforce|hubspot)/i;

/** A safety constraint such as "do not write files" is evidence AGAINST an
 * artifact promise, not a promise whose absence should block completion. Check
 * the clause immediately before the matched action; "do not stop until you
 * write the report" remains positive because `until` reverses that reading. */
function promptCommitsTo(
  prompt: string,
  intentPattern: RegExp,
): boolean {
  for (const clause of prompt.split(/[\n;]|(?<=[.!?])\s+/)) {
    const match = intentPattern.exec(clause);
    if (!match) continue;
    const prefix = clause.slice(Math.max(0, match.index - 80), match.index);
    const directlyNegated = /\b(?:do\s+not|don't|never)\b(?:(?!\b(?:until|before)\b)[\s\S]){0,70}$/i.test(prefix);
    if (!directlyNegated) return true;
  }
  return false;
}

export interface BackgroundCompletionEvidence {
  artifactBindings: number;
  extractedDeliverables: number;
  externalWriteReceipts: number;
  ambiguousExternalWrites: number;
}

/**
 * Reduce only facts the runtime already owns. This is the background lane's
 * completion authority: model prose explains the work, while durable bindings,
 * successful deliverable-return rows, and uncompensated external-write receipts
 * prove that promised effects exist. No model call and no semantic verdict.
 */
export function backgroundCompletionEvidence(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
): BackgroundCompletionEvidence {
  let artifactBindings = 0;
  let extractedDeliverables = 0;
  let externalWriteReceipts = 0;
  let ambiguousExternalWrites = 0;
  try { artifactBindings = listRunArtifacts(task.runSessionId).length; } catch { /* unreadable evidence stays absent */ }
  try { extractedDeliverables = extractDeliverables(task.runSessionId).length; } catch { /* unreadable evidence stays absent */ }
  try {
    const writes = assessBackgroundTaskRestartSafety(task);
    ambiguousExternalWrites = writes.ambiguousWriteCount;
    const writeEvents = listHarnessEventsForRefute(task.runSessionId, {
      types: [
        'external_write',
        'external_write_succeeded',
        'external_write_failed',
        'external_write_orphaned',
        'tool_returned',
      ],
    });
    const lifecycleEvents = writeEvents.filter((event) => (
      event.type === 'external_write'
      || event.type === 'external_write_succeeded'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    ));
    const receiptKeys = new Set<string>();
    const lifecycleCallIds = new Set<string>();
    for (const event of lifecycleEvents) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const callId = typeof data.canonicalCallId === 'string' && data.canonicalCallId.trim()
        ? data.canonicalCallId.trim()
        : typeof data.callId === 'string'
          ? data.callId.trim()
          : '';
      if (callId) lifecycleCallIds.add(callId);
    }
    for (const event of resolveWriteEvidence(lifecycleEvents).confirmed) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const callId = typeof data.canonicalCallId === 'string' && data.canonicalCallId.trim()
        ? data.canonicalCallId.trim()
        : typeof data.callId === 'string'
          ? data.callId.trim()
          : '';
      receiptKeys.add(callId ? `call:${callId}` : `event:${event.seq}`);
    }
    // Restart safety deliberately treats a lone external-write return as
    // write-touched even when its result failed. Completion is stricter: only
    // a successful return for a call whose canonical lifecycle is absent can
    // stand in for a missing receipt.
    for (const event of writeEvents) {
      if (event.type !== 'tool_returned') continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.accounting === 'transport_mirror' || data.effect !== 'external_write') continue;
      const callId = typeof data.callId === 'string' ? data.callId.trim() : '';
      if (callId && lifecycleCallIds.has(callId)) continue;
      const resultText = [data.result, data.preview, data.output, data.error]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
      const failed = data.ok === false
        || data.isError === true
        || (typeof data.error === 'string' && data.error.trim().length > 0)
        || detectStructuredToolFailure(resultText).failed;
      if (failed) continue;
      receiptKeys.add(callId ? `call:${callId}` : `event:${event.seq}`);
    }
    externalWriteReceipts = receiptKeys.size;
  } catch { /* unreadable evidence stays absent */ }
  return { artifactBindings, extractedDeliverables, externalWriteReceipts, ambiguousExternalWrites };
}

function latestConcreteToolFailure(
  sessionId: string,
): NonNullable<OutcomeEvidence['lastToolFailure']> | undefined {
  try {
    const events = listHarnessEventsForRefute(sessionId, {
      types: ['tool_returned'],
      desc: true,
      limit: 120,
    });
    for (const event of events) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const raw = [data.error, data.result, data.preview, data.output]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
      if (!raw) continue;
      const structured = detectStructuredToolFailure(raw);
      const failed = data.ok === false
        || data.isError === true
        || (typeof data.error === 'string' && data.error.trim().length > 0)
        || structured.failed
        || /\bexit_code\s*:\s*[1-9]\d*\b/i.test(raw);
      if (!failed) continue;
      const summary = clean(redactSensitiveText(structured.summary || raw), 700);
      if (!summary) continue;
      const tool = typeof data.tool === 'string' ? clean(data.tool, 120) : undefined;
      return { ...(tool ? { tool } : {}), summary };
    }
  } catch {
    // Outcome evidence is a report-back enhancement, never a settlement gate.
  }
  return undefined;
}

function backgroundOutcomeEvidence(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
  includeToolFailure = true,
): OutcomeEvidence | undefined {
  const work = summarizeWorkManifests(task.runSessionId)
    .slice(-4)
    .map((manifest) => ({
      label: manifest.objective || manifest.manifestId,
      completed: manifest.completed,
      total: manifest.total,
      evidenceCount: manifest.evidenceCount,
    }));

  const artifacts: NonNullable<OutcomeEvidence['artifacts']> = [];
  const seenArtifacts = new Set<string>();
  const addArtifact = (kind: string, ref: string | null | undefined, verified?: boolean): void => {
    const safeRef = redactSensitiveText(ref ?? '').trim().slice(0, 500);
    if (!safeRef) return;
    const key = `${kind}:${safeRef}`;
    if (seenArtifacts.has(key) || artifacts.length >= 8) return;
    seenArtifacts.add(key);
    artifacts.push({
      kind: clean(kind || 'artifact', 80),
      ref: safeRef,
      ...(verified ? { verified: true } : {}),
    });
  };
  try {
    for (const artifact of listRunArtifacts(task.runSessionId)) {
      if (artifact.status !== 'bound') continue;
      addArtifact(
        artifact.kind,
        artifact.uri || artifact.resourceId,
        Boolean(artifact.bindingVerifiedAt),
      );
    }
  } catch { /* best-effort evidence projection */ }
  try {
    for (const deliverable of extractDeliverables(task.runSessionId)) {
      addArtifact(deliverable.kind, deliverable.ref);
    }
  } catch { /* best-effort evidence projection */ }

  const completion = backgroundCompletionEvidence(task);
  // A recovered error remains useful trace history, but it is not a remaining
  // dependency once the run honestly settles done.
  const lastToolFailure = includeToolFailure
    ? latestConcreteToolFailure(task.runSessionId)
    : undefined;
  const evidence: OutcomeEvidence = {
    ...(work.length > 0 ? { work } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(completion.externalWriteReceipts > 0
      ? { committedExternalActions: completion.externalWriteReceipts }
      : {}),
    ...(lastToolFailure ? { lastToolFailure } : {}),
  };
  return evidence.work
    || evidence.artifacts
    || evidence.committedExternalActions
    || evidence.lastToolFailure
    ? evidence
    : undefined;
}

function defaultBackgroundNextAction(
  outcome: BackgroundTaskOutcome,
  blockerType: BlockerType | undefined,
): { nextAction?: string; resumable?: boolean } {
  if (outcome === 'done') return {};
  if (blockerType === 'permission') {
    return {
      nextAction: 'Authenticate or reconnect the service named in the concrete tool failure above, then reply `continue`. Clementine will resume this same saved task.',
      resumable: true,
    };
  }
  if (blockerType === 'needs_user_input') {
    return {
      nextAction: 'Provide the missing input, then reply `continue`. Clementine will resume this same saved task.',
      resumable: true,
    };
  }
  if (blockerType === 'needs_approval') {
    return {
      nextAction: 'Review the pending approval. If approved, resume this same saved task.',
      resumable: true,
    };
  }
  if (blockerType === 'budget') {
    return {
      nextAction: 'Reply `continue` or resume from the Tasks board to continue this same saved run.',
      resumable: true,
    };
  }
  if (blockerType === 'rate_limited' || blockerType === 'external_down') {
    return {
      nextAction: 'Wait for the provider to recover, then resume this same saved task. Do not repeat already committed actions.',
      resumable: true,
    };
  }
  if (outcome === 'needs_input') {
    return {
      nextAction: 'Answer the question above so Clementine can resume this same saved task.',
      resumable: true,
    };
  }
  return outcome === 'blocked' || outcome === 'failed'
    ? {
      nextAction: 'Inspect the saved evidence, resolve the remaining issue, then resume this same saved task. Do not recreate proven work or repeat committed actions.',
      resumable: true,
    }
    : {};
}

function buildBackgroundTaskOutcomeSnapshot(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
  outcome: BackgroundTaskOutcome,
  input: {
    blocker?: string;
    blockerType?: BlockerType;
    nextAction?: string;
    resumable?: boolean;
  } = {},
): BackgroundTaskOutcomeSnapshot {
  const blocker = input.blocker ? clean(redactSensitiveText(input.blocker), 1000) : undefined;
  const blockerType = input.blockerType ?? (blocker ? classifyBlocker(blocker) : undefined);
  const fallback = defaultBackgroundNextAction(outcome, blockerType);
  const nextAction = clean(
    redactSensitiveText(input.nextAction ?? fallback.nextAction ?? ''),
    700,
  ) || undefined;
  return {
    version: 1,
    capturedAt: nowIso(),
    evidence: backgroundOutcomeEvidence(task, outcome !== 'done'),
    ...(blocker ? { blocker } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...((input.resumable ?? fallback.resumable) !== undefined
      ? { resumable: input.resumable ?? fallback.resumable }
      : {}),
  };
}

function hasDurableDeliverableEvidence(evidence: BackgroundCompletionEvidence): boolean {
  return evidence.artifactBindings > 0
    || evidence.extractedDeliverables > 0
    || evidence.externalWriteReceipts > 0;
}

function workManifestHasDurableCompletionEvidence(manifest: WorkManifestSummary): boolean {
  if (
    manifest.total < 1
    || manifest.completed !== manifest.total
    || manifest.remaining !== 0
    || manifest.untrackedCheckpoints !== 0
    || manifest.anomalies.length > 0
    || manifest.phases.length === 0
    || manifest.items.length !== manifest.total
  ) {
    return false;
  }
  const phaseIds = manifest.phases.map((phase) => phase.id);
  return manifest.items.every((item) => (
    item.complete
    && phaseIds.every((phaseId) => {
      const state = item.phases[phaseId];
      return state?.status === 'succeeded'
        && state.contractVersion === manifest.contractVersion
        && state.evidence.length > 0;
    })
  ));
}

function taskRequiresExternalSendReceipt(
  task: Pick<BackgroundTaskRecord, 'prompt' | 'title'>,
): boolean {
  return stepLooksLikeIrreversibleSend(`${task.title}\n${task.prompt}`);
}

export function completionLacksDeliverableEvidence(
  task: Pick<BackgroundTaskRecord, 'runSessionId' | 'prompt'>,
): boolean {
  try {
    const prompt = task.prompt ?? '';
    if (!promptCommitsTo(prompt, ARTIFACT_INTENT_RE) && !promptCommitsTo(prompt, EXTERNAL_DRAFT_INTENT_RE)) return false;
    return !hasDurableDeliverableEvidence(backgroundCompletionEvidence(task));
  } catch {
    return false; // evidence read failure must never block an honest done
  }
}

async function verifyBackgroundTaskDelivery(
  task: Pick<BackgroundTaskRecord, 'runSessionId' | 'prompt' | 'title'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
): Promise<{ outcome: 'done' | 'blocked'; reason?: string; blockerType?: BlockerType }> {
  const classified = classifyBackgroundTaskOutcome(task, finalText, stoppedReason, { ignoreFanoutCoverage: true });
  if (classified.outcome === 'blocked') return classified;
  if (backgroundCompletionVerificationPauseForTests) await backgroundCompletionVerificationPauseForTests();

  const completionEvidence = backgroundCompletionEvidence(task);
  if (completionEvidence.ambiguousExternalWrites > 0) {
    return {
      outcome: 'blocked',
      reason: 'An external mutation started but has no durable success or proven-failure receipt. Check the external system before continuing; replay may duplicate the action.',
      blockerType: 'unknown',
    };
  }
  if (taskRequiresExternalSendReceipt(task) && completionEvidence.externalWriteReceipts === 0) {
    return {
      outcome: 'blocked',
      reason: 'The task required an external send or publish, but the run has no committed external-write receipt.',
      blockerType: 'unknown',
    };
  }
  if (completionLacksDeliverableEvidence(task)) {
    return {
      outcome: 'blocked',
      reason: 'Completion claimed, but the task promised an external deliverable and the run shows no evidence of one (no artifact, no external write, no file written).',
      blockerType: 'unknown',
    };
  }

  // Stage 3: close out the reduce tier before verification — reduce any
  // full-but-unstarted shard a crash left behind and let in-flight shard
  // reduces land, so every shard artifact is on disk for synthesis/readers.
  // Best-effort; a sweep failure never blocks delivery.
  try {
    await sweepFanoutReduce(task.runSessionId);
  } catch { /* sweep is best-effort */ }

  // Wave 4 Stage 2 — per-item verification of the fan-out worker OUTPUTS (anti-
  // silent-success). A zero-LLM tripwire flags hollow / blocked / off-objective /
  // unsupported ok-status worker outputs; ONE batched cross-family judge confirms
  // the flagged subset; a confirmed fabrication is recorded as worker_result
  // ok:false so the coverage read below counts it failed (honest "M of N"). Reduce-
  // time + fail-open — never touches the hot fan-out return path. Kill-switch
  // CLEMMY_FANOUT_ITEM_VERIFY. Runs BEFORE the coverage read so its verdicts land.
  const workManifests = summarizeWorkManifests(task.runSessionId);
  if (workManifests.length === 0 && fanoutItemVerifyEnabled()) {
    try {
      const verifyObjective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId));
      if (verifyObjective.trim()) await verifyFanoutItems(task.runSessionId, verifyObjective);
    } catch {
      // A verify hiccup must NEVER block a run — fall through to the existing checks.
    }
  }

  let coverageBlock = fanoutCoverageBlock(task.runSessionId);
  // Inline-recovery promotion (v2.2.1): the brain may have closed failed items
  // INLINE after their workers died — the ledger cannot see that (live
  // 2026-07-22: a complete 3-firm deliverable stamped blocked on its 2
  // pre-recovery worker failures). The legacy fan-out verifier checks each
  // failed item against the final deliverable; ALL confirmed → durable ok:true
  // promotions flip coverage and the run proceeds to deterministic deliverable
  // readback below. Promotion alone never grants done. This remaining fan-out
  // judge is intentionally separate from terminal completion authority and is
  // the next migration slice.
  if (coverageBlock && workManifests.length === 0) {
    try {
      const cov = summarizeFanoutCoverage(task.runSessionId);
      const objective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId)) || task.prompt || task.title;
      if (await verifyInlineRecovery(task.runSessionId, objective, cov.failedItems, finalText)) {
        coverageBlock = null;
      }
    } catch { /* fail-closed: the block stands */ }
  }
  // Fan-out coverage is AUTHORITATIVE: if any worker failed (a raw ERROR: from
  // Stage 1, or a Stage-2-confirmed hollow output just recorded above), the run is
  // a partial and MUST NOT report a hollow "done" — per the run_worker contract
  // ("never report a batch complete if any worker returned ERROR"). Before this
  // gate, coverageBlock was only a fallback reason on later
  // verification-failure paths, so a confident aggregate could discard it and
  // the honest "M of N" never surfaced (Stage-2 adversarial review #1 — the
  // feature was inert on exactly its target path). Gate here before artifact
  // readback.
  if (coverageBlock) return coverageBlock;

  // DELIVERABLE PROBE — deterministic readback of the artifacts THIS run produced
  // (created sheet ids, written file paths, space views), gated to GOAL-BOUND
  // background runs (the trust-critical lane: a bound goal contract exists). The fix
  // for the 2026-07-08 "shipped 5 BLANK Google Sheets as done" — the judge only saw
  // the model's claims. A CONFIRMED probe failure blocks completion with the SPECIFIC
  // gap. Requirement-sensitive: an unprobeable existence-only artifact keeps
  // its creation receipt, but an unprobeable REQUIRED population/readback can
  // never manufacture proof of completion. Kill:
  // CLEMMY_DELIVERABLE_PROBES=off.
  if (deliverableProbesEnabled()) {
    try {
      // Objective for the deterministic artifact readback. A GOAL-bound run uses
      // its plan objective + success criteria; an AD-HOC run (no goal contract)
      // falls back to its own prompt/title. 2026-07-13 Wave 1: the probe caught
      // the "shipped 5 BLANK sheets as done" class only for goal-bound runs —
      // extend it to EVERY background task so a hollow deliverable is caught by
      // deterministic readback, not a semantic model verdict.
      const objective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId));
      if (objective.trim()) {
        const probe = await probeSessionDeliverables(task.runSessionId, objective);
        if (probe.failures.length > 0) {
          return { outcome: 'blocked', reason: probe.summary.slice(0, 400) };
        }
      }
    } catch {
      // The probe module converts requirement-sensitive readback failures into
      // verdicts. This outer catch is only a module-level availability backstop;
      // existing durable evidence continues to govern if the verifier itself
      // could not be invoked at all.
    }
  }

  // Promise-only output is protocol hygiene, not a semantic judgment. When no
  // durable effect exists, "I'll do it next" is deterministically not a result.
  // When a receipt/artifact DOES exist, facts win: do not let awkward tense
  // erase already-committed work or invite a duplicate retry.
  // A fully completed logical manifest is also durable completion evidence for
  // hermetic/research fan-out. This gate runs after the stricter external-send
  // and promised-artifact receipt checks above, so worker receipts can never
  // substitute for a missing sheet, file, publish, or external mutation.
  const manifestCompletionEvidence = workManifests.some(workManifestHasDurableCompletionEvidence);
  if (
    isPromiseShapedReply(finalText)
    && !hasDurableDeliverableEvidence(completionEvidence)
    && !manifestCompletionEvidence
  ) {
    return {
      outcome: 'blocked',
      reason: 'The worker only promised future work and the run contains no durable completion evidence.',
      blockerType: 'unknown',
    };
  }

  return { outcome: 'done' };
}

/**
 * FIX 7 — derive a partial-coverage "blocked" verdict from the per-run fan-out
 * ledger, or null when coverage is complete / the flag is off / nothing fanned
 * out. Shared by both the post-approval and main drain completion paths so a
 * partial batch never reports a hollow "done" on either. Best-effort.
 */
function fanoutCoverageBlock(runSessionId: string): { outcome: 'blocked'; reason: string } | null {
  if (!fanoutLedgerEnabled()) return null;
  try {
    // The durable logical manifest supersedes attempt-label accounting. Once a
    // run declares canonical items/phases, completion is measured against that
    // fixed universe — never against however many worker labels happened to be
    // emitted. This is what prevents "120 accounts" from becoming "240 items"
    // when a later wave names the same accounts by spreadsheet row.
    const manifests = summarizeWorkManifests(runSessionId);
    if (manifests.length > 0) {
      const incomplete = manifests.find((manifest) => manifest.remaining > 0);
      if (incomplete) return workManifestCoverageBlock(incomplete);
      return null;
    }
    // Wave 4 Stage 1: read coverage from the DURABLE worker_result log (restart-
    // surviving, deduped by packetKey) rather than the per-process in-memory
    // ledger, so a resumed swarm reports honest "M of N" without a rehydrate that
    // double-counted against the live path or got wiped by clearLedger-on-continue.
    const cov = summarizeFanoutCoverage(runSessionId);
    if (cov.total > 0 && cov.failed > 0) {
      const shown = cov.failedItems.slice(0, 8).join(', ');
      const more = cov.failedItems.length > 8 ? `, +${cov.failedItems.length - 8} more` : '';
      return {
        outcome: 'blocked',
        reason: `Partial coverage: ${cov.done}/${cov.total} items done, ${cov.failed} failed (${shown}${more}).`,
      };
    }
  } catch {
    // best-effort
  }
  return null;
}

function workManifestCoverageBlock(
  manifest: WorkManifestSummary,
): { outcome: 'blocked'; reason: string } {
  const current = manifest.phases.find((phase) => phase.id === manifest.currentPhase)
    ?? manifest.phases.find((phase) => phase.succeeded < phase.total);
  const phaseProgress = current
    ? `${current.label}: ${current.succeeded}/${current.total} complete`
      + (current.running ? `, ${current.running} running` : '')
      + (current.failed ? `, ${current.failed} failed` : '')
      + (current.needsValidation ? `, ${current.needsValidation} need validation` : '')
      + (current.invalidated ? `, ${current.invalidated} invalidated` : '')
    : `${manifest.completed}/${manifest.total} items complete`;
  const anomaly = manifest.untrackedCheckpoints > 0
    ? ` ${manifest.untrackedCheckpoints} untracked attempt${manifest.untrackedCheckpoints === 1 ? '' : 's'} were excluded from logical totals.`
    : '';
  return {
    outcome: 'blocked',
    reason: `Logical work is incomplete under contract ${manifest.contractVersion}: ${phaseProgress}; ${manifest.completed}/${manifest.total} items completed every phase.${anomaly}`,
  };
}

export function cancelBackgroundTask(id: string, reason = 'Cancelled by user.'): BackgroundTaskRecord | null {
  // Read/branch/write is retried as a conditional transition. Whichever of
  // pending->running or pending->aborted obtains the task lease first becomes
  // authoritative; a stale starter can never overwrite the cancellation.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const task = getBackgroundTask(id);
    if (!task) return null;
    if (task.status === 'done' || task.status === 'failed' || task.status === 'aborted') {
      return task;
    }
    if (task.status === 'running' || task.status === 'cancelling') {
      if (task.status === 'cancelling') return task;
      const now = nowIso();
      const updated = updateBackgroundTaskWhere(id, (latest) => latest.status === 'running', {
        status: 'cancelling',
        cancellationRequestedAt: now,
        cancellationReason: reason,
        lastCheckInAt: now,
        lastCheckInMessage: `Cancellation requested. ${reason}`,
      });
      if (!updated) continue;
      addNotification({
        id: `${Date.now()}-background-${updated.id}-cancelling`,
        kind: 'execution',
        title: `Background task cancelling: ${updated.title}`,
        body: `Cancellation was requested for task ${updated.id}. It will stop at the next safe checkpoint.`,
        createdAt: now,
        read: false,
        metadata: taskNotificationMetadata(updated, { status: 'cancelling' }),
      });
      return updated;
    }
    const updated = updateBackgroundTaskWhere(id, (latest) => latest.status === task.status, {
      ...clearParkedBackgroundState(),
      status: 'aborted',
      completedAt: nowIso(),
      error: clean(reason, 1000),
    });
    if (!updated) continue;
    emitBackgroundTaskFailedTransition(updated, reason, 'aborted');
    return updated;
  }
  return getBackgroundTask(id);
}

/** Task statuses that mean a resume clone is STILL live (an executor exists or is
 *  queued) — used to stop a second clone spawning while the first is in flight. */
const LIVE_TASK_STATUSES: readonly BackgroundTaskStatus[] = [
  'pending', 'running', 'cancelling', 'awaiting_approval', 'awaiting_input', 'awaiting_continue',
];

export interface BackgroundRestartSafetyAssessment {
  safeToAutoResume: boolean;
  reason: NonNullable<BackgroundTaskRecord['restartRecovery']>['reason'];
  externalWriteCount: number;
  ambiguousWriteCount: number;
}

/**
 * Inspect the ORIGINAL background run's durable receipt history before boot
 * recovery. A new safety session is never an acceptable substitute: it cannot
 * see the old duplicate-write ledger. The current harness event producers are
 * best-effort, so an EMPTY ledger is never proof that no mutation was attempted
 * — it parks as `receipt_history_unavailable`. But a ledger that DID record
 * tool activity or an exactly-failed no-dispatch write is positive evidence
 * the producers were running and no mutation landed: it reattaches
 * automatically as `safe_no_external_write`. Legacy write receipts and new
 * reservations with exact same-call success park as `external_write_history`;
 * unsettled reservations, unreturned external calls, and explicit orphan
 * markers are the stronger ambiguous class (`ambiguous_external_write`).
 */
export function assessBackgroundTaskRestartSafety(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
): BackgroundRestartSafetyAssessment {
  try {
    if (!getHarnessSessionRow(task.runSessionId)) {
      return {
        safeToAutoResume: false,
        reason: 'receipt_history_unavailable',
        externalWriteCount: 0,
        ambiguousWriteCount: 0,
      };
    }

    const events = listHarnessEventsForRefute(task.runSessionId, {
      types: [
        'tool_called',
        'tool_returned',
        'external_write',
        'external_write_succeeded',
        'external_write_failed',
        'external_write_orphaned',
        'orphaned_tool_inflight',
      ],
    });
    const returnedCallIds = new Set<string>();
    const externalCallIds = new Set<string>();
    for (const event of events) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === 'tool_returned') {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId) returnedCallIds.add(callId);
      } else if (
        event.type === 'tool_called'
        && data.accounting !== 'transport_mirror'
        && data.effect === 'external_write'
      ) {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId) externalCallIds.add(callId);
      }
    }

    const writeKey = (event: (typeof events)[number]): string => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const callId = typeof data.canonicalCallId === 'string' && data.canonicalCallId.trim()
        ? data.canonicalCallId.trim()
        : typeof data.callId === 'string'
          ? data.callId.trim()
          : '';
      return callId ? `call:${callId}` : `event:${event.seq}`;
    };
    const lifecycleEvents = events.filter((event) => (
      event.type === 'external_write'
      || event.type === 'external_write_succeeded'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    ));
    const canonicalWrites = lifecycleEvents.filter((event) => event.type === 'external_write');
    const resolvedWrites = resolveWriteEvidence(lifecycleEvents);
    const ledgerWriteEvidence = new Set(resolvedWrites.confirmed.map(writeKey));
    const returnedWriteEvidence = new Set<string>();
    const ambiguousEvidence = new Set(resolvedWrites.uncertain.map(writeKey));
    const lifecycleCallIds = new Set<string>();
    for (const event of lifecycleEvents) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const callId = typeof data.canonicalCallId === 'string' && data.canonicalCallId.trim()
        ? data.canonicalCallId.trim()
        : typeof data.callId === 'string'
          ? data.callId.trim()
          : '';
      if (callId) lifecycleCallIds.add(callId);
    }
    const hasUncorrelatedCanonicalWrite = canonicalWrites.some((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      return !(
        (typeof data.canonicalCallId === 'string' && data.canonicalCallId.trim())
        || (typeof data.callId === 'string' && data.callId.trim())
      );
    });
    // A succeeded terminal without any reservation cannot certify a physical
    // dispatch. Preserve it as one ambiguous write-history fact. When a
    // reservation is already pending, that pending call is the actionable
    // ambiguity and an unrelated terminal need not inflate the count.
    if (canonicalWrites.length === 0) {
      for (const event of lifecycleEvents) {
        if (event.type === 'external_write_succeeded') ambiguousEvidence.add(writeKey(event));
      }
    }
    for (const event of events) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (
        event.type === 'external_write'
        || event.type === 'external_write_succeeded'
        || event.type === 'external_write_failed'
        || event.type === 'external_write_orphaned'
      ) {
        continue;
      }
      if (event.type === 'tool_returned') {
        // FIX (finding B): an external-write effect stamped on the RETURN row —
        // with no matching external-effect `tool_called` row (partial best-effort
        // logging where only the return was recorded) — is still positive
        // evidence of a committed external call. Count it (fail CLOSED) instead
        // of letting the run read as safe-to-replay. The transport mirror still
        // describes the same physical dispatch and must not inflate it; and an
        // ordinary read-return (no `effect`) is untouched, so this never
        // double-counts the normal paired case.
        if (data.accounting === 'transport_mirror' || data.effect !== 'external_write') continue;
        if (hasUncorrelatedCanonicalWrite) continue;
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId && lifecycleCallIds.has(callId)) continue;
        returnedWriteEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
        continue;
      }
      if (event.type === 'tool_called') {
        // The top-level row is the logical provider call. The native MCP mirror
        // describes the same physical dispatch and must not inflate/risk-split it.
        if (data.accounting === 'transport_mirror' || data.effect !== 'external_write') continue;
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (hasUncorrelatedCanonicalWrite) {
          // A returned legacy call is already represented by the uncorrelated
          // canonical row. An unreturned call remains ambiguous: it could be a
          // different dispatch, and assuming correlation would risk replay.
          if (!callId || !returnedCallIds.has(callId)) {
            ambiguousEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
          }
          continue;
        }
        if (callId && lifecycleCallIds.has(callId)) continue;
        if (!callId || !returnedCallIds.has(callId)) {
          ambiguousEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
        } else {
          returnedWriteEvidence.add(`call:${callId}`);
        }
        continue;
      }
      if (event.type === 'orphaned_tool_inflight') {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId && externalCallIds.has(callId) && !lifecycleCallIds.has(callId)) {
          ambiguousEvidence.add(`call:${callId}`);
        }
      }
    }

    // The lifecycle is canonical per call. Tool-boundary evidence for a
    // different call still matters when that call's lifecycle append was lost;
    // lifecycleCallIds above prevents ordinary paired rows from double-counting.
    const externalWriteCount = new Set([
      ...ledgerWriteEvidence,
      ...returnedWriteEvidence,
    ]).size;

    if (ambiguousEvidence.size > 0) {
      return {
        safeToAutoResume: false,
        reason: 'ambiguous_external_write',
        externalWriteCount,
        ambiguousWriteCount: ambiguousEvidence.size,
      };
    }
    if (externalWriteCount > 0) {
      return {
        safeToAutoResume: false,
        reason: 'external_write_history',
        externalWriteCount,
        ambiguousWriteCount: 0,
      };
    }

    // Reaching here means no write landed and no provider outcome is
    // ambiguous. Any non-empty producer history—including an exact failed
    // no-dispatch lifecycle—proves the evidence seam was active and is safe to
    // resume. Only a truly empty best-effort ledger remains unavailable.
    const historyRecordedToolActivity = events.length > 0;
    if (historyRecordedToolActivity) {
      return {
        safeToAutoResume: true,
        reason: 'safe_no_external_write',
        externalWriteCount: 0,
        ambiguousWriteCount: 0,
      };
    }
    return {
      safeToAutoResume: false,
      reason: 'receipt_history_unavailable',
      externalWriteCount: 0,
      ambiguousWriteCount: 0,
    };
  } catch {
    return {
      safeToAutoResume: false,
      reason: 'receipt_history_unavailable',
      externalWriteCount: 0,
      ambiguousWriteCount: 0,
    };
  }
}

function parkInterruptedTaskForVerification(
  task: BackgroundTaskRecord,
  assessment: BackgroundRestartSafetyAssessment,
): BackgroundTaskRecord | null {
  const decidedAt = nowIso();
  const restartRecovery: NonNullable<BackgroundTaskRecord['restartRecovery']> = {
    disposition: 'parked_for_verification',
    reason: assessment.reason,
    decidedAt,
    externalWriteCount: assessment.externalWriteCount,
    ambiguousWriteCount: assessment.ambiguousWriteCount,
  };
  const updated = updateBackgroundTask(task.id, {
    error: RESTART_VERIFICATION_ERROR,
    restartRecovery,
    lastCheckInAt: decidedAt,
    lastCheckInMessage: 'Restart recovery parked for external-outcome verification.',
  });
  if (!updated) return null;

  try {
    appendEvent({
      sessionId: updated.runSessionId,
      turn: 0,
      role: 'system',
      type: 'restart_recovery_decision',
      data: {
        taskId: updated.id,
        disposition: restartRecovery.disposition,
        reason: restartRecovery.reason,
        externalWriteCount: restartRecovery.externalWriteCount,
        ambiguousWriteCount: restartRecovery.ambiguousWriteCount,
        preservedRunSessionId: updated.runSessionId,
      },
    });
  } catch { /* the task record remains the recovery authority */ }

  addNotification({
    id: `${Date.now()}-background-${updated.id}-restart-verification`,
    kind: 'approval',
    title: `Verify before resuming: ${updated.title}`,
    body: [
      `Task ${updated.id} was interrupted after an external write was attempted or could not be ruled out. It was NOT auto-resumed.`,
      `Verify the destination first, then choose Resume. The task will continue on its original run session (${updated.runSessionId}) with the prior receipts and duplicate-write safeguards intact.`,
    ].join('\n\n'),
    createdAt: decidedAt,
    read: false,
    metadata: taskNotificationMetadata(updated, {
      status: 'interrupted',
      verificationRequired: true,
      restartRecoveryReason: restartRecovery.reason,
      runSessionId: updated.runSessionId,
    }),
  });
  emitBackgroundTaskOperational('background_task_parked', updated, {
    reason: 'restart_verification_required',
    restartRecoveryReason: restartRecovery.reason,
  }, 'warn');
  return updated;
}

export function resumeBackgroundTask(id: string): BackgroundTaskRecord | null {
  const resolved = resolveLatestBackgroundResumeOwner(id);
  if (!resolved) return null;
  const { task, followed } = resolved;
  if (task.status === 'awaiting_continue') {
    return queueBackgroundTaskContinue(task.id);
  }
  // A resolved descendant that is already live remains the sole owner. The
  // original task itself keeps the historical API behavior (Resume on a task
  // that is already live is a no-op).
  if (followed && LIVE_TASK_STATUSES.includes(task.status)) return task;
  if (task.status !== 'interrupted' && task.status !== 'failed'
    && task.status !== 'aborted' && task.status !== 'blocked') return null;

  // Every terminal retry stays on the SAME task and run session. Failed,
  // aborted, and blocked turns can contain committed or ambiguous mutations;
  // cloning them would hide that evidence from the next executor. Manual
  // Resume is the explicit verification boundary, and the continuation prompt
  // directs the worker to inspect retained receipts before another mutation.
  return reattachBackgroundTaskInPlace(task.id, {
    mode: task.status === 'interrupted' ? 'manual_restart' : 'manual_retry',
    assessment: assessBackgroundTaskRestartSafety(task),
  });
}

const MAX_BACKGROUND_RESUME_CHAIN_HOPS = 256;
const BACKGROUND_TASK_ID_PATTERN = /^bg-[a-z0-9]+-[a-f0-9]+$/;

/**
 * Follow the complete legacy clone ownership chain. A one-hop lookup is unsafe:
 * with A -> B -> C and C live, reattaching terminal B creates a second executor.
 * Missing/malformed targets, contradictory backlinks, cycles, and unreasonable
 * depth all fail closed rather than guessing which run session owns receipts.
 */
function resolveLatestBackgroundResumeOwner(
  id: string,
): { task: BackgroundTaskRecord; followed: boolean } | null {
  let currentId = id;
  let followed = false;
  const visited = new Set<string>();

  for (let hop = 0; hop <= MAX_BACKGROUND_RESUME_CHAIN_HOPS; hop += 1) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const task = getBackgroundTask(currentId);
    if (!task || task.id !== currentId) return null;
    const nextId = (task as BackgroundTaskRecord & { resumedIntoTaskId?: unknown }).resumedIntoTaskId;
    if (nextId === undefined) return { task, followed };
    if (typeof nextId !== 'string' || !BACKGROUND_TASK_ID_PATTERN.test(nextId)) return null;
    if (visited.has(nextId)) return null;

    const next = getBackgroundTask(nextId);
    if (!next || next.id !== nextId) return null;
    if (next.resumedFromTaskId !== undefined && next.resumedFromTaskId !== task.id) return null;

    currentId = nextId;
    followed = true;
  }
  return null;
}

/**
 * Boot-time recovery for tasks marked `interrupted` by
 * interruptStaleRunningBackgroundTasks. A run whose durable ledger recorded
 * tool activity and proves it stayed read-only (`safe_no_external_write`)
 * reattaches automatically to the SAME task/run session. Everything else —
 * committed/ambiguous writes, or a best-effort empty log that cannot authorize
 * replay — parks for explicit verification and reattaches only on manual Resume.
 *
 * Bounded two ways so a task that reliably crashes the daemon can't loop
 * forever: we skip tasks already carried forward (`resumedIntoTaskId`) and
 * tasks whose `resumeCount` has reached `cap`. Returns the number resumed.
 */
export function resumeInterruptedBackgroundTasks(opts: { cap?: number } = {}): number {
  const cap = Math.max(1, opts.cap ?? 2);
  let resumedCount = 0;
  for (const task of listBackgroundTasks({ status: 'interrupted' })) {
    if (task.error !== DAEMON_RESTART_INTERRUPT_REASON) continue;
    if (task.resumedIntoTaskId) continue;          // already carried forward (clone path)
    if ((task.resumeCount ?? 0) >= cap) continue;  // give up after cap retries
    const assessment = assessBackgroundTaskRestartSafety(task);
    if (!assessment.safeToAutoResume) {
      parkInterruptedTaskForVerification(task, assessment);
      continue;
    }
    // Safe read-only recovery still reattaches IN PLACE. Even this branch never
    // clones: retaining one session gives future turns the exact same receipts,
    // tool outputs, and duplicate-write ledger that the interrupted turn saw.
    if (reattachBackgroundTaskInPlace(task.id, { mode: 'automatic_restart', assessment })) {
      resumedCount += 1;
    }
  }
  return resumedCount;
}

/**
 * Reattach a task to its own resuming run instead of cloning it: flip the SAME
 * record back to `pending` (so the drain re-drives its existing
 * `background:<id>` session), clear the interrupt error, and carry a continuation
 * marker. Used for every restart interruption and every explicit
 * failed/aborted/blocked retry. The resumeCount bump keeps crash caps
 * meaningful. No new task record, exactly one executor, and the receipt ledger
 * remains attached.
 */
function reattachBackgroundTaskInPlace(
  id: string,
  opts: {
    mode: 'automatic_restart' | 'manual_restart' | 'manual_retry';
    assessment?: BackgroundRestartSafetyAssessment;
  },
): BackgroundTaskRecord | null {
  backgroundTaskReattachCasHookForTests?.();
  const task = getBackgroundTask(id);
  if (!task) return null;
  const mode = opts.mode;
  // Automatic boot recovery revives ONLY a still-`interrupted` task. A user abort
  // ('aborted'/'cancelling') that landed between the interrupted-scan and this
  // reattach must survive — never be clobbered back to `pending` (finding C). We
  // both bail on a non-interrupted read here AND pin the CAS below to
  // 'interrupted', closing the abort-before-read and abort-before-write windows.
  // Manual retries legitimately resume failed/aborted/blocked tasks, so they keep
  // anchoring the CAS to the status this reattach observed.
  if (mode === 'automatic_restart' && task.status !== 'interrupted') return null;
  const requiredStatus = mode === 'automatic_restart' ? 'interrupted' : task.status;
  const assessment = opts.assessment;
  const restartRecovery = assessment
    ? {
      disposition: mode === 'automatic_restart' ? 'auto_resumed_in_place' as const : 'manual_resumed_in_place' as const,
      reason: assessment.reason,
      decidedAt: nowIso(),
      externalWriteCount: assessment.externalWriteCount,
      ambiguousWriteCount: assessment.ambiguousWriteCount,
    }
    : task.restartRecovery;
  const reason = mode === 'automatic_restart'
    ? 'Resumed in place after a daemon restart (durable history proved no external writes).'
    : mode === 'manual_restart'
      ? 'Explicitly resumed in place after a daemon restart; verify prior external outcomes before any retry.'
      : 'Explicitly retried in place after a failed, aborted, or blocked run; verify prior external outcomes before any retry.';
  const updated = updateBackgroundTaskWhere(id, (latest) => (
    latest.status === requiredStatus
    && latest.resumedIntoTaskId === task.resumedIntoTaskId
    && latest.resumedFromTaskId === task.resumedFromTaskId
  ), (latest) => ({
    status: 'pending',
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
    outcomeSnapshot: undefined,
    resumeCount: (latest.resumeCount ?? 0) + 1,
    restartRecovery,
    continueResolution: {
      queuedAt: nowIso(),
      reason,
      auto: mode === 'automatic_restart',
    },
  }));
  if (updated) {
    // Wave 4 Stage 1 (durable swarm resume): no ledger rehydrate needed — coverage
    // is now summarized directly from the durable worker_result log at the check
    // point (fanoutCoverageBlock → summarizeFanoutCoverage), which survives the
    // restart by construction. The per-worker idempotency guard separately skips
    // re-executing workers that already completed.
    addNotification({
      id: `${Date.now()}-background-${updated.id}-reattached`,
      kind: 'execution',
      title: `Background task resuming: ${updated.title}`,
      body: `Task ${updated.id} is resuming on its original run session (${updated.runSessionId}) — no duplicate was created and its receipt history remains attached.`,
      createdAt: nowIso(),
      read: false,
      silent: true,
      metadata: taskNotificationMetadata(updated, {
        status: 'pending',
        reattachedInPlace: true,
        restartResumeMode: mode,
        preservedRunSessionId: updated.runSessionId,
      }),
    });
    // Hand the reattached task back to the runner. Updating the JSON to `pending`
    // alone relied on the next drain tick; a manual resume (runtime, drain kick
    // registered) now re-enters immediately, and on boot the setImmediate drain
    // still covers it (the kick is a no-op until registered). Idempotent — the
    // drain is guarded by backgroundProcessorInFlight and markRunning(pending),
    // so a task already being drained is never double-run.
    requestBackgroundDrain(1);
  }
  return updated;
}

let backgroundTaskResolutionCasHookForTests: (() => void) | null = null;
export function _setBackgroundTaskResolutionCasHookForTests(fn: (() => void) | null): void {
  backgroundTaskResolutionCasHookForTests = fn;
}

// Deterministic seam for the reattach authority boundary. Fires at the very top
// of reattachBackgroundTaskInPlace, BEFORE it reads the task, so a test can
// commit a user abort in the window between the interrupted-scan read and the
// reattach read — the exact race finding C closes.
let backgroundTaskReattachCasHookForTests: (() => void) | null = null;
export function _setBackgroundTaskReattachCasHookForTests(fn: (() => void) | null): void {
  backgroundTaskReattachCasHookForTests = fn;
}

// Deterministic seam for the approval-continuation authority boundary. Tests use
// it to commit cancellation after pending->running won but before the final
// cancellation read that guards resolveApproval/provider dispatch.
let backgroundTaskApprovalDispatchCheckHookForTests: (() => void) | null = null;
export function _setBackgroundTaskApprovalDispatchCheckHookForTests(fn: (() => void) | null): void {
  backgroundTaskApprovalDispatchCheckHookForTests = fn;
}

/** Bounded requeues per task for brain-infrastructure outages. A task that hits
 *  the cap fails honestly — 4 separate provider outages deserve a human eye. */
export const TRANSIENT_BRAIN_RETRY_CAP = 3;

/** True when a drain-level error is a BRAIN availability problem (rate limit /
 *  overload / quota), not a defect in the work. Duck-types status-carrying
 *  errors via classifyModelError; falls back to a TIGHT message test because
 *  resume paths often re-throw the provider text as a bare Error. Deliberately
 *  excludes generic transport/5xx shapes so a genuine bug cannot requeue-loop. */
export function isTransientBrainError(error: unknown): boolean {
  try {
    const cls = classifyModelError(error);
    if (cls.kind === 'model.rate_limited' || cls.kind === 'model.overloaded') return true;
  } catch { /* classification is best-effort */ }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|529)\b|rate.?limit|overloaded|usage.?limit|quota (?:exceeded|reached)/i.test(message);
}

export function transientRetryDelayMs(error: unknown, attempts: number): number {
  try {
    const retryAfterMs = classifyModelError(error).retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      return Math.min(retryAfterMs + 5_000, 30 * 60_000);
    }
  } catch { /* fall through to the schedule */ }
  return [2 * 60_000, 5 * 60_000, 10 * 60_000][Math.min(attempts, 3) - 1] ?? 10 * 60_000;
}

export function queueBackgroundTaskApprovalResolution(approvalId: string, approved: boolean): BackgroundTaskRecord | null {
  const task = getBackgroundTaskByApprovalId(approvalId);
  if (!task || task.status !== 'awaiting_approval') return null;
  backgroundTaskResolutionCasHookForTests?.();
  const now = nowIso();
  const updated = updateBackgroundTaskWhere(task.id, (latest) => (
    latest.status === 'awaiting_approval' && latest.pendingApprovalId === approvalId
  ), {
    status: 'pending',
    pendingApprovalId: approvalId,
    approvalResolution: {
      approvalId,
      approved,
      queuedAt: now,
    },
    lastCheckInAt: now,
    lastCheckInMessage: `${approved ? 'Approval granted' : 'Approval rejected'} for ${approvalId}; queued daemon continuation.`,
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-approval-resolution-queued`,
      kind: 'execution',
      title: `Background task ${approved ? 'approved' : 'rejected'}: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon to process approval ${approvalId}.`,
      createdAt: now,
      read: false,
      metadata: taskNotificationMetadata(updated, { approvalId, approved, status: 'pending' }),
    });
  }
  return updated;
}

/**
 * Re-queue a task parked on a clarifying question, carrying the user's FREEFORM
 * answer. Twin of queueBackgroundTaskApprovalResolution, but the next drain
 * resumes via an ordinary background turn (respondPreferHarness) that injects
 * the answer — NOT resolveApproval (an ask_user_question turn completed
 * normally, so there is no serialized SDK state to replay; the run session holds
 * the full history and re-enters cleanly with the answer).
 */
export function queueBackgroundTaskInputResolution(questionId: string, answer: string): BackgroundTaskRecord | null {
  const task = getBackgroundTaskByQuestionId(questionId);
  if (!task || task.status !== 'awaiting_input') return null;
  backgroundTaskResolutionCasHookForTests?.();
  const now = nowIso();
  const updated = updateBackgroundTaskWhere(task.id, (latest) => (
    latest.status === 'awaiting_input' && latest.pendingQuestionId === questionId
  ), {
    status: 'pending',
    pendingQuestionId: questionId,
    inputResolution: { questionId, answer: clean(answer, RESULT_TRUNCATE_CHARS), queuedAt: now },
    lastCheckInAt: now,
    lastCheckInMessage: `Answer received for ${questionId}; queued daemon continuation.`,
  });
  if (updated) {
    // Store unification (2026-07-22): the answer arriving through the TASK
    // side closes any open check-in copy of the same question, so the
    // "Questions for you" panel never shows a ghost the user already answered.
    void (async () => {
      try {
        const { listOpenCheckIns, closeCheckIn } = await import('../agents/check-ins.js');
        for (const checkIn of listOpenCheckIns()) {
          if ((checkIn as { linkedTaskId?: string }).linkedTaskId === updated.id) {
            closeCheckIn(checkIn.id, 'Answered via the task — question resolved.');
          }
        }
      } catch { /* cross-store cleanup is best-effort */ }
    })();
    addNotification({
      id: `${Date.now()}-background-${updated.id}-input-resolution-queued`,
      kind: 'execution',
      title: `Background task resuming: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon with your answer.`,
      createdAt: now,
      read: false,
      // This is an informational lifecycle event, not the still-actionable
      // question card. Keeping questionId here made consumers (and people)
      // treat the fresh "resuming" notice as the old unresolved request.
      metadata: taskNotificationMetadata(updated, { resolvedQuestionId: questionId, status: 'pending' }),
    });
  }
  return updated;
}

export function queueBackgroundTaskContinue(id: string, opts: { auto?: boolean; reason?: string } = {}): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.status !== 'awaiting_continue') return null;
  backgroundTaskResolutionCasHookForTests?.();
  const now = nowIso();
  const updated = updateBackgroundTaskWhere(task.id, (latest) => (
    latest.status === 'awaiting_continue' && latest.resumedIntoTaskId === undefined
  ), (latest) => ({
    status: 'pending',
    continueResolution: {
      queuedAt: now,
      reason: clean(opts.reason ?? latest.error ?? 'Continue requested.', 700),
      auto: opts.auto,
    },
    lastCheckInAt: now,
    lastCheckInMessage: opts.auto
      ? 'Internal run budget reached; queued automatic continuation.'
      : 'Continue requested; queued daemon continuation.',
  }));
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-continue-queued`,
      kind: 'execution',
      title: `Background task continuing: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon from its previous partial progress.`,
      createdAt: nowIso(),
      read: false,
      silent: Boolean(opts.auto),
      metadata: taskNotificationMetadata(updated, { status: 'pending', continuing: true, auto: opts.auto }),
    });
  }
  return updated;
}

export function interruptStaleRunningBackgroundTasks(): number {
  let interrupted = 0;
  for (const task of listBackgroundTasks()) {
    if (task.status === 'cancelling') {
      // The user already chose Stop. A daemon restart may interrupt the worker
      // before its safe-checkpoint finally settles, but it must never transform
      // that cancellation into restart-resumable work.
      markBackgroundTaskFailed(
        task.id,
        task.cancellationReason ?? 'Cancelled by user before the daemon restarted.',
        'aborted',
      );
      interrupted += 1;
    } else if (task.status === 'running') {
      markBackgroundTaskFailed(task.id, DAEMON_RESTART_INTERRUPT_REASON, 'interrupted');
      interrupted += 1;
    }
  }
  return interrupted;
}

/**
 * Classify + record a finished worker turn. Shared by the fresh-run path AND the
 * input-resume path (both produce an AssistantResponse from respondPreferHarness),
 * so the pendingApproval / awaiting-input / coverage / classify / done sequence
 * lives in ONE place. Order matters: the awaiting-input park MUST come before the
 * coverage/classify checks so a clarifying question is never misread as
 * blocked/done.
 */
async function finishWorkerRun(
  task: BackgroundTaskRecord,
  run: { id: string },
  response: { text: string; pendingApprovalId?: string; stoppedReason?: RunStoppedReason },
): Promise<void> {
  const settleCancelled = (latest: BackgroundTaskRecord | null): void => {
    const reason = latest?.cancellationReason ?? 'Cancelled by user.';
    // `aborted` is the background-task store's canonical user-cancelled state;
    // the tracked run settles as `cancelled` (never blocked/failed), and the
    // delivery verifier is deliberately skipped.
    markBackgroundTaskFailed(task.id, reason, 'aborted');
    finishRun(run.id, {
      status: 'cancelled',
      message: `Background task ${task.id} was cancelled at a safe checkpoint.`,
      outputPreview: response.text,
    });
    clearLedger(task.runSessionId);
    logger.info({ taskId: task.id }, 'Background task cancelled (not blocked)');
  };
  const acceptWorkerTransition = (updated: BackgroundTaskRecord | null, intendedStatus: string): boolean => {
    if (updated) return true;
    const latest = getBackgroundTask(task.id);
    if (latest?.status === 'cancelling' || latest?.status === 'aborted') {
      settleCancelled(latest);
      return false;
    }
    // A missing record or an unrecoverable lease conflict must not be followed
    // by a contradictory run completion. Throw into the outer worker catch,
    // which records a failure if task ownership still exists.
    throw new Error(`Background task ${task.id} could not transition to ${intendedStatus}; latest durable state is ${latest?.status ?? 'missing'}.`);
  };
  const latestAtSettle = getBackgroundTask(task.id);
  if (
    response.stoppedReason === 'cancelled'
    || latestAtSettle?.status === 'cancelling'
    || latestAtSettle?.status === 'aborted'
  ) {
    settleCancelled(latestAtSettle);
    return;
  }
  if (response.pendingApprovalId) {
    const parked = markBackgroundTaskAwaitingApproval(task.id, response.pendingApprovalId, response.text);
    if (!acceptWorkerTransition(parked, 'awaiting_approval')) return;
    finishRun(run.id, {
      status: 'awaiting_approval',
      message: `Background task paused for approval ${response.pendingApprovalId}.`,
      pendingApprovalId: response.pendingApprovalId,
      outputPreview: response.text,
    });
    logger.info({ taskId: task.id, approvalId: response.pendingApprovalId }, 'Background task paused for approval');
    return;
  }
  if (response.stoppedReason === 'awaiting-input') {
    // Judge-gated check-in: the run asked the user a clarifying question. Park as
    // needs_input (surfaced to origin chat + needs-you card) and resume on the
    // answer. The question text IS response.text. MUST precede coverage/classify.
    const questionId = `bgq-${task.id}-${Date.now().toString(36)}`;
    const parked = markBackgroundTaskAwaitingInput(task.id, questionId, response.text || 'I need your input to continue.');
    if (!acceptWorkerTransition(parked, 'awaiting_input')) return;
    finishRun(run.id, {
      status: 'awaiting_approval', // run-record paused state (the task status is 'awaiting_input')
      message: 'Background task paused for your input.',
      outputPreview: response.text,
    });
    logger.info({ taskId: task.id, questionId }, 'Background task paused for clarifying input');
    return;
  }
  if (response.stoppedReason === 'token-budget') {
    // Stage 4 — the run's aggregate TOKEN budget window is exhausted. Park
    // awaiting_continue (the docstring's "internal run budget" state) —
    // NEVER fall through to verify/classify, which could mark it done, and
    // never burn auto-continues on it (only a user continue re-arms via a
    // fresh drain-iteration baseline). Distinct reason string: "run token
    // budget" ≠ "turn budget".
    const reason = 'Run token budget reached before finishing. Reply continue to authorize another budget window.';
    clearLedger(task.runSessionId);
    const parked = markBackgroundTaskAwaitingContinue(task.id, reason, response.text);
    if (!acceptWorkerTransition(parked, 'awaiting_continue')) return;
    finishRun(run.id, {
      status: 'awaiting_approval',
      message: `Background task ${task.id} paused at its run token budget and can be continued.`,
      outputPreview: response.text,
    });
    logger.warn({ taskId: task.id, reason }, 'Background task paused at run token budget (awaiting continue, not done)');
    return;
  }
  if (response.stoppedReason === 'max-turns-with-grace') {
    const reason = (response.text || 'The run hit its turn budget before finishing; continue is required.').trim().slice(0, 400);
    clearLedger(task.runSessionId);
    const parked = markBackgroundTaskAwaitingContinue(task.id, reason, response.text);
    if (!acceptWorkerTransition(parked, 'awaiting_continue')) return;
    finishRun(run.id, {
      status: 'awaiting_approval',
      message: `Background task ${task.id} paused at its internal run budget and can be continued.`,
      outputPreview: response.text,
    });
    logger.warn({ taskId: task.id, reason }, 'Background task paused awaiting continue (not done)');
    return;
  }
  // Objective re-anchor, normal completion path (same contract as the approval
  // settle above): a first artifact-less completion on an artifact-committed
  // task earns ONE auto-queued continuation with the objective re-pinned; the
  // verify below blocks honestly on repeat.
  if (completionLacksDeliverableEvidence(task) && !task.deliverableContinueQueuedAt) {
    const reAnchored = updateBackgroundTaskWhere(task.id, (latest) => latest.status === 'running', {
      status: 'pending',
      deliverableContinueQueuedAt: nowIso(),
      result: [
        'CONTINUATION NOTE (auto): the reply below concluded after setup/preamble only — the promised deliverable does not exist yet.',
        'Continue the ORIGINAL objective to completion now, and do not conclude until the deliverable exists.',
        '',
        (response.text ?? '').slice(0, 4_000),
      ].join('\n'),
      continueResolution: {
        queuedAt: nowIso(),
        reason: 'Completion lacked deliverable evidence; objective re-anchored.',
        auto: true,
      },
      lastCheckInAt: nowIso(),
      lastCheckInMessage: 'Completion lacked deliverable evidence; auto-queued one objective-re-anchored continuation.',
    });
    if (reAnchored) {
      finishRun(run.id, {
        status: 'awaiting_approval',
        message: `Background task ${task.id} concluded without its promised deliverable — auto-continuing with the objective re-anchored.`,
        outputPreview: response.text,
      });
      clearLedger(task.runSessionId);
      emitBackgroundTaskCheckIn(reAnchored, {
        title: `Self-correcting: ${reAnchored.title}`,
        body: 'The run concluded without producing its promised deliverable — I caught it and am continuing the original objective now. No action needed.',
        runId: run.id,
        metadata: { status: 'reanchored' },
      });
      logger.warn({ taskId: task.id }, 'Artifact-less completion — objective-re-anchored continuation queued');
      return;
    }
  }
  const outcome = await verifyBackgroundTaskDelivery(task, response.text, response.stoppedReason);
  // Verification may take long enough for a stop request to arrive. Re-read
  // durable task state after the await so a late-but-valid cancellation cannot
  // be overwritten with a contradictory blocked/failed completion.
  const latestAfterVerification = getBackgroundTask(task.id);
  if (latestAfterVerification?.status === 'cancelling' || latestAfterVerification?.status === 'aborted') {
    settleCancelled(latestAfterVerification);
    return;
  }
  if (outcome.outcome === 'blocked') {
    if (isResumableUserDependency(outcome.blockerType)) {
      const blockerType = outcome.blockerType!;
      const questionId = `bgdep-${task.id}-${Date.now().toString(36)}`;
      const reason = outcome.reason ?? 'The task needs user input before it can continue.';
      const parked = markBackgroundTaskAwaitingInput(
        task.id,
        questionId,
        dependencyResumeQuestion(blockerType),
        {
          resultText: response.text,
          blockerReason: reason,
          blockerType,
        },
      );
      if (!acceptWorkerTransition(parked, 'awaiting_input')) return;
      finishRun(run.id, {
        status: 'awaiting_approval',
        message: `Background task ${task.id} paused on a resumable ${blockerType} dependency.`,
        outputPreview: response.text,
      });
      clearLedger(task.runSessionId);
      logger.info(
        { taskId: task.id, questionId, blockerType, reason },
        'Background task preserved progress and paused on a resumable dependency',
      );
      return;
    }
    const blocked = markBackgroundTaskBlocked(task.id, outcome.reason ?? 'Run did not finish cleanly.', response.text, outcome.blockerType);
    if (!acceptWorkerTransition(blocked, 'blocked')) return;
    finishRun(run.id, {
      status: 'failed',
      message: `Background task ${task.id} did not complete: ${outcome.reason ?? 'run did not finish cleanly'}`,
      outputPreview: response.text,
    });
    clearLedger(task.runSessionId);
    logger.warn({ taskId: task.id, reason: outcome.reason, stoppedReason: response.stoppedReason }, 'Background task did not complete cleanly (blocked, not done)');
    return;
  }
  const done = markBackgroundTaskDone(task.id, response.text);
  if (!acceptWorkerTransition(done, 'done')) return;
  finishRun(run.id, { status: 'completed', message: `Background task ${task.id} completed.`, outputPreview: response.text });
  clearLedger(task.runSessionId);
  logger.info({ taskId: task.id }, 'Background task completed');
}

export async function processBackgroundTasks(assistant: ClementineAssistant, limit?: number): Promise<number> {
  if (backgroundProcessorInFlight) return 0;
  backgroundProcessorInFlight = true;
  try {
    const policy = loadProactivityPolicy();
    const requestedLimit = typeof limit === 'number' ? limit : policy.maxConcurrentBackgroundTasks;
    const effectiveLimit = Math.max(1, Math.min(requestedLimit, policy.maxConcurrentBackgroundTasks));
    const progressCheckInMinMs = getBackgroundCheckInMs(policy);
    const pending = listBackgroundTasks({ status: 'pending' })
      .filter((t) => !t.transientRetry || Date.parse(t.transientRetry.notBefore) <= Date.now())
      .slice(0, effectiveLimit);
    let processed = 0;

	  for (const queued of pending) {
	    const runningTask = markBackgroundTaskRunning(queued.id);
	    if (!runningTask) continue;
	    let task: BackgroundTaskRecord = runningTask;
	    processed += 1;
	    logger.info({ taskId: task.id, title: task.title }, 'Background task started');

	    // Launching a background task authorizes its reversible work. Exact
	    // irreversible sends remain owned by the concrete approval card because
	    // a wildcard task prompt cannot enumerate recipients/payloads safely.
	    // We reuse the canonical plan-scope mechanism (the same
	    // one request_approval and plan-first approval open) keyed on this
	    // task's run session. allowedTools `*` covers reversible non-read tools;
	    // the send lock deliberately ignores wildcards and parks exact sends.
	    // survives the taxonomy safety floor — admin tools and destructive-hint
	    // invocations are still gated BEFORE evaluateAutoApprove is consulted
	    // (decideToolApproval), so the parking sites below remain a real
	    // fallback for a genuinely un-coverable approval. Scoped strictly to
	    // this worker run's session; interactive chat/Discord/console turns are
	    // untouched.
	    try {
	      openPlanScope({
	        sessionId: task.runSessionId,
	        planProposalId: `background-task:${task.id}`,
	        approvedPlanObjective: task.title,
	        ttlMs: task.maxMinutes * 60_000,
	        allowedTools: ['*'],
	      });
	    } catch (scopeErr) {
	      // Opening the scope is best-effort plumbing; a failure here must
	      // never block the task. Without it, the parking fallback still
	      // protects the user — they just see the legacy per-tool prompts.
	      logger.warn({ err: scopeErr, taskId: task.id }, 'Failed to open background-task plan scope; falling back to per-tool approval');
	    }
	    const run = startRun({
      id: `run-${task.id}`,
      sessionId: task.runSessionId,
      userId: task.userId,
      channel: task.channel ?? 'background',
      source: task.source,
      title: task.title,
      message: task.prompt,
    });
	    addRunEvent(run.id, {
	      type: 'model_started',
	      message: `Background task ${task.id} started.`,
	    });
	    task = emitBackgroundTaskCheckIn(task, {
	      title: `Background task started: ${task.title}`,
	      body: [
	        `Task ${task.id} is now running.`,
	        `Run: ${run.id}`,
	        `Soft max runtime: ${task.maxMinutes} minutes`,
	        `I'll check in here about every ${policy.checkInMinutes} minute${policy.checkInMinutes === 1 ? '' : 's'} with progress, and report back here as soon as it's done.`,
	      ].join('\n'),
	      runId: run.id,
	      metadata: { status: 'running' },
	    });

	    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	    try {
	      let toolCount = 0;
	      let latestActivitySummary = '';
	      let lastProgressCheckInAt = Date.now();
	      // The time-based heartbeat runs on its OWN cadence clock, independent of
	      // the tool-triggered silent pings below, so a busy task's every-5-call
	      // check-ins can never starve the loud "still working" update the user
	      // sees in their channel.
	      let lastHeartbeatAt = Date.now();
	      const taskStartedAtMs = Date.parse(task.startedAt ?? '') || Date.now();
	      heartbeatTimer = setInterval(() => {
	        const latestTask = getBackgroundTask(task.id);
	        if (!latestTask) return;
	        const now = Date.now();
	        const decision = decideHeartbeat({
	          status: latestTask.status,
	          nowMs: now,
	          lastHeartbeatAtMs: lastHeartbeatAt,
	          intervalMs: progressCheckInMinMs,
	        });
	        if (!decision.emit) return;
	        lastHeartbeatAt = now;
	        if (latestTask.status === 'cancelling') {
	          // Quiet dashboard ping only — the loud signal is the imminent abort.
	          task = emitBackgroundTaskCheckIn(latestTask, {
	            title: `Background task still cancelling: ${latestTask.title}`,
	            body: [
	              `Task ${latestTask.id} is ${latestTask.status}.`,
	              `Run: ${run.id}`,
	              'Cancellation has been requested. I am waiting for the runtime to reach a safe checkpoint.',
	              `Observed tool calls: ${toolCount}`,
	            ].join('\n'),
	            runId: run.id,
	            metadata: { status: latestTask.status, heartbeat: true, toolCount },
	          });
	          return;
	        }
	        // Running: a substantive progress update, delivered loud to the
	        // report-back channel (or silent/dashboard-only when the kill-switch
	        // is off — decideHeartbeat carries that call in decision.loud).
	        task = emitBackgroundTaskProgressUpdate(latestTask, {
	          loud: decision.loud,
	          title: `Background task update: ${latestTask.title}`,
	          body: buildProgressCheckInBody({
	            task: latestTask,
	            elapsedMs: now - taskStartedAtMs,
	            toolCount,
	            latestActivitySummary,
	            runId: run.id,
	          }),
	          runId: run.id,
	          metadata: {
	            status: latestTask.status,
	            heartbeat: true,
	            toolCount,
	            elapsedMs: now - taskStartedAtMs,
	          },
	        });
	      }, progressCheckInMinMs);
	      heartbeatTimer.unref?.();
	      if (task.approvalResolution) {
	        const resolution = task.approvalResolution;
	        const settleApprovalCancellation = (
	          latest: BackgroundTaskRecord,
	          outputPreview = '',
	        ): void => {
	          const reason = latest.cancellationReason ?? latest.error ?? 'Cancelled by user.';
	          if (latest.status !== 'aborted') markBackgroundTaskFailed(task.id, reason, 'aborted');
	          finishRun(run.id, {
	            status: 'cancelled',
	            message: `Background task ${task.id} was cancelled before approval ${resolution.approvalId} dispatched.`,
	            outputPreview,
	          });
	          clearLedger(task.runSessionId);
	          logger.info(
	            { taskId: task.id, approvalId: resolution.approvalId },
	            'Background task cancelled before approval continuation dispatch',
	          );
	        };
	        const acceptApprovalTransition = (updated: BackgroundTaskRecord | null, intendedStatus: string, outputPreview: string): boolean => {
	          if (updated) return true;
	          const latest = getBackgroundTask(task.id);
	          if (latest?.status === 'cancelling' || latest?.status === 'aborted') {
	            settleApprovalCancellation(latest, outputPreview);
	            return false;
	          }
	          throw new Error(`Background task ${task.id} could not transition to ${intendedStatus}; latest durable state is ${latest?.status ?? 'missing'}.`);
	        };
        addRunEvent(run.id, {
          type: 'status',
	          message: `${resolution.approved ? 'Approving' : 'Rejecting'} pending approval ${resolution.approvalId} and resuming from serialized SDK state.`,
	          data: { approvalId: resolution.approvalId, approved: resolution.approved },
	        });
	        // pending->running was authoritative only at task admission. A user may
	        // cancel while the processor opens its plan scope / tracked run /
	        // heartbeat. Re-read at the actual approval-dispatch boundary and bind
	        // the continuation to the exact resolution this worker observed. If
	        // cancellation won that intervening CAS, settle it without ever calling
	        // resolveApproval (which may execute the already-approved mutation).
	        backgroundTaskApprovalDispatchCheckHookForTests?.();
	        const latestAtApprovalDispatch = getBackgroundTask(task.id);
	        if (
	          latestAtApprovalDispatch?.status === 'cancelling'
	          || latestAtApprovalDispatch?.status === 'aborted'
	        ) {
	          settleApprovalCancellation(latestAtApprovalDispatch);
	          continue;
	        }
	        if (
	          latestAtApprovalDispatch?.status !== 'running'
	          || latestAtApprovalDispatch.approvalResolution?.approvalId !== resolution.approvalId
	          || latestAtApprovalDispatch.approvalResolution.approved !== resolution.approved
	        ) {
	          throw new Error(
	            `Background task ${task.id} lost approval ${resolution.approvalId} dispatch authority; `
	            + `latest durable state is ${latestAtApprovalDispatch?.status ?? 'missing'}.`,
	          );
	        }
	        task = latestAtApprovalDispatch;
	        // Registry-first: a harness-lane approval lives in the sqlite registry,
	        // which the legacy runtime store never sees (live 2026-07-22: board
	        // approve → "Approval not found" → task failed, row still pending).
	        const { resolveDrainApproval } = await import('./approval-drain.js');
	        const result = await resolveDrainApproval({
	          approvalId: resolution.approvalId,
	          approved: resolution.approved,
	          legacyResolve: () => assistant.getRuntime().resolveApproval(resolution.approvalId, resolution.approved),
	        });
        if (heartbeatTimer) clearInterval(heartbeatTimer);

        if (!resolution.approved) {
          const aborted = markBackgroundTaskFailed(task.id, result.text || `Approval ${resolution.approvalId} rejected.`, 'aborted');
          if (!acceptApprovalTransition(aborted, 'aborted', result.text)) continue;
          finishRun(run.id, {
            status: 'cancelled',
            message: `Background task stopped after approval ${resolution.approvalId} was rejected.`,
            outputPreview: result.text,
          });
          logger.info({ taskId: task.id, approvalId: resolution.approvalId }, 'Background task stopped after rejected approval');
          continue;
        }

        if (result.nextApprovalId) {
          const parked = markBackgroundTaskAwaitingApproval(task.id, result.nextApprovalId, result.text);
          if (!acceptApprovalTransition(parked, 'awaiting_approval', result.text)) continue;
          finishRun(run.id, {
            status: 'awaiting_approval',
            message: `Background task paused for follow-up approval ${result.nextApprovalId}.`,
            pendingApprovalId: result.nextApprovalId,
            outputPreview: result.text,
          });
          logger.info({ taskId: task.id, approvalId: result.nextApprovalId }, 'Background task paused for follow-up approval');
          continue;
        }

        if (result.awaitingInputQuestion) {
          const questionId = `bgq-${task.id}-${Date.now().toString(36)}`;
          const parkedOnInput = markBackgroundTaskAwaitingInput(
            task.id,
            questionId,
            result.awaitingInputQuestion,
            {
              resultText: result.text,
              blockerReason: result.awaitingInputQuestion,
              blockerType: 'needs_user_input',
            },
          );
          if (!acceptApprovalTransition(parkedOnInput, 'awaiting_input', result.text)) continue;
          finishRun(run.id, {
            status: 'awaiting_approval', // run-record paused state (the task status is 'awaiting_input')
            message: `Background task ${task.id} needs input after approval ${resolution.approvalId}: ${result.awaitingInputQuestion.slice(0, 200)}`,
            outputPreview: result.text,
          });
          logger.info({ taskId: task.id, approvalId: resolution.approvalId, questionId }, 'Background task awaiting input after approval continuation');
          continue;
        }
        // Objective re-anchor (live 2026-07-23, twice in one night): a resumed
        // run concluded after SETUP ONLY ("loaded roster, confirmed access")
        // with the promised artifact never produced. When the completion lacks
        // deliverable evidence, re-queue ONE continuation that re-pins the
        // FULL original objective — the exact manual intervention the owner's
        // runs needed, automated. A second artifact-less completion falls
        // through to the verify below and blocks honestly.
        if (completionLacksDeliverableEvidence(task) && !task.deliverableContinueQueuedAt) {
          // The continue prompt renders task.result as the "continuation note"
          // (it wins over continueResolution.reason), so the corrective framing
          // lives THERE — guaranteed in front of the model on the next turn.
          const reAnchored = updateBackgroundTaskWhere(task.id, (latest) => latest.status === 'running', {
            status: 'pending',
            deliverableContinueQueuedAt: nowIso(),
            result: [
              'CONTINUATION NOTE (auto): the reply below concluded after setup/preamble only — the promised deliverable does not exist yet.',
              'Continue the ORIGINAL objective to completion now, and do not conclude until the deliverable exists.',
              '',
              (result.text ?? '').slice(0, 4_000),
            ].join('\n'),
            continueResolution: {
              queuedAt: nowIso(),
              reason: 'Completion lacked deliverable evidence; objective re-anchored.',
              auto: true,
            },
            lastCheckInAt: nowIso(),
            lastCheckInMessage: 'Completion lacked deliverable evidence; auto-queued one objective-re-anchored continuation.',
          });
          if (reAnchored) {
            finishRun(run.id, {
              status: 'awaiting_approval',
              message: `Background task ${task.id} concluded without its promised deliverable — auto-continuing with the objective re-anchored.`,
              outputPreview: result.text,
            });
            emitBackgroundTaskCheckIn(reAnchored, {
              title: `Self-correcting: ${reAnchored.title}`,
              body: 'The run concluded without producing its promised deliverable — I caught it and am continuing the original objective now. No action needed.',
              runId: run.id,
              metadata: { status: 'reanchored', approvalId: resolution.approvalId },
            });
            logger.warn({ taskId: task.id, approvalId: resolution.approvalId }, 'Artifact-less completion after approval — objective-re-anchored continuation queued');
            continue;
          }
        }
        const postApprovalOutcome = await verifyBackgroundTaskDelivery(task, result.text);
        if (postApprovalOutcome.outcome === 'blocked') {
          if (isResumableUserDependency(postApprovalOutcome.blockerType)) {
            const blockerType = postApprovalOutcome.blockerType!;
            const questionId = `bgdep-${task.id}-${Date.now().toString(36)}`;
            const reason = postApprovalOutcome.reason ?? 'The task needs user input before it can continue.';
            const parkedOnDependency = markBackgroundTaskAwaitingInput(
              task.id,
              questionId,
              dependencyResumeQuestion(blockerType),
              {
                resultText: result.text,
                blockerReason: reason,
                blockerType,
              },
            );
            if (!acceptApprovalTransition(parkedOnDependency, 'awaiting_input', result.text)) continue;
            finishRun(run.id, {
              status: 'awaiting_approval',
              message: `Background task ${task.id} paused on a resumable ${blockerType} dependency after approval ${resolution.approvalId}.`,
              outputPreview: result.text,
            });
            clearLedger(task.runSessionId);
            logger.info(
              { taskId: task.id, approvalId: resolution.approvalId, questionId, blockerType, reason },
              'Background task preserved progress and paused on a resumable dependency after approval',
            );
            continue;
          }
          const blocked = markBackgroundTaskBlocked(task.id, postApprovalOutcome.reason ?? 'Task could not be completed.', result.text, postApprovalOutcome.blockerType);
          if (!acceptApprovalTransition(blocked, 'blocked', result.text)) continue;
          finishRun(run.id, {
            status: 'failed',
            message: `Background task ${task.id} blocked after approval ${resolution.approvalId}: ${postApprovalOutcome.reason ?? 'could not complete'}`,
            outputPreview: result.text,
          });
          clearLedger(task.runSessionId);
          logger.warn({ taskId: task.id, approvalId: resolution.approvalId, reason: postApprovalOutcome.reason }, 'Background task blocked after approval continuation (not marked done)');
          continue;
        }
        const done = markBackgroundTaskDone(task.id, result.text);
        if (!acceptApprovalTransition(done, 'done', result.text)) continue;
        finishRun(run.id, {
          status: 'completed',
          message: `Background task ${task.id} completed after approval ${resolution.approvalId}.`,
          outputPreview: result.text,
        });
        clearLedger(task.runSessionId);
        logger.info({ taskId: task.id, approvalId: resolution.approvalId }, 'Background task completed after approval continuation');
        continue;
      }

	      // Hard wall-clock cap. Previously `maxMinutes` was only embedded
	      // in the worker prompt as a soft hint — a model that ignored
	      // it (or a runtime stall) would have the task run for hours.
	      // The 2s shouldCancel poll inside the runtime turns this into
	      // an at-most-2s grace period past the deadline before we
	      // unwind via AgentRuntimeCancelledError. The catch handler
	      // reads cancellationReason and marks the task aborted with a
	      // user-readable message.
	      // Resume-with-answer / resume-with-continue vs fresh run: if this task
	      // was re-queued with a user's answer or a continuation request, inject
	      // that context instead of the original prompt. The run session holds the
	      // full history, so it re-enters cleanly. Consume the resolution once.
	      const resume = task.inputResolution;
	      const continuation = task.continueResolution;
	      const acceptedContractVersion = task.contractVersion ?? 1;
	      let workerMessage = resume
	        ? buildWorkerInputResumePrompt(task, resume.answer)
	        : continuation
	          ? buildWorkerContinuePrompt(task, task.result ?? continuation.reason)
	          : buildWorkerPrompt(task);
	      if (resume || continuation) {
	        task = updateBackgroundTask(task.id, {
	          inputResolution: resume ? undefined : task.inputResolution,
	          continueResolution: continuation ? undefined : task.continueResolution,
	        }) ?? task;
	      }
	      // The prompt above now contains the queued revision. Mark it applied
	      // only after that exact text has been built; a newer revision racing
	      // this transition remains pending for the next boundary.
	      task = markPendingContractRevisionApplied(task);
	      const wallClockDeadlineMs = Date.now() + task.maxMinutes * 60_000;
	      // Stage 4 — aggregate run token budget: one durable window per drain
	      // iteration. The baseline is captured HERE (not per auto-continue), so
	      // the ceiling genuinely aggregates across the whole unattended chain;
	      // a user continue re-queues the task and a NEW drain iteration opens a
	      // fresh window structurally (no counter reset, no re-park loop).
	      const runTokenCeiling = resolveRunTokenCeiling({ override: task.maxTokens, budget: getHarnessBudgetSettings() });
	      const runTokenBaseline = getSessionTokensUsed(task.runSessionId);
	      const runTokenWindowExhausted = (): boolean =>
	        runTokenBudgetEnforcementEnabled()
	        && runTokenCeiling > 0
	        && (getSessionTokensUsed(task.runSessionId) - runTokenBaseline) >= runTokenCeiling;
	      let autoContinueAttempts = 0;
	      let toolCountAtLastCap = 0; // Wave 3: tool activity at each budget cycle
	      let response: AssistantResponse;
	      let contractSuperseded = false;
	      while (true) {
	        // CANON-ONE-LOOP: background tasks (incl. the mobile chat lane) run the
	        // gated harness loop; legacy fallback only pre-run. The shouldCancel
	        // deadline contract is preserved — the bridge maps it onto the harness
	        // kill switch and re-throws AgentRuntimeCancelledError on caller-driven
	        // aborts. Kill-switch CLEMMY_HARNESS_BACKGROUND=off.
	        const remainingWallMs = Math.max(1, wallClockDeadlineMs - Date.now());
	        const requestedModel = task.model ?? MODELS.deep;
	        response = await respondPreferHarness('background', {
	          sessionId: task.runSessionId,
	          channel: task.channel ?? 'background',
	          userId: task.userId,
	          model: requestedModel,
	          // P0-B — give a heavy worker turn real headroom, but never more than
	          // half the task's soft cap so one overlong call aborts-and-recovers
	          // (P0-A) well before the whole-task deadline cancels everything.
	          maxWallClockMs: Math.min(
	            BACKGROUND_STEP_WALL_CLOCK_MS,
	            Math.floor((task.maxMinutes * 60_000) / 2),
	            remainingWallMs,
	          ),
	          maxRunTokens: runTokenCeiling,
	          runTokenBaseline,
	          message: workerMessage,
	          runId: run.id,
	          shouldCancel: () => {
	            if (Date.now() > wallClockDeadlineMs) {
	              const cancelling = updateBackgroundTaskWhere(task.id, (latest) => latest.status === 'running', {
	                  status: 'cancelling',
	                  cancellationRequestedAt: new Date().toISOString(),
	                  cancellationReason: `Exceeded soft max runtime of ${task.maxMinutes} minutes. Re-queue with a higher cap to continue.`,
	              });
	              if (cancelling) return true;
	              const latest = getBackgroundTask(task.id);
	              return !latest || latest.status !== 'running';
	            }
	            const latest = getBackgroundTask(task.id);
	            return latest?.status === 'cancelling' || latest?.status === 'aborted';
	          },
	          onToolActivity: (activity) => {
	            toolCount += 1;
	            // Feed the loud time-based heartbeat its "Currently: …" line.
	            latestActivitySummary = activity.toolName;
	            const now = Date.now();
	            const shouldCheckIn = toolCount === 1 ||
	              toolCount % PROGRESS_CHECKIN_TOOL_INTERVAL === 0 ||
	              now - lastProgressCheckInAt >= progressCheckInMinMs;
	            if (!shouldCheckIn) return;
	            lastProgressCheckInAt = now;
	            const latestTask = getBackgroundTask(task.id) ?? task;
	            task = emitBackgroundTaskCheckIn(latestTask, {
	              title: `Background task progress: ${latestTask.title}`,
	              body: [
	                `Task ${latestTask.id} is still running.`,
	                `Run: ${run.id}`,
	                `Latest tool: ${activity.toolName}`,
	                `Tool calls observed: ${toolCount}`,
	                // Stage 4 — surfaced only when enforcement is on (conditional-surface rule).
	                ...((): string[] => { const line = budgetLineFor(task.runSessionId, runTokenBaseline, runTokenCeiling); return line ? [line] : []; })(),
	              ].join('\n'),
	              runId: run.id,
	              metadata: {
	                status: 'running',
	                toolName: activity.toolName,
	                toolCount,
	              },
	            });
	          },
	        }, (req) => assistant.respond(req));
	        task = recordBackgroundTaskRoute(task, run.id, response, requestedModel);
	        const latestContractTask = getBackgroundTask(task.id);
	        if ((latestContractTask?.contractVersion ?? 1) > acceptedContractVersion) {
	          contractSuperseded = true;
	          break;
	        }

	        if (response.stoppedReason !== 'max-turns-with-grace') break;
	        // Stage 4 — a turn-budget stop whose token WINDOW is also exhausted
	        // must park as a budget park, not burn free auto-continues + judge
	        // cycles tunneling past it. Coerce and fall to finishWorkerRun.
	        if (runTokenWindowExhausted()) {
	          response = { ...response, stoppedReason: 'token-budget' };
	          addRunEvent(run.id, {
	            type: 'status',
	            message: 'Run token budget window exhausted at a turn-budget boundary — parking for a user continue.',
	            data: { tokensUsedWindow: getSessionTokensUsed(task.runSessionId) - runTokenBaseline, tokenCeiling: runTokenCeiling },
	          });
	          break;
	        }
	        if (autoContinueAttempts >= BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP) {
	          // Wave 3 Move A: past the free auto-continue cap, SELF-RESUME only if an
	          // independent cross-family judge confirms genuine PROGRESS, under the hard
	          // ceiling, with new tool activity — else park (baseline). Cheap checks first
	          // (selfResumeDecision, pure/tested); the judge fails CLOSED (park). The
	          // 240-min wall clock bounds everything regardless.
	          const cycleToolCalls = toolCount - toolCountAtLastCap;
	          const dec = selfResumeDecision({ enabled: backgroundSelfResumeEnabled(), autoContinueAttempts, hardCap: BACKGROUND_SELF_RESUME_HARD_CAP, cycleToolCalls, budgetExhausted: runTokenWindowExhausted() });
	          let selfResumeOk = dec.resume === true;
	          let progressReason = dec.reason;
	          if (dec.needJudge) {
	            const objective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId));
	            const prog = await runProgressJudgeImpl(objective, response.text ?? '', cycleToolCalls);
	            selfResumeOk = prog.verdict?.progressing === true;
	            progressReason = prog.verdict?.reason ?? `progress judge ${prog.failure ?? 'no-verdict'} → park`;
	            emitBackgroundTaskOperational('background_self_resume_check', task, { progressing: selfResumeOk, attempt: autoContinueAttempts, hardCap: BACKGROUND_SELF_RESUME_HARD_CAP, cycleToolCalls, reason: progressReason, selfJudge: prog.selfJudge, judgeFailure: prog.failure ?? null }, selfResumeOk ? 'info' : 'warn');
	          }
	          addRunEvent(run.id, { type: 'status', message: `Self-resume at continue ${autoContinueAttempts}: ${selfResumeOk ? 'PROGRESSING → continuing unattended' : 'STOP → parking'} — ${progressReason}`, data: { selfResume: selfResumeOk, autoContinueAttempts, reason: progressReason, cycleToolCalls } });
	          if (!selfResumeOk) break;
	        }
	        clearLedger(task.runSessionId);
	        autoContinueAttempts += 1;
	        toolCountAtLastCap = toolCount;
	        addRunEvent(run.id, {
	          type: 'status',
	          message: `Background task hit an internal run budget; continuing automatically (${autoContinueAttempts}/${BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP}).`,
	          data: { stoppedReason: response.stoppedReason, autoContinueAttempts },
	        });
	        const latestTask = getBackgroundTask(task.id) ?? task;
	        lastProgressCheckInAt = Date.now();
	        task = emitBackgroundTaskCheckIn(latestTask, {
	          title: `Background task continuing: ${latestTask.title}`,
	          body: [
	            `Task ${latestTask.id} hit an internal run budget before finishing.`,
	            `Run: ${run.id}`,
	            `Automatic continuation: ${autoContinueAttempts}/${BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP}`,
	          ].join('\n'),
	          runId: run.id,
	          metadata: {
	            status: 'running',
	            autoContinue: true,
	            autoContinueAttempts,
	          },
	        });
	        workerMessage = buildWorkerContinuePrompt(task, response.text);
	      }
	      if (heartbeatTimer) clearInterval(heartbeatTimer);

	      if (contractSuperseded) {
	        const latest = getBackgroundTask(task.id);
	        const nextVersion = latest?.contractVersion ?? acceptedContractVersion + 1;
	        let latestContractSatisfied = false;
	        if (latest && pendingContractRevisionSatisfiedByDurableManifest(latest)) {
	          // The same harness call crossed the contract boundary and produced
	          // complete exact-version checkpoints. Claim that pending revision
	          // atomically; if a newer revision raced us, the claim fails and the
	          // ordinary requeue path below remains authoritative.
	          const applied = tryMarkPendingContractRevisionApplied(latest);
	          if (applied) {
	            task = applied;
	            latestContractSatisfied = true;
	            addRunEvent(run.id, {
	              type: 'status',
	              message: `Contract v${nextVersion} was satisfied inside the in-flight harness call; reusing its durable manifest without another continuation.`,
	              data: {
	                fromVersion: acceptedContractVersion,
	                toVersion: nextVersion,
	                disposition: 'completed_in_flight',
	              },
	            });
	            logger.info(
	              { taskId: task.id, fromVersion: acceptedContractVersion, toVersion: nextVersion },
	              'In-flight contract revision completed before the harness call returned',
	            );
	          }
	        }
	        if (!latestContractSatisfied) {
	          const requeued = updateBackgroundTaskWhere(
	            task.id,
	            (candidate) => candidate.status === 'running'
	              && (candidate.contractVersion ?? 1) > acceptedContractVersion,
	            {
	              status: 'pending',
	              result: (response.text ?? '').slice(0, RESULT_TRUNCATE_CHARS),
	              continueResolution: {
	                queuedAt: nowIso(),
	                reason: `The prior response targeted contract v${acceptedContractVersion}; continue under v${nextVersion} after reconciling durable progress.`,
	                auto: true,
	              },
	              lastCheckInAt: nowIso(),
	              lastCheckInMessage: `Contract changed from v${acceptedContractVersion} to v${nextVersion}; stale-contract completion was preserved and the task was re-queued.`,
	            },
	          );
	          if (requeued) {
	            finishRun(run.id, {
	              status: 'cancelled',
	              message: `Background task run superseded by contract v${nextVersion}; re-queued on the same durable session.`,
	              outputPreview: response.text,
	            });
	            clearLedger(task.runSessionId);
	            logger.info(
	              { taskId: task.id, fromVersion: acceptedContractVersion, toVersion: nextVersion },
	              'Background task re-queued after an in-flight contract revision',
	            );
	            continue;
	          }
	        }
	      }

	      // Classify + record the result: pending-approval / awaiting-input (the
	      // judge-gated check-in) / partial-coverage / blocked / done — all in the
	      // shared helper so the fresh-run and input-resume paths agree.
	      await finishWorkerRun(task, run, response);
	    } catch (error) {
	      if (heartbeatTimer) clearInterval(heartbeatTimer);
	      const message = error instanceof Error ? error.message : String(error);
	      const latestTask = getBackgroundTask(task.id);
	      const cancelled = error instanceof AgentRuntimeCancelledError || latestTask?.status === 'cancelling';
	      if (!cancelled && isTransientBrainError(error)) {
	        // L3 (v2.3.0) capacity advisor: a PLAN-LIMIT shape (weekly/unknown
	        // reset — the $20-plan case) makes bounded requeues futile; fail
	        // once, honestly, in the user's language with the guided fix. The
	        // card's Resume button is the "retry now". Short-reset shapes keep
	        // the automatic requeue, with the same plain-words check-in.
	        const advice = capacityAdvice({ reason: message, preparedNote: 'The work done so far is saved.' });
	        if (advice.shape === 'plan_limit') {
	          markBackgroundTaskFailed(task.id, advice.copy, 'failed');
	          finishRun(run.id, { status: 'failed', message: advice.copy, error: message });
	          logger.warn({ taskId: task.id, err: message }, 'Background task stopped on a plan-limit capacity shape; advisor surfaced');
	          continue;
	        }
	        const attempts = (latestTask?.transientRetry?.attempts ?? 0) + 1;
	        if (attempts <= TRANSIENT_BRAIN_RETRY_CAP) {
	          const delayMs = transientRetryDelayMs(error, attempts);
	          const notBefore = new Date(Date.now() + delayMs).toISOString();
	          const requeued = updateBackgroundTaskWhere(task.id, (t) => t.status === 'running', {
	            status: 'pending',
	            transientRetry: { attempts, notBefore, lastError: clean(message, 400) },
	            lastCheckInAt: nowIso(),
	            lastCheckInMessage: capacityAdvice({ reason: message, retryAtIso: notBefore }).copy + ` (attempt ${attempts}/${TRANSIENT_BRAIN_RETRY_CAP})`,
	          });
	          if (requeued) {
	            finishRun(run.id, {
	              status: 'failed',
	              message: `Brain provider unavailable; task requeued (attempt ${attempts}/${TRANSIENT_BRAIN_RETRY_CAP}, retry after ${notBefore}).`,
	              error: message,
	            });
	            logger.warn({ taskId: task.id, attempts, notBefore, err: message }, 'Background task hit a transient brain outage; requeued instead of failing');
	            continue;
	          }
	        }
	      }
	      markBackgroundTaskFailed(
	        task.id,
	        cancelled ? latestTask?.cancellationReason ?? 'Cancelled by user.' : message,
	        cancelled ? 'aborted' : 'failed',
	      );
	      finishRun(run.id, {
	        status: cancelled ? 'cancelled' : 'failed',
	        message: cancelled ? 'Background task cancelled at a safe checkpoint.' : message,
	        error: cancelled ? undefined : message,
	      });
	      if (cancelled) {
	        logger.info({ taskId: task.id }, 'Background task cancelled');
	      } else {
	        logger.error({ err: error, taskId: task.id }, 'Background task failed');
	      }
	    }
  }

    return processed;
  } finally {
    backgroundProcessorInFlight = false;
  }
}

export function renderBackgroundTask(task: BackgroundTaskRecord): string {
  const lines = [
    `Task ${task.id}`,
    `Status: ${task.status}`,
    `Title: ${task.title}`,
	    task.effectiveModel || task.modelProvider || task.modelRouteKind
	      ? `Model route: ${task.modelRouteKind ?? 'unknown'}${task.modelProvider ? `/${task.modelProvider}` : ''}${task.effectiveModel ? ` ${task.effectiveModel}` : ''}${task.modelRouteFalloverFrom ? ` (fallover from ${task.modelRouteFalloverFrom})` : ''}`
	      : '',
	    task.pendingApprovalId ? `Approval: ${task.pendingApprovalId}` : '',
	    task.startedAt ? `Started: ${task.startedAt}` : '',
	    task.lastCheckInAt ? `Last check-in: ${task.lastCheckInAt}` : '',
	    task.completedAt ? `Completed: ${task.completedAt}` : '',
	    task.error ? `Error: ${task.error}` : '',
	    task.lastCheckInMessage ? `Latest check-in:\n${task.lastCheckInMessage}` : '',
	    task.result ? `Result:\n${task.result.slice(0, 1600)}` : '',
	  ].filter(Boolean);
  return lines.join('\n');
}

export function renderBackgroundTaskList(tasks: BackgroundTask[], emptyText = 'No background tasks found.'): string {
  if (tasks.length === 0) return emptyText;
  return tasks
    .slice(0, 10)
    .map((task) => `- ${task.id} | ${task.status} | ${task.title}`)
    .join('\n');
}

type BackgroundTask = BackgroundTaskRecord;
