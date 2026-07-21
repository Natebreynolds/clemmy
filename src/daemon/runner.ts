import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import matter from 'gray-matter';
import pino from 'pino';
import { ClementineAssistant } from '../assistant/core.js';
import { validateCronExpression } from '../shared/cron.js';
import { processAgentAutonomyV2 } from '../agents/autonomy-v2.js';
import { processMonitors } from '../agents/monitors.js';
import { processInboxMonitor } from '../agents/inbox-monitor.js';
import { processCalendarMonitor } from '../agents/calendar-monitor.js';
import { getProactivityPolicySnapshot } from '../agents/proactivity-policy.js';
import { processProactiveBriefs } from '../agents/proactive-briefs.js';
import { ensureSeedTemplates, processProactiveCheckIns } from '../agents/check-in-templates.js';
import { MODELS, getActiveAuthMode, getByoBackendConfig, getModelRoutingMode, getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import { processExecutionController } from '../execution/controller.js';
import { ExecutionStore } from '../execution/store.js';
import { interruptStaleRunningBackgroundTasks, resumeInterruptedBackgroundTasks, processBackgroundTasks, registerBackgroundDrainKick, sweepInvalidDoneBackgroundTasks } from '../execution/background-tasks.js';
import { processWorkflowRuns, reconcilePendingWorkflowRuns, reapResolvedParkedRuns } from '../execution/workflow-runner.js';
import { runWorkflowWatchdog } from '../execution/workflow-watchdog.js';
import { runBackgroundTaskWatchdog } from '../execution/background-task-watchdog.js';
import { processComposioJobWatchTick } from '../integrations/composio/job-watcher.js';
import { runRoutePolicyJob } from '../runtime/harness/route-policy.js';
import { executeComposioTool } from '../integrations/composio/client.js';
import { getBuildInfo, describeBuild } from '../runtime/build-info.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { ensureBuiltInWorkflows } from '../runtime/builtin-workflows.js';
import { verifyDelivered } from '../runtime/harness/verify-delivered.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import { processWorkflowSchedules, reapStaleWorkflowRuns } from '../execution/workflow-scheduler.js';
import { recoverPendingWorkflowTriggerEvents, syncWorkflowTriggerRegistry } from '../execution/workflow-trigger-engine.js';
import { processGoalResumptions } from '../execution/goal-resume.js';
import { processOrphanedToolReports } from '../execution/orphan-tool-reports.js';
import { processSpaceSchedules, retryPausedSpaces } from '../spaces/scheduler.js';
import { maybeOfferStarterWorkspace } from '../spaces/starter-recipes.js';
import { listUsableConnectedToolkits } from '../integrations/composio/client.js';
import { sweepStaleExecutions, sweepCrashedExecutions, sweepStaleBlockedExecutions } from '../execution/store.js';
import { sweepStaleRuns } from '../runtime/run-events.js';
import { reportInterruptedChatRuns } from '../runtime/harness/restart-recovery.js';
import { interruptOrphanedRunAttemptsAtBoot } from '../runtime/harness/eventlog.js';
import { reconcileDormantTerminalWorkSessions } from '../runtime/harness/session-reconcile.js';
import { withHarnessRunContext, ToolCallsCounter } from '../runtime/harness/brackets.js';
import { sweepStaleApprovals } from '../runtime/approval-store.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { getClaudeAuthSnapshot } from '../runtime/claude-oauth.js';
import { tickAuthKeepalive } from '../runtime/auth-keepalive.js';
import { DISCORD_BOT_TOKEN, DISCORD_ENABLED, WEBHOOK_ENABLED, WEBHOOK_SECRET } from '../config.js';
import { getOrRefreshScan as warmCliScan } from '../runtime/cli-discovery.js';
import { closePlanScope, openPlanScope } from '../agents/plan-scope.js';
import {
  finalizeGroundedEntityLinksOnBoot,
  finalizeGroundedResourceLinksOnBoot,
  finalizeLegacyReflectionCandidatesOnBoot,
  finalizeMemoryIdentityOnBoot,
  processMemoryMaintenance,
} from '../memory/maintenance.js';
import { reapStaleCheckIns } from '../agents/check-ins.js';
import { embedQuery, isEmbeddingsEnabled } from '../memory/embeddings.js';
import { runRecursiveReflection, consolidateActiveFacts } from '../memory/reflection.js';
import { decayAndEvictFacts } from '../memory/facts.js';
import { appendHygieneAudit } from '../memory/hygiene-audit.js';
import { autoCleanSafeMemory } from '../autoresearch/memory-apply.js';
import { setDaemonRuntimePhase, withDaemonRuntimePhase } from './phase.js';
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
  isDeliveryJobStale,
  listQueuedNotificationDeliveries,
  markNotificationRead,
  replaceQueuedNotificationDeliveries,
  reapStaleNotifications,
  updateNotificationDeliveryStatus,
  type NotificationRecord,
} from '../runtime/notifications.js';
import { deliverNotificationToDestination } from '../runtime/notification-delivery.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import type { AssistantResponse } from '../types.js';

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
// Drop a delivery job that has been undeliverable longer than this. Without
// it, jobs deferred for lack of a destination accumulate forever and flush
// all at once when one is finally added (2026-06-05: 395 two-week-old jobs
// dumped on first Discord connect). 24h default; env-overridable for ops.
const DELIVERY_MAX_AGE_MS = (() => {
  const hours = parseInt(getRuntimeEnv('NOTIFICATION_DELIVERY_MAX_AGE_HOURS') ?? '', 10);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60_000;
})();
// Even fresh, legitimate bursts shouldn't fire as one wall of messages. Cap
// how many notifications actually deliver per 15s tick; the rest defer to
// the next tick and trickle out. env-overridable.
const DELIVERY_MAX_PER_TICK = (() => {
  const n = parseInt(getRuntimeEnv('NOTIFICATION_DELIVERY_MAX_PER_TICK') ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
})();
const NO_DESTINATION_RETRY_KEY = '__no_destinations__';
const NO_DESTINATION_RETRY_MS = (() => {
  const minutes = parseInt(getRuntimeEnv('NOTIFICATION_NO_DESTINATION_RETRY_MINUTES') ?? '', 10);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
})();

interface BootModelWarmupGate {
  run: boolean;
  harnessConfigured: boolean;
  directOpenAiKey: boolean;
  reason?: string;
}

type ConfigureHarnessRuntimeFn = typeof configureHarnessRuntime;
type ReadOpenAiApiKeyFn = typeof getOpenAiApiKey;

export function bootModelWarmupEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_BOOT_WARMUP', 'off') ?? 'off').trim());
}

export async function resolveBootModelWarmupGate(
  configure: ConfigureHarnessRuntimeFn = configureHarnessRuntime,
  readOpenAiApiKey: ReadOpenAiApiKeyFn = getOpenAiApiKey,
): Promise<BootModelWarmupGate> {
  const directOpenAiKey = Boolean(readOpenAiApiKey().trim());
  try {
    const auth = await configure();
    if (auth.ok) {
      return { run: true, harnessConfigured: true, directOpenAiKey };
    }
    return {
      run: directOpenAiKey,
      harnessConfigured: false,
      directOpenAiKey,
      reason: auth.reason,
    };
  } catch (err) {
    return {
      run: directOpenAiKey,
      harnessConfigured: false,
      directOpenAiKey,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

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

function cronRouteMetadata(response: Pick<AssistantResponse, 'route' | 'raw'>): Record<string, unknown> | undefined {
  const route = routeDiagnosticsFromResponse(response);
  if (!route) return undefined;
  return {
    routeKind: route.routeKind,
    requestedModel: route.requestedModel,
    effectiveModel: route.effectiveModel,
    provider: route.provider,
    transport: route.transport,
    falloverFrom: route.falloverFrom,
  };
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
  recordOperationalEvent({
    source: 'scheduler',
    type: 'cron_job_started',
    sessionId: `cron:${job.name}`,
    actor: `cron:${job.name}`,
    payload: { job: job.name, source, mode: job.mode },
  });
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

    // CANON-ONE-LOOP: cron jobs run unattended — exactly where the harness
    // write gates matter most. Kill-switch CLEMMY_HARNESS_CRON=off.
    const response = await respondPreferHarness('cron', {
      sessionId: cronSessionId,
      channel: 'cron',
      message: prompt,
      model: job.mode === 'unleashed' ? MODELS.deep : MODELS.primary,
      maxWallClockMs: cronBudgetMs,
    }, (req) => assistant.respond(req));

    // Report-back honesty: a non-throwing respond() can still be a blocked /
    // promised / errored run. Fail-open + suspicious-only, so this only ever
    // converts a false "ok" into an honest "needs attention".
    const verdict = await verifyDelivered(prompt, response.text, { stoppedReason: response.stoppedReason });
    const route = cronRouteMetadata(response);

    appendRunLog(job.name, {
      status: verdict.delivered ? 'ok' : 'blocked',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      source,
      response: response.text,
      ...(route ? { route } : {}),
      ...(verdict.delivered ? {} : { blockedReason: verdict.reason }),
    });
    addNotification({
      id: `${Date.now()}-cron-${job.name}`,
      kind: 'cron',
      title: verdict.delivered ? `Cron job completed: ${job.name}` : `Cron job needs attention: ${job.name}`,
      // Send the full body. Discord delivery (notification-delivery.ts)
      // splits long content into multiple messages with paragraph-
      // preserving chunks. Previously this was hard-sliced to 2000 chars
      // and a morning briefing > 2000 arrived cut off with no continuation.
      body: verdict.delivered
        ? response.text
        : `⚠️ This run did not finish cleanly: ${verdict.reason ?? 'no verifiable result'}\n\n${response.text}`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, source, ...(route ? { route } : {}), ...(verdict.delivered ? {} : { status: 'blocked' }) },
    });
    logger.info({ job: job.name, source, delivered: verdict.delivered, route }, verdict.delivered ? 'Cron job completed' : 'Cron job blocked (not done)');
    recordOperationalEvent({
      source: 'scheduler',
      type: 'cron_job_completed',
      severity: verdict.delivered ? 'info' : 'warn',
      sessionId: `cron:${job.name}`,
      actor: `cron:${job.name}`,
      payload: { job: job.name, source, delivered: verdict.delivered, durationMs: Date.now() - startMs, ...(verdict.delivered ? {} : { blockedReason: verdict.reason }) },
    });
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
    recordOperationalEvent({
      source: 'scheduler',
      type: 'cron_job_failed',
      severity: 'error',
      sessionId: `cron:${job.name}`,
      actor: `cron:${job.name}`,
      payload: { job: job.name, source, durationMs: Date.now() - startMs, error: error instanceof Error ? error.message : String(error) },
    });
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
  // Phase A observability: the episodic→semantic distillation tick is the
  // mandate's "background consolidation". Bracket it so the operator view shows
  // when memory consolidates and what it produced. Fail-open.
  recordOperationalEvent({ source: 'memory', type: 'memory_consolidation_started', actor: 'recursive-reflection', payload: { day } });
  try {
    const result = await runRecursiveReflection();
    logger.info({ result }, 'Brain recursive reflection completed');
    recordOperationalEvent({ source: 'memory', type: 'memory_consolidation_completed', actor: 'recursive-reflection', payload: { day, ...result } });
  } catch (err) {
    recordOperationalEvent({ source: 'memory', type: 'memory_consolidation_completed', severity: 'error', actor: 'recursive-reflection', payload: { day, error: err instanceof Error ? err.message : String(err) } });
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Brain recursive reflection failed (will retry tomorrow)',
    );
  }
}

// Tier A2/A3 — nightly memory hygiene: forgetting (decay/eviction of the
// stale, low-value, unpinned tail) + optional retroactive semantic dedup of
// near-identical facts. Semantic similarity only proposes identity; it cannot
// safely prove it, so dedup is explicitly opt-in. Same once-per-local-day,
// survives-restart contract as recursive reflection (offset one hour so
// the two brain jobs don't pile onto the same tick).
const MEMORY_HYGIENE_LOCAL_HOUR = 4;

async function processMemoryHygieneTick(state: DaemonState): Promise<void> {
  // Decay remains default-on. Semantic dedup is default-off after production
  // evidence showed it collapsing distinct phone numbers, dates, and topics.
  // Both halves are SOFT (active=0,
  // pinned-exempt, importance<=4, idle>=60d, score-floored, capped) and every
  // retirement is recoverable (reactivateFact / restore route) AND reviewable
  // (the hygiene audit log below + the inactive-facts view). The env vars
  // survive ONLY as an operator kill-switch (set to 'off' to disable), not as a
  // rollout gate.
  const decayOn = (getRuntimeEnv('CLEMMY_MEMORY_DECAY', 'on') || 'on').toLowerCase() !== 'off';
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
      if (result.deactivated > 0) {
        appendHygieneAudit({
          at: now.toISOString(),
          kind: 'decay',
          ids: result.ids,
          detail: { scanned: result.scanned, deactivated: result.deactivated, reasons: result.reasons },
        });
      }
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
      if (result.ids.length > 0) {
        appendHygieneAudit({
          at: now.toISOString(),
          kind: 'dedup',
          ids: result.ids,
          detail: { examined: result.examined, merged: result.merged },
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Memory dedup/consolidation failed (will retry tomorrow)',
      );
    }
  }
  // Tier A4: auto-clean the provably-safe class (synthetic smoke-test pollution
  // matched by EXACT signature). The first auto-APPLY of the memory-refinement
  // loop. Soft, capped, pinned-exempt, audited (kind:'autoclean'), reversible —
  // and it only ever touches non-user-knowledge. CLEMMY_MEMORY_AUTOCLEAN=off is
  // the kill-switch; autoCleanSafeMemory() honours it internally.
  try {
    const result = autoCleanSafeMemory({ nowIso: now.toISOString() });
    if (result.pruned > 0) {
      logger.info({ pruned: result.pruned, ids: result.ids }, 'Memory auto-clean (synthetic junk) completed');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Memory auto-clean failed (will retry tomorrow)',
    );
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
    if (!bootAuthSetupSatisfied(auth.configured)) {
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

export function bootAuthSetupSatisfied(authConfigured: boolean): boolean {
  if (authConfigured) return true;
  if (getModelRoutingMode() === 'all_in' && getByoBackendConfig().configured) return true;
  return getActiveAuthMode() === 'claude_oauth' && getClaudeAuthSnapshot().configured;
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
    // Dashboard-only: this warning exists because there is no external route.
    // Queueing it for delivery would create another unroutable queue item.
    silent: true,
    metadata: { errorCategory: 'no_destinations', deferredCount },
  });
}

function isNoDestinationsSetupNotification(notification: NotificationRecord): boolean {
  return notification.kind === 'system' && notification.metadata?.errorCategory === 'no_destinations';
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
  // so the user never saw Discord buttons for bg-task write_file approvals.
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

export async function processNotificationDeliveries(assistant: ClementineAssistant): Promise<void> {
  const queue = listQueuedNotificationDeliveries();
  if (queue.length === 0) return;

  const nextQueue: typeof queue = [];
  let deferredCount = 0;
  let droppedStale = 0;
  let deliveredThisTick = 0;
  const nowMs = Date.now();
  for (const job of queue) {
    const notification = getNotification(job.notificationId);
    if (!notification) {
      continue;
    }

    if (isNoDestinationsSetupNotification(notification)) {
      // Legacy queue hygiene: older builds created this setup warning as a
      // normal push notification. It exists because there is no external route,
      // so keep it in Activity but never deliver or retry it externally.
      updateNotificationDeliveryStatus(notification.id, {
        deliveredAt: notification.deliveredAt,
        deliveryError: 'Skipped: no-destination setup notification is dashboard-only',
      });
      continue;
    }

    // Age cap (terminal): a job undeliverable past DELIVERY_MAX_AGE_MS is
    // dropped rather than delivered. This is what stops a long-deferred
    // backlog from flooding the moment a destination is finally configured
    // (2026-06-05 incident). The notification itself stays in Activity.
    if (isDeliveryJobStale(job.queuedAt, nowMs, DELIVERY_MAX_AGE_MS)) {
      droppedStale += 1;
      updateNotificationDeliveryStatus(notification.id, {
        deliveredAt: notification.deliveredAt,
        deliveryError: `Dropped: undelivered for over ${Math.round(DELIVERY_MAX_AGE_MS / 3_600_000)}h`,
      });
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
      const nextNoDestinationAttempt = job.nextAttemptAtByDestination?.[NO_DESTINATION_RETRY_KEY];
      if (nextNoDestinationAttempt) {
        const nextAttemptMs = Date.parse(nextNoDestinationAttempt);
        if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) {
          nextQueue.push(job);
          continue;
        }
      }

      // No destinations resolved. Previously this dropped the job
      // permanently — the user could trigger hours of work and never
      // hear a peep. Now we keep the job alive in the queue (cheap;
      // it's just a scan per tick), but we back off the warning/prompt
      // path so one unroutable job cannot spam logs every 15s. We still
      // resolve destinations before honoring this backoff, so adding a
      // destination lets queued jobs flush on the next tick.
      job.nextAttemptAtByDestination = {
        ...(job.nextAttemptAtByDestination ?? {}),
        [NO_DESTINATION_RETRY_KEY]: new Date(nowMs + NO_DESTINATION_RETRY_MS).toISOString(),
      };
      updateNotificationDeliveryStatus(notification.id, {
        deliveredAt: notification.deliveredAt,
        deliveryError: 'Deferred: no notification destinations configured',
      });
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

    // Per-tick send cap: once this pass has delivered DELIVERY_MAX_PER_TICK
    // notifications, defer the rest to the next 15s tick so a large (but
    // fresh) burst trickles out instead of arriving as one wall. Stale jobs
    // were already dropped above, so this only paces legitimate volume.
    if (deliveredThisTick >= DELIVERY_MAX_PER_TICK) {
      nextQueue.push(job);
      continue;
    }

    const now = new Date();
    const completed = new Set(job.completedDestinationIds ?? []);
    const failed = new Set(job.failedDestinationIds ?? []);
    const attemptCountByDestination = { ...(job.attemptCountByDestination ?? {}) };
    const nextAttemptAtByDestination = { ...(job.nextAttemptAtByDestination ?? {}) };
    const lastErrorByDestination = { ...(job.lastErrorByDestination ?? {}) };
    delete nextAttemptAtByDestination[NO_DESTINATION_RETRY_KEY];
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

    // Count toward the per-tick cap only when this job actually pushed a
    // message out — deferred/retry-waiting jobs don't burn the budget.
    if (successfulDestinations.length > 0) deliveredThisTick += 1;

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
  if (droppedStale > 0) {
    logger.warn({ droppedStale, maxAgeHours: Math.round(DELIVERY_MAX_AGE_MS / 3_600_000) },
      'Dropped stale notification deliveries (older than max age) to prevent a backlog flush');
  }
  if (deliveredThisTick >= DELIVERY_MAX_PER_TICK && nextQueue.length > 0) {
    logger.info({ deliveredThisTick, deferred: nextQueue.length },
      'Hit per-tick delivery cap; remaining notifications will trickle out on the next tick');
  }
}

export async function startDaemon(assistant: ClementineAssistant): Promise<void> {
  setDaemonRuntimePhase('daemon.boot.start', { build: describeBuild() });
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
  // Migration-safe identity finalization: the schema upgrade preserves every
  // historical row, then this backup-first step redirects only people sharing
  // an exact non-generic personal email. This makes identity readiness true on
  // first boot instead of waiting for the 4:40 AM maintenance window.
  try {
    const identityFinalization = finalizeMemoryIdentityOnBoot();
    if (identityFinalization.reason === 'backup_failed') {
      logger.warn(identityFinalization, 'Withheld boot identity reconciliation because the safety backup failed');
    } else if (identityFinalization.ran) {
      logger.info(identityFinalization, 'Finalized stable person identities on boot');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot identity finalization failed');
  }
  // v26 introduced a per-claim reflection ledger, but older threshold buffers
  // contain only exact extractor JSON. Project those stored claims into the
  // ledger before expiry cleanup so upgrade history says what was proposed and
  // why it expired instead of silently deleting the last auditable payload.
  try {
    const reflectionFinalization = finalizeLegacyReflectionCandidatesOnBoot();
    if (reflectionFinalization.reason === 'backup_failed') {
      logger.warn(reflectionFinalization, 'Withheld legacy reflection-ledger finalization because the safety backup failed');
    } else if (reflectionFinalization.ran) {
      logger.info(reflectionFinalization, 'Finalized legacy reflection candidates on boot');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot reflection-ledger finalization failed');
  }
  // The migration labels every legacy text match as inferred. Promote only
  // links whose canonical fact and surviving source excerpt name the same
  // unique identity, so stored-truth graph mode is useful on the first boot
  // without ever converting co-occurrence into evidence.
  try {
    const graphFinalization = finalizeGroundedEntityLinksOnBoot();
    if (graphFinalization.reason === 'backup_failed') {
      logger.warn(graphFinalization, 'Withheld grounded graph reconciliation because the safety backup failed');
    } else if (graphFinalization.ran) {
      logger.info(graphFinalization, 'Grounded recoverable legacy entity links on boot');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot grounded graph finalization failed');
  }
  try {
    const resourceFinalization = finalizeGroundedResourceLinksOnBoot();
    if (resourceFinalization.reason === 'backup_failed') {
      logger.warn(resourceFinalization, 'Withheld grounded resource reconciliation because the safety backup failed');
    } else if (resourceFinalization.ran) {
      logger.info(resourceFinalization, 'Grounded recoverable legacy resource links on boot');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot grounded resource finalization failed');
  }
  const interrupted = interruptStaleRunningBackgroundTasks();
  if (interrupted > 0) {
    logger.warn({ interrupted }, 'Marked stale running background tasks as interrupted');
  }
  // Every run attempt still 'active' at daemon boot belonged to the dead
  // process — Discord/webhook attempts carry no run id or lease, so the
  // desktop-only foreign-lease sweep never reached them and they showed as
  // phantom running sessions forever (workflow recovery review).
  try {
    const orphanedAttempts = interruptOrphanedRunAttemptsAtBoot();
    if (orphanedAttempts > 0) {
      logger.warn({ orphanedAttempts }, 'Interrupted orphaned run attempts from the previous process on boot');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot run-attempt sweep failed');
  }
  // Re-queue tasks interrupted by a previous restart/crash so the work
  // resumes instead of stranding (bounded by resumeCount to avoid loops).
  const autoResumed = resumeInterruptedBackgroundTasks({ cap: 2 });
  if (autoResumed > 0) {
    logger.warn({ autoResumed }, 'Auto-resumed interrupted background tasks on boot');
  }
  // Chat runs execute in-process with no resumer; a restart mid-run would
  // otherwise die SILENTLY. Surface each interrupted chat run, and — when the
  // interrupted turn provably made no external writes — RESUME it automatically
  // through the same harness spine a user's `continue` uses (2026-07-09: users
  // sat on "reply continue" banners after every restart; the resume path itself
  // was live-verified to work). Write-touched / stale runs keep the manual banner.
  const recoveredChats = reportInterruptedChatRuns(Date.now, async (sessionId, directive) => {
    await respondPreferHarness('background', {
      sessionId,
      channel: 'daemon',
      message: directive,
      model: MODELS.primary,
    }, (req) => assistant.respond(req));
  }, { bootCutoffMs: performance.timeOrigin });
  if (recoveredChats > 0) {
    logger.warn({ recoveredChats }, 'Surfaced chat runs interrupted by a previous restart (safe ones auto-resumed)');
  }
  const reconciledHarnessSessions = reconcileDormantTerminalWorkSessions();
  if (reconciledHarnessSessions.reconciled > 0) {
    logger.warn(
      {
        reconciled: reconciledHarnessSessions.reconciled,
        completed: reconciledHarnessSessions.completed,
        failed: reconciledHarnessSessions.failed,
      },
      'Reconciled stale non-chat harness sessions with terminal event evidence',
    );
  }
  // Sweep records that got stuck active across a previous crash/restart.
  // Without this, the dashboard "NOW" panel still reports phantom in-flight
  // work from runs that the model forgot to close out (executions) or that
  // the gateway never got to finishRun() on (runs).
  const sweptRuns = sweepStaleRuns();
  const sweptExecutions = sweepStaleExecutions();
  const sweptApprovals = sweepStaleApprovals();
  const repairedDoneTasks = (getRuntimeEnv('CLEMMY_BGTASK_INTEGRITY_SWEEP', 'on') ?? 'on').toLowerCase() === 'off'
    ? { repaired: 0, ids: [] as string[] }
    : sweepInvalidDoneBackgroundTasks();
  // On boot, the heartbeat sweeper is the most important one — any
  // execution that was mid-cycle when the previous daemon died has a
  // stale heartbeat and the dashboard would otherwise report it as
  // still working.
  const sweptCrashed = sweepCrashedExecutions();
  const sweptBlocked = sweepStaleBlockedExecutions();
  if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0 || sweptCrashed > 0 || sweptBlocked > 0 || repairedDoneTasks.repaired > 0) {
    logger.warn(
      { sweptRuns, sweptExecutions, sweptApprovals, sweptCrashed, sweptBlocked, repairedDoneTasks },
      'Auto-closed stale runs / executions / approvals on daemon start',
    );
  }
  // Notification hygiene on boot: stale unread approval/execution cards
  // (dead runs) flip to read; >30d records purge. Clears the "Needs you"
  // ghosts that bury real items (observed live: 873 unread from weeks back).
  try {
    const reaped = reapStaleNotifications();
    if (reaped.markedRead > 0 || reaped.purged > 0) {
      logger.info(reaped, 'Reaped stale notifications on boot');
    }
  } catch (err) {
    logger.warn({ err }, 'Notification reap on boot failed');
  }
  // Same hygiene for open check-ins: an unanswered agent question whose
  // work died weeks ago must not pin "Needs you" to Home forever.
  try {
    const closedCheckIns = reapStaleCheckIns();
    if (closedCheckIns > 0) {
      logger.info({ closedCheckIns }, 'Auto-closed stale open check-ins on boot');
    }
  } catch (err) {
    logger.warn({ err }, 'Check-in reap on boot failed');
  }
  // First-tick init: ensure built-in proactive check-in templates
  // exist on disk (disabled). Re-runs are no-ops because the seeder
  // skips seededIds it already created.
  ensureSeedTemplates();
  try {
    const seeded = ensureBuiltInWorkflows();
    if (seeded.installed.length > 0) {
      logger.info({ workflows: seeded.installed }, 'Seeded built-in workflows');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Built-in workflow seeding failed (continuing)');
  }

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

  // Chat approval auto-resume (fail-closed park, 2026-07-20): when a WAIT-gate
  // approval that PARKED (hold ceiling hit, turn ended honestly) is later
  // APPROVED, re-drive the session through the normal respond spine so the
  // approved action actually runs — "I approved it and nothing happened" is a
  // trust break. Same injected-dispatcher shape as restart-recovery's resume.
  try {
    const { startChatApprovalResume } = await import('../runtime/harness/chat-approval-resume.js');
    startChatApprovalResume(async (sessionId, directive) => {
      await respondPreferHarness('background', {
        sessionId,
        channel: 'daemon',
        message: directive,
        model: MODELS.primary,
      }, (req) => assistant.respond(req));
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Chat approval auto-resume failed to start (parked approvals will need a manual "continue")',
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
    withDaemonRuntimePhase('daemon.timer.notification_delivery', {}, () => processNotificationDeliveries(assistant))
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
    withDaemonRuntimePhase('daemon.timer.background_tasks', {}, () => processBackgroundTasks(assistant)).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Independent background task tick failed',
      );
    });
  };
  setImmediate(drainBackgroundTasks);
  const backgroundTimer = setInterval(drainBackgroundTasks, 15_000);
  backgroundTimer.unref?.();
  // Wire the immediate-drain kick: a freshly enqueued task (dispatch_background_task,
  // chat/mobile/discord auto-promotion) drains NOW instead of waiting for the 15s
  // tick, so it fires + turns RUNNING + becomes expandable right away. Single-flight
  // guarded inside processBackgroundTasks, so a kick can never double-run a task.
  registerBackgroundDrainKick((limit) => {
    setImmediate(() => {
      withDaemonRuntimePhase('daemon.kick.background_tasks', { limit: limit ?? 1 }, () => processBackgroundTasks(assistant, limit ?? 1)).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Immediate background drain kick failed',
        );
      });
    });
  });

  // Composio background job-watcher: a DETERMINISTIC poller (not an LLM worker) for
  // queued Composio jobs the tool call-site parked — a genuinely-long Apify scrape,
  // or a DataForSEO/Firecrawl async job whose result-getter needs a live lookup. Runs
  // on its OWN 15s timer (like the background drain) so it never waits behind the main
  // loop; each due record is polled once and its owning background task reports the
  // REAL result back to the origin session on completion. The exec binds the record's
  // connectionId (executeComposioTool's 3rd arg). Fail-open.
  const tickComposioJobs = () => {
    withDaemonRuntimePhase('daemon.timer.composio_job_watch', {}, () => processComposioJobWatchTick((slug, args, connectionId) => executeComposioTool(slug, args, connectionId)))
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Composio job-watch tick failed',
        );
      });
  };
  const composioJobTimer = setInterval(tickComposioJobs, 15_000);
  composioJobTimer.unref?.();

  // Adaptive route policy — the periodic OFFLINE learning job (Phase E). Groups
  // recent route outcomes by (role, intent, model), scores them with the
  // existing scorer, and rebuilds model_route_policy. The hot path only READS
  // the table (resolveRoleModel, kill-switch CLEMMY_ROUTE_POLICY); this tick is
  // observe-only bookkeeping and always runs. Hourly + once shortly after boot
  // so a fresh install has scores as soon as it has outcomes. Never throws.
  const tickRoutePolicy = () => {
    void withDaemonRuntimePhase('daemon.timer.route_policy', {}, async () => {
      const result = runRoutePolicyJob();
      if (result) {
        logger.info(
          { policyVersion: result.policyVersion, rows: result.rowsWritten, windowDays: result.windowDays },
          'route-policy job rebuilt model_route_policy',
        );
      }
    }).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'route-policy job failed');
    });
  };
  const routePolicyBootTimer = setTimeout(tickRoutePolicy, 90_000);
  routePolicyBootTimer.unref?.();
  const routePolicyTimer = setInterval(tickRoutePolicy, 60 * 60_000);
  routePolicyTimer.unref?.();

  // Workflow watchdog — reports-back safety net. Runs on its OWN timer
  // (not the main loop) precisely because the failure it catches is the
  // main loop being starved: a run stuck `queued` with no signal. It
  // only observes + notifies (deduped), never mutates run state.
  const tickWatchdog = () => {
    void withDaemonRuntimePhase('daemon.timer.watchdogs', {}, async () => {
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
    });
  };
  const watchdogTimer = setInterval(tickWatchdog, 60_000);
  watchdogTimer.unref?.();

  // Proactive Codex auth keepalive: refresh a soon-to-expire token while idle and
  // surface a re-auth prompt EARLY (not mid-task). Routes through the existing
  // single-flight + lock, so it adds no reuse-revoke risk.
  // Run once shortly after boot so a daemon that started with a near-expired
  // token warms it before the first job, then every 5 min.
  setTimeout(() => { void tickAuthKeepalive(); }, 30_000).unref?.();
  const authKeepaliveTimer = setInterval(() => { void tickAuthKeepalive(); }, 5 * 60_000);
  authKeepaliveTimer.unref?.();

  // Boot warmup: one model call + one embed ping shortly after boot so the
  // FIRST real user turn doesn't pay the cold-start tax (observed live on the
  // 0.9.1 update: a 35s model call + hybrid-recall timeout on the first
  // post-restart greeting). NOTE: the prompt below is trivial ("ok") but the
  // runtime still assembles the FULL system prefix (rubric + tools + context),
  // so this is a ~50K-token call, not a "tiny" one — that's intentional, it
  // primes the provider prompt cache with a representative prefix. It fires
  // ONCE per boot, so it is a bounded cold-start cost, not a per-turn leak;
  // confirm/track it via `npx tsx scripts/measure-efficiency.ts` (the `warmup`
  // kind row). Explicit opt-in only: this still enters through the legacy
  // assistant runtime, which can select a different provider than the active
  // harness brain and races the first real turn. Keep it dormant until the
  // warmup uses the unified provider-qualified core.
  if (bootModelWarmupEnabled()) {
    setTimeout(() => {
      void (async () => {
        try {
          const warmupSessionId = `warmup-${Date.now()}`;
          const warmupGate = await resolveBootModelWarmupGate();
          if (!warmupGate.run) {
            logger.info(
              { reason: warmupGate.reason ?? 'model runtime is not configured' },
              'boot warmup: model path skipped',
            );
          } else {
            // Establish the harness run context so the BYO/Claude SDK usage
            // recorders (which read sessionId from harnessRunContextStorage, not
            // the bare ModelRequest) tag this as kind:'warmup' instead of falling
            // back to 'unknown'/'other' — keeping warmup isolated from the
            // interactive-chat cache-hit-rate on every lane, not just Codex.
            await withHarnessRunContext(
              { sessionId: warmupSessionId, counter: new ToolCallsCounter(8) },
              () => assistant.getRuntime().run({
                instructions: 'Reply with the single word: ok',
                // Warm the BRAIN's actual model, not MODELS.fast: the provider prompt
                // cache is keyed per-model, so priming the fast slot never helped the
                // first real (brain) turn — and a repurposed BYO fast slot (e.g.
                // glm-5.2) turned this boot ping into an unintended BYO call. The brain
                // model is what the first turn will actually use.
                model: resolveRoleModel('brain').modelId,
                prompt: 'ok',
                sessionId: warmupSessionId,
              }),
            );
            logger.info(
              { harnessConfigured: warmupGate.harnessConfigured, directOpenAiKey: warmupGate.directOpenAiKey },
              'boot warmup: model path warmed',
            );
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'boot warmup: model ping failed');
        }
        try {
          if (isEmbeddingsEnabled()) {
            await embedQuery('warmup');
            logger.info('boot warmup: embedding path warmed');
          }
        } catch {
          /* embedQuery already fails safe */
        }
      })();
    }, 5_000).unref?.();
  }

  // MCP pre-warm regression: connect scoped external MCP servers while the
  // boot loop is IDLE, so a cold handshake does not race a turn. Default is now
  // scoped/demand-driven: explicit CLEMMY_MCP_PREWARM_SERVERS, otherwise healthy
  // remembered MCP servers, otherwise one configured server only. The legacy
  // all-external warm remains available with CLEMMY_MCP_PREWARM=all.
  if (!['off', '0', 'false', 'no'].includes((getRuntimeEnv('CLEMMY_MCP_PREWARM', 'scoped') ?? 'scoped').toLowerCase())) {
    setTimeout(() => {
      void (async () => {
        try {
          const {
            getOrCreateExternalMcpServers,
            prewarmMcpServers,
            resolveMcpPrewarmSelection,
          } = await import('../runtime/mcp-servers.js');
          const selection = resolveMcpPrewarmSelection();
          if (selection.mode === 'off' || selection.mode === 'none') {
            logger.info({ reason: selection.reason }, 'MCP pre-warm skipped');
            return;
          }

          const { attempts, allConnected, target, serverSlugs } = await prewarmMcpServers({
            allowedServerSlugs: selection.mode === 'scoped' ? selection.allowedServerSlugs ?? [] : undefined,
          });
          logger.info({ attempts, allConnected, target, serverSlugs, reason: selection.reason }, 'MCP pre-warm complete');
          // Prime the semantic tool-vector cache too. Connect alone left the
          // FIRST scoped turn paying listTools + embedTexts cold. Prime only the
          // same target set we warmed; listing all external tools here would
          // reintroduce the all-server startup boot this path is avoiding.
          const { rankToolsBySemantic } = await import('../runtime/mcp-tool-rank.js');
          const externalTools = target === 'all'
            ? await getOrCreateExternalMcpServers().listTools()
            : serverSlugs.length > 0
              ? await getOrCreateExternalMcpServers({
                  reason: 'boot MCP vector prime',
                  allowedServerSlugs: serverSlugs,
                  maxTools: Number.MAX_SAFE_INTEGER,
                }).listTools()
              : [];
          if (externalTools.length === 0) {
            logger.info({ target, serverSlugs }, 'MCP pre-warm: no tool vectors to prime');
            return;
          }
          await rankToolsBySemantic('warmup: prime external tool vectors', externalTools as never);
          logger.info({ target, serverSlugs, toolCount: externalTools.length }, 'MCP pre-warm: tool vectors primed');
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'MCP pre-warm failed (servers connect on first use)');
        }
      })();
    }, 8_000).unref?.();
  }

  // Workflow-run lane: drain queued runs on an independent timer so one
  // long/parked run can't starve the main loop (cron, schedules,
  // autonomy, watchdog) — the exact failure that left audit runs queued
  // with no progress. processWorkflowRuns single-flights internally, so
  // overlapping ticks are safe. Disable with CLEMMY_WORKFLOW_RUN_LANE=off
  // to fall back to draining inline on the main tick.
  const workflowRunLane = (getRuntimeEnv('CLEMMY_WORKFLOW_RUN_LANE', 'on') ?? 'on').toLowerCase() !== 'off';
  if (workflowRunLane) {
    const drainWorkflowRunsTick = () => {
      withDaemonRuntimePhase('daemon.timer.workflow_runs', {}, async () => {
        // P0 parking: re-admit any run whose approvals have resolved (no-op
        // when WORKFLOW_APPROVAL_PARKING is off) BEFORE draining, so a freed
        // parked run is picked up in the same tick. setImmediate below also
        // runs this on boot, covering approvals resolved during downtime.
        try { reapResolvedParkedRuns(); } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reapResolvedParkedRuns tick failed');
        }
        await processWorkflowRuns(assistant);
      }).catch((err) => {
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
    setDaemonRuntimePhase('daemon.loop.tick', { tickCount });
    await withDaemonRuntimePhase('daemon.loop.cron_schedules', { tickCount }, () => processCronSchedules(assistant, state));
    await withDaemonRuntimePhase('daemon.loop.cron_triggers', { tickCount }, () => processCronTriggers(assistant));
    // Match workflows with trigger.schedule against the wall clock and
    // enqueue runs. processWorkflowRuns (below) then drains the queue.
    await withDaemonRuntimePhase('daemon.loop.workflow_schedules', { tickCount }, () => processWorkflowSchedules());
    // T2.1: keep the trigger registry in sync with each enabled workflow's
    // declared event/webhook triggers so fireWorkflowSystemEvent / the
    // /api/hooks/workflows route can match them. Cheap (no-op upserts are
    // skipped) and best-effort.
    await withDaemonRuntimePhase('daemon.loop.workflow_trigger_registry', { tickCount }, async () => {
      try {
        syncWorkflowTriggerRegistry();
        recoverPendingWorkflowTriggerEvents();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'syncWorkflowTriggerRegistry tick failed');
      }
    });
    // Workspaces: silently refresh any scheduled data sources (no LLM).
    {
      await withDaemonRuntimePhase('daemon.loop.space_schedules', { tickCount }, () => processSpaceSchedules()).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'processSpaceSchedules tick failed');
      });
      // Paused-build auto-retry: a workspace parked by a TRANSIENT build-time
      // failure re-pulls its sources (2 attempts, spaced) and reactivates on
      // success instead of stranding until the user notices the banner.
      await withDaemonRuntimePhase('daemon.loop.space_retry_paused', { tickCount }, () => retryPausedSpaces()).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'retryPausedSpaces tick failed');
      });
      // First-ten-minutes activation: once-ever SUGGEST when the user has zero
      // workspaces but a usable connection ("I can build you a Deal Board").
      // Deterministic + marker-guarded + probe-throttled; never auto-builds.
      await withDaemonRuntimePhase('daemon.loop.space_starter_offer', { tickCount }, () => maybeOfferStarterWorkspace({
        listConnectedSlugs: async () => (await listUsableConnectedToolkits()).map((t) => t.slug).filter(Boolean),
      })).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'starter-workspace offer check failed');
      });
    }
    // When the run lane is active, draining happens on its own timer
    // (above) so a long run can't block this loop. Only drain inline
    // when the lane is disabled.
    if (!workflowRunLane) {
      // P0 parking: re-admit resolved parked runs on the inline path too
      // (no-op when WORKFLOW_APPROVAL_PARKING is off). Keeps parking
      // correct even when the independent run lane is disabled.
      await withDaemonRuntimePhase('daemon.loop.workflow_runs_inline', { tickCount }, async () => {
        try { reapResolvedParkedRuns(); } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reapResolvedParkedRuns inline tick failed');
        }
        await processWorkflowRuns(assistant);
      });
    }
    const proactivity = getProactivityPolicySnapshot();

    // Run monitors every 4 ticks (~60s) - they have their own internal rate limiting.
    if (proactivity.proactiveWorkAllowed && tickCount % 4 === 0) {
      await withDaemonRuntimePhase('daemon.loop.monitors', { tickCount }, async () => {
        processMonitors();
      });
      // C2 ambient inbox watch (general, read-only). Self-rate-limited (own
      // cadence) + surface-only; fire-and-forget so its mailbox reads never block
      // the tick. Best-effort.
      void withDaemonRuntimePhase('daemon.fire_and_forget.inbox_monitor', { tickCount }, () => processInboxMonitor())
        .catch((err) => logger.warn({ err }, 'inbox monitor tick failed'));
      // C2 ambient calendar watch — same pattern (general, read-only).
      // Self-rate-limited; fire-and-forget.
      void withDaemonRuntimePhase('daemon.fire_and_forget.calendar_monitor', { tickCount }, () => processCalendarMonitor())
        .catch((err) => logger.warn({ err }, 'calendar monitor tick failed'));
    }

    if (proactivity.proactiveWorkAllowed) {
      await withDaemonRuntimePhase('daemon.loop.execution_controller', { tickCount }, () => processExecutionController(assistant));
      // Autonomy v1 (processAgentAutonomy) was deleted in Phase-2 Wave 2 — v2
      // owns every standing agent (AUTONOMY_V2_AGENTS) and self-driving goals
      // own the rest. Only v2 + goals run the standing-work cadence now.
      await withDaemonRuntimePhase('daemon.loop.agent_autonomy_v2', { tickCount }, () => processAgentAutonomyV2());
      // Self-driving goals (A2): re-enter active goals due for a heartbeat.
      // Inside proactiveWorkAllowed ⇒ quiet hours pause resumption for free
      // (the autonomous-hours window, reusing proactivity-policy). ~60s scan
      // cadence; per-goal nextResumeAt governs the real interval. This is the
      // principled replacement for processAgentAutonomy{,V2} — do NOT add new
      // standing-work features to those two engines; land them as goals here.
      if (tickCount % 4 === 0) {
        await withDaemonRuntimePhase('daemon.loop.goal_resumptions', { tickCount }, () => processGoalResumptions());
      }
      // Reunify tools left in flight when a turn died on an infra error — fire a
      // follow-up report turn once the tool (e.g. a long run_batch) completes.
      await withDaemonRuntimePhase('daemon.loop.orphaned_tool_reports', { tickCount }, () => processOrphanedToolReports());
      await withDaemonRuntimePhase('daemon.loop.proactive_briefs', { tickCount }, () => processProactiveBriefs(assistant));
      // Evaluate user-defined check-in templates — fires open
      // questions through the existing check-in path when their
      // trigger (schedule / condition) is hot and cooldown elapsed.
      const checkInResult = await withDaemonRuntimePhase('daemon.loop.proactive_check_ins', { tickCount }, async () => processProactiveCheckIns());
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
    await withDaemonRuntimePhase('daemon.loop.memory_maintenance', { tickCount }, () => processMemoryMaintenance(tickCount));
    await withDaemonRuntimePhase('daemon.loop.recursive_reflection', { tickCount }, () => processRecursiveReflectionTick(state));
    await withDaemonRuntimePhase('daemon.loop.memory_hygiene', { tickCount }, () => processMemoryHygieneTick(state));
    // Notification delivery used to run inline here. It now ticks on
    // its own independent setInterval above, so deliveries keep
    // flowing while this loop is parked on a long workflow / cron /
    // background task.
    // Periodic stale-record sweep: cheap (one JSON load + a filter) and
    // bounded — only writes when something actually expired. Every 60 ticks
    // ≈ 15 minutes, which is plenty fast for dashboard correctness without
    // hammering disk.
    if (tickCount % 60 === 0) {
      await withDaemonRuntimePhase('daemon.loop.stale_record_sweep', { tickCount }, async () => {
        const sweptRuns = sweepStaleRuns();
        const sweptExecutions = sweepStaleExecutions();
        const sweptApprovals = sweepStaleApprovals();
        const sweptBlocked = sweepStaleBlockedExecutions();
        const repairedDoneTasks = (getRuntimeEnv('CLEMMY_BGTASK_INTEGRITY_SWEEP', 'on') ?? 'on').toLowerCase() === 'off'
          ? { repaired: 0, ids: [] as string[] }
          : sweepInvalidDoneBackgroundTasks();
        if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0 || sweptBlocked > 0 || repairedDoneTasks.repaired > 0) {
          logger.warn({ sweptRuns, sweptExecutions, sweptApprovals, sweptBlocked, repairedDoneTasks }, 'Periodic stale-record sweep auto-closed records');
        }
      });
    }
    // Heartbeat sweep runs FASTER than the others (every ~5 min instead
    // of every ~15) because its whole purpose is to catch crashed
    // controller cycles quickly. tickCount * sleep(15s) = tickCount in
    // 15-second units, so 20 ticks ≈ 5 min.
    if (tickCount % 20 === 0) {
      await withDaemonRuntimePhase('daemon.loop.crashed_execution_sweep', { tickCount }, async () => {
        const sweptCrashed = sweepCrashedExecutions();
        if (sweptCrashed > 0) {
          logger.warn({ sweptCrashed }, 'Heartbeat sweep auto-failed crashed executions');
        }
      });
    }
    // Reap terminal workflow run records older than 7 days. Without
    // this, processWorkflowRuns re-reads every completed run file every
    // tick — a `*/1 * * * *` workflow that ran for a day would leave
    // 1440 files re-parsed on every 15s tick, slowly browning out the
    // main loop. Hourly cadence keeps disk traffic minimal.
    if (tickCount % 240 === 0) {
      await withDaemonRuntimePhase('daemon.loop.workflow_run_reaper', { tickCount }, async () => {
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
      });
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
      await withDaemonRuntimePhase('daemon.loop.persist_heartbeat', { tickCount }, async () => {
        state.lastHealthyTickAt = new Date().toISOString();
        saveState(state);
      });
    }
    setDaemonRuntimePhase('daemon.loop.sleep', { tickCount });
    await sleep(15_000);
  }
}
