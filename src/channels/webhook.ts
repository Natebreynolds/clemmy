import express from 'express';
import pino from 'pino';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { ClementineAssistant } from '../assistant/core.js';
import {
  BASE_DIR,
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
  getSession as harnessGetSession,
  listEvents as harnessListEvents,
  listSessions as harnessListSessions,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import { registerConsoleRoutes } from '../dashboard/console-routes.js';
import { isConsoleNextEnabled, registerConsoleSpaRoutes } from '../dashboard/console-spa.js';
import { registerSpaceRoutes } from '../dashboard/space-routes.js';
import { isSpacesEnabled } from '../spaces/store.js';
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
import { testNotificationDestination } from '../runtime/notification-delivery.js';
import { fetchDiscordInstallInfo } from './discord-install.js';
import { readEnvFile, writeEnvFile } from '../setup/env-file.js';
import {
  authorizeToolkit,
  buildComposioDashboardSnapshot,
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
import { ClementineGateway } from '../gateway/router.js';
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

function effectiveHarnessStatus(session: HarnessSessionRow, events: HarnessEventRow[]): string {
  // Both callers pass events newest-first (desc), so the MOST RECENT terminal
  // event must win — e.g. a run that requested approval and then completed is
  // 'completed', not stuck on 'awaiting_approval'. (Previously this reversed to
  // oldest-first under a misleading name and returned the stale state.)
  const newestFirst = events;
  const terminal = newestFirst.find((event) =>
    event.type === 'conversation_completed'
    || event.type === 'run_completed'
    || event.type === 'run_failed'
    || event.type === 'approval_requested',
  );
  if (terminal?.type === 'run_failed') return 'failed';
  if (terminal?.type === 'approval_requested') return 'awaiting_approval';
  if (terminal?.type === 'conversation_completed' || terminal?.type === 'run_completed') return 'completed';
  if (session.status === 'paused') return 'awaiting_approval';
  if (session.status === 'active') {
    const updatedMs = Date.parse(session.updatedAt);
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs > 2 * 60_000) return 'idle';
    return 'running';
  }
  return session.status;
}

function harnessSessionAsActivityRun(session: HarnessSessionRow) {
  const events = harnessListEvents(session.id, { limit: 80, desc: true });
  const status = effectiveHarnessStatus(session, events);
  // events are newest-first (desc), so find() returns the MOST RECENT
  // completion — i.e. the latest reply/summary, not the first one.
  const completion = events.find((event) =>
    event.type === 'conversation_completed' || event.type === 'run_completed',
  );
  const outputPreview = completionOutputPreview(completion);
  return {
    id: session.id,
    sessionId: session.id,
    userId: session.userId ?? undefined,
    channel: session.channel ?? undefined,
    source: harnessSource(session),
    title: session.title || session.objective || (isDiscordHarnessSession(session) ? 'Discord conversation' : 'Clementine session'),
    input: session.objective || session.title || '',
    status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: status === 'completed' ? session.updatedAt : undefined,
    outputPreview,
    // Harness events are fetched newest-first; emit them oldest-first so the
    // timeline and liveLine match legacy runs (which are appended in order).
    events: events.slice().reverse().map((event) => ({
      id: event.id,
      type: event.type,
      message: harnessEventMessage(event),
      createdAt: event.createdAt,
      data: event.data,
    })),
  };
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

export const __test__ = {
  completionOutputPreview,
  enrichActivityRun,
  enrichActivityRunDetail,
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
  const dashboardSessionToken = randomBytes(32).toString('base64url');

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
      res.json(await authorizeToolkit(slug));
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
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/refresh', requireAuth, (_req, res) => {
    resetComposioClient();
    res.json({ ok: true });
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
    const type = body.type === 'discord_webhook' || body.type === 'discord_channel' || body.type === 'discord_user'
      ? body.type
      : 'generic_webhook';
    if (!body.name) {
      res.status(400).json({ error: 'Missing name' });
      return;
    }
    if ((type === 'generic_webhook' || type === 'discord_webhook') && !body.url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    if (type === 'discord_channel' && !body.channel_id) {
      res.status(400).json({ error: 'Missing channel_id' });
      return;
    }
    if (type === 'discord_user' && !body.user_id) {
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
  // Workspaces ("Spaces") — agent-authored interactive surfaces. Additive,
  // flag-gated (CLEMENTINE_SPACES, default off). MUST register BEFORE the
  // console SPA: its /console/* deep-link fallback would otherwise intercept
  // GET /console/spaces/:id/view and serve the React index instead of the
  // agent-authored view.
  if (isSpacesEnabled()) registerSpaceRoutes(app, isAuthorized);
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
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
      writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({ id, workflow: name, status: 'queued', createdAt: new Date().toISOString() }, null, 2), 'utf-8');
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
    const run = getRun(id);
    if (!run) {
      redirectDashboard(res, token, { kind: 'error', text: `Run not found: ${id}` });
      return;
    }
    // Resolve the background task either from the originating run's link, or
    // from the run id itself when this IS a background task's own run
    // (id `run-<taskid>`, which carries no queuedTaskId).
    const ownTask = run.id.startsWith('run-') ? getBackgroundTask(run.id.slice(4)) : null;
    const taskId = run.queuedTaskId ?? ownTask?.id;
    if (!taskId) {
      redirectDashboard(res, token, { kind: 'error', text: `Run ${id} is not linked to a background task.` });
      return;
    }

    const task = getBackgroundTask(taskId);
    if (!task) {
      redirectDashboard(res, token, { kind: 'error', text: `Background task not found: ${run.queuedTaskId}` });
      return;
    }
    if (!['pending', 'running', 'awaiting_approval', 'interrupted'].includes(task.status)) {
      redirectDashboard(res, token, {
        kind: 'error',
        text: task.status === 'cancelling'
          ? `Background task ${task.id} is already cancelling.`
          : `Background task ${task.id} is already ${task.status}.`,
      });
      return;
    }

    const cancelled = cancelBackgroundTask(task.id, 'Cancelled from the dashboard Run Control Center.');
    if (!cancelled) {
      redirectDashboard(res, token, { kind: 'error', text: `Unable to cancel background task ${task.id}.` });
      return;
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
    }
    if (backgroundRunId !== run.id && cancelled.status !== 'cancelling') {
      finishRun(backgroundRunId, {
        status: 'cancelled',
        message: `Background task ${task.id} cancelled from the dashboard.`,
        queuedTaskId: task.id,
      });
    }
    redirectDashboard(res, token, {
      kind: 'success',
      text: cancelled.status === 'cancelling'
        ? `Cancellation requested for running background task ${task.id}.`
        : `Cancelled background task ${task.id}.`,
    });
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
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id.trim() : '';
    const type = req.body.type === 'discord_webhook'
      ? 'discord_webhook'
      : req.body.type === 'discord_channel'
        ? 'discord_channel'
        : req.body.type === 'discord_user'
          ? 'discord_user'
        : 'generic_webhook';
    if (
      name &&
      (
        ((type === 'generic_webhook' || type === 'discord_webhook') && url) ||
        (type === 'discord_channel' && channelId) ||
        (type === 'discord_user' && userId)
      )
    ) {
      upsertNotificationDestination({
        id: randomUUID(),
        name,
        url: url || undefined,
        channelId: channelId || undefined,
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
      user_id?: string;
      model?: string;
    };

    if (!body.text) {
      res.status(400).json({ error: 'Missing "text" field' });
      return;
    }

    const sessionId = body.session_id ?? `webhook:${body.user_id ?? 'default'}`;

    try {
      const response = await new ClementineGateway(assistant).handleMessage({
        message: body.text,
        sessionId,
        userId: body.user_id,
        channel: 'webhook',
        model: body.model,
        source: 'webhook',
      });

      res.json({
        response: response.text,
        session_id: response.sessionId,
        run_id: response.runId,
        queued_task_id: response.queuedTaskId,
        pending_approval_id: response.pendingApprovalId,
      });
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
    const harnessRuns = harnessListSessions({ limit: Math.max(resolvedLimit, 80) })
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
      .map(enrichActivityRun);
    res.json({ runs });
  });

  app.get('/api/runs/:id', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Legacy run-store lookup first (run-xxx IDs).
    const run = getRun(id);
    if (run) {
      res.json({ run: enrichActivityRunDetail(run) });
      return;
    }
    // Fallback A — harness session (sess-xxx IDs).
    try {
      if (id.startsWith('sess-')) {
        const session = harnessGetSession(id);
        if (session) {
          const events = harnessListEvents(id, { limit: 500, desc: true }) ?? [];
          const status = effectiveHarnessStatus(session, events);
          // Most-recent reply/summary for the reading pane "Result" block
          // (events are newest-first, so find() returns the latest).
          const completion = events.find((event) =>
            event.type === 'conversation_completed' || event.type === 'run_completed',
          );
          const outputPreview = completionOutputPreview(completion);
          res.json({ run: enrichActivityRunDetail({
            id,
            sessionId: id,
            kind: ((session as { kind?: unknown }).kind ?? 'harness') as string,
            channel: ((session as { channel?: unknown }).channel ?? undefined) as string | undefined,
            source: harnessSource(session),
            title: ((session as { title?: unknown }).title ?? '(Clementine session)') as string,
            objective: ((session as { objective?: unknown }).objective ?? undefined) as string | undefined,
            metadata: (session as { metadata?: Record<string, unknown> }).metadata,
            status,
            outputPreview,
            createdAt: (session as { createdAt?: unknown }).createdAt as string | undefined,
            updatedAt: (session as { updatedAt?: unknown }).updatedAt as string | undefined,
            completedAt: status === 'completed' ? (session as { updatedAt?: unknown }).updatedAt as string | undefined : undefined,
            // Keep `data` so the clean timeline can name tools/steps; `message`
            // is the pre-rendered friendly line for the raw view. Reverse to
            // oldest-first (events are fetched newest-first via desc).
            events: events.slice().reverse().map((ev) => ({
              id: (ev as { id?: unknown }).id as string | undefined,
              type: (ev as { type?: unknown }).type as string | undefined,
              createdAt: (ev as { createdAt?: unknown }).createdAt as string | undefined,
              data: (ev as { data?: Record<string, unknown> }).data,
              message: harnessEventMessage(ev),
            })),
          }) });
          return;
        }
      }
      // Fallback B — workflow run record at workflows/runs/<runId>.json.
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
}
