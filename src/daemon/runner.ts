import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import { ClementineAssistant } from '../assistant/core.js';
import { processAgentAutonomy } from '../agents/autonomy.js';
import { processAgentAutonomyV2 } from '../agents/autonomy-v2.js';
import { processMonitors } from '../agents/monitors.js';
import { getProactivityPolicySnapshot } from '../agents/proactivity-policy.js';
import { processProactiveBriefs } from '../agents/proactive-briefs.js';
import { ensureSeedTemplates, processProactiveCheckIns } from '../agents/check-in-templates.js';
import { MODELS, getRuntimeEnv } from '../config.js';
import { processExecutionController } from '../execution/controller.js';
import { ExecutionStore } from '../execution/store.js';
import { interruptStaleRunningBackgroundTasks, resumeInterruptedBackgroundTasks, processBackgroundTasks } from '../execution/background-tasks.js';
import { processWorkflowRuns, reconcilePendingWorkflowRuns, reapResolvedParkedRuns } from '../execution/workflow-runner.js';
import { runWorkflowWatchdog } from '../execution/workflow-watchdog.js';
import { runBackgroundTaskWatchdog } from '../execution/background-task-watchdog.js';
import { getBuildInfo, describeBuild } from '../runtime/build-info.js';
import { processWorkflowSchedules, reapStaleWorkflowRuns } from '../execution/workflow-scheduler.js';
import { sweepStaleExecutions, sweepCrashedExecutions, sweepStaleBlockedExecutions } from '../execution/store.js';
import { sweepStaleRuns } from '../runtime/run-events.js';
import { sweepStaleApprovals } from '../runtime/approval-store.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { DISCORD_BOT_TOKEN, DISCORD_ENABLED, WEBHOOK_ENABLED, WEBHOOK_SECRET } from '../config.js';
import { getOrRefreshScan as warmCliScan } from '../runtime/cli-discovery.js';
import { closePlanScope, openPlanScope } from '../agents/plan-scope.js';
import { processMemoryMaintenance } from '../memory/maintenance.js';
import { runRecursiveReflection, consolidateActiveFacts } from '../memory/reflection.js';
import { decayAndEvictFacts } from '../memory/facts.js';
import {
  CRON_FILE,
} from '../memory/vault.js';
import {
  migrateLegacyWorkflowsOnce,
} from '../memory/workflow-store.js';
import {
  CRON_PROGRESS_DIR,
  CRON_RUNS_DIR,
  CRON_TRIGGERS_DIR,
  WORKFLOW_RUNS_DIR,
  ensureDir,
} from '../tools/shared.js';
import {
  addNotification,
  getNotificationDestinationsForRecord,
  getNotification,
  listQueuedNotificationDeliveries,
  markNotificationRead,
  replaceQueuedNotificationDeliveries,
  updateNotificationDeliveryStatus,
  type NotificationRecord,
} from '../runtime/notifications.js';
import { deliverNotificationToDestination } from '../runtime/notification-delivery.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';

const logger = pino({ name: 'clementine-next.daemon' });
const STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'daemon-state.json');

interface CronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
  max_hours?: number;
}

interface DaemonState {
  lastCronRunByMinute: Record<string, string>;
  // Wall-clock heartbeat written on every tick so a boot-time check
  // can detect daemon-offline gaps and notify the user about cron runs
  // that would have fired during the outage. Without this, a daemon
  // crash at 02:00:30 means a 02:00 cron is silently lost — the
  // existing dedup map would prevent re-firing within the same minute,
  // and there's nothing to detect "scheduled but never ran" otherwise.
  lastHealthyTickAt?: string;
  // Brain Phase 2: nightly recursive-reflection day-stamp (YYYY-MM-DD,
  // local). Set after a successful run so we fire exactly once per
  // local day even across daemon restarts.
  lastRecursiveReflectionDay?: string;
  // Tier A2/A3: nightly memory-hygiene day-stamp (decay + dedup). Same
  // once-per-local-day-across-restarts contract as recursive reflection.
  lastMemoryHygieneDay?: string;
}

const DELIVERY_MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState(): DaemonState {
  if (!existsSync(STATE_FILE)) {
    return { lastCronRunByMinute: {} };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as DaemonState;
  } catch {
    return { lastCronRunByMinute: {} };
  }
}

// Cron deduplication keys are minute-stamped strings like
// "2026-05-18T07:30". Without pruning the map grows unboundedly for
// every job × minute since first daemon boot, which slowly turns each
// saveState into a measurable disk hit. Seven days is plenty: we only
// need enough history to avoid re-firing a job we already ran in the
// current minute, plus a safety margin for daemon clock-stutter.
const CRON_STATE_RETENTION_DAYS = 7;

function pruneDaemonState(state: DaemonState): DaemonState {
  const cutoff = new Date(Date.now() - CRON_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16); // YYYY-MM-DDTHH:MM — lexicographically comparable to currentMinuteKey
  const next: Record<string, string> = {};
  for (const [name, key] of Object.entries(state.lastCronRunByMinute)) {
    if (key >= cutoff) next[name] = key;
  }
  return { ...state, lastCronRunByMinute: next };
}

function saveState(state: DaemonState): void {
  ensureDir(path.dirname(STATE_FILE));
  const pruned = pruneDaemonState(state);
  writeFileSync(STATE_FILE, JSON.stringify(pruned, null, 2), 'utf-8');
  // Mutate in place so callers retain a reference to the pruned map —
  // otherwise the next saveState would re-write the dropped entries.
  state.lastCronRunByMinute = pruned.lastCronRunByMinute;
}

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

function cronMatches(expr: string, at: Date): boolean {
  if (!validateCronExpression(expr)) return false;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  return (
    fieldMatch(min, at.getMinutes()) &&
    fieldMatch(hour, at.getHours()) &&
    fieldMatch(dom, at.getDate()) &&
    fieldMatch(mon, at.getMonth() + 1) &&
    fieldMatch(dow, at.getDay())
  );
}

function currentMinuteKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function loadCronJobs(): CronJobRecord[] {
  if (!existsSync(CRON_FILE)) return [];
  try {
    const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
    return Array.isArray(parsed.data.jobs) ? (parsed.data.jobs as CronJobRecord[]) : [];
  } catch {
    return [];
  }
}

function appendRunLog(jobName: string, payload: Record<string, unknown>): void {
  ensureDir(CRON_RUNS_DIR);
  const filePath = path.join(CRON_RUNS_DIR, `${jobName.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  writeFileSync(filePath, `${existing}${JSON.stringify(payload)}\n`, 'utf-8');
}

// Per-cron wall-clock budget. Unleashed/background jobs are allowed
// more headroom because they're often the ones doing real research
// (proposal briefs, audits). job.max_hours is honored if set; otherwise
// fall back to a sane default per mode. We never let a single cron run
// hold the daemon's main loop hostage forever — that's the failure mode
// that turned cron, notification delivery, and heartbeat sweeping into
// silent dead air for hours at a time.
function resolveCronWallClockMs(job: CronJobRecord): number {
  if (typeof job.max_hours === 'number' && job.max_hours > 0) {
    return Math.min(job.max_hours * 60 * 60_000, 6 * 60 * 60_000);
  }
  return job.mode === 'unleashed' ? 60 * 60_000 : 15 * 60_000;
}

// Long-running cron jobs used to vanish into total silence between
// "started" and "completed". For a 30-min cron, the user got nothing
// for 30 min and couldn't tell crash from progress. We now emit one
// heartbeat at the 5-min mark and every 10 min after. Each heartbeat
// has a deterministic ID so re-runs of the same cron at the same
// timestamp don't double-fire (dedup via addNotification's id check).
const CRON_HEARTBEAT_FIRST_MS = 5 * 60_000;
const CRON_HEARTBEAT_INTERVAL_MS = 10 * 60_000;

function startCronHeartbeat(job: CronJobRecord, startedAt: string, startMs: number): () => void {
  let count = 0;
  const fire = () => {
    count += 1;
    const elapsedMin = Math.max(1, Math.round((Date.now() - startMs) / 60_000));
    addNotification({
      id: `cron-heartbeat-${job.name}-${startedAt}-${count}`,
      kind: 'cron',
      title: `Cron job still running: ${job.name}`,
      body: `Elapsed: ${elapsedMin} min. Will notify on completion or failure. Open Console → Activity for live status.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, heartbeat: true, elapsedMin },
    });
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    fire();
    interval = setInterval(fire, CRON_HEARTBEAT_INTERVAL_MS);
    interval.unref?.();
  }, CRON_HEARTBEAT_FIRST_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

async function runCronJob(assistant: ClementineAssistant, job: CronJobRecord, source: 'schedule' | 'trigger'): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const stopHeartbeat = startCronHeartbeat(job, startedAt, startMs);
  try {
    const prompt = [
      `Cron job: ${job.name}`,
      `Execution source: ${source}`,
      job.work_dir ? `Working directory context: ${job.work_dir}` : '',
      job.mode === 'unleashed' ? 'This is an unleashed/background job. Work through the task fully and leave a concise status/result.' : '',
      'Execute the following job prompt and produce a concise but substantive result.',
      '',
      job.prompt,
    ].filter(Boolean).join('\n');

    const cronSessionId = `cron:${job.name}`;
    const cronBudgetMs = resolveCronWallClockMs(job);
    openPlanScope({
      sessionId: cronSessionId,
      planProposalId: `cron:${job.name}`,
      approvedPlanObjective: `Approved cron job "${job.name}"`,
      ttlMs: cronBudgetMs + 60_000,
      allowedTools: ['*'],
    });

    const response = await assistant.respond({
      sessionId: cronSessionId,
      channel: 'cron',
      message: prompt,
      model: job.mode === 'unleashed' ? MODELS.deep : MODELS.primary,
      maxWallClockMs: cronBudgetMs,
    });

    appendRunLog(job.name, {
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      source,
      response: response.text,
    });
    addNotification({
      id: `${Date.now()}-cron-${job.name}`,
      kind: 'cron',
      title: `Cron job completed: ${job.name}`,
      // Send the full body. Discord delivery (notification-delivery.ts)
      // splits long content into multiple messages with paragraph-
      // preserving chunks. Previously this was hard-sliced to 2000 chars
      // and a morning briefing > 2000 arrived cut off with no continuation.
      body: response.text,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, source },
    });
    logger.info({ job: job.name, source }, 'Cron job completed');
  } catch (error) {
    appendRunLog(job.name, {
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    addNotification({
      id: `${Date.now()}-cron-${job.name}-error`,
      kind: 'cron',
      title: `Cron job failed: ${job.name}`,
      body: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, source, status: 'error' },
    });
    logger.error({ err: error, job: job.name, source }, 'Cron job failed');
  } finally {
    closePlanScope(`cron:${job.name}`, 'cron-run-finished');
    stopHeartbeat();
  }
}

// Brain Phase 2 — Stanford recursive reflection.
// Fires once per local day after 03:00, the canonical "nightly synthesis"
// window. We use a state-persisted day stamp (not a cron expression)
// because the daemon's YAML cron file is user-editable; the brain's
// internal jobs should be system-level and undisturbed by user edits.
// The job is cheap (<$0.01/night per the Phase 2 plan) so a missed-run
// catch-up on next-boot is fine — no make-up scheduling needed.
const RECURSIVE_REFLECTION_LOCAL_HOUR = 3;

function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function processRecursiveReflectionTick(state: DaemonState): Promise<void> {
  const now = new Date();
  if (now.getHours() < RECURSIVE_REFLECTION_LOCAL_HOUR) return;
  const day = localDayKey(now);
  if (state.lastRecursiveReflectionDay === day) return;
  state.lastRecursiveReflectionDay = day;
  saveState(state);
  try {
    const result = await runRecursiveReflection();
    logger.info({ result }, 'Brain recursive reflection completed');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Brain recursive reflection failed (will retry tomorrow)',
    );
  }
}

// Tier A2/A3 — nightly memory hygiene: forgetting (decay/eviction of the
// stale, low-value, unpinned tail) + retroactive semantic dedup of
// near-identical facts. Without this the consolidated_facts store only
// grows (~100/day with ~zero deactivation). Both halves are flag-gated
// (default off) and conservative + bounded; the owner flips them on after
// tuning thresholds from observed counts. Same once-per-local-day,
// survives-restart contract as recursive reflection (offset one hour so
// the two brain jobs don't pile onto the same tick).
const MEMORY_HYGIENE_LOCAL_HOUR = 4;

async function processMemoryHygieneTick(state: DaemonState): Promise<void> {
  const decayOn = (getRuntimeEnv('CLEMMY_MEMORY_DECAY', 'off') || 'off').toLowerCase() === 'on';
  const dedupOn = (getRuntimeEnv('CLEMMY_MEMORY_DEDUP', 'off') || 'off').toLowerCase() === 'on';
  if (!decayOn && !dedupOn) return;

  const now = new Date();
  if (now.getHours() < MEMORY_HYGIENE_LOCAL_HOUR) return;
  const day = localDayKey(now);
  if (state.lastMemoryHygieneDay === day) return;
  state.lastMemoryHygieneDay = day;
  saveState(state);

  if (decayOn) {
    try {
      const result = decayAndEvictFacts();
      logger.info({ result }, 'Memory decay/eviction completed');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Memory decay/eviction failed (will retry tomorrow)',
      );
    }
  }
  if (dedupOn) {
    try {
      const result = await consolidateActiveFacts();
      logger.info({ result }, 'Memory dedup/consolidation completed');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Memory dedup/consolidation failed (will retry tomorrow)',
      );
    }
  }
}

async function processCronSchedules(assistant: ClementineAssistant, state: DaemonState): Promise<void> {
  const now = new Date();
  const minuteKey = currentMinuteKey(now);
  const jobs = loadCronJobs();

  for (const job of jobs) {
    if (job.enabled === false) continue;
    if (!cronMatches(job.schedule, now)) continue;
    if (state.lastCronRunByMinute[job.name] === minuteKey) continue;
    // In-memory dedup BEFORE await so a follow-up tick within the
    // same minute doesn't re-fire. Persist AFTER successful run so a
    // crash mid-job leaves the disk state clean — the boot-time
    // missed-run scan will see the gap and surface it instead of
    // silently treating it as "ran."
    state.lastCronRunByMinute[job.name] = minuteKey;
    await runCronJob(assistant, job, 'schedule');
    saveState(state);
  }
}

// Surfaces critical setup gaps as one-per-day notifications at daemon
// boot. The doctor CLI catches the same things but only when the user
// runs it manually — for problems that silently break agent work
// (missing auth, missing Discord token), the user should learn at the
// next login to the dashboard, not when they go investigate why no
// notifications have arrived. Each issue uses a daily-bucketed id so
// addNotification's dedup keeps the noise down.
function reportBootSetupIssues(): void {
  const dayKey = new Date().toISOString().slice(0, 10);
  const issues: Array<{ slug: string; title: string; body: string }> = [];

  try {
    const auth = getAuthStatus();
    if (!auth.configured) {
      issues.push({
        slug: 'auth',
        title: 'Authentication not configured — agent runs will fail',
        body: `${auth.message}\n\nOpen the desktop app → Settings → Re-authenticate, or run \`clementine auth login\`. Until this is fixed, cron jobs, workflows, chat, and background tasks all error out.`,
      });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Boot setup check: getAuthStatus threw',
    );
  }

  if (WEBHOOK_ENABLED && (!WEBHOOK_SECRET || WEBHOOK_SECRET === 'change-me' || WEBHOOK_SECRET === 'change-me-local-secret')) {
    issues.push({
      slug: 'webhook-secret',
      title: 'Webhook secret is the default placeholder',
      body: 'The dashboard / webhook endpoint is using a placeholder WEBHOOK_SECRET. Local access is protected by loopback binding, but you should still set a real secret in `~/.clementine-next/.env` before enabling LAN access.',
    });
  }

  if (DISCORD_ENABLED && !DISCORD_BOT_TOKEN) {
    issues.push({
      slug: 'discord-token',
      title: 'Discord enabled but token is missing',
      body: 'DISCORD_ENABLED=true but DISCORD_BOT_TOKEN is empty. The Discord channel will not connect. Run `clementine setup` and configure the bot token, or set DISCORD_ENABLED=false.',
    });
  }

  for (const issue of issues) {
    addNotification({
      id: `system-setup-${issue.slug}-${dayKey}`,
      kind: 'system',
      title: issue.title,
      body: issue.body,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'setup_gap', slug: issue.slug },
    });
  }
}

// Marks due executions with a once-per-day "paused by policy" activity
// entry so the dashboard can render "Paused: quiet hours" instead of
// looking like the execution is stuck. The reason string is built from
// the proactivity snapshot so the user sees what specifically is
// preventing work (quiet hours vs. global disable).
function annotateDueExecutionsAsPolicyPaused(
  proactivity: ReturnType<typeof getProactivityPolicySnapshot>,
): void {
  try {
    const store = new ExecutionStore();
    const due = store.listDue(new Date(), 20);
    if (due.length === 0) return;
    const reason = proactivity.quietHoursActive
      ? 'Paused for quiet hours'
      : 'Paused: proactivity policy disabled';
    const dayKey = new Date().toISOString().slice(0, 10);
    for (const execution of due) {
      store.addActivity({
        executionId: execution.id,
        key: `policy_paused:${dayKey}`,
        type: 'status',
        message: `${reason} — execution will resume on next allowed tick.`,
        metadata: {
          policyPaused: true,
          quietHoursActive: proactivity.quietHoursActive,
          policyEnabled: proactivity.policy.enabled,
          observedAt: new Date().toISOString(),
        },
      });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to annotate due executions as policy-paused',
    );
  }
}

// Boot-time missed-run detection. Compares the persisted
// lastHealthyTickAt against now; if the daemon was offline for more
// than 5 min, walk every minute in the gap and count cron schedules
// that would have matched. Roll up into one notification so the user
// learns "you were down for X minutes and missed Y scheduled runs"
// instead of finding out hours later that the morning briefing never
// arrived.
function reportMissedCronRunsOnBoot(state: DaemonState): void {
  if (!state.lastHealthyTickAt) return;
  const lastAt = Date.parse(state.lastHealthyTickAt);
  if (!Number.isFinite(lastAt)) return;
  const now = Date.now();
  const gapMs = now - lastAt;
  const GAP_THRESHOLD_MS = 5 * 60_000;
  if (gapMs < GAP_THRESHOLD_MS) return;

  const jobs = loadCronJobs().filter((job) => job.enabled !== false);
  const missed: Array<{ job: string; at: string }> = [];
  // Iterate every minute in the gap. We start one minute past the
  // last healthy tick (the tick before the crash already covered
  // anything in its own minute) and include the current minute so a
  // crash that straddled a scheduled fire still surfaces.
  for (let t = lastAt + 60_000; t <= now; t += 60_000) {
    const at = new Date(t);
    for (const job of jobs) {
      if (cronMatches(job.schedule, at)) {
        missed.push({ job: job.name, at: at.toISOString().slice(0, 16) });
      }
    }
  }
  const gapMinutes = Math.round(gapMs / 60_000);
  const id = `system-daemon-offline-${state.lastHealthyTickAt}`;
  if (missed.length === 0) {
    addNotification({
      id,
      kind: 'system',
      title: `Clementine was offline for ${gapMinutes} min`,
      body: `Daemon was down from ${state.lastHealthyTickAt} until ${new Date(now).toISOString()}. No scheduled cron runs were due during the outage.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'daemon_offline', gapMinutes, missedCount: 0 },
    });
    return;
  }
  const list = missed.slice(0, 10).map((m) => `• ${m.job} @ ${m.at}`).join('\n');
  addNotification({
    id,
    kind: 'system',
    title: `${missed.length} scheduled cron run${missed.length === 1 ? '' : 's'} missed (daemon was offline ${gapMinutes} min)`,
    body: `These scheduled runs did NOT fire while Clementine was down:\n${list}${missed.length > 10 ? `\n(+${missed.length - 10} more)` : ''}\n\nIf any are critical, re-trigger from Console → Crons.`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'daemon_offline', gapMinutes, missedCount: missed.length, missed: missed.slice(0, 50) },
  });
}

async function processCronTriggers(assistant: ClementineAssistant): Promise<void> {
  ensureDir(CRON_TRIGGERS_DIR);
  const jobs = loadCronJobs();
  for (const file of readdirSync(CRON_TRIGGERS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(CRON_TRIGGERS_DIR, file);
    try {
      const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as { jobName?: string };
      const job = jobs.find((entry) => entry.name === payload.jobName);
      if (job) {
        await runCronJob(assistant, job, 'trigger');
      }
    } catch (error) {
      logger.warn({ err: error, file }, 'Failed to process cron trigger');
    } finally {
      rmSync(filePath, { force: true });
    }
  }
}

// Workflow execution lives in src/execution/workflow-runner.ts now —
// the new runner supports per-step forEach fan-out, deterministic
// scripted steps, and append-only events.jsonl for resume after
// daemon restart (research_bot/manager.py pattern). The inline
// sequential runner that lived here has been retired.

// Daily user-facing prompt when notifications can't be delivered for
// lack of any configured destination. Bucketed by calendar day so the
// user sees it once, not on every 15s tick. When destinations get
// configured later, deferred jobs flush automatically on the next tick.
function emitNoDestinationsPromptIfNeeded(deferredCount: number): void {
  if (deferredCount === 0) return;
  const id = `system-no-notification-destinations-${new Date().toISOString().slice(0, 10)}`;
  if (getNotification(id)) return;
  addNotification({
    id,
    kind: 'system',
    title: `${deferredCount} notification${deferredCount === 1 ? '' : 's'} can't be delivered — no destination configured`,
    body: 'Clementine has produced notifications (cron jobs, workflows, executions) that have nowhere to go. Open Console → Settings → Notifications to add a Discord channel/DM or webhook. Deferred notifications will flush automatically once a destination is configured.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'no_destinations', deferredCount },
  });
}

function staleApprovalNotificationReason(
  notification: NotificationRecord,
  assistant: ClementineAssistant,
): string | null {
  if (notification.kind !== 'approval') return null;
  const approvalId = notification.metadata?.approvalId;
  if (typeof approvalId !== 'string' || approvalId.length === 0) return null;
  // First check the harness sqlite registry — this catches every harness
  // approval (apr-* IDs from request_approval, composio_execute_tool,
  // write_file, etc.) generated from the orchestrator path.
  const approval = approvalRegistry.get(approvalId);
  if (approval) {
    if (approvalRegistry.isExpired(approval)) return 'approval_expired';
    if (approval.status !== 'pending') return `approval_${approval.status}`;
    return null;
  }
  // Fallback to the codex-native runtime's in-memory ApprovalStore. This
  // is where background tasks (meeting-capture analysis, summarizers,
  // anything spawned through codex-native-runtime) park their approvals
  // — UUID-style IDs, NOT in the sqlite registry. Without this branch,
  // the prior call to approvalRegistry.get() returned undefined and the
  // delivery loop silently skipped the notification as 'approval_not_found',
  // so Nathan never saw Discord buttons for bg-task write_file approvals.
  try {
    const runtimeApproval = assistant
      .getRuntime()
      .listPendingApprovals()
      .find((row) => row.id === approvalId);
    if (runtimeApproval) {
      if (runtimeApproval.status !== 'pending') return `approval_${runtimeApproval.status}`;
      return null;
    }
  } catch {
    // If the runtime isn't queryable, fall through to 'approval_not_found'
    // — same as before — so we don't loop a notification forever waiting
    // on a runtime that may have been replaced.
  }
  return 'approval_not_found';
}

async function processNotificationDeliveries(assistant: ClementineAssistant): Promise<void> {
  const queue = listQueuedNotificationDeliveries();
  if (queue.length === 0) return;

  const nextQueue: typeof queue = [];
  let deferredCount = 0;
  for (const job of queue) {
    const notification = getNotification(job.notificationId);
    if (!notification) {
      continue;
    }

    const staleApprovalReason = staleApprovalNotificationReason(notification, assistant);
    if (staleApprovalReason) {
      markNotificationRead(notification.id);
      updateNotificationDeliveryStatus(notification.id, {
        deliveredAt: notification.deliveredAt,
        deliveryError: `Skipped stale approval notification: ${staleApprovalReason}`,
      });
      logger.info({
        notificationId: notification.id,
        approvalId: notification.metadata?.approvalId,
        reason: staleApprovalReason,
      }, 'Skipped stale approval notification delivery');
      continue;
    }

    const destinations = getNotificationDestinationsForRecord(notification);
    if (destinations.length === 0) {
      // No destinations resolved. Previously this dropped the job
      // permanently — the user could trigger hours of work and never
      // hear a peep. Now we keep the job alive in the queue (cheap;
      // it's just a scan per tick) and emit a single daily prompt
      // telling the user to configure a destination. As soon as one
      // is added, the queued jobs flush on the next tick.
      deferredCount += 1;
      if (deferredCount === 1) {
        logger.warn({
          notificationId: notification.id,
          kind: notification.kind,
          title: notification.title,
        }, 'No notification destinations resolved — keeping job deferred in queue.');
      }
      nextQueue.push(job);
      continue;
    }
    const now = new Date();
    const completed = new Set(job.completedDestinationIds ?? []);
    const failed = new Set(job.failedDestinationIds ?? []);
    const attemptCountByDestination = { ...(job.attemptCountByDestination ?? {}) };
    const nextAttemptAtByDestination = { ...(job.nextAttemptAtByDestination ?? {}) };
    const lastErrorByDestination = { ...(job.lastErrorByDestination ?? {}) };
    const successfulDestinations: string[] = [];
    let lastError = '';
    let attemptedThisPass = 0;

    for (const destination of destinations) {
      if (completed.has(destination.id) || failed.has(destination.id)) {
        continue;
      }

      const nextAttemptAt = nextAttemptAtByDestination[destination.id];
      if (nextAttemptAt && new Date(nextAttemptAt).getTime() > now.getTime()) {
        continue;
      }

      attemptedThisPass += 1;
      attemptCountByDestination[destination.id] = (attemptCountByDestination[destination.id] ?? 0) + 1;

      try {
        await deliverNotificationToDestination(notification, destination);
        completed.add(destination.id);
        delete nextAttemptAtByDestination[destination.id];
        delete lastErrorByDestination[destination.id];
        successfulDestinations.push(destination.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;
        lastErrorByDestination[destination.id] = message;

        if (attemptCountByDestination[destination.id] >= DELIVERY_MAX_ATTEMPTS) {
          failed.add(destination.id);
        } else {
          const retryDelayMinutes = Math.min(60, 2 ** (attemptCountByDestination[destination.id] - 1));
          nextAttemptAtByDestination[destination.id] = new Date(now.getTime() + retryDelayMinutes * 60_000).toISOString();
        }
      }
    }

    job.completedDestinationIds = [...completed];
    job.failedDestinationIds = [...failed];
    job.attemptCountByDestination = attemptCountByDestination;
    job.nextAttemptAtByDestination = nextAttemptAtByDestination;
    job.lastErrorByDestination = lastErrorByDestination;

    const allDestinationIds = destinations.map((destination) => destination.id);
    const terminal = allDestinationIds.every((id) => completed.has(id) || failed.has(id));
    const totalAttempts = Object.values(attemptCountByDestination).reduce((sum, value) => sum + value, 0);

    updateNotificationDeliveryStatus(notification.id, {
      deliveredAt: successfulDestinations.length > 0 ? new Date().toISOString() : notification.deliveredAt,
      deliveryAttempts: totalAttempts,
      deliveryError: lastError || (failed.size > 0 ? 'One or more destinations permanently failed' : undefined),
      deliveredDestinations: successfulDestinations,
    });

    if (terminal) {
      // Reports-back (P1): a notification that exhausted its retries to one
      // or more destinations must NOT vanish silently — that is the single
      // worst outcome per the north star. Surface a follow-up so the user
      // knows delivery failed and how to fix it. Guard against an alert
      // about a failed alert looping forever: a delivery-failure alert that
      // itself fails does not spawn another.
      if (failed.size > 0 && !notification.metadata?.deliveryFailureAlert) {
        try {
          addNotification({
            id: `delivery-failed-${notification.id}`,
            kind: 'system',
            title: 'Notification delivery failed',
            body: `Couldn't deliver "${notification.title}" after ${DELIVERY_MAX_ATTEMPTS} attempts to ${failed.size} destination${failed.size === 1 ? '' : 's'}: ${lastError || 'unknown error'}. Re-check the destination (e.g. your Discord webhook) in Console → Settings, or add another — the original message is still in Activity.`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: {
              deliveryFailureAlert: true,
              failedNotificationId: notification.id,
              failedDestinationIds: [...failed],
            },
          });
        } catch { /* best-effort; the failure is also on the notification record */ }
      }
      continue;
    }

    nextQueue.push(job);
  }

  replaceQueuedNotificationDeliveries(nextQueue);
  emitNoDestinationsPromptIfNeeded(deferredCount);
}

export async function startDaemon(assistant: ClementineAssistant): Promise<void> {
  // Surface exactly which build is running so a stale packaged bundle
  // can't masquerade as the latest src silently (see build-info.ts).
  logger.info({ build: getBuildInfo() }, `Clementine daemon build: ${describeBuild()}`);
  ensureDir(CRON_PROGRESS_DIR);
  const state = loadState();
  // Surface "we missed N scheduled runs while you were offline" BEFORE
  // any other startup work so the user has the bad news first. Safe to
  // call even on first boot (no-op without a previous heartbeat).
  reportMissedCronRunsOnBoot(state);
  // Daily-bucketed setup-gap notifications so the user discovers
  // missing auth / broken config when they open the dashboard, not
  // when they go looking for a missing notification.
  reportBootSetupIssues();
  const interrupted = interruptStaleRunningBackgroundTasks();
  if (interrupted > 0) {
    logger.warn({ interrupted }, 'Marked stale running background tasks as interrupted');
  }
  // Re-queue tasks interrupted by a previous restart/crash so the work
  // resumes instead of stranding (bounded by resumeCount to avoid loops).
  const autoResumed = resumeInterruptedBackgroundTasks({ cap: 2 });
  if (autoResumed > 0) {
    logger.warn({ autoResumed }, 'Auto-resumed interrupted background tasks on boot');
  }
  // Sweep records that got stuck active across a previous crash/restart.
  // Without this, the dashboard "NOW" panel still reports phantom in-flight
  // work from runs that the model forgot to close out (executions) or that
  // the gateway never got to finishRun() on (runs).
  const sweptRuns = sweepStaleRuns();
  const sweptExecutions = sweepStaleExecutions();
  const sweptApprovals = sweepStaleApprovals();
  // On boot, the heartbeat sweeper is the most important one — any
  // execution that was mid-cycle when the previous daemon died has a
  // stale heartbeat and the dashboard would otherwise report it as
  // still working.
  const sweptCrashed = sweepCrashedExecutions();
  const sweptBlocked = sweepStaleBlockedExecutions();
  if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0 || sweptCrashed > 0 || sweptBlocked > 0) {
    logger.warn(
      { sweptRuns, sweptExecutions, sweptApprovals, sweptCrashed, sweptBlocked },
      'Auto-closed stale runs / executions / approvals on daemon start',
    );
  }
  // First-tick init: ensure built-in proactive check-in templates
  // exist on disk (disabled). Re-runs are no-ops because the seeder
  // skips seededIds it already created.
  ensureSeedTemplates();

  // One-time migration: convert any legacy flat workflow .md files
  // into <name>/SKILL.md directories so the rest of the loader can
  // assume the Skills-spec layout. Idempotent; the original is kept
  // as <name>.md.bak for one clean boot, then removed.
  try {
    const migrated = migrateLegacyWorkflowsOnce();
    if (migrated.length > 0) {
      logger.info({ migrated }, 'Migrated legacy workflow .md files to SKILL.md directories');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Workflow legacy migration failed (continuing)');
  }

  // Surface any in-flight workflow runs that didn't reach a terminal
  // state — daemon restart, crash, or kill mid-run. The runner picks
  // these up on the next tick and resumes from the last successful
  // step using the events.jsonl log.
  try {
    reconcilePendingWorkflowRuns();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Pending workflow run reconcile failed');
  }

  logger.info('Daemon loop started');

  // Start the approval reaper. Every 60s it expires past-due rows in
  // pending_approvals (default TTL 24h), clears the orphan session's
  // interrupt state, marks the session 'cancelled', and posts a user
  // notification ("Approval on `X` expired — re-ask and I'll redo it").
  // Without this, the audit found 3+ paused sessions that sat in
  // __interrupt_state indefinitely; the user had no signal the work
  // was lost. See src/runtime/harness/reaper.ts.
  try {
    const { startApprovalReaper } = await import('../runtime/harness/reaper.js');
    startApprovalReaper();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Approval reaper failed to start (continuing without periodic expiry)',
    );
  }

  // Warm the CLI-discovery cache in the background so the first agent
  // call to local_cli_list and the first dashboard render of the Local
  // CLIs card don't pay the full $PATH-walk-and-probe cost (5–30s on a
  // typical dev machine). Errors are non-fatal — the cache will rebuild
  // on demand if this fails.
  //
  // DEFERRED + cache-respecting. The scan forks a storm of `--version`
  // probes (6-way, 2s timeout each) that saturates the single Node event
  // loop. Fired immediately at boot it starves the FIRST dashboard
  // render: the first /meetings/recall/recent fetch (a ~5ms file read)
  // was observed queued behind it for ~31s, so the Meetings panel looked
  // blank/hung. Pushing it past the initial-render window — and using
  // getOrRefreshScan, which skips the scan entirely when a recent scan is
  // still fresh (10-min TTL, so rapid restarts pay nothing) — keeps first
  // paint responsive while the cache is still warm long before any CLI
  // feature is used. unref() so the timer never holds the process open.
  const CLI_WARM_DELAY_MS = 10_000;
  const cliWarmTimer = setTimeout(() => {
    void warmCliScan().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Initial CLI discovery scan failed (will retry on demand)',
      );
    });
  }, CLI_WARM_DELAY_MS);
  cliWarmTimer.unref?.();

  // Notification delivery runs on its OWN cadence, independent of the
  // main loop. The main loop can park for 30+ min on a long cron job
  // or workflow; without this decoupling, notifications queued during
  // that window would only flush after the long phase returned. With
  // this, the user sees completion/failure notifications, heartbeats,
  // and approvals in near-real-time even while a deep job is in flight.
  // An in-flight guard prevents overlap when a single delivery pass
  // is unusually slow.
  let deliveryInFlight = false;
  const deliveryTimer = setInterval(() => {
    if (deliveryInFlight) return;
    deliveryInFlight = true;
    processNotificationDeliveries(assistant)
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Independent notification delivery tick failed',
        );
      })
      .finally(() => {
        deliveryInFlight = false;
      });
  }, 15_000);
  deliveryTimer.unref?.();

  // Background tasks should not wait behind the main daemon loop.
  // A long workflow/autonomy pass can occupy that loop for minutes,
  // which made approved plans appear as "queued" with no visible
  // progress. Drain the background queue independently; the processor
  // itself has an in-flight guard, so explicit approval kicks and this
  // timer cannot double-run the same task.
  const drainBackgroundTasks = () => {
    processBackgroundTasks(assistant).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Independent background task tick failed',
      );
    });
  };
  setImmediate(drainBackgroundTasks);
  const backgroundTimer = setInterval(drainBackgroundTasks, 15_000);
  backgroundTimer.unref?.();

  // Workflow watchdog — reports-back safety net. Runs on its OWN timer
  // (not the main loop) precisely because the failure it catches is the
  // main loop being starved: a run stuck `queued` with no signal. It
  // only observes + notifies (deduped), never mutates run state.
  const tickWatchdog = () => {
    try {
      runWorkflowWatchdog();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Workflow watchdog tick failed',
      );
    }
    // Same safety net for background TASKS (a task that died mid-run or whose
    // terminal notification was lost would otherwise go silent — no watchdog
    // existed for tasks before). Observe-only + deduped, like the workflow one.
    try {
      runBackgroundTaskWatchdog();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Background-task watchdog tick failed',
      );
    }
  };
  const watchdogTimer = setInterval(tickWatchdog, 60_000);
  watchdogTimer.unref?.();

  // Workflow-run lane: drain queued runs on an independent timer so one
  // long/parked run can't starve the main loop (cron, schedules,
  // autonomy, watchdog) — the exact failure that left audit runs queued
  // with no progress. processWorkflowRuns single-flights internally, so
  // overlapping ticks are safe. Disable with CLEMMY_WORKFLOW_RUN_LANE=off
  // to fall back to draining inline on the main tick.
  const workflowRunLane = (getRuntimeEnv('CLEMMY_WORKFLOW_RUN_LANE', 'on') ?? 'on').toLowerCase() !== 'off';
  if (workflowRunLane) {
    const drainWorkflowRunsTick = () => {
      // P0 parking: re-admit any run whose approvals have resolved (no-op
      // when WORKFLOW_APPROVAL_PARKING is off) BEFORE draining, so a freed
      // parked run is picked up in the same tick. setImmediate below also
      // runs this on boot, covering approvals resolved during downtime.
      try { reapResolvedParkedRuns(); } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reapResolvedParkedRuns tick failed');
      }
      processWorkflowRuns(assistant).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Independent workflow-run drain tick failed',
        );
      });
    };
    setImmediate(drainWorkflowRunsTick);
    const workflowRunTimer = setInterval(drainWorkflowRunsTick, 15_000);
    workflowRunTimer.unref?.();
  }

  // Stagger monitor runs — don't run them every 15s tick
  let tickCount = 0;

  while (true) {
    tickCount++;
    await processCronSchedules(assistant, state);
    await processCronTriggers(assistant);
    // Match workflows with trigger.schedule against the wall clock and
    // enqueue runs. processWorkflowRuns (below) then drains the queue.
    await processWorkflowSchedules();
    // When the run lane is active, draining happens on its own timer
    // (above) so a long run can't block this loop. Only drain inline
    // when the lane is disabled.
    if (!workflowRunLane) {
      // P0 parking: re-admit resolved parked runs on the inline path too
      // (no-op when WORKFLOW_APPROVAL_PARKING is off). Keeps parking
      // correct even when the independent run lane is disabled.
      try { reapResolvedParkedRuns(); } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reapResolvedParkedRuns inline tick failed');
      }
      await processWorkflowRuns(assistant);
    }
    const proactivity = getProactivityPolicySnapshot();

    // Run monitors every 4 ticks (~60s) - they have their own internal rate limiting.
    if (proactivity.proactiveWorkAllowed && tickCount % 4 === 0) {
      processMonitors();
    }

    if (proactivity.proactiveWorkAllowed) {
      await processExecutionController(assistant);
      await processAgentAutonomy(assistant);
      // v2 runs in parallel with v1 - each agent is owned by exactly one
      // engine. v2 processes agents listed in AUTONOMY_V2_AGENTS env var;
      // v1 handles the rest. After a v2 cycle marks lastRunAt, v1 sees
      // the cadence as not-yet-due and skips that agent.
      await processAgentAutonomyV2();
      await processProactiveBriefs(assistant);
      // Evaluate user-defined check-in templates — fires open
      // questions through the existing check-in path when their
      // trigger (schedule / condition) is hot and cooldown elapsed.
      const checkInResult = processProactiveCheckIns();
      if (checkInResult.fired.length > 0) {
        logger.info({
          fired: checkInResult.fired.length,
          checkInIds: checkInResult.fired,
        }, 'proactive check-in templates fired');
      }
    } else if (tickCount % 20 === 0) {
      logger.info({
        enabled: proactivity.policy.enabled,
        quietHoursActive: proactivity.quietHoursActive,
      }, 'Proactive daemon work is paused by policy');
      // Daily-bucketed "I'm paused, not stuck" marker on each
      // currently-due execution. Without this, a tracked execution
      // sitting at "Active · next review now" with no progress for
      // 8h overnight looks broken on the dashboard — actually it's
      // just quiet hours. addActivity's key-based dedup means each
      // execution gets at most one entry per UTC day per pause window.
      annotateDueExecutionsAsPolicyPaused(proactivity);
    }
    await processMemoryMaintenance(tickCount);
    await processRecursiveReflectionTick(state);
    await processMemoryHygieneTick(state);
    // Notification delivery used to run inline here. It now ticks on
    // its own independent setInterval above, so deliveries keep
    // flowing while this loop is parked on a long workflow / cron /
    // background task.
    // Periodic stale-record sweep: cheap (one JSON load + a filter) and
    // bounded — only writes when something actually expired. Every 60 ticks
    // ≈ 15 minutes, which is plenty fast for dashboard correctness without
    // hammering disk.
    if (tickCount % 60 === 0) {
      const sweptRuns = sweepStaleRuns();
      const sweptExecutions = sweepStaleExecutions();
      const sweptApprovals = sweepStaleApprovals();
      const sweptBlocked = sweepStaleBlockedExecutions();
      if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0 || sweptBlocked > 0) {
        logger.warn({ sweptRuns, sweptExecutions, sweptApprovals, sweptBlocked }, 'Periodic stale-record sweep auto-closed records');
      }
    }
    // Heartbeat sweep runs FASTER than the others (every ~5 min instead
    // of every ~15) because its whole purpose is to catch crashed
    // controller cycles quickly. tickCount * sleep(15s) = tickCount in
    // 15-second units, so 20 ticks ≈ 5 min.
    if (tickCount % 20 === 0) {
      const sweptCrashed = sweepCrashedExecutions();
      if (sweptCrashed > 0) {
        logger.warn({ sweptCrashed }, 'Heartbeat sweep auto-failed crashed executions');
      }
    }
    // Reap terminal workflow run records older than 7 days. Without
    // this, processWorkflowRuns re-reads every completed run file every
    // tick — a `*/1 * * * *` workflow that ran for a day would leave
    // 1440 files re-parsed on every 15s tick, slowly browning out the
    // main loop. Hourly cadence keeps disk traffic minimal.
    if (tickCount % 240 === 0) {
      try {
        const reaped = reapStaleWorkflowRuns();
        if (reaped.deleted > 0) {
          logger.info(reaped, 'Reaped stale workflow run records');
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Workflow run reaper failed',
        );
      }
    }
    // Persist a daemon-alive heartbeat. Two cadences:
    //   - tick 1 (15s after boot): immediate write so a quick restart
    //     cycle doesn't keep computing "offline X min" against a
    //     stale pre-quit timestamp. Observed 2026-05-24 during hot-
    //     patch cycles — three back-to-back restarts < 60s each
    //     emitted three duplicate "offline" notifications with
    //     compounding gap values because tickCount % 4 never reached.
    //   - every 4 ticks (~60s) thereafter: steady-state cadence.
    //     Keeps disk traffic minimal while staying inside cron's
    //     minute-resolution gap detection threshold.
    if (tickCount === 1 || tickCount % 4 === 0) {
      state.lastHealthyTickAt = new Date().toISOString();
      saveState(state);
    }
    await sleep(15_000);
  }
}
