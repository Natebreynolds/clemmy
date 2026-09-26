/**
 * The work-review heartbeat in the daemon: where it reads, where it keeps its
 * state, when it ticks, and how it asks Jev to apply the owner's rules.
 *
 * Reads are local files the runtime already writes: workflow run records,
 * the chat run ledger, and the drafts folder. No provider is called, so a
 * quiet tick costs a directory listing and nothing else.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { listRuns } from '../runtime/run-events.js';
import { addNotification, getNotification } from '../runtime/notifications.js';
import { tryJevHeartbeatItemVerdict } from '../runtime/jev/control-plane.js';
import { isQuietHoursActive, loadProactivityPolicy, saveProactivityPolicy } from './proactivity-policy.js';
import { loadHeartbeatContract } from './heartbeat-contracts.js';
import {
  DEFAULT_WORK_REVIEW_CONFIG,
  emptyWorkReviewState,
  runWorkReviewTick,
  type ChatWaitObservation,
  type DraftObservation,
  type WorkObservation,
  type WorkReviewCandidate,
  type WorkReviewItem,
  type WorkReviewJudgeVerdict,
  type WorkReviewState,
  type WorkReviewTickResult,
  type WorkRunObservation,
} from './work-review.js';

const logger = pino({ name: 'clementine.work-review' });

export const WORK_REVIEW_ID = 'work-review';
export const WORK_REVIEW_SESSION_ID = 'watch:work-review';
const STATE_FILE = path.join(BASE_DIR, 'state', 'work-review.json');
const DRAFTS_DIR = path.join(BASE_DIR, 'drafts');
export const WORK_REVIEW_HEARTBEAT_MS = 60_000;
const FIRST_HEARTBEAT_DELAY_MS = 45_000;
/** How many run records to look at per tick, newest first. */
const RUN_RECORDS_PER_TICK = 400;

// ── state file ────────────────────────────────────────────────────────────────
export function loadWorkReviewState(): WorkReviewState {
  if (!existsSync(STATE_FILE)) return emptyWorkReviewState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<WorkReviewState>;
    const base = emptyWorkReviewState();
    return {
      ...base,
      ...raw,
      version: 1,
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      metrics: { ...base.metrics, ...(raw.metrics ?? {}) },
    };
  } catch {
    return emptyWorkReviewState();
  }
}

export function saveWorkReviewState(state: WorkReviewState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

// ── the read ──────────────────────────────────────────────────────────────────
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Workflow run records as the runner writes them, newest first, bounded. */
export function observeWorkflowRuns(limit = RUN_RECORDS_PER_TICK): { runs: WorkRunObservation[]; failures: number } {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return { runs: [], failures: 0 };
  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
  const runs: WorkRunObservation[] = [];
  let failures = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      const id = str(raw.id) ?? file.slice(0, -5);
      const workflow = str(raw.workflow) ?? str(raw.workflowSlug);
      const status = str(raw.status);
      if (!workflow || !status) continue;
      runs.push({
        runId: id,
        workflow,
        status,
        createdAt: str(raw.createdAt),
        finishedAt: str(raw.finishedAt) ?? str(raw.completedAt),
        error: str(raw.error),
        needsAttention: raw.needsAttention === true,
        source: str(raw.source),
        targetStepId: str(raw.targetStepId) ?? null,
      });
    } catch {
      failures += 1;
    }
  }
  return { runs, failures };
}

/** Conversations whose run is parked on an approval or a question. */
export function observeWaitingChats(): ChatWaitObservation[] {
  const out: ChatWaitObservation[] = [];
  for (const run of listRuns(200)) {
    if (run.archived) continue;
    const waitingOn = run.pendingApprovalId ? 'approval' : run.pendingInput ? 'input' : null;
    if (!waitingOn) continue;
    out.push({
      runId: run.id,
      sessionId: run.sessionId,
      title: run.title || run.input.slice(0, 80) || 'A conversation',
      status: String(run.status),
      updatedAt: run.updatedAt,
      waitingOn,
    });
  }
  return out;
}

/** Files in the drafts folder, as they sit. */
export function observeDrafts(): DraftObservation[] {
  if (!existsSync(DRAFTS_DIR)) return [];
  const out: DraftObservation[] = [];
  for (const name of readdirSync(DRAFTS_DIR)) {
    if (name.startsWith('.')) continue;
    try {
      const st = statSync(path.join(DRAFTS_DIR, name));
      if (!st.isFile()) continue;
      out.push({ name, dir: 'drafts', modifiedAt: st.mtime.toISOString(), bytes: st.size });
    } catch { /* a vanished file is not a draft */ }
  }
  return out;
}

export async function observeWork(): Promise<{ observation: WorkObservation; readFailures: number }> {
  const { runs, failures } = observeWorkflowRuns();
  const observation: WorkObservation = { runs, chats: observeWaitingChats(), drafts: observeDrafts() };
  return { observation, readFailures: failures };
}

// ── Jev ───────────────────────────────────────────────────────────────────────
export async function judgeWorkReviewCandidate(candidate: WorkReviewCandidate, rules: string[]): Promise<WorkReviewJudgeVerdict | null> {
  return tryJevHeartbeatItemVerdict({
    heartbeat: 'work review',
    rules,
    sessionId: WORK_REVIEW_SESSION_ID,
    item: {
      kind: candidate.kind,
      subject: candidate.subject,
      detail: candidate.detail,
      ref: candidate.ref,
    },
  });
}

// ── policy ────────────────────────────────────────────────────────────────────
export interface WorkReviewPolicyView { enabled: boolean; cadenceMinutes: number; quietHoursActive: boolean }

export function workReviewPolicy(): WorkReviewPolicyView {
  const policy = loadProactivityPolicy();
  return { enabled: policy.workReviewEnabled, cadenceMinutes: policy.workReviewMinutes, quietHoursActive: isQuietHoursActive(policy) };
}

export function setWorkReviewPolicy(patch: { enabled?: boolean; cadenceMinutes?: number }): WorkReviewPolicyView {
  saveProactivityPolicy({
    ...(patch.enabled !== undefined ? { workReviewEnabled: patch.enabled } : {}),
    ...(patch.cadenceMinutes !== undefined ? { workReviewMinutes: patch.cadenceMinutes } : {}),
  });
  return workReviewPolicy();
}

// ── ticking ───────────────────────────────────────────────────────────────────
let inFlight: Promise<WorkReviewTickResult> | null = null;

export function runWorkReviewTickNow(options: { source: string } = { source: 'heartbeat' }): Promise<WorkReviewTickResult> {
  if (inFlight) return inFlight;
  const contract = loadHeartbeatContract(WORK_REVIEW_ID);
  const tickId = `wr-${Date.now().toString(36)}`;
  inFlight = runWorkReviewTick({
    now: () => Date.now(),
    tickId,
    source: options.source,
    config: DEFAULT_WORK_REVIEW_CONFIG,
    rules: contract.rules.map((r) => r.text),
    notify: contract.notify,
    observe: observeWork,
    judge: judgeWorkReviewCandidate,
    publish: addNotification,
    isNotificationRead: (id) => getNotification(id)?.read === true,
    loadState: loadWorkReviewState,
    saveState: saveWorkReviewState,
  }).then((result) => {
    logger.info(
      { tickId, source: options.source, produced: result.produced, vetoed: result.vetoed, held: result.held, retired: result.retired, quiet: result.quiet, durationMs: result.durationMs },
      result.quiet ? 'work review: quiet tick' : 'work review: tick',
    );
    return result;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function isWorkReviewDue(nowMs = Date.now()): { due: boolean; reason: string; nextAt?: string } {
  const policy = workReviewPolicy();
  if (!policy.enabled) return { due: false, reason: 'disabled' };
  if (policy.quietHoursActive) return { due: false, reason: 'quiet_hours' };
  const state = loadWorkReviewState();
  const last = state.lastTickAt ? Date.parse(state.lastTickAt) : Number.NaN;
  if (!Number.isFinite(last)) return { due: true, reason: 'never_ticked' };
  const nextAt = last + policy.cadenceMinutes * 60_000;
  return nowMs >= nextAt ? { due: true, reason: 'cadence' } : { due: false, reason: 'not_yet', nextAt: new Date(nextAt).toISOString() };
}

/** Daemon heartbeat: checks every minute, ticks on the policy cadence. */
export function startWorkReviewHeartbeat(): { stop: () => void } {
  const beat = (): void => {
    let due: ReturnType<typeof isWorkReviewDue>;
    try { due = isWorkReviewDue(); } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'work review: due check failed');
      return;
    }
    if (!due.due) return;
    runWorkReviewTickNow({ source: 'heartbeat' }).catch((error) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'work review: tick failed');
    });
  };
  const first = setTimeout(beat, FIRST_HEARTBEAT_DELAY_MS);
  first.unref?.();
  const timer = setInterval(beat, WORK_REVIEW_HEARTBEAT_MS);
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── status for the console ────────────────────────────────────────────────────
export interface WorkReviewStatus {
  id: 'work-review';
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  quietHoursActive: boolean;
  connectedOperations: string[];
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: WorkReviewState['lastFinding'];
  lastError?: WorkReviewState['lastError'];
  metrics: WorkReviewState['metrics'];
  openItems: WorkReviewItem[];
  recentlyRetired: WorkReviewItem[];
}

export function workReviewStatus(nowMs = Date.now()): WorkReviewStatus {
  const policy = workReviewPolicy();
  const state = loadWorkReviewState();
  const due = isWorkReviewDue(nowMs);
  const items = Object.values(state.items);
  const open = items.filter((i) => !i.retiredAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const retired = items.filter((i) => i.retiredAt).sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? '')).slice(0, 8);
  return {
    id: 'work-review',
    title: 'Work review',
    purpose: 'Looks over the work that ran while you were away and raises one line per thing worth your attention: a run that failed, a run or conversation that has been waiting on you for hours, a draft nobody sent. It reads only what Clementine already keeps, and it offers help rather than taking it.',
    enabled: policy.enabled,
    cadenceMinutes: policy.cadenceMinutes,
    quietHoursActive: policy.quietHoursActive,
    connectedOperations: [],
    running: inFlight !== null,
    ...(state.lastTickAt ? { lastTickAt: state.lastTickAt } : {}),
    ...(due.nextAt ? { nextTickAt: due.nextAt } : policy.enabled && !state.lastTickAt ? { nextTickAt: new Date(nowMs).toISOString() } : {}),
    ...(state.lastFinding ? { lastFinding: state.lastFinding } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    metrics: state.metrics,
    openItems: open,
    recentlyRetired: retired,
  };
}
