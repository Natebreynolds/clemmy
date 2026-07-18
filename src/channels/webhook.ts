import express from 'express';
import pino from 'pino';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { ClementineAssistant } from '../assistant/core.js';
import {
  BASE_DIR,
  DISCORD_ALLOWED_CHANNELS,
  DISCORD_DM_ALLOWED_USERS,
  SLACK_ALLOWED_CHANNELS,
  SLACK_ALLOWED_USERS,
  SLACK_PROACTIVE_CHANNEL,
  WEBHOOK_ALLOW_LAN,
  WEBHOOK_HOST,
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
  WEBHOOK_SECRET_IS_STRONG,
  isLoopbackWebhookHost,
} from '../config.js';
import { DASHBOARD_CRON_RUNS_DIR, buildDashboardSnapshot, loadCronJobs, loadWorkflows, readDaemonState, readRecentJsonLines, readWorkflowRuns } from '../dashboard/state.js';
// Added 2026-05-21: /api/runs/:id fallbacks for harness sessions and
// workflow runs. The legacy run-store only knows about run-xxx IDs;
// without these fallbacks, clicking a harness session or workflow run
// in the dashboard's Live Runs feed 404s and the inspector shows
// "Run not found".
import {
  countMatchingEvents as harnessCountMatchingEvents,
  getLatestEventSeq as harnessGetLatestEventSeq,
  getLatestRunAttempt as harnessGetLatestRunAttempt,
  getLatestRunAttemptByRunId as harnessGetLatestRunAttemptByRunId,
  getSession as harnessGetSession,
  listEvents as harnessListEvents,
  listSessions as harnessListSessions,
  type EventRow as HarnessEventRow,
  type ListEventsOptions as HarnessListEventsOptions,
  type RunAttemptRecord as HarnessRunAttemptRecord,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import { getArtifactRunScope, listRunArtifacts } from '../runtime/harness/artifact-ledger.js';
import { registerConsoleRoutes } from '../dashboard/console-routes.js';
import {
  fireWorkflowWebhook,
  syncWorkflowTriggerRegistry,
  workflowWebhookResponseDisposition,
} from '../execution/workflow-trigger-engine.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';
import { isConsoleNextEnabled, registerConsoleSpaRoutes } from '../dashboard/console-spa.js';
import { registerSpaceRoutes } from '../dashboard/space-routes.js';
import { createMobileRouter } from './mobile-routes.js';
import { readMobileAccess } from '../runtime/mobile-access-state.js';
import {
  addNotification,
  listNotifications,
  listNotificationDestinations,
  markNotificationRead,
  NotificationDestination,
  requeueNotificationDelivery,
  removeNotificationDestination,
  upsertNotificationDestination,
} from '../runtime/notifications.js';
import { buildNotificationDoctor } from '../runtime/notification-doctor.js';
import { testNotificationDestination } from '../runtime/notification-delivery.js';
import { runChannelAcceptance } from '../runtime/channel-acceptance.js';
import { fetchDiscordInstallInfo } from './discord-install.js';
import { getDiscordRuntimeStatus } from './discord.js';
import { getSlackRuntimeStatus } from './slack.js';
import { readEnvFile, writeEnvFile } from '../setup/env-file.js';
import {
  authorizeToolkit,
  buildComposioDashboardSnapshot,
  bustComposioDashboardCaches,
  COMPOSIO_AUTH_CONFIGS_URL,
  ComposioNeedsAuthConfigError,
  disconnectToolkit,
  getComposioCredentialStatus,
  getComposioRuntimeStatus,
  resetComposioClient,
  saveComposioCredentials,
  validateComposioApiKey,
  saveComposioExecutionBackend,
  setupApiKeyToolkit,
  setupOAuthToolkit,
  getToolkitSetupMeta,
} from '../integrations/composio/client.js';
import { computeAvailability, KNOWN_SERVICES, loadToolPreferences, saveToolPreferences, type ToolSource } from '../integrations/tool-preferences.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { ClementineGateway, type GatewayResponse } from '../gateway/router.js';
import { addRunEvent, finishRun, getRun, listRuns, startRun } from '../runtime/run-events.js';
import {
  friendlyEventMessage,
  friendlyKindLabel,
  friendlyStatusLabel,
  friendlyTimeline,
  isLive,
  liveLine,
  runFilterCategory,
  runPreview,
  userFacingRunState,
  userFacingRunStateIsLive,
  userFacingRunStateLabel,
  type ActivityRunLike,
} from '../runtime/activity-format.js';
import { readMemoryIndexStatus, rebuildVaultIndex } from '../memory/indexer.js';
import { embedMissingChunks } from '../memory/embeddings.js';
import { CRON_FILE } from '../memory/vault.js';
import { setAccountLabel } from '../memory/account-alias-store.js';
import {
  cancelBackgroundTask,
  createBackgroundTask,
  getBackgroundTask,
  queueBackgroundTaskApprovalResolution,
  resumeBackgroundTask,
} from '../execution/background-tasks.js';
import { saveProactivityPolicy } from '../agents/proactivity-policy.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';

const logger = pino({ name: 'clementine-next.webhook' });
const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

function isDiscordHarnessSession(session: HarnessSessionRow): boolean {
  return session.channel === 'discord'
    || session.channel === 'discord-dm'
    || session.metadata.source === 'discord';
}

function isSlackHarnessSession(session: HarnessSessionRow): boolean {
  return session.channel === 'slack'
    || session.channel === 'slack-dm'
    || session.metadata.source === 'slack';
}

/** Desktop background handoff currently knows how to report back only to the
 * desktop origin. Discord/Slack sessions may also be `kind: chat`, but moving
 * one from this surface would discard its external channel/thread attribution.
 * Hide the control until that attribution is part of the exact handoff. */
function supportsDesktopBackgroundHandoff(session: HarnessSessionRow): boolean {
  return session.kind === 'chat'
    && !session.id.startsWith('background:')
    && !isDiscordHarnessSession(session)
    && !isSlackHarnessSession(session);
}

// A workflow runs each step in its own harness session (see
// getWorkflowHarnessSession in workflow-runner.ts: id `workflow:<suffix>`,
// title `<workflow>::<stepId>`, metadata.workflowRunId+stepId). Those are
// internal SUB-UNITS of a run — the run itself is surfaced as a single legacy
// run ("Workflow: <name>", id = workflowRunId) or its workflows/runs/*.json
// record. Without this guard a 5-step workflow spawned 6 inbox rows.
function isWorkflowStepSession(session: HarnessSessionRow): boolean {
  const md = session.metadata ?? {};
  return Boolean(md.stepId)
    || Boolean(md.workflowRunId)
    || String(session.id).startsWith('workflow:');
}

function isActivityVisibleHarnessSession(session: HarnessSessionRow): boolean {
  if (isWorkflowStepSession(session)) return false;
  return session.kind === 'chat'
    || session.kind === 'workflow'
    || session.status === 'active'
    || session.status === 'paused'
    || isDiscordHarnessSession(session)
    || isSlackHarnessSession(session)
    || session.channel === 'workflow'
    || session.metadata.source === 'workflow'
    || session.metadata.source === 'desktop';
}

function harnessSource(session: HarnessSessionRow) {
  if (isDiscordHarnessSession(session)) return 'discord';
  if (isSlackHarnessSession(session)) return 'slack';
  return 'daemon';
}

// Friendly per-event phrasing lives in the shared activity-format module so it
// cannot drift between the desktop console, mobile-web, and Discord surfaces.
function harnessEventMessage(event: HarnessEventRow): string {
  return friendlyEventMessage({ type: event.type, data: event.data });
}

function completionOutputPreview(
  completion: Pick<HarnessEventRow, 'data'> | null | undefined,
  limit = 1200,
): string {
  const data = completion?.data as { reply?: unknown; summary?: unknown } | undefined;
  const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
  const summary = typeof data?.summary === 'string' ? data.summary.trim() : '';
  return (reply || summary).slice(0, limit);
}

const HARNESS_ACTIVITY_EVENT_TYPES: HarnessEventRow['type'][] = [
  'user_input_received',
  'turn_started',
  'plan_drafted',
  'step_started',
  'step_verified',
  'step_failed',
  'worker_started',
  'worker_result',
  'handoff',
  'awaiting_user_input',
  'approval_requested',
  'approval_resolved',
  'kill_requested',
  'run_paused',
  'run_resumed',
  'heartbeat',
  'run_completed',
  'run_failed',
  'conversation_completed',
];

const HARNESS_STATUS_EVENT_TYPES: HarnessEventRow['type'][] = [
  'user_input_received',
  'turn_started',
  'awaiting_user_input',
  'approval_requested',
  'approval_resolved',
  'kill_requested',
  'run_paused',
  'run_resumed',
  'heartbeat',
  'run_completed',
  'run_failed',
  'conversation_completed',
];

const RUN_ENVIRONMENT_PROJECTION_TYPES: HarnessEventRow['type'][] = [
  'plan_drafted',
  'step_started',
  'step_verified',
  'step_failed',
  'worker_started',
  'worker_result',
  'handoff',
];

interface HarnessCurrentScope {
  attempt: HarnessRunAttemptRecord | null;
  query: Pick<HarnessListEventsOptions, 'sinceSeq' | 'sinceAt'>;
  runScopeId?: string;
  scopeKind: 'current_attempt' | 'latest_turn' | 'session_history';
  scopeStartedAt?: string;
  attemptId?: string;
  sourceUserSeq?: number;
}

function brainRunScopeId(sessionId: string, attempt: HarnessRunAttemptRecord): string {
  return `${sessionId}::brain:${attempt.runId ?? attempt.attemptId}`;
}

/** Explicit ids on user-input events are the durable attempt binding. `null`
 * means a legacy unbound event, which may still be classified by its bounded
 * occurrence time; `false` means it explicitly belongs somewhere else. */
function userInputAttemptBinding(
  event: HarnessEventRow | undefined,
  attempt: HarnessRunAttemptRecord,
): boolean | null {
  if (!event) return null;
  const data = eventRecord(event.data);
  const attemptId = firstEventText(data.attemptId, data.attempt_id);
  const runId = firstEventText(data.runId, data.run_id);
  if (!attemptId && !runId) return null;
  return attemptId === attempt.attemptId
    || Boolean(runId && attempt.runId && runId === attempt.runId);
}

function occurredAfter(left: string | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}

function latestInputStartsNewTurn(
  event: HarnessEventRow | undefined,
  attempt: HarnessRunAttemptRecord,
): boolean {
  return Boolean(event && (
    userInputAttemptBinding(event, attempt) === false
    || occurredAfter(event.createdAt, attempt.finishedAt)
  ));
}

function chooseArtifactProjectionScope(
  attemptScopeId: string | undefined,
  lineageRootScopeId: string | null | undefined,
  terminalRootScopeId: string | undefined,
): string | undefined {
  return lineageRootScopeId || terminalRootScopeId || attemptScopeId;
}

/**
 * A harness session is a reusable conversation, not one run. Project the
 * latest durable attempt (or, for pre-attempt history, the latest user turn)
 * so an old completion/plan/document cannot leak into the active run card.
 */
function currentHarnessScope(sessionId: string): HarnessCurrentScope {
  const attempt = harnessGetLatestRunAttempt(sessionId);
  const latestInput = harnessListEvents(sessionId, {
    types: ['user_input_received'],
    desc: true,
    limit: 1,
  })[0];
  if (attempt) {
    const binding = userInputAttemptBinding(latestInput, attempt);
    // A completed attempt must never absorb a newer accepted turn. Future
    // inputs carry explicit attempt/run ids; the timestamp bound preserves
    // honest behavior for pre-upgrade rows that do not.
    if (latestInputStartsNewTurn(latestInput, attempt)) {
      return {
        attempt: null,
        query: { sinceSeq: Math.max(0, latestInput.seq - 1) },
        scopeKind: 'latest_turn',
        scopeStartedAt: latestInput.createdAt,
      };
    }
    if (latestInput && (binding === true || !occurredAfter(attempt.startedAt, latestInput.createdAt))) {
      return {
        attempt,
        query: { sinceSeq: Math.max(0, (attempt.sourceUserSeq ?? latestInput.seq) - 1) },
        runScopeId: brainRunScopeId(sessionId, attempt),
        scopeKind: 'current_attempt',
        scopeStartedAt: attempt.startedAt,
        attemptId: attempt.attemptId,
        sourceUserSeq: attempt.sourceUserSeq ?? undefined,
      };
    }
    return {
      attempt,
      query: { sinceAt: attempt.startedAt },
      runScopeId: brainRunScopeId(sessionId, attempt),
      scopeKind: 'current_attempt',
      scopeStartedAt: attempt.startedAt,
      attemptId: attempt.attemptId,
      sourceUserSeq: attempt.sourceUserSeq ?? undefined,
    };
  }
  if (latestInput) {
    return {
      attempt: null,
      query: { sinceSeq: Math.max(0, latestInput.seq - 1) },
      scopeKind: 'latest_turn',
      scopeStartedAt: latestInput.createdAt,
    };
  }
  return { attempt: null, query: {}, scopeKind: 'session_history' };
}

function scopedHarnessEvents(
  sessionId: string,
  scope: HarnessCurrentScope,
  options: Pick<HarnessListEventsOptions, 'types' | 'limit' | 'desc'> = {},
): HarnessEventRow[] {
  return harnessListEvents(sessionId, { ...scope.query, ...options });
}

function harnessRunControlProjection(
  sessionId: string,
  scope: HarnessCurrentScope,
  status: string,
  allowBackground = false,
): {
  canCancel: boolean;
  cancelEndpoint?: string;
  canBackground: boolean;
  backgroundEndpoint?: string;
} {
  const canCancel = scope.attempt?.status === 'active'
    && Boolean(scope.attemptId && scope.runScopeId)
    && ['running', 'awaiting_approval', 'awaiting_user_input'].includes(status);
  if (!canCancel || !scope.attemptId || !scope.runScopeId) return { canCancel: false, canBackground: false };
  const query = new URLSearchParams({
    attemptId: scope.attemptId,
    runScopeId: scope.runScopeId,
  });
  return {
    canCancel: true,
    cancelEndpoint: `/api/console/harness-sessions/${encodeURIComponent(sessionId)}/cancel?${query.toString()}`,
    canBackground: allowBackground && status === 'running',
    ...(allowBackground && status === 'running'
      ? { backgroundEndpoint: `/api/console/harness-sessions/${encodeURIComponent(sessionId)}/background?${query.toString()}` }
      : {}),
  };
}

function eventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsedEventRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return eventRecord(value);
  try { return eventRecord(JSON.parse(value)); } catch { return {}; }
}

function firstEventText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

interface ToolProjectionEvent {
  id?: string;
  type?: string;
  createdAt?: string;
  data?: Record<string, unknown>;
}

function projectedToolName(event: ToolProjectionEvent): string {
  const data = eventRecord(event.data);
  const args = parsedEventRecord(data.args ?? data.arguments ?? data.input);
  const nested = parsedEventRecord(args.arguments);
  return firstEventText(
    data.slug,
    data.toolSlug,
    args.tool_slug,
    args.toolSlug,
    nested.slug,
    data.tool,
    data.toolName,
    data.name,
  ) || 'tool';
}

/** Select one bounded, canonical tool milestone for live-state projection.
 * Transport mirrors are audit evidence, not another action. The sanitized
 * clone keeps only the display name so a 4s UI poll never returns a second
 * copy of potentially large tool arguments just to say "Working". */
function latestCanonicalToolMilestone<T extends ToolProjectionEvent>(events: T[]): T | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'tool_called') continue;
    if (eventRecord(event.data).accounting === 'transport_mirror') continue;
    return {
      ...event,
      data: {
        tool: projectedToolName(event),
        accounting: 'top_level',
      },
    } as T;
  }
  return undefined;
}

function projectScopedToolSummary(events: ToolProjectionEvent[]) {
  const calls = events.filter((event) => event.type === 'tool_called');
  const mirrors = calls.filter((event) => eventRecord(event.data).accounting === 'transport_mirror');
  const topLevel = calls.filter((event) => eventRecord(event.data).accounting !== 'transport_mirror');
  const logical = new Map<string, ToolProjectionEvent>();
  for (const [index, event] of topLevel.entries()) {
    const data = eventRecord(event.data);
    const canonical = firstEventText(
      data.canonicalCallId,
      data.logicalCallId,
      data.invocationId,
      data.callId,
    );
    // Missing IDs are not silently collapsed. Each durable event is one
    // conservative logical call, which cannot under-report a runaway.
    logical.set(canonical || `event:${event.id ?? index}`, event);
  }
  const counts = new Map<string, number>();
  for (const event of logical.values()) {
    const name = projectedToolName(event);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const countEntries = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return {
    names: countEntries.map((entry) => entry.name),
    countsByName: Object.fromEntries(countEntries.map((entry) => [entry.name, entry.count])),
    logicalCount: logical.size,
    recordedCalls: topLevel.length,
    mirrorEvents: mirrors.length,
  };
}

type ScopedToolSummary = ReturnType<typeof projectScopedToolSummary>;
const RUN_ENVIRONMENT_TOOL_CACHE_MAX = 128;
const runEnvironmentToolSummaryCache = new Map<string, {
  latestSeq: number;
  summary: ScopedToolSummary;
}>();

/** The open Environment rail polls every few seconds. Event rows are immutable,
 * so an unchanged latest sequence means repeatedly decoding a 135-call runaway
 * would be pure waste. Cache only the derived aggregate, scoped to the exact
 * attempt/turn boundary; any append or scope change recomputes truthfully. */
function cachedScopedToolSummary(
  sessionId: string,
  scope: HarnessCurrentScope,
  latestSeq: number,
): ScopedToolSummary {
  const scopeKey = scope.runScopeId
    ?? `${scope.scopeKind}:${scope.query.sinceSeq ?? ''}:${scope.query.sinceAt ?? ''}`;
  const key = `${sessionId}\0${scopeKey}`;
  const cached = runEnvironmentToolSummaryCache.get(key);
  if (cached?.latestSeq === latestSeq) {
    // Refresh insertion order so the cap behaves as a tiny LRU.
    runEnvironmentToolSummaryCache.delete(key);
    runEnvironmentToolSummaryCache.set(key, cached);
    return cached.summary;
  }
  const summary = projectScopedToolSummary(scopedHarnessEvents(sessionId, scope, { types: ['tool_called'] }));
  runEnvironmentToolSummaryCache.set(key, { latestSeq, summary });
  while (runEnvironmentToolSummaryCache.size > RUN_ENVIRONMENT_TOOL_CACHE_MAX) {
    const oldest = runEnvironmentToolSummaryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    runEnvironmentToolSummaryCache.delete(oldest);
  }
  return summary;
}

function terminalWasCancelled(event: HarnessEventRow | undefined): boolean {
  if (!event) return false;
  const data = eventRecord(event.data);
  return /cancel|reject|den(?:y|ied)|stopp?ed|abort/i.test(
    firstEventText(data.reason, data.status, data.decision, data.resolution, data.summary),
  );
}

function latestHarnessEvent(
  events: HarnessEventRow[],
  predicate: (event: HarnessEventRow) => boolean,
): HarnessEventRow | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return undefined;
}

function normalizeHostHeader(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!first) return '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end >= 0 ? first.slice(1, end) : first.replace(/^\[/, '');
  }
  return first.replace(/:\d+$/, '');
}

function isConfiguredMobileHost(req: express.Request): boolean {
  const host = normalizeHostHeader(req.headers.host);
  if (!host) return false;
  const mobileHost = readMobileAccess().tunnel?.hostname?.trim().toLowerCase() ?? '';
  return Boolean(mobileHost && host === mobileHost);
}

function requireMobileSurfaceForMobileHost(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!isConfiguredMobileHost(req)) {
    next();
    return;
  }
  if (req.path === '/m' || req.path.startsWith('/m/')) {
    next();
    return;
  }
  res.status(404).type('text/plain').send('Not found');
}

async function autoStartMobileTunnelIfConfigured(): Promise<void> {
  const access = readMobileAccess();
  if (!access.autoStart || !access.tunnel || access.tunnel.mode === 'quick') return;
  const { startTunnel } = await import('../integrations/mobile-access.js');
  const result = await startTunnel();
  if (!result.ok) {
    logger.warn({ error: result.error }, 'Mobile custom-domain tunnel auto-start failed');
  }
}

function effectiveHarnessStatus(
  session: HarnessSessionRow,
  events: HarnessEventRow[],
  attempt: HarnessRunAttemptRecord | null = null,
): string {
  // listEvents({ desc: true, limit }) selects the newest bounded window, then
  // returns that window in chronological order. Walk backward so a completion
  // after an approval wins and the desktop never resurrects stale state.
  let terminal: HarnessEventRow | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === 'conversation_completed'
      || event.type === 'run_completed'
      || event.type === 'run_failed'
      || event.type === 'approval_requested'
      || event.type === 'approval_resolved'
      || event.type === 'awaiting_user_input'
      || event.type === 'kill_requested'
      || event.type === 'run_paused'
      || event.type === 'run_resumed'
    ) {
      terminal = event;
      break;
    }
  }
  if (session.status === 'cancelled') return 'cancelled';
  if (attempt?.status === 'cancelled' || terminalWasCancelled(terminal)) return 'cancelled';
  if (attempt?.status === 'failed' || terminal?.type === 'run_failed') return 'failed';
  if (terminal?.type === 'kill_requested') return 'cancelled';
  if (terminal?.type === 'awaiting_user_input') return 'awaiting_user_input';
  if (terminal?.type === 'approval_requested') return 'awaiting_approval';
  if (terminal?.type === 'run_paused') return 'awaiting_approval';
  if (terminal?.type === 'conversation_completed' || terminal?.type === 'run_completed') return 'completed';
  if (attempt?.status === 'active') return 'running';
  if (attempt?.status === 'completed') return 'completed';
  if (attempt?.status === 'interrupted' || attempt?.status === 'superseded') return 'idle';
  if (session.status === 'paused') return 'awaiting_approval';
  if (session.status === 'active') {
    const updatedMs = Date.parse(session.updatedAt);
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs > 2 * 60_000) return 'idle';
    return 'running';
  }
  return session.status;
}

function computeHarnessSessionActivityRun(session: HarnessSessionRow, latestSeq: number) {
  const scope = currentHarnessScope(session.id);
  const activityEvents = scopedHarnessEvents(session.id, scope, {
    types: HARNESS_ACTIVITY_EVENT_TYPES,
    limit: 40,
    desc: true,
  });
  // One latest tool milestone is enough for Planning vs Working/liveLine. Do
  // not load up to 40 argument-heavy tool events for every row in a 4s poll.
  const latestTool = latestCanonicalToolMilestone(scopedHarnessEvents(session.id, scope, {
    types: ['tool_called'],
    // A production call can be followed by its MCP transport mirror. Keep the
    // lookup bounded while looking past that mirror to the actual action.
    limit: 16,
    desc: true,
  }));
  const events = [...activityEvents, ...(latestTool ? [latestTool] : [])]
    .sort((left, right) => left.seq - right.seq);
  const status = effectiveHarnessStatus(session, events, scope.attempt);
  const completion = latestHarnessEvent(events, (event) =>
    event.type === 'conversation_completed' || event.type === 'run_completed',
  );
  const latestInput = latestHarnessEvent(events, (event) => event.type === 'user_input_received');
  const latestInputData = eventRecord(latestInput?.data);
  const currentInput = firstEventText(latestInputData.displayText, latestInputData.text);
  const outputPreview = completionOutputPreview(completion);
  const control = harnessRunControlProjection(
    session.id,
    scope,
    status,
    supportsDesktopBackgroundHandoff(session),
  );
  return {
    id: session.id,
    sessionId: session.id,
    userId: session.userId ?? undefined,
    channel: session.channel ?? undefined,
    source: harnessSource(session),
    title: currentInput
      ? (currentInput.length > 100 ? `${currentInput.slice(0, 97)}...` : currentInput)
      : session.title || session.objective || (isDiscordHarnessSession(session) ? 'Discord conversation' : 'Clementine session'),
    input: currentInput || session.objective || session.title || '',
    status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: status === 'completed' ? session.updatedAt : undefined,
    outputPreview,
    runScopeId: scope.runScopeId,
    runEnvironmentMeta: {
      scopeKind: scope.scopeKind,
      runScopeId: scope.runScopeId,
      scopeStartedAt: scope.scopeStartedAt,
      latestSeq,
      attemptId: scope.attemptId,
      sourceUserSeq: scope.sourceUserSeq,
    },
    ...control,
    // listEvents already emits the selected window oldest-first, matching
    // legacy run timelines and the plan/helper state folders in the desktop.
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      message: harnessEventMessage(event),
      createdAt: event.createdAt,
      data: event.data,
    })),
  };
}

type HarnessActivityProjection = ReturnType<typeof computeHarnessSessionActivityRun>;
const HARNESS_ACTIVITY_CACHE_MAX = 256;
const harnessActivityProjectionCache = new Map<string, {
  version: string;
  run: HarnessActivityProjection;
}>();

/** `/api/runs` is polled as a safety net, but unchanged sessions should cost
 * one indexed latest-seq read—not five queries plus repeated JSON decoding.
 * Every append changes latestSeq; lifecycle-only session changes are covered by
 * status/updatedAt. The small LRU-like cap prevents long-lived daemon growth. */
function harnessSessionAsActivityRun(session: HarnessSessionRow): HarnessActivityProjection {
  const latestSeq = harnessGetLatestEventSeq(session.id);
  // Active sessions have a time-based idle projection even without new events.
  // Refresh that derived state twice a minute while still caching the hot poll.
  const freshnessBucket = session.status === 'active' ? Math.floor(Date.now() / 30_000) : 0;
  const version = `${session.status}:${session.updatedAt}:${latestSeq}:${freshnessBucket}`;
  const cached = harnessActivityProjectionCache.get(session.id);
  if (cached?.version === version) {
    harnessActivityProjectionCache.delete(session.id);
    harnessActivityProjectionCache.set(session.id, cached);
    return cached.run;
  }
  const run = computeHarnessSessionActivityRun(session, latestSeq);
  harnessActivityProjectionCache.set(session.id, { version, run });
  while (harnessActivityProjectionCache.size > HARNESS_ACTIVITY_CACHE_MAX) {
    const oldest = harnessActivityProjectionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    harnessActivityProjectionCache.delete(oldest);
  }
  return run;
}

/**
 * Decorate an activity run (legacy run-store record OR harness-session-derived
 * run) with the user-facing fields the Activity inbox renders. Additive only —
 * every original field is preserved, so older clients keep working.
 */
function enrichActivityRun<T extends ActivityRunLike>(run: T) {
  const runState = userFacingRunState(run);
  return {
    ...run,
    kindLabel: friendlyKindLabel(run),
    rawStatusLabel: friendlyStatusLabel(run.status),
    statusLabel: userFacingRunStateLabel(runState),
    runState,
    runStateLabel: userFacingRunStateLabel(runState),
    category: runFilterCategory(run),
    live: userFacingRunStateIsLive(runState),
    rawLive: isLive(run.status),
    liveLine: liveLine(run),
    preview: runPreview(run),
    needsAttention: run.needsAttention === true
      || runState === 'waiting_for_approval'
      || runState === 'waiting_for_input'
      || runState === 'stalled'
      || runState === 'failed',
  };
}

const CANCELLABLE_BACKGROUND_TASK_STATUSES = new Set([
  'pending',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_continue',
  'interrupted',
]);

/** `/api/runs` is a polling summary contract. Compute friendly state from the
 * event window server-side, then remove the raw audit array from every row. */
function compactActivityRunListRow<T extends ActivityRunLike>(run: T) {
  const { events: _events, ...summary } = enrichActivityRun(run);
  const existingCanCancel = (run as T & { canCancel?: unknown }).canCancel;
  if (typeof existingCanCancel === 'boolean') return summary;
  const ownTask = run.id?.startsWith('run-bg') ? getBackgroundTask(run.id.slice(4)) : null;
  const taskId = run.queuedTaskId ?? ownTask?.id;
  const task = taskId ? getBackgroundTask(taskId) : null;
  const canCancel = Boolean(task && CANCELLABLE_BACKGROUND_TASK_STATUSES.has(task.status));
  return {
    ...summary,
    canCancel,
    ...(canCancel && run.id ? { cancelEndpoint: `/api/runs/${encodeURIComponent(run.id)}/cancel` } : {}),
  };
}

/**
 * Detail variant — adds the clean milestone `timeline` and a `summary` block
 * (ask / result / error) for the reading pane, on top of the inbox fields. The
 * raw `events` array is preserved untouched for the "Technical details" toggle.
 */
function enrichActivityRunDetail<T extends ActivityRunLike>(run: T) {
  return {
    ...enrichActivityRun(run),
    timeline: friendlyTimeline(run.events),
    summary: {
      ask: String(run.input || run.objective || run.title || '').trim(),
      result: run.outputPreview ?? '',
      error: run.error ?? '',
    },
  };
}

/** Derive the live label from a tiny state-only milestone set while returning
 * the intentionally compact structural event projection. This prevents the
 * Environment view from saying "Planning" after a tool has started without
 * re-inflating its response with raw tool arguments. */
function enrichProjectedActivityRunDetail<T extends ActivityRunLike>(
  run: T,
  stateEvents: ActivityRunLike['events'],
) {
  const visibleEvents = run.events ?? [];
  const enriched = enrichActivityRunDetail({ ...run, events: stateEvents });
  return {
    ...enriched,
    events: visibleEvents,
    timeline: friendlyTimeline(visibleEvents),
  };
}

function workflowRunRecordAsActivityRun(
  rec: Record<string, unknown>,
  fallbackId?: string,
  options: { detail?: boolean; outputLimit?: number; preferFallbackId?: boolean; statusFallback?: string } = {},
): ActivityRunLike {
  const recordId = typeof rec.id === 'string' && rec.id.trim() ? rec.id : '';
  const fallback = fallbackId && fallbackId.trim() ? fallbackId : '';
  const id = options.preferFallbackId && fallback ? fallback : (recordId || fallback || 'workflow-run');
  const wfStatus = (rec.status as string | undefined) ?? options.statusFallback ?? 'queued';
  const workflowName = typeof rec.workflow === 'string' && rec.workflow.trim() ? rec.workflow.trim() : '';
  const outputLimit = options.outputLimit ?? 1200;
  return {
    id,
    sessionId: options.detail ? id : `workflow:${id}`,
    kind: 'workflow',
    channel: 'workflow',
    source: 'workflow',
    title: options.detail
      ? (workflowName || '(workflow run)')
      : (workflowName ? `Workflow: ${workflowName}` : 'Workflow run'),
    input: '',
    status: wfStatus,
    createdAt: rec.createdAt as string | undefined,
    updatedAt: (rec.finishedAt as string | undefined)
      ?? (rec.startedAt as string | undefined)
      ?? (options.detail ? undefined : rec.createdAt as string | undefined),
    completedAt: ['completed', 'failed', 'cancelled'].includes(wfStatus) ? (rec.finishedAt as string | undefined) : undefined,
    outputPreview: typeof rec.output === 'string' ? rec.output.slice(0, outputLimit) : '',
    error: typeof rec.error === 'string' ? rec.error : undefined,
    needsAttention: rec.needsAttention === true,
    events: [],
  };
}

function serializeMessageResponse(response: GatewayResponse): {
  response: string;
  session_id: string;
  run_id?: string;
  queued_task_id?: string;
  pending_approval_id?: string;
  stopped_reason?: string;
  turns_used?: number;
  route?: GatewayResponse['route'];
} {
  return {
    response: response.text,
    session_id: response.sessionId,
    run_id: response.runId,
    queued_task_id: response.queuedTaskId,
    pending_approval_id: response.pendingApprovalId,
    stopped_reason: response.stoppedReason,
    turns_used: response.turnsUsed,
    route: response.route,
  };
}

function resolveApiMessageSession(body: {
  session_id?: string;
  sessionId?: string;
  user_id?: string;
  userId?: string;
}): { sessionId: string; userId: string | undefined } {
  const userId = body.user_id ?? body.userId;
  return {
    sessionId: body.session_id ?? body.sessionId ?? `webhook:${userId ?? 'default'}`,
    userId,
  };
}

function deriveDashboardSessionToken(webhookSecret: string): string {
  if (!webhookSecret) return randomBytes(32).toString('base64url');
  // The cookie must survive a daemon restart, but must not expose or equal the
  // bearer secret. A domain-separated HMAC is stable for one installation and
  // naturally invalidates when the webhook secret rotates.
  return createHmac('sha256', webhookSecret)
    .update('clementine-dashboard-session:v1')
    .digest('base64url');
}

export const __test__ = {
  cancelTrackedRun,
  chooseArtifactProjectionScope,
  compactActivityRunListRow,
  completionOutputPreview,
  deriveDashboardSessionToken,
  effectiveHarnessStatus,
  enrichActivityRun,
  enrichActivityRunDetail,
  enrichProjectedActivityRunDetail,
  harnessRunControlProjection,
  latestInputStartsNewTurn,
  latestCanonicalToolMilestone,
  projectScopedToolSummary,
  resolveApiMessageSession,
  serializeMessageResponse,
  supportsDesktopBackgroundHandoff,
  workflowRunRecordAsActivityRun,
};

interface DashboardCronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function readConfiguredWorkspaceDirs(): string[] {
  const current = readEnvFile(path.join(BASE_DIR, '.env'));
  return (current.WORKSPACE_DIRS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function saveConfiguredWorkspaceDirs(dirs: string[]): void {
  const envPath = path.join(BASE_DIR, '.env');
  const current = readEnvFile(envPath);
  current.WORKSPACE_DIRS = dirs.join(',');
  writeEnvFile(envPath, current);
}

function saveCronJobs(jobs: DashboardCronJobRecord[]): void {
  mkdirSync(path.dirname(CRON_FILE), { recursive: true });
  const content = existsSync(CRON_FILE) ? readFileSync(CRON_FILE, 'utf-8') : '';
  const parsed = matter(content || '');
  parsed.data.jobs = jobs;
  writeFileSync(CRON_FILE, matter.stringify(parsed.content || '# Cron Jobs\n', parsed.data), 'utf-8');
}

function isValidCronSchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\d*/,\-A-Za-z?]+$/.test(field));
}

function discordRunMetadata(run: NonNullable<ReturnType<typeof getRun>>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    runId: run.id,
    sessionId: run.sessionId,
    userId: run.userId,
    channel: run.channel,
  };
  if (!run.channel?.startsWith('discord:')) return metadata;

  const parts = run.channel.split(':');
  const channelId = parts.length >= 3 ? parts[parts.length - 1] : '';
  if (channelId) metadata.discordChannelId = channelId;
  if (run.userId) metadata.discordUserId = run.userId;
  return metadata;
}

function buildRunUpdateBody(run: NonNullable<ReturnType<typeof getRun>>): string {
  const latest = run.events[run.events.length - 1];
  return [
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Title: ${run.title}`,
    run.queuedTaskId ? `Background task: ${run.queuedTaskId}` : '',
    run.pendingApprovalId ? `Approval: ${run.pendingApprovalId}` : '',
    run.error ? `Error: ${run.error}` : '',
    latest ? `Latest: ${latest.message}` : '',
    run.outputPreview ? `Output:\n${run.outputPreview.slice(0, 1200)}` : '',
  ].filter(Boolean).join('\n');
}

function queueRunRetry(run: NonNullable<ReturnType<typeof getRun>>) {
  const linkedTask = run.queuedTaskId ? getBackgroundTask(run.queuedTaskId) : null;
  const resumed = linkedTask && ['awaiting_continue', 'failed', 'aborted', 'interrupted'].includes(linkedTask.status)
    ? resumeBackgroundTask(linkedTask.id)
    : null;
  const task = resumed ?? createBackgroundTask({
    title: `Retry ${run.title}`,
    prompt: [
      `Retry run ${run.id}.`,
      run.outputPreview ? `Previous output:\n${run.outputPreview}` : '',
      run.error ? `Previous error:\n${run.error}` : '',
      '',
      'Original request:',
      run.input,
    ].filter(Boolean).join('\n\n'),
    originSessionId: run.sessionId,
    userId: run.userId,
    channel: run.channel,
    maxMinutes: 90,
    source: run.source ?? 'gateway',
  });

  const retryRun = startRun({
    id: `run-${task.id}`,
    sessionId: task.runSessionId,
    userId: task.userId,
    channel: task.channel,
    source: task.source,
    title: task.title,
    message: task.prompt,
  });
  finishRun(retryRun.id, {
    status: 'queued',
    message: `Queued background task ${task.id}.`,
    queuedTaskId: task.id,
    outputPreview: `Queued retry from ${run.id}.`,
  });
  addRunEvent(run.id, {
    type: 'status',
    message: `Retry queued as background task ${task.id}.`,
    data: {
      queuedTaskId: task.id,
      retryRunId: retryRun.id,
      resumedFromTaskId: task.resumedFromTaskId,
    },
  });
  return { task, retryRun };
}

interface CancelTrackedRunResult {
  ok: boolean;
  httpStatus: 200 | 404 | 409 | 500;
  message: string;
  runId: string;
  taskId?: string;
  taskStatus?: string;
}

/** Shared mutation behind the HTML dashboard action and the JSON desktop API. */
function cancelTrackedRun(id: string): CancelTrackedRunResult {
  const run = getRun(id);
  if (!run) return { ok: false, httpStatus: 404, message: `Run not found: ${id}`, runId: id };

  // The originating run may carry queuedTaskId; a background task's own run
  // uses id `run-<taskid>` and does not need that back-link.
  const ownTask = run.id.startsWith('run-') ? getBackgroundTask(run.id.slice(4)) : null;
  const taskId = run.queuedTaskId ?? ownTask?.id;
  if (!taskId) {
    return {
      ok: false,
      httpStatus: 409,
      message: `Run ${id} is not linked to a background task.`,
      runId: id,
    };
  }

  const task = getBackgroundTask(taskId);
  if (!task) {
    return {
      ok: false,
      httpStatus: 404,
      message: `Background task not found: ${taskId}`,
      runId: id,
      taskId,
    };
  }
  if (!CANCELLABLE_BACKGROUND_TASK_STATUSES.has(task.status)) {
    return {
      ok: false,
      httpStatus: 409,
      message: task.status === 'cancelling'
        ? `Background task ${task.id} is already cancelling.`
        : `Background task ${task.id} is already ${task.status}.`,
      runId: id,
      taskId,
      taskStatus: task.status,
    };
  }

  const cancelled = cancelBackgroundTask(task.id, 'Cancelled from the dashboard Run Control Center.');
  if (!cancelled) {
    return {
      ok: false,
      httpStatus: 500,
      message: `Unable to cancel background task ${task.id}.`,
      runId: id,
      taskId,
    };
  }

  const backgroundRunId = `run-${task.id}`;
  if (cancelled.status === 'cancelling') {
    addRunEvent(run.id, {
      type: 'status',
      status: 'running',
      message: `Cancellation requested for linked background task ${task.id}.`,
      data: { queuedTaskId: task.id },
    });
    if (backgroundRunId !== run.id) {
      addRunEvent(backgroundRunId, {
        type: 'status',
        status: 'running',
        message: `Cancellation requested for background task ${task.id}.`,
        data: { queuedTaskId: task.id },
      });
    }
  } else {
    finishRun(run.id, {
      status: 'cancelled',
      message: `Linked background task ${task.id} cancelled from the dashboard.`,
      queuedTaskId: task.id,
    });
    if (backgroundRunId !== run.id) {
      finishRun(backgroundRunId, {
        status: 'cancelled',
        message: `Background task ${task.id} cancelled from the dashboard.`,
        queuedTaskId: task.id,
      });
    }
  }

  return {
    ok: true,
    httpStatus: 200,
    message: cancelled.status === 'cancelling'
      ? `Cancellation requested for running background task ${task.id}.`
      : `Cancelled background task ${task.id}.`,
    runId: id,
    taskId: task.id,
    taskStatus: cancelled.status,
  };
}

async function resolveApprovalOrQueueBackgroundContinuation(
  assistant: ClementineAssistant,
  approvalId: string,
  approved: boolean,
) {
  const queued = queueBackgroundTaskApprovalResolution(approvalId, approved);
  if (queued) {
    return {
      approvalId,
      status: approved ? 'approved' as const : 'rejected' as const,
      sessionId: queued.runSessionId,
      text: `Queued background task continuation: ${queued.id}. The daemon will resume the paused SDK run.`,
      queuedTaskId: queued.id,
    };
  }
  return assistant.getRuntime().resolveApproval(approvalId, approved);
}

export async function startWebhookServer(assistant: ClementineAssistant): Promise<void> {
  const app = express();
  const dashboardSessionCookieName = 'clementine_dashboard_session';
  const dashboardSessionToken = deriveDashboardSessionToken(WEBHOOK_SECRET);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'none'",
        // 'self' (not 'none') so the console can embed an agent-authored
        // Workspace view in a same-origin iframe (gallery previews + the
        // full-bleed surface). Still blocks ALL cross-origin framing.
        "frame-ancestors 'self'",
        "object-src 'none'",
        // Allow remote app/toolkit logos (Composio CDN, etc.) to load. Loopback
        // Electron surface — images are inert; this just stops broken-logo icons.
        "img-src 'self' data: https:",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' https://api.openai.com wss://api.openai.com",
      ].join('; '),
    );
    next();
  });
  app.use(requireMobileSurfaceForMobileHost);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 1000 }));

  function buildConsoleRedirectPath(token: string, flash?: { kind: 'success' | 'error'; text: string }): string {
    const url = new URL('/console', 'http://localhost');
    void token;
    if (flash) {
      url.searchParams.set('flash', flash.kind);
      url.searchParams.set('message', flash.text);
    }
    const query = url.searchParams.toString();
    return query ? `${url.pathname}?${query}` : url.pathname;
  }

  function redirectDashboard(res: express.Response, token: string, flash?: { kind: 'success' | 'error'; text: string }): void {
    res.redirect(buildConsoleRedirectPath(token, flash));
  }

  function isAuthorized(req: express.Request): boolean {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionCookie = cookies[dashboardSessionCookieName] ?? '';
    return (Boolean(WEBHOOK_SECRET) && (safeEqual(bearer, WEBHOOK_SECRET) || safeEqual(queryToken, WEBHOOK_SECRET)))
      || safeEqual(sessionCookie, dashboardSessionToken);
  }

  function safeEqual(left: string, right: string): boolean {
    if (!left || !right) return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  function parseCookies(header: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index === -1) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) {
        try { cookies[key] = decodeURIComponent(value); }
        catch { cookies[key] = value; }
      }
    }
    return cookies;
  }

  function setDashboardSessionCookie(res: express.Response): void {
    res.cookie(dashboardSessionCookieName, dashboardSessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  app.get('/api/status', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // T2.1 — event-driven workflow recurrence over HTTP. An external service
  // POSTs here (Bearer WEBHOOK_SECRET or ?token=), and every enabled workflow
  // whose trigger.webhookPath matches :hookPath is queued through the standard
  // run queue — dedupe-key-once via the trigger registry, same-inputs dedupe
  // via queueWorkflowRun. 404 when nothing subscribes to the path.
  app.post('/api/hooks/workflows/:hookPath', requireAuth, (req, res) => {
    const hookPath = String(req.params.hookPath ?? '');
    // No daemon-liveness gate: fireWorkflowWebhook persists a durable receipt
    // and queues the run file even with the daemon down (standalone `clementine
    // webhook` mode runs this server with no daemon by design). Recovery on the
    // next daemon boot/tick drains anything still pending. Gating here dropped
    // every event for producers that never retry 5xx.
    let results;
    try {
      syncWorkflowTriggerRegistry(); // a hook may land before the next daemon tick
      results = fireWorkflowWebhook(hookPath, req.body ?? {});
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (results.length === 0) {
      res.status(404).json({ error: `No enabled workflow subscribes to webhook path "${hookPath}".` });
      return;
    }
    const disposition = workflowWebhookResponseDisposition(results);
    res.status(disposition.httpStatus).json({
      ok: disposition.ok,
      pending: disposition.pending,
      results,
    });
  });

  app.get('/api/daemon/status', requireAuth, (_req, res) => {
    res.json({
      daemon_state: readDaemonState(),
      recent_cron_runs: readRecentJsonLines(DASHBOARD_CRON_RUNS_DIR, 10),
      recent_workflow_runs: readWorkflowRuns(10),
      // Runtime flag introspection — surfaces the env-var values the
      // harness actually sees at runtime, so a Settings-UI edit can
      // be verified end-to-end (supervisor → daemon process.env).
      // Added 2026-05-24 after the env-injection fix landed; without
      // this there was no non-invasive way to confirm .env values
      // reached the daemon.
      runtime_flags: {
        HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS ?? null,
        CLEMMY_TOOL_GUARDRAIL: process.env.CLEMMY_TOOL_GUARDRAIL ?? null,
        CLEMMY_PREFLIGHT_GATE: process.env.CLEMMY_PREFLIGHT_GATE ?? null,
        CLEMMY_AUTO_COMPACT: process.env.CLEMMY_AUTO_COMPACT ?? null,
        HARNESS_SESSION_LOCK: process.env.HARNESS_SESSION_LOCK ?? null,
        OPENAI_MODEL_PRIMARY: process.env.OPENAI_MODEL_PRIMARY ?? null,
        AUTH_MODE: process.env.AUTH_MODE ?? null,
      },
    });
  });

  app.get('/api/dashboard', requireAuth, async (_req, res) => {
    res.json(await buildDashboardSnapshot());
  });

  app.get('/api/memory/status', requireAuth, (_req, res) => {
    res.json({ memory: readMemoryIndexStatus() });
  });

  app.post('/api/memory/reindex', requireAuth, (_req, res) => {
    try {
      const stats = rebuildVaultIndex();
      res.json({ ok: true, stats, memory: readMemoryIndexStatus() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/composio/status', requireAuth, async (_req, res) => {
    res.json(await getComposioRuntimeStatus());
  });

  app.get('/api/composio/toolkits', requireAuth, async (_req, res) => {
    try {
      res.json(await buildComposioDashboardSnapshot());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/api-key', requireAuth, async (req, res) => {
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key : '';
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id : undefined;
    try {
      // Validate FIRST so a typo'd / revoked key doesn't silently land in
      // .env (where it then poisons every downstream Composio call with
      // an empty connections list — the failure mode that drove this
      // check, observed 2026-05-23).
      const validation = await validateComposioApiKey(apiKey);
      if (validation.result === 'invalid') {
        res.status(400).json({
          error: validation.message ?? 'Composio rejected the API key.',
          validation: 'invalid',
        });
        return;
      }
      await saveComposioCredentials(apiKey, userId);
      bustComposioDashboardCaches();
      res.json({
        ok: true,
        status: getComposioCredentialStatus(),
        validation: validation.result,
        ...(validation.result === 'unknown' ? { warning: validation.message } : {}),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/backend', requireAuth, (req, res) => {
    const backend = typeof req.body.backend === 'string' ? req.body.backend : 'auto';
    try {
      const saved = saveComposioExecutionBackend(backend);
      res.json({ ok: true, backend: saved });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/toolkits/:slug/authorize', requireAuth, async (req, res) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const authorized = await authorizeToolkit(slug);
      bustComposioDashboardCaches();
      res.json(authorized);
    } catch (error) {
      if (error instanceof ComposioNeedsAuthConfigError) {
        res.status(409).json({
          error: error.message,
          needsAuthConfig: true,
          toolkit: slug,
          setupUrl: COMPOSIO_AUTH_CONFIGS_URL,
        });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), toolkit: slug });
    }
  });

  app.post('/api/composio/toolkits/:slug/disconnect', requireAuth, async (req, res) => {
    const connectionId = typeof req.body.connectionId === 'string'
      ? req.body.connectionId
      : typeof req.body.connection_id === 'string'
        ? req.body.connection_id
        : '';
    if (!connectionId) {
      res.status(400).json({ error: 'connectionId required in body' });
      return;
    }
    try {
      await disconnectToolkit(connectionId);
      bustComposioDashboardCaches();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/refresh', requireAuth, (_req, res) => {
    resetComposioClient();
    bustComposioDashboardCaches();
    res.json({ ok: true });
  });

  // Attach (or CLEAR, when label is empty) the user's memory label for one
  // connected account — the desktop-UI path into the SAME account-alias store
  // the agent already reads for mailbox routing ("send from my work mailbox").
  // connectionId in the URL; toolkit + label (+ optional email) in the body.
  // Passing the account's email from the connections snapshot binds the label to
  // the stable mailbox identity so it survives re-auth.
  app.post('/api/composio/accounts/:connectionId/label', requireAuth, (req, res) => {
    const connectionId = Array.isArray(req.params.connectionId) ? req.params.connectionId[0] : req.params.connectionId;
    const toolkit = typeof req.body?.toolkit === 'string' ? req.body.toolkit : '';
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const email = typeof req.body?.email === 'string' ? req.body.email : undefined;
    if (!connectionId || !toolkit) {
      res.status(400).json({ error: 'connectionId (url) and toolkit (body) are required' });
      return;
    }
    try {
      const saved = setAccountLabel({ toolkit, label, email, connectionId });
      bustComposioDashboardCaches();
      res.json({ ok: true, label: saved?.label ?? null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Setup metadata for the Clementine-native modal — exposes the
  // toolkit's per-field descriptions + the right "where do I get
  // my API key" link. Lets the modal render guidance instead of
  // a generic "API key" prompt that leaves the user hunting for
  // where to get the key (real ux feedback from 2026-05-21).
  app.get('/api/composio/toolkits/:slug/setup-meta', requireAuth, async (req, res) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const meta = await getToolkitSetupMeta(slug);
      if (!meta) {
        res.status(404).json({ error: 'toolkit not found or Composio not configured' });
        return;
      }
      res.json(meta);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Bypass route for API_KEY-mode toolkits whose Composio hosted popup
  // throws "Something went wrong" (firecrawl, apify, ...). Front-end
  // collects the API key in a Clementine-native modal and POSTs here;
  // we create both the auth_config and the per-user connection via
  // Composio's REST API directly.
  app.post('/api/composio/toolkits/:slug/setup-api-key', requireAuth, async (req, res) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : '';
    if (!slug || !apiKey) {
      res.status(400).json({ error: 'slug + apiKey required' });
      return;
    }
    try {
      const result = await setupApiKeyToolkit(slug, apiKey, baseUrl || undefined);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // OAuth2 auto-setup. Creates a `use_composio_managed_auth` config
  // for OAUTH2 toolkits where Composio offers managed credentials
  // (gmail, slack, github, notion, etc.). After this returns, the
  // existing /authorize flow can run and Composio's OAuth window will
  // load properly. Without this preflight, /authorize bounces the
  // user to "Something went wrong" because there's no auth_config.
  app.post('/api/composio/toolkits/:slug/setup-oauth', requireAuth, async (req, res) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    if (!slug) {
      res.status(400).json({ error: 'slug required' });
      return;
    }
    try {
      const result = await setupOAuthToolkit(slug);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/tool-preferences', requireAuth, async (_req, res) => {
    const prefs = loadToolPreferences();
    const composio = await buildComposioDashboardSnapshot();
    const composioSlugs = new Set(composio.connected
      .filter((connection) => connection.status === 'ACTIVE')
      .map((connection) => connection.slug));
    const activeMcp = new Set(discoverMcpServers()
      .filter((server) => server.enabled)
      .map((server) => server.name));
    const availability = computeAvailability(composioSlugs, activeMcp, prefs.preferences);
    res.json({
      preferences: prefs.preferences,
      services: availability.map((item) => ({
        id: item.service.id,
        label: item.service.label,
        composio: item.service.composioSlug ? { slug: item.service.composioSlug, available: item.composioAvailable } : null,
        mcp: item.service.mcpServerNames?.length ? { names: item.service.mcpServerNames, available: item.mcpAvailable } : null,
        hasConflict: item.hasConflict,
        effective: item.effective,
      })),
    });
  });

  app.put('/api/tool-preferences', requireAuth, (req, res) => {
    const incoming = (req.body as { preferences?: Record<string, string> } | undefined)?.preferences;
    if (!incoming || typeof incoming !== 'object') {
      res.status(400).json({ error: 'preferences (object) required in body' });
      return;
    }
    const knownIds = new Set(KNOWN_SERVICES.map((service) => service.id));
    const preferences: Record<string, ToolSource> = {};
    for (const [id, source] of Object.entries(incoming)) {
      if (!knownIds.has(id)) continue;
      if (source === 'composio' || source === 'mcp' || source === 'off') preferences[id] = source;
    }
    saveToolPreferences({ preferences });
    res.json({ ok: true, preferences });
  });

  app.get('/api/notifications', requireAuth, (req, res) => {
    // limit is capped to the command-center's 300-notification window so a
    // Home-card deep link (/inbox?select=<id>) can always find its target —
    // the feed reads 300 but this route returned only 50, stranding older
    // anchors with an empty detail pane.
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 300) : 50;
    res.json({ notifications: listNotifications(limit) });
  });

  app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const notification = markNotificationRead(id);
    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ ok: true, notification });
  });

  app.post('/api/notifications/:id/retry', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    requeueNotificationDelivery(id);
    res.json({ ok: true });
  });

  app.get('/api/notifications/destinations', requireAuth, (_req, res) => {
    res.json({ destinations: listNotificationDestinations() });
  });

  app.get('/api/notifications/doctor', requireAuth, (_req, res) => {
    try {
      res.json(buildNotificationDoctor({
        destinations: listNotificationDestinations(),
        notifications: listNotifications(300),
        discord: getDiscordRuntimeStatus(),
        slack: getSlackRuntimeStatus(),
        config: {
          discordAllowedUsers: DISCORD_DM_ALLOWED_USERS,
          discordAllowedChannels: DISCORD_ALLOWED_CHANNELS,
          slackAllowedUsers: SLACK_ALLOWED_USERS,
          slackAllowedChannels: SLACK_ALLOWED_CHANNELS,
          slackProactiveChannel: SLACK_PROACTIVE_CHANNEL || undefined,
        },
      }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/notifications/acceptance/run', requireAuth, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { live?: unknown };
      const report = await runChannelAcceptance({
        destinations: listNotificationDestinations(),
        live: body.live !== false,
        deliver: testNotificationDestination,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/notifications/destinations', requireAuth, (req, res) => {
    const body = req.body as {
      name?: string;
      url?: string;
      enabled?: boolean;
      type?: NotificationDestination['type'];
      channel_id?: string;
      guild_id?: string;
      user_id?: string;
    };
    const type = body.type === 'discord_webhook'
      || body.type === 'discord_channel'
      || body.type === 'discord_user'
      || body.type === 'slack_webhook'
      || body.type === 'slack_channel'
      || body.type === 'slack_user'
      || body.type === 'generic_webhook'
      ? body.type
      : 'generic_webhook';
    if (!body.name) {
      res.status(400).json({ error: 'Missing name' });
      return;
    }
    if ((type === 'generic_webhook' || type === 'discord_webhook' || type === 'slack_webhook') && !body.url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    if ((type === 'discord_channel' || type === 'slack_channel') && !body.channel_id) {
      res.status(400).json({ error: 'Missing channel_id' });
      return;
    }
    if ((type === 'discord_user' || type === 'slack_user') && !body.user_id) {
      res.status(400).json({ error: 'Missing user_id' });
      return;
    }
    upsertNotificationDestination({
      id: randomUUID(),
      name: body.name,
      url: body.url,
      channelId: body.channel_id,
      guildId: body.guild_id,
      userId: body.user_id,
      type,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  app.post('/api/notifications/destinations/:id/test', requireAuth, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destination = listNotificationDestinations().find((entry) => entry.id === id);
    if (!destination) {
      res.status(404).json({ error: 'Destination not found' });
      return;
    }
    try {
      await testNotificationDestination(destination);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // JSON enable/disable + delete (the new console SPA consumes these instead
  // of the /dashboard/actions/* redirect endpoints, which return HTML and
  // ignore the request body). PATCH SETS enabled from the body (idempotent).
  app.patch('/api/notifications/destinations/:id', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destination = listNotificationDestinations().find((entry) => entry.id === id);
    if (!destination) { res.status(404).json({ error: 'Destination not found' }); return; }
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    upsertNotificationDestination({ ...destination, enabled: enabled === true });
    res.json({ ok: true, enabled: enabled === true });
  });

  app.delete('/api/notifications/destinations/:id', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    removeNotificationDestination(id);
    res.json({ ok: true });
  });

  // /console is the primary UI surface. /dashboard remains only as a
  // compatibility redirect for stale bookmarks and older local installs.
  app.get('/console', (req, res, next) => {
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (!WEBHOOK_SECRET || !safeEqual(queryToken, WEBHOOK_SECRET)) {
      next();
      return;
    }
    setDashboardSessionCookie(res);
    const url = new URL('/console', 'http://localhost');
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'token') continue;
      if (typeof value === 'string') url.searchParams.set(key, value);
    }
    const query = url.searchParams.toString();
    res.redirect(302, query ? `${url.pathname}?${query}` : url.pathname);
  });
  // New React/Vite console (apps/console-web), behind a flag. When on
  // and built, it answers GET /console; the legacy string console stays
  // reachable at /console-legacy. Registered *before* the legacy routes
  // so its /console handler wins. If the flag is off — or the bundle
  // isn't built — /console falls through to the legacy renderer.
  const consoleNext = isConsoleNextEnabled();
  // Workspaces ("Spaces") — agent-authored interactive surfaces. MUST register
  // BEFORE the console SPA: its /console/* deep-link fallback would otherwise
  // intercept GET /console/spaces/:id/view and serve the React index instead
  // of the agent-authored view.
  registerSpaceRoutes(app, isAuthorized);
  const consoleSpaServed = consoleNext && registerConsoleSpaRoutes(app, isAuthorized);
  registerConsoleRoutes(app, isAuthorized, assistant, { serveLegacyAtRoot: !consoleSpaServed });
  app.use('/m', createMobileRouter({ isAdminAuthorized: isAuthorized, assistant }));

  app.get('/dashboard', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const url = new URL('/console', 'http://localhost');
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'token') continue;
      if (typeof value === 'string') {
        url.searchParams.set(key, value);
      }
    }
    const query = url.searchParams.toString();
    res.redirect(302, query ? `${url.pathname}?${query}` : url.pathname);
  });

  app.post('/dashboard/actions/composio/api-key', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id.trim() : undefined;
    try {
      const validation = await validateComposioApiKey(apiKey);
      if (validation.result === 'invalid') {
        redirectDashboard(res, token, { kind: 'error', text: validation.message ?? 'Composio rejected the API key.' });
        return;
      }
      await saveComposioCredentials(apiKey, userId);
      bustComposioDashboardCaches();
      const msg = validation.result === 'unknown'
        ? `Saved, but ${validation.message ?? 'could not confirm with Composio'}.`
        : 'Composio API key saved. You can connect app toolkits now.';
      redirectDashboard(res, token, { kind: 'success', text: msg });
    } catch (error) {
      redirectDashboard(res, token, { kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/dashboard/actions/openai/api-key', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
    if (!apiKey) {
      redirectDashboard(res, token, { kind: 'error', text: 'OpenAI capability key is required for this optional feature.' });
      return;
    }
    const envPath = path.join(BASE_DIR, '.env');
    const current = readEnvFile(envPath);
    current.OPENAI_API_KEY = apiKey;
    writeEnvFile(envPath, current);
    process.env.OPENAI_API_KEY = apiKey;
    redirectDashboard(res, token, { kind: 'success', text: 'OpenAI capability key saved for semantic memory embeddings and live voice.' });
  });

  app.post('/dashboard/actions/openai/clear-api-key', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const envPath = path.join(BASE_DIR, '.env');
    const current = readEnvFile(envPath);
    current.OPENAI_API_KEY = '';
    writeEnvFile(envPath, current);
    delete process.env.OPENAI_API_KEY;
    redirectDashboard(res, token, { kind: 'success', text: 'OpenAI capability key cleared. Codex OAuth runtime is unchanged; memory will use FTS-only recall.' });
  });

  app.post('/dashboard/actions/composio/connect', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const slug = typeof req.body.slug === 'string' ? req.body.slug.trim() : '';
    if (!slug) {
      redirectDashboard(res, token, { kind: 'error', text: 'Toolkit slug is required.' });
      return;
    }
    try {
      const result = await authorizeToolkit(slug);
      if (result.redirectUrl) {
        res.redirect(result.redirectUrl);
        return;
      }
      redirectDashboard(res, token, { kind: 'success', text: `Composio connection started for ${slug}.` });
    } catch (error) {
      const text = error instanceof ComposioNeedsAuthConfigError
        ? `${error.message} Open ${COMPOSIO_AUTH_CONFIGS_URL}, then try again.`
        : error instanceof Error ? error.message : String(error);
      redirectDashboard(res, token, { kind: 'error', text });
    }
  });

  app.post('/dashboard/actions/composio/disconnect', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const connectionId = typeof req.body.connection_id === 'string' ? req.body.connection_id.trim() : '';
    if (!connectionId) {
      redirectDashboard(res, token, { kind: 'error', text: 'Connection ID is required.' });
      return;
    }
    try {
      await disconnectToolkit(connectionId);
      redirectDashboard(res, token, { kind: 'success', text: 'Composio connection disconnected.' });
    } catch (error) {
      redirectDashboard(res, token, { kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/dashboard/actions/composio/refresh', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    resetComposioClient();
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token, { kind: 'success', text: 'Composio cache refreshed.' });
  });

  app.post('/dashboard/actions/tool-preferences', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const preferences: Record<string, ToolSource> = {};
    for (const service of KNOWN_SERVICES) {
      const value = req.body[`pref_${service.id}`];
      if (value === 'composio' || value === 'mcp' || value === 'off') preferences[service.id] = value;
    }
    saveToolPreferences({ preferences });
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token, { kind: 'success', text: 'Tool preferences saved.' });
  });

  app.post('/dashboard/actions/discord/setup', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const botToken = typeof req.body.bot_token === 'string' ? req.body.bot_token.trim() : '';
    if (!botToken) {
      redirectDashboard(res, token, { kind: 'error', text: 'Discord bot token is required.' });
      return;
    }

    try {
      const installInfo = await fetchDiscordInstallInfo(botToken);
      if (!installInfo) {
        redirectDashboard(res, token, { kind: 'error', text: 'Discord bot lookup returned no application data.' });
        return;
      }

      const envPath = path.join(BASE_DIR, '.env');
      const current = readEnvFile(envPath);
      current.DISCORD_ENABLED = 'true';
      current.DISCORD_BOT_TOKEN = botToken;
      current.DISCORD_CLIENT_ID = installInfo.clientId;
      if (!current.DISCORD_REQUIRE_MENTION) current.DISCORD_REQUIRE_MENTION = 'true';
      writeEnvFile(envPath, current);

      redirectDashboard(res, token, {
        kind: 'success',
        text: `Discord bot saved for ${installInfo.appName ?? installInfo.clientId}. Use the install link below, then restart the daemon or Discord service.`,
      });
    } catch (error) {
      logger.error({ err: error }, 'Discord dashboard setup failed');
      redirectDashboard(res, token, {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/dashboard/actions/trigger-cron', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const jobName = typeof req.body.job_name === 'string' ? req.body.job_name : '';
    if (jobName) {
      mkdirSync(CRON_TRIGGERS_DIR, { recursive: true });
      writeFileSync(path.join(CRON_TRIGGERS_DIR, `${Date.now()}-${jobName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), JSON.stringify({ jobName, triggeredAt: new Date().toISOString() }, null, 2), 'utf-8');
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/run-workflow', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    if (name) {
      const workflow = loadWorkflows().find((entry) => entry.name === name);
      if (!workflow || !workflow.enabled || workflow.trigger.manual === false) {
        res.status(400).send('Workflow is not runnable from the dashboard.');
        return;
      }
      queueWorkflowRun(name, {}, { source: 'dashboard', dedupe: false });
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/memory/rebuild-index', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    try {
      const stats = rebuildVaultIndex();
      redirectDashboard(res, token, {
        kind: stats.errors > 0 ? 'error' : 'success',
        text: `Memory index rebuilt: ${stats.inserted} chunks from ${stats.scanned} files (${stats.errors} errors).`,
      });
    } catch (error) {
      redirectDashboard(res, token, { kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/dashboard/actions/memory/embed-backfill', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    try {
      const maxChunksRaw = typeof req.body.max_chunks === 'string' ? Number.parseInt(req.body.max_chunks, 10) : 200;
      const maxChunks = Number.isFinite(maxChunksRaw) ? Math.max(1, Math.min(maxChunksRaw, 1000)) : 200;
      const stats = await embedMissingChunks({ maxChunks });
      if (!stats.enabled) {
        redirectDashboard(res, token, { kind: 'error', text: stats.reason ?? 'Embeddings are disabled. Add the optional OpenAI capability key first.' });
        return;
      }
      redirectDashboard(res, token, {
        kind: stats.failed > 0 ? 'error' : 'success',
        text: `Embedding backfill complete: ${stats.embedded}/${stats.candidateChunks} chunks embedded (${stats.failed} failed).`,
      });
    } catch (error) {
      redirectDashboard(res, token, { kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/dashboard/actions/workspaces/add', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const rawDirectory = typeof req.body.directory === 'string' ? req.body.directory.trim() : '';
    if (!rawDirectory) {
      redirectDashboard(res, token, { kind: 'error', text: 'Workspace directory is required.' });
      return;
    }

    const directory = path.resolve(expandHome(rawDirectory));
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      redirectDashboard(res, token, { kind: 'error', text: `Workspace directory does not exist: ${directory}` });
      return;
    }

    const dirs = readConfiguredWorkspaceDirs()
      .map((entry) => path.resolve(expandHome(entry)));
    if (!dirs.includes(directory)) dirs.push(directory);
    saveConfiguredWorkspaceDirs(dirs);
    redirectDashboard(res, token, { kind: 'success', text: `Workspace added: ${directory}` });
  });

  app.post('/dashboard/actions/workspaces/remove', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const rawDirectory = typeof req.body.directory === 'string' ? req.body.directory.trim() : '';
    if (!rawDirectory) {
      redirectDashboard(res, token, { kind: 'error', text: 'Workspace directory is required.' });
      return;
    }
    const directory = path.resolve(expandHome(rawDirectory));
    const dirs = readConfiguredWorkspaceDirs()
      .map((entry) => path.resolve(expandHome(entry)))
      .filter((entry) => entry !== directory);
    saveConfiguredWorkspaceDirs(dirs);
    redirectDashboard(res, token, { kind: 'success', text: `Workspace removed: ${directory}` });
  });

  app.post('/dashboard/actions/cron/create', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const schedule = typeof req.body.schedule === 'string' ? req.body.schedule.trim() : '';
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    const rawWorkDir = typeof req.body.work_dir === 'string' ? req.body.work_dir.trim() : '';
    const mode = req.body.mode === 'unleashed' ? 'unleashed' : 'standard';
    if (!name || !schedule || !prompt) {
      redirectDashboard(res, token, { kind: 'error', text: 'Scheduled task name, schedule, and prompt are required.' });
      return;
    }
    if (!isValidCronSchedule(schedule)) {
      redirectDashboard(res, token, { kind: 'error', text: 'Schedule must be a five-field cron expression, such as */30 * * * *.' });
      return;
    }
    const workDir = rawWorkDir ? path.resolve(expandHome(rawWorkDir)) : undefined;
    if (workDir && (!existsSync(workDir) || !statSync(workDir).isDirectory())) {
      redirectDashboard(res, token, { kind: 'error', text: `Work directory does not exist: ${workDir}` });
      return;
    }
    const jobs = loadCronJobs().filter((job) => job.name !== name) as DashboardCronJobRecord[];
    jobs.push({
      name,
      schedule,
      prompt,
      enabled: true,
      mode,
      ...(workDir ? { work_dir: workDir } : {}),
    });
    saveCronJobs(jobs);
    redirectDashboard(res, token, { kind: 'success', text: `Scheduled task saved: ${name}` });
  });

  app.post('/dashboard/actions/proactivity-policy', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    try {
      const policy = saveProactivityPolicy({
        enabled: req.body.enabled === 'on',
        mode: req.body.mode === 'watch' || req.body.mode === 'hands_on' ? req.body.mode : 'balanced',
        checkInMinutes: typeof req.body.check_in_minutes === 'string' ? req.body.check_in_minutes : undefined,
        briefCadenceMinutes: typeof req.body.brief_cadence_minutes === 'string' ? req.body.brief_cadence_minutes : undefined,
        defaultLongTaskMinutes: typeof req.body.default_long_task_minutes === 'string' ? req.body.default_long_task_minutes : undefined,
        maxConcurrentBackgroundTasks: typeof req.body.max_concurrent_background_tasks === 'string' ? req.body.max_concurrent_background_tasks : undefined,
        quietHoursEnabled: req.body.quiet_hours_enabled === 'on',
        quietHoursStart: typeof req.body.quiet_hours_start === 'string' ? req.body.quiet_hours_start : undefined,
        quietHoursEnd: typeof req.body.quiet_hours_end === 'string' ? req.body.quiet_hours_end : undefined,
        allowDiscordCheckIns: req.body.allow_discord_checkins === 'on',
        allowComposioActions: req.body.allow_composio_actions === 'on',
        allowComputerActions: req.body.allow_computer_actions === 'on',
        requireWorkflowApprovalForExecution: req.body.require_workflow_approval_for_execution === 'on',
      });
      redirectDashboard(res, token, {
        kind: 'success',
        text: `Autonomy policy saved: ${policy.mode}, check-ins every ${policy.checkInMinutes} minutes, briefs every ${policy.briefCadenceMinutes} minutes.`,
      });
    } catch (error) {
      redirectDashboard(res, token, { kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/dashboard/actions/background/create', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    const maxMinutesRaw = typeof req.body.max_minutes === 'string' ? Number.parseInt(req.body.max_minutes, 10) : 90;
    const maxMinutes = Number.isFinite(maxMinutesRaw) ? Math.max(5, Math.min(maxMinutesRaw, 240)) : 90;
    if (!prompt) {
      redirectDashboard(res, token, { kind: 'error', text: 'A long-task prompt is required.' });
      return;
    }

    const task = createBackgroundTask({
      title: title || prompt,
      prompt,
      channel: 'dashboard',
      maxMinutes,
      source: 'webhook',
    });
    const run = startRun({
      id: `run-${task.id}`,
      sessionId: task.runSessionId,
      channel: task.channel,
      source: task.source,
      title: task.title,
      message: task.prompt,
    });
    finishRun(run.id, {
      status: 'queued',
      message: `Queued dashboard background task ${task.id}.`,
      queuedTaskId: task.id,
      outputPreview: `Queued from dashboard. Soft max runtime: ${task.maxMinutes} minutes.`,
    });
    redirectDashboard(res, token, { kind: 'success', text: `Background task queued: ${task.id}.` });
  });

  app.post('/dashboard/actions/runs/:id/cancel', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = cancelTrackedRun(id);
    redirectDashboard(res, token, {
      kind: result.ok ? 'success' : 'error',
      text: result.message,
    });
  });

  /** JSON-native control contract for the desktop. Unlike the historical
   * redirect action, failures remain non-2xx after fetch redirect handling. */
  app.post('/api/runs/:id/cancel', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = cancelTrackedRun(id);
    res.status(result.httpStatus).json(result.ok
      ? { ok: true, message: result.message, runId: result.runId, taskId: result.taskId, taskStatus: result.taskStatus }
      : { ok: false, error: result.message, runId: result.runId, taskId: result.taskId, taskStatus: result.taskStatus });
  });

  app.post('/dashboard/actions/runs/:id/retry', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = getRun(id);
    if (!run) {
      redirectDashboard(res, token, { kind: 'error', text: `Run not found: ${id}` });
      return;
    }

    const { task } = queueRunRetry(run);
    redirectDashboard(res, token, { kind: 'success', text: `Retry queued as background task ${task.id}.` });
  });

  app.post('/dashboard/actions/runs/:id/notify', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = getRun(id);
    if (!run) {
      redirectDashboard(res, token, { kind: 'error', text: `Run not found: ${id}` });
      return;
    }
    const metadata = discordRunMetadata(run);
    if (!metadata.discordChannelId && !metadata.discordUserId) {
      redirectDashboard(res, token, { kind: 'error', text: `Run ${id} is not linked to a Discord channel or user.` });
      return;
    }

    const notificationId = `${Date.now()}-run-${run.id}-update`;
    addNotification({
      id: notificationId,
      kind: 'execution',
      title: `Run update: ${run.title}`,
      body: buildRunUpdateBody(run),
      createdAt: new Date().toISOString(),
      read: false,
      metadata,
    });
    addRunEvent(run.id, {
      type: 'status',
      message: 'Dashboard update queued for Discord delivery.',
      data: { notificationId },
    });
    redirectDashboard(res, token, { kind: 'success', text: `Queued Discord update for run ${run.id}.` });
  });

  app.post('/dashboard/actions/approve', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = typeof req.body.id === 'string' ? req.body.id : '';
    if (id) {
      try {
        await resolveApprovalOrQueueBackgroundContinuation(assistant, id, true);
      } catch (err) {
        logger.error({ err, id }, 'Dashboard approve failed');
      }
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/reject', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = typeof req.body.id === 'string' ? req.body.id : '';
    if (id) {
      try {
        await resolveApprovalOrQueueBackgroundContinuation(assistant, id, false);
      } catch (err) {
        logger.error({ err, id }, 'Dashboard reject failed');
      }
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/:id/read', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    markNotificationRead(id);
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/:id/retry', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    requeueNotificationDelivery(id);
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/destinations', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    const channelId = typeof req.body.channel_id === 'string' ? req.body.channel_id.trim() : '';
    const guildId = typeof req.body.guild_id === 'string' ? req.body.guild_id.trim() : '';
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id.trim() : '';
    const type = req.body.type === 'discord_webhook'
      ? 'discord_webhook'
      : req.body.type === 'discord_channel'
        ? 'discord_channel'
        : req.body.type === 'discord_user'
          ? 'discord_user'
          : req.body.type === 'slack_webhook'
            ? 'slack_webhook'
            : req.body.type === 'slack_channel'
              ? 'slack_channel'
              : req.body.type === 'slack_user'
                ? 'slack_user'
                : 'generic_webhook';
    if (
      name &&
      (
        ((type === 'generic_webhook' || type === 'discord_webhook' || type === 'slack_webhook') && url) ||
        ((type === 'discord_channel' || type === 'slack_channel') && channelId) ||
        ((type === 'discord_user' || type === 'slack_user') && userId)
      )
    ) {
      upsertNotificationDestination({
        id: randomUUID(),
        name,
        url: url || undefined,
        channelId: channelId || undefined,
        guildId: guildId || undefined,
        userId: userId || undefined,
        type,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/destinations/:id/test', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destination = listNotificationDestinations().find((entry) => entry.id === id);
    if (destination) {
      try {
        await testNotificationDestination(destination);
      } catch (err) {
        logger.error({ err, id }, 'Destination test failed');
      }
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/destinations/:id/toggle', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destination = listNotificationDestinations().find((entry) => entry.id === id);
    if (destination) {
      upsertNotificationDestination({
        ...destination,
        enabled: !destination.enabled,
      });
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/dashboard/actions/notifications/destinations/:id/delete', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    removeNotificationDestination(id);
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    redirectDashboard(res, token);
  });

  app.post('/api/message', requireAuth, async (req, res) => {
    const body = req.body as {
      text?: string;
      session_id?: string;
      sessionId?: string;
      user_id?: string;
      userId?: string;
      model?: string;
    };

    if (!body.text) {
      res.status(400).json({ error: 'Missing "text" field' });
      return;
    }

    const { sessionId, userId } = resolveApiMessageSession(body);

    try {
      const response = await new ClementineGateway(assistant).handleMessage({
        message: body.text,
        sessionId,
        userId,
        channel: 'webhook',
        model: body.model,
        source: 'webhook',
      });

      res.json(serializeMessageResponse(response));
    } catch (err) {
      logger.error({ err }, 'Webhook /api/message failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/approvals/:id/approve', requireAuth, async (req, res) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await resolveApprovalOrQueueBackgroundContinuation(assistant, id, true);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Webhook approval approve failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/approvals/:id/reject', requireAuth, async (req, res) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await resolveApprovalOrQueueBackgroundContinuation(assistant, id, false);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Webhook approval reject failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/approvals', requireAuth, (_req, res) => {
    res.json({
      approvals: assistant.getRuntime().listPendingApprovals(),
      harnessApprovals: approvalRegistry.listPending({ status: 'pending' }),
    });
  });

  app.get('/api/runs', requireAuth, (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 30;
    const resolvedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(120, limit)) : 30;
    const legacyRuns = listRuns(Math.max(resolvedLimit, 40));
    const harnessRuns = harnessListSessions({ limit: Math.max(30, Math.min(120, resolvedLimit * 2)) })
      .filter(isActivityVisibleHarnessSession)
      .map(harnessSessionAsActivityRun);
    // Dedup: a chat can produce BOTH a harness session (sess-…) and a legacy
    // run record sharing the same sessionId. Prefer the harness session (it
    // carries the richer event timeline) and drop the duplicate legacy row so
    // the same conversation never shows twice in the inbox.
    const harnessSessionIds = new Set(harnessRuns.map((run) => run.sessionId || run.id));
    const dedupedLegacy = legacyRuns.filter((run) => !harnessSessionIds.has(run.sessionId));
    // Workflow runs queued via the API exist only as workflows/runs/<id>.json
    // until the runner starts them (which upserts a legacy run with the SAME
    // id). Surface those file records so a queued/orphaned workflow run is
    // visible in the inbox too — deduped by id against runs already collected.
    const knownIds = new Set([...harnessRuns, ...dedupedLegacy].map((run) => run.id));
    const workflowFileRuns = readWorkflowRuns(Math.max(resolvedLimit, 40))
      .filter((rec) => typeof rec.id === 'string' && !knownIds.has(rec.id as string))
      .map((rec) => workflowRunRecordAsActivityRun(rec, rec.id as string));
    const runs = [...harnessRuns, ...dedupedLegacy, ...workflowFileRuns]
      .sort((left, right) =>
        String(right.updatedAt || right.completedAt || right.createdAt || '')
          .localeCompare(String(left.updatedAt || left.completedAt || left.createdAt || '')),
      )
      .slice(0, resolvedLimit)
      .map(compactActivityRunListRow);
    res.json({ runs });
  });

  app.get('/api/runs/:id', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const environmentView = req.query.view === 'environment';
    const sendHarnessRun = (): boolean => {
      const session = harnessGetSession(id);
      if (!session) return false;
      const scope = currentHarnessScope(id);
      const statusEvents = scopedHarnessEvents(id, scope, {
        types: HARNESS_STATUS_EVENT_TYPES,
        limit: 40,
        desc: true,
      });
      const status = effectiveHarnessStatus(session, statusEvents, scope.attempt);
      const completion = latestHarnessEvent(statusEvents, (event) =>
        event.type === 'conversation_completed' || event.type === 'run_completed',
      );
      const latestInput = latestHarnessEvent(statusEvents, (event) => event.type === 'user_input_received');
      const latestInputData = eventRecord(latestInput?.data);
      const currentInput = firstEventText(latestInputData.displayText, latestInputData.text);
      const outputPreview = completionOutputPreview(completion);
      const auditEventsTotal = harnessCountMatchingEvents(id, scope.query);
      const latestSeq = harnessGetLatestEventSeq(id);

      let scopedArtifacts: ReturnType<typeof listRunArtifacts> = [];
      let artifactRootScopeId: string | undefined;
      let artifactCoverageStatus: 'available' | 'unavailable' = 'available';
      try {
        // Never attach another turn's documents to a reusable chat. Old
        // pre-attempt sessions remain explicitly labelled session_history.
        const terminalArtifactRoot = firstEventText(eventRecord(completion?.data).artifactRunScopeId);
        artifactRootScopeId = scope.runScopeId
          ? chooseArtifactProjectionScope(
            scope.runScopeId,
            getArtifactRunScope(id, scope.runScopeId)?.rootScopeId,
            terminalArtifactRoot,
          )
          : undefined;
        scopedArtifacts = artifactRootScopeId
          ? listRunArtifacts(id, artifactRootScopeId)
          : scope.scopeKind === 'session_history'
            ? listRunArtifacts(id)
            : [];
      } catch {
        artifactCoverageStatus = 'unavailable';
        scopedArtifacts = [];
      }
      const artifacts = scopedArtifacts.slice(-24);

      const projectionTotal = environmentView
        ? harnessCountMatchingEvents(id, { ...scope.query, types: RUN_ENVIRONMENT_PROJECTION_TYPES })
        : auditEventsTotal;
      const events = environmentView
        ? scopedHarnessEvents(id, scope, {
          types: RUN_ENVIRONMENT_PROJECTION_TYPES,
          limit: 160,
          desc: true,
        })
        : scopedHarnessEvents(id, scope, { limit: 500, desc: true });
      const latestStateTool = environmentView
        ? latestCanonicalToolMilestone(scopedHarnessEvents(id, scope, {
          types: ['tool_called'],
          limit: 16,
          desc: true,
        }))
        : undefined;
      const toolSummary = environmentView
        ? cachedScopedToolSummary(id, scope, latestSeq)
        : undefined;
      const control = harnessRunControlProjection(
        id,
        scope,
        status,
        supportsDesktopBackgroundHandoff(session),
      );
      const runEnvironmentMeta = {
        scopeKind: scope.scopeKind,
        runScopeId: scope.runScopeId,
        attemptScopeId: scope.runScopeId,
        artifactRootScopeId,
        attemptId: scope.attemptId,
        sourceUserSeq: scope.sourceUserSeq,
        scopeStartedAt: scope.scopeStartedAt,
        latestSeq,
        auditEventsTotal,
        projectionEventsTotal: projectionTotal,
        projectionEventsReturned: events.length,
        projectionEventsOmitted: Math.max(0, projectionTotal - events.length),
        artifactsTotal: scopedArtifacts.length,
        artifactsReturned: artifacts.length,
        artifactsOmitted: Math.max(0, scopedArtifacts.length - artifacts.length),
        artifactCoverageStatus,
      };
      const asActivityEvent = (event: HarnessEventRow) => ({
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
        data: event.data,
        message: harnessEventMessage(event),
      });
      const projectedEvents = events.map(asActivityEvent);
      const stateEvents = latestStateTool
        ? [...events, latestStateTool]
          .sort((left, right) => left.seq - right.seq)
          .map(asActivityEvent)
        : projectedEvents;
      const runProjection = {
        id,
        sessionId: id,
        kind: ((session as { kind?: unknown }).kind ?? 'harness') as string,
        channel: ((session as { channel?: unknown }).channel ?? undefined) as string | undefined,
        source: harnessSource(session),
        title: currentInput
          ? (currentInput.length > 100 ? `${currentInput.slice(0, 97)}...` : currentInput)
          : ((session as { title?: unknown }).title ?? '(Clementine session)') as string,
        input: currentInput || ((session as { objective?: unknown }).objective ?? '') as string,
        objective: currentInput || ((session as { objective?: unknown }).objective ?? undefined) as string | undefined,
        metadata: (session as { metadata?: Record<string, unknown> }).metadata,
        status,
        outputPreview,
        createdAt: (session as { createdAt?: unknown }).createdAt as string | undefined,
        updatedAt: (session as { updatedAt?: unknown }).updatedAt as string | undefined,
        completedAt: status === 'completed' ? (session as { updatedAt?: unknown }).updatedAt as string | undefined : undefined,
        runScopeId: scope.runScopeId,
        runEnvironmentMeta,
        toolSummary,
        ...control,
        artifacts,
        // Keep `data` so the clean timeline can name tools/steps; `message`
        // is the pre-rendered friendly line for the raw view. The environment
        // contract stays structural even when stateEvents contains one
        // sanitized tool milestone used only to derive Working/liveLine.
        events: projectedEvents,
      };
      res.json({
        run: environmentView
          ? enrichProjectedActivityRunDetail(runProjection, stateEvents)
          : enrichActivityRunDetail(runProjection),
      });
      return true;
    };

    // A chat can have both a harness session and a legacy run record with the
    // same id. The list endpoint already prefers harness; detail must do the
    // same for every valid id shape (sess-*, space-*, discord:*, background:*).
    try {
      if (sendHarnessRun()) return;
    } catch (err) {
      // Fall through to legacy/fallback lookups below.
    }

    // Legacy run-store lookup first (run-xxx IDs).
    const run = getRun(id);
    if (run) {
      const sessionId = run.sessionId?.trim();
      const attempt = sessionId
        ? harnessGetLatestRunAttemptByRunId(sessionId, run.id)
        : null;
      const attemptScopeId = sessionId && attempt ? brainRunScopeId(sessionId, attempt) : undefined;
      let artifactRootScopeId: string | undefined;
      let scopedArtifacts: ReturnType<typeof listRunArtifacts> = [];
      let artifactCoverageStatus: 'available' | 'unavailable' = 'available';
      try {
        if (sessionId && attemptScopeId) {
          artifactRootScopeId = chooseArtifactProjectionScope(
            attemptScopeId,
            getArtifactRunScope(sessionId, attemptScopeId)?.rootScopeId,
            undefined,
          );
          scopedArtifacts = listRunArtifacts(sessionId, artifactRootScopeId);
        }
      } catch {
        artifactCoverageStatus = 'unavailable';
        scopedArtifacts = [];
      }
      const artifacts = scopedArtifacts.slice(-24);
      const ownTask = run.id.startsWith('run-') ? getBackgroundTask(run.id.slice(4)) : null;
      const linkedTaskId = run.queuedTaskId ?? ownTask?.id;
      const linkedTask = linkedTaskId ? getBackgroundTask(linkedTaskId) : null;
      const canCancel = Boolean(linkedTask && CANCELLABLE_BACKGROUND_TASK_STATUSES.has(linkedTask.status));
      const control = {
        canCancel,
        ...(canCancel ? { cancelEndpoint: `/api/runs/${encodeURIComponent(run.id)}/cancel` } : {}),
      };
      if (environmentView) {
        const rawEvents = Array.isArray(run.events) ? run.events : [];
        const structuralEvents = rawEvents.filter((event) => [
          'plan_drafted', 'step_started', 'step_completed', 'step_verified', 'step_failed',
          'worker_started', 'worker_result', 'worker_completed', 'worker_failed', 'handoff',
        ].includes(event.type));
        const projected = structuralEvents.slice(-160);
        const latestStateTool = latestCanonicalToolMilestone(rawEvents);
        const stateEvents = latestStateTool
          ? [...projected, latestStateTool].sort((left, right) =>
            String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')),
          )
          : projected;
        const compactRun = {
          ...run,
          events: projected,
          artifacts,
          runScopeId: attemptScopeId,
          toolSummary: projectScopedToolSummary(rawEvents),
          ...control,
          runEnvironmentMeta: {
            scopeKind: attempt ? 'current_attempt' : 'session_history',
            runScopeId: attemptScopeId,
            attemptScopeId,
            artifactRootScopeId,
            attemptId: attempt?.attemptId,
            scopeStartedAt: attempt?.startedAt,
            latestSeq: sessionId ? harnessGetLatestEventSeq(sessionId) : 0,
            auditEventsTotal: rawEvents.length,
            projectionEventsTotal: structuralEvents.length,
            projectionEventsReturned: projected.length,
            projectionEventsOmitted: Math.max(0, structuralEvents.length - projected.length),
            artifactsTotal: scopedArtifacts.length,
            artifactsReturned: artifacts.length,
            artifactsOmitted: Math.max(0, scopedArtifacts.length - artifacts.length),
            artifactCoverageStatus,
          },
        };
        res.json({ run: enrichProjectedActivityRunDetail(compactRun, stateEvents) });
      } else {
        res.json({ run: enrichActivityRunDetail({
          ...run,
          artifacts,
          runScopeId: attemptScopeId,
          artifactRootScopeId,
          artifactCoverageStatus,
          ...control,
        }) });
      }
      return;
    }
    // Fallback — workflow run record at workflows/runs/<runId>.json.
    try {
      const runPath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
      if (existsSync(runPath)) {
        const wfRun = JSON.parse(readFileSync(runPath, 'utf-8')) as Record<string, unknown>;
        res.json({ run: enrichActivityRunDetail(workflowRunRecordAsActivityRun(wfRun, id, {
          detail: true,
          outputLimit: 2000,
          preferFallbackId: true,
          statusFallback: 'unknown',
        })) });
        return;
      }
    } catch (err) {
      // Fallback lookups are best-effort.
    }
    res.status(404).json({ error: 'Run not found' });
  });

  app.get('/api/runs/:id/events', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = getRun(id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    let events = run.events;
    if (after) {
      const index = events.findIndex((event) => event.id === after);
      events = index >= 0 ? events.slice(index + 1) : events;
    } else if (since) {
      events = events.filter((event) => event.createdAt > since);
    }
    res.json({
      run: {
        id: run.id,
        status: run.status,
        updatedAt: run.updatedAt,
        outputPreview: run.outputPreview,
        error: run.error,
      },
      events,
    });
  });

  await new Promise<void>((resolve, reject) => {
    if (!isLoopbackWebhookHost(WEBHOOK_HOST)) {
      if (!WEBHOOK_ALLOW_LAN) {
        reject(new Error(`Refusing to bind webhook server to ${WEBHOOK_HOST}. Set WEBHOOK_ALLOW_LAN=true to opt in.`));
        return;
      }
      if (!WEBHOOK_SECRET_IS_STRONG) {
        reject(new Error('Refusing LAN webhook bind because WEBHOOK_SECRET is missing, weak, or placeholder-like.'));
        return;
      }
    }
    const server = app.listen(WEBHOOK_PORT, WEBHOOK_HOST, () => {
      logger.info({ host: WEBHOOK_HOST, port: WEBHOOK_PORT }, 'Webhook server listening');
      resolve();
    });
    server.on('error', (error) => {
      reject(error);
    });
  });
  void autoStartMobileTunnelIfConfigured().catch((err) => {
    logger.warn({ err }, 'Mobile custom-domain tunnel auto-start failed');
  });
}
