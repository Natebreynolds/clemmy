import { randomBytes } from 'node:crypto';
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
import { deliverOutcome } from '../runtime/outcome.js';
import { humanizeReportBody } from '../runtime/report-voice.js';
import { getGoalPinForDelegation, getActiveGoalForSession } from '../agents/plan-proposals.js';
import { deliverableProbesEnabled, probeSessionDeliverables } from './deliverable-probe.js';
import { ExecutionStore } from './store.js';
import type { AssistantResponse, RunStoppedReason } from '../types.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { addRunEvent, finishRun as persistFinishRun, getRun, startRun } from '../runtime/run-events.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { getBackgroundCheckInMs, loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { openPlanScope } from '../agents/plan-scope.js';
import { fanoutLedgerEnabled, summarizeFanoutCoverage, clearLedger } from '../runtime/harness/fanout-ledger.js';
import { resetFanoutWindow, sweepFanoutReduce } from '../runtime/harness/fanout-reduce.js';
import { classifyBlocker, matchesBlockedText, verifyDelivered, type BlockerType } from '../runtime/harness/verify-delivered.js';
import { verifyFanoutItems, fanoutItemVerifyEnabled } from '../runtime/harness/fanout-item-verify.js';
import type { ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import { judgeRunProgress } from '../runtime/harness/objective-judge.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { renderSessionHistoryForModel } from '../runtime/harness/session-transcript.js';
import { classifyTurnText } from '../runtime/harness/turn-decision.js';
import { getSession as getHarnessSessionRow, createSession as createHarnessSession, appendEvent, listEvents as listHarnessEventsForRefute, getSessionTokensUsed } from '../runtime/harness/eventlog.js';
import { getHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { budgetLineFor, resolveRunTokenCeiling, runTokenBudgetEnforcementEnabled } from '../runtime/harness/run-token-budget.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import { recordOperationalEvent, type OperationalEventSeverity } from '../runtime/operational-telemetry.js';
import { getWorkspaceDirs } from '../tools/shared.js';

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

let backgroundDeliveryJudgeForTests: ObjectiveJudgeFn | null = null;
export function _setBackgroundDeliveryJudgeForTests(fn: ObjectiveJudgeFn | null): void {
  backgroundDeliveryJudgeForTests = fn;
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
  pendingApprovalId?: string;
  approvalResolution?: {
    approvalId: string;
    approved: boolean;
    queuedAt: string;
  };
  /** Parked clarifying question (status 'awaiting_input'), twin of
   *  pendingApprovalId/approvalResolution but carrying freeform Q&A. */
  pendingQuestionId?: string;
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
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
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
    'Keep a concise task ledger in your reasoning and finish with these sections:',
    '## Completed',
    '## Evidence / Verification',
    '## Remaining Risks',
    '## Next Step',
    '',
    `Task ID: ${task.id}`,
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

export function createBackgroundTask(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const createdAt = nowIso();
  const id = makeTaskId(new Date(createdAt));
  const task: BackgroundTaskRecord = {
    id,
    title: clean(input.title || input.prompt, 120) || 'Background task',
    prompt: input.prompt.trim(),
    status: 'pending',
    originSessionId: input.originSessionId,
    foregroundHandoff: input.foregroundHandoff,
    runSessionId: `background:${id}`,
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
 *  record (restorable). The single irreversible-feeling action made reversible. */
export function archiveBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.archived) return task; // idempotent — re-archiving is a no-op
  return updateBackgroundTask(id, { archived: true, archivedAt: nowIso() });
}

/** Restore an archived task back onto the board. Its updatedAt is bumped (by
 *  updateBackgroundTask) so it does not immediately re-flag as stale. */
export function restoreBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  if (!task.archived) return task;
  return updateBackgroundTask(id, { archived: false, archivedAt: undefined });
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

function clearParkedBackgroundState(): Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>> {
  return {
    pendingApprovalId: undefined,
    approvalResolution: undefined,
    pendingQuestionId: undefined,
    pendingQuestion: undefined,
    inputResolution: undefined,
    continueResolution: undefined,
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
  // Unified report-back (Move 4): one mechanism for every lane. Preserves the
  // `[background task <id> …]` prefix (idempotency + UI detect); the body is the
  // shared Outcome card. See src/runtime/outcome.ts.
  return deliverOutcome(
    { status: outcome, detail },
    {
      originSessionId: task.originSessionId,
      sourceLabel: 'background task',
      sourceId: task.id,
      title: task.title,
      statusHint: `background_task_status('${task.id}')`,
      maxDetailChars: RESULT_TRUNCATE_CHARS,
      // A clarifying question must surface in the chat NOW (not wait for the
      // user's next unrelated message) so they can answer it.
      proactiveTurn: outcome === 'needs_input',
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
  if (stored) return stored;
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
export function markBackgroundTaskAwaitingInput(id: string, questionId: string, question: string): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_input',
    pendingQuestionId: questionId,
    pendingQuestion: question.slice(0, RESULT_TRUNCATE_CHARS),
    result: question.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-needs-input`,
      kind: 'approval',
      title: `Background task needs your input: ${updated.title}`,
      body: question.slice(0, 2000),
      createdAt: nowIso(),
      read: false,
      metadata: {
        ...taskNotificationMetadata(updated, { status: 'awaiting_input' }),
        questionId,
        needsInput: true,
      },
    });
    // Surface the question into the origin chat too, so the user can answer in
    // the conversation (the answer is routed back via queueBackgroundTaskInputResolution).
    enqueueBackgroundTaskOutcomeTurn(updated, 'needs_input', question);
    emitBackgroundTaskOperational('background_task_parked', updated, { reason: 'awaiting_input' }, 'warn');
  }
  return updated;
}

export function markBackgroundTaskAwaitingApproval(id: string, approvalId: string, resultText: string): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_approval',
    pendingApprovalId: approvalId,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
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
  }
  return updated;
}

export function markBackgroundTaskAwaitingContinue(id: string, reason: string, resultText: string): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const reasonText = clean(reason || 'The task reached its internal run budget before finishing.', 1000);
  const updated = updateBackgroundTaskWhere(id, workerParkMayProceed, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_continue',
    completedAt: undefined,
    error: reasonText,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
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
 * would just re-block); the user re-runs once the blocker is cleared.
 */
export function markBackgroundTaskBlocked(id: string, reason: string, resultText: string, knownBlockerType?: BlockerType): BackgroundTaskRecord | null {
  if (!prepareWorkerSettlementForCas(id)) return null;
  const updated = updateBackgroundTaskWhere(id, workerBlockedMayProceed, {
    ...clearParkedBackgroundState(),
    status: 'blocked',
    completedAt: nowIso(),
    error: clean(reason, 1000),
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    // Tag the blocker by KIND (deterministic, zero-token) so the dashboard /
    // proactive brief / future routing can act on the class, not just the prose.
    const blockerType = knownBlockerType ?? classifyBlocker(reason);
    addNotification({
      id: `${Date.now()}-background-${updated.id}-blocked`,
      kind: 'approval',
      title: `Background task blocked: ${updated.title}`,
      // 'unverified_completion' (Move 3) is the OPPOSITE situation from the
      // default copy: the run claims done and DID perform an irreversible
      // external action, but the refuters couldn't verify it. Telling the user
      // "I did NOT ship … re-run" here invites a manual DOUBLE-SEND (review
      // the check-first regression review). Say check-first instead.
      body: blockerType === 'unverified_completion'
        ? [
          `The run reports this as done and it DID perform an irreversible external action — but I could not independently verify the completion.`,
          ``,
          `Unverified because: ${clean(reason, 600)}`,
          ``,
          `CHECK the actual outcome (sent messages / created records) BEFORE re-running — re-running may duplicate an irreversible send.`,
        ].join('\n')
        : [
          `I couldn't finish this — I'm blocked, so I did NOT ship a partial/empty result.`,
          ``,
          `Blocker (${blockerType}): ${clean(reason, 600)}`,
          ``,
          `Re-run once that's resolved and I'll continue.`,
        ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'blocked', blockerType, terminalReportBack: true }),
    });
    // Report-back without fail: a BLOCKED task must reach Clementine's context,
    // not just a notification — so she can surface the blocker or resolve it.
    enqueueBackgroundTaskOutcomeTurn(updated, 'blocked', reason);
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
    {
      ...clearParkedBackgroundState(),
      status,
      completedAt: nowIso(),
      error: clean(error, 1000),
    },
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
): { outcome: 'done' | 'blocked'; reason?: string } {
  // 1) Structured signal: did the worker explicitly mark an execution
  //    blocked in its own session? This is the strongest signal — it's
  //    the agent telling us, in code, that it could not proceed.
  try {
    const blockedExecution = new ExecutionStore()
      .list(40)
      .find((e) => e.sessionId === task.runSessionId && e.status === 'blocked');
    if (blockedExecution) {
      return { outcome: 'blocked', reason: blockedExecution.blocker || 'Execution marked blocked by the agent.' };
    }
  } catch {
    // store read is best-effort; fall through to text heuristics
  }

  // 2) The runtime stopped while still pending an approval but the caller
  //    didn't catch it (defense-in-depth; the explicit pendingApprovalId
  //    branch normally handles this first).
  if (stoppedReason === 'pending-approval') {
    return { outcome: 'blocked', reason: 'Stopped awaiting an approval that was not surfaced.' };
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
    };
  }
  if (stoppedReason === 'max-turns-with-grace') {
    const text = (finalText || '').trim();
    return {
      outcome: 'blocked',
      reason: (text || 'The run hit its turn budget before finishing; continue is required.').slice(0, 400),
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
      return { outcome: 'blocked', reason: text.slice(0, 400) };
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

async function verifyBackgroundTaskDelivery(
  task: Pick<BackgroundTaskRecord, 'runSessionId' | 'prompt' | 'title'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
): Promise<{ outcome: 'done' | 'blocked'; reason?: string; blockerType?: BlockerType }> {
  const classified = classifyBackgroundTaskOutcome(task, finalText, stoppedReason, { ignoreFanoutCoverage: true });
  if (classified.outcome === 'blocked') return classified;

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
  if (fanoutItemVerifyEnabled()) {
    try {
      const verifyObjective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId));
      if (verifyObjective.trim()) await verifyFanoutItems(task.runSessionId, verifyObjective);
    } catch {
      // A verify hiccup must NEVER block a run — fall through to the existing checks.
    }
  }

  const coverageBlock = fanoutCoverageBlock(task.runSessionId);
  // Fan-out coverage is AUTHORITATIVE: if any worker failed (a raw ERROR: from
  // Stage 1, or a Stage-2-confirmed hollow output just recorded above), the run is
  // a partial and MUST NOT report a hollow "done" — per the run_worker contract
  // ("never report a batch complete if any worker returned ERROR"). Previously
  // coverageBlock was only ever used as a fallback REASON on the probe/verify-fail
  // paths, so a confident aggregate that passed verifyDelivered discarded it and
  // the honest "M of N" never surfaced (Stage-2 adversarial review #1 — the feature
  // was inert on exactly its target path). Gate here, before the probe/judge, so
  // their model calls are also skipped when coverage already says blocked.
  if (coverageBlock) return coverageBlock;

  // DELIVERABLE PROBE — deterministic readback of the artifacts THIS run produced
  // (created sheet ids, written file paths, space views), gated to GOAL-BOUND
  // background runs (the trust-critical lane: a bound goal contract exists). The fix
  // for the 2026-07-08 "shipped 5 BLANK Google Sheets as done" — the judge only saw
  // the model's claims. A CONFIRMED probe failure blocks completion with the SPECIFIC
  // gap; passing/unprobeable findings are folded into the delivery judge's evidence
  // so even the judge lane can't pass a hollow deliverable. Best-effort per class
  // (an unprobeable artifact passes through). Kill: CLEMMY_DELIVERABLE_PROBES=off.
  let probeEvidence = '';
  if (deliverableProbesEnabled()) {
    try {
      // Objective for the deterministic artifact readback. A GOAL-bound run uses
      // its plan objective + success criteria; an AD-HOC run (no goal contract)
      // falls back to its own prompt/title. 2026-07-13 Wave 1: the probe caught
      // the "shipped 5 BLANK sheets as done" class only for goal-bound runs —
      // extend it to EVERY background task so a hollow deliverable is caught by
      // deterministic readback, not just the (now cross-family) judge.
      const objective = probeObjectiveForTask(task, getActiveGoalForSession(task.runSessionId));
      if (objective.trim()) {
        const probe = await probeSessionDeliverables(task.runSessionId, objective);
        if (probe.failures.length > 0) {
          return { outcome: 'blocked', reason: probe.summary.slice(0, 400) };
        }
        probeEvidence = probe.evidenceText;
      }
    } catch {
      // A probe error must NEVER block a run — pass through to the judge as before.
    }
  }

  try {
    const evidence = probeEvidence ? `${finalText}\n\n${probeEvidence}` : finalText;
    // Move 3: a run that recorded an IRREVERSIBLE external write gets the
    // adversarial refuters before its "done" is banked (unattended lane).
    let refuteHighStakes = false;
    try { refuteHighStakes = listHarnessEventsForRefute(task.runSessionId, { types: ['external_write'] }).length > 0; } catch { /* fail-open: no refuters */ }
    const verdict = await verifyDelivered(task.prompt || task.title, evidence, {
      highStakes: refuteHighStakes,
      stoppedReason,
      ...(backgroundDeliveryJudgeForTests ? { judgeFn: backgroundDeliveryJudgeForTests } : {}),
    });
    if (!verdict.delivered) {
      return { outcome: 'blocked', reason: verdict.reason ?? 'Run did not produce a verifiable deliverable.', blockerType: verdict.blockerType };
    }
  } catch {
    return { outcome: 'done' };
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
 * tool activity, all of it read-only (no committed, compensated, failed, or
 * unreturned external write), is positive evidence the producers were running
 * and the run never touched an external system: it reattaches automatically as
 * `safe_no_external_write`. Committed writes park as `external_write_history`;
 * unreturned external calls and explicit orphan markers are the stronger,
 * ambiguous class (`ambiguous_external_write`).
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

    type WriteEvidence = {
      seq: number;
      callId?: string;
      shapeKey?: string;
      targets: string[];
    };
    const asWriteEvidence = (event: (typeof events)[number]): WriteEvidence => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      return {
        seq: event.seq,
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.shapeKey === 'string' ? { shapeKey: data.shapeKey } : {}),
        targets: Array.isArray(data.targets)
          ? data.targets.filter((target): target is string => typeof target === 'string').map((target) => target.toLowerCase())
          : [],
      };
    };
    const canonicalWrites = events.filter((event) => event.type === 'external_write').map(asWriteEvidence);
    const failedWrites = events.filter((event) => event.type === 'external_write_failed').map(asWriteEvidence);
    const failureMatchesWrite = (write: WriteEvidence, failure: WriteEvidence): boolean => {
      if (write.seq >= failure.seq) return false;
      if (write.callId && failure.callId) return write.callId === failure.callId;
      if (write.shapeKey !== failure.shapeKey) return false;
      return write.targets.length === 0
        || failure.targets.length === 0
        || failure.targets.some((target) => write.targets.includes(target));
    };
    const compensatedWriteIndexes = new Set<number>();
    for (const failure of failedWrites) {
      for (let index = canonicalWrites.length - 1; index >= 0; index -= 1) {
        if (compensatedWriteIndexes.has(index) || !failureMatchesWrite(canonicalWrites[index], failure)) continue;
        compensatedWriteIndexes.add(index);
        break;
      }
    }
    const ledgerWriteEvidence = new Set(
      canonicalWrites
        .filter((_write, index) => !compensatedWriteIndexes.has(index))
        .map((write) => write.callId ? `call:${write.callId}` : `event:${write.seq}`),
    );
    const returnedWriteEvidence = new Set<string>();
    const ambiguousEvidence = new Set<string>();
    for (const event of events) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === 'external_write' || event.type === 'external_write_failed') {
        continue;
      }
      if (event.type === 'external_write_orphaned') {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        ambiguousEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
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
        const callId = typeof data.callId === 'string' ? data.callId : '';
        returnedWriteEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
        continue;
      }
      if (event.type === 'tool_called') {
        // The top-level row is the logical provider call. The native MCP mirror
        // describes the same physical dispatch and must not inflate/risk-split it.
        if (data.accounting === 'transport_mirror' || data.effect !== 'external_write') continue;
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (!callId || !returnedCallIds.has(callId)) {
          ambiguousEvidence.add(callId ? `call:${callId}` : `event:${event.seq}`);
        } else {
          returnedWriteEvidence.add(`call:${callId}`);
        }
        continue;
      }
      if (event.type === 'orphaned_tool_inflight') {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId && externalCallIds.has(callId)) {
          ambiguousEvidence.add(`call:${callId}`);
        }
      }
    }

    // external_write is the canonical pre-dispatch ledger. Fall back to a
    // completed external-write tool boundary only if that ledger append was
    // unavailable, avoiding a misleading double-count for the ordinary case
    // where one physical mutation emitted both rows.
    const externalWriteCount = canonicalWrites.length > 0
      ? ledgerWriteEvidence.size
      : returnedWriteEvidence.size;

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

    // Reaching here means: no committed writes and no ambiguous/unreturned
    // external calls. Two histories look identical on those two counters yet
    // must diverge:
    //
    //   (a) The producers recorded real tool activity for this run and ALL of
    //       it was read-only — no external_write ledger row (even a compensated
    //       one), no external_write_failed, no external-effect tool_called. The
    //       non-empty ledger is positive evidence the best-effort producers WERE
    //       functioning, so the absence of write rows is now meaningful: the run
    //       provably never touched an external system. Read-only work reattaches
    //       automatically (`safe_no_external_write`).
    //
    //   (b) An empty best-effort ledger (nothing recorded), or a history that
    //       DID attempt a write which then failed/compensated to a net-zero
    //       remainder. Neither proves the run stayed read-only, so both stay
    //       fail-closed as `receipt_history_unavailable` and park for manual
    //       verification.
    //
    // external_write_orphaned and unreturned external-effect tool_called are
    // already routed to `ambiguous_external_write` above, so the only lingering
    // write evidence to exclude here is a compensated canonical write or a bare
    // external_write_failed row.
    const historyRecordedToolActivity = events.length > 0;
    const historyHasWriteEvidence = canonicalWrites.length > 0 || failedWrites.length > 0;
    if (historyRecordedToolActivity && !historyHasWriteEvidence) {
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
  if (task.status !== 'interrupted' && task.status !== 'failed' && task.status !== 'aborted') return null;

  // Every terminal retry stays on the SAME task and run session. Failed/aborted
  // turns can contain the same committed or ambiguous mutations as a restart;
  // cloning them would hide that evidence from the next executor. Manual Resume
  // is the explicit verification boundary, and the continuation prompt directs
  // the worker to inspect the retained receipt history before another mutation.
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
 * marker. Used for every restart interruption and every explicit failed/aborted
 * retry. The resumeCount bump keeps crash caps meaningful. No new task record,
 * exactly one executor, and the receipt ledger remains attached.
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
  // Manual retries legitimately resume failed/aborted tasks, so they keep
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
      : 'Explicitly retried in place after a failed or aborted run; verify prior external outcomes before any retry.';
  const updated = updateBackgroundTaskWhere(id, (latest) => (
    latest.status === requiredStatus
    && latest.resumedIntoTaskId === task.resumedIntoTaskId
    && latest.resumedFromTaskId === task.resumedFromTaskId
  ), (latest) => ({
    status: 'pending',
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
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
    const pending = listBackgroundTasks({ status: 'pending' }).slice(0, effectiveLimit);
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
	        const result = await assistant.getRuntime().resolveApproval(resolution.approvalId, resolution.approved);
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

        const postApprovalOutcome = await verifyBackgroundTaskDelivery(task, result.text);
        if (postApprovalOutcome.outcome === 'blocked') {
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

	      // Classify + record the result: pending-approval / awaiting-input (the
	      // judge-gated check-in) / partial-coverage / blocked / done — all in the
	      // shared helper so the fresh-run and input-resume paths agree.
	      await finishWorkerRun(task, run, response);
	    } catch (error) {
	      if (heartbeatTimer) clearInterval(heartbeatTimer);
	      const message = error instanceof Error ? error.message : String(error);
	      const latestTask = getBackgroundTask(task.id);
	      const cancelled = error instanceof AgentRuntimeCancelledError || latestTask?.status === 'cancelling';
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
