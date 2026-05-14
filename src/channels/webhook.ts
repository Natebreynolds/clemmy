import express from 'express';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { ClementineAssistant } from '../assistant/core.js';
import { BASE_DIR, WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';
import { DASHBOARD_CRON_RUNS_DIR, buildDashboardSnapshot, loadCronJobs, loadWorkflows, readDaemonState, readRecentJsonLines, readWorkflowRuns } from '../dashboard/state.js';
import { renderDashboardHtml } from '../dashboard/page.js';
import { registerConsoleRoutes } from '../dashboard/console-routes.js';
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
import { getAuthStatus } from '../runtime/auth-store.js';
import { fetchDiscordInstallInfo } from './discord-install.js';
import { readEnvFile, writeEnvFile } from '../setup/env-file.js';
import {
  authorizeToolkit,
  buildComposioDashboardSnapshot,
  ComposioNeedsAuthConfigError,
  disconnectToolkit,
  getComposioCredentialStatus,
  resetComposioClient,
  saveComposioCredentials,
} from '../integrations/composio/client.js';
import { computeAvailability, KNOWN_SERVICES, loadToolPreferences, saveToolPreferences, type ToolSource } from '../integrations/tool-preferences.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { ClementineGateway } from '../gateway/router.js';
import { addRunEvent, finishRun, getRun, listRuns, startRun } from '../runtime/run-events.js';
import { readMemoryIndexStatus, rebuildVaultIndex } from '../memory/indexer.js';
import { embedMissingChunks } from '../memory/embeddings.js';
import { CRON_FILE } from '../memory/vault.js';
import { cancelBackgroundTask, createBackgroundTask, getBackgroundTask, resumeBackgroundTask } from '../execution/background-tasks.js';
import { saveProactivityPolicy } from '../agents/proactivity-policy.js';

const logger = pino({ name: 'clementine-next.webhook' });
const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

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
  const resumed = linkedTask && ['failed', 'aborted', 'interrupted'].includes(linkedTask.status)
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

export async function startWebhookServer(assistant: ClementineAssistant): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  function redirectDashboard(res: express.Response, token: string, flash?: { kind: 'success' | 'error'; text: string }): void {
    const url = new URL('/dashboard', 'http://localhost');
    url.searchParams.set('token', token);
    if (flash) {
      url.searchParams.set('flash', flash.kind);
      url.searchParams.set('message', flash.text);
    }
    res.redirect(`${url.pathname}?${url.searchParams.toString()}`);
  }

  function isAuthorized(req: express.Request): boolean {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    return Boolean(WEBHOOK_SECRET) && (bearer === WEBHOOK_SECRET || queryToken === WEBHOOK_SECRET);
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
      auth: getAuthStatus(),
      daemon_state_present: Object.keys(readDaemonState()).length > 0,
    });
  });

  app.get('/api/daemon/status', requireAuth, (_req, res) => {
    res.json({
      daemon_state: readDaemonState(),
      recent_cron_runs: readRecentJsonLines(DASHBOARD_CRON_RUNS_DIR, 10),
      recent_workflow_runs: readWorkflowRuns(10),
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

  app.get('/api/composio/status', requireAuth, (_req, res) => {
    res.json(getComposioCredentialStatus());
  });

  app.get('/api/composio/toolkits', requireAuth, async (_req, res) => {
    try {
      res.json(await buildComposioDashboardSnapshot());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/composio/api-key', requireAuth, (req, res) => {
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key : '';
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id : undefined;
    try {
      saveComposioCredentials(apiKey, userId);
      res.json({ ok: true, status: getComposioCredentialStatus() });
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
          setupUrl: 'https://platform.composio.dev/auth-configs',
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

  app.get('/api/notifications', requireAuth, (_req, res) => {
    res.json({ notifications: listNotifications(50) });
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

  // /console — new parallel dashboard surface. Coexists with /dashboard;
  // own visual language and growing surface area (workflows, memory
  // navigator, project picker, etc.). See src/dashboard/console.ts.
  registerConsoleRoutes(app, isAuthorized, assistant);

  app.get('/dashboard', async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const flashKind = req.query.flash === 'success' || req.query.flash === 'error' ? req.query.flash : undefined;
    const flashText = typeof req.query.message === 'string' ? req.query.message : '';
    res.type('html').send(await renderDashboardHtml(
      assistant.getRuntime().listPendingApprovals(),
      queryToken,
      flashKind && flashText ? { kind: flashKind, text: flashText } : undefined,
    ));
  });

  app.post('/dashboard/actions/composio/api-key', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
    const userId = typeof req.body.user_id === 'string' ? req.body.user_id.trim() : undefined;
    try {
      saveComposioCredentials(apiKey, userId);
      redirectDashboard(res, token, { kind: 'success', text: 'Composio API key saved. You can connect app toolkits now.' });
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
      redirectDashboard(res, token, { kind: 'error', text: 'OpenAI API key is required.' });
      return;
    }
    const envPath = path.join(BASE_DIR, '.env');
    const current = readEnvFile(envPath);
    current.OPENAI_API_KEY = apiKey;
    writeEnvFile(envPath, current);
    process.env.OPENAI_API_KEY = apiKey;
    redirectDashboard(res, token, { kind: 'success', text: 'OpenAI API key saved for semantic memory embeddings.' });
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
    redirectDashboard(res, token, { kind: 'success', text: 'OpenAI API key cleared. Memory will use FTS-only recall.' });
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
        ? `${error.message} Open https://platform.composio.dev/auth-configs, then try again.`
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
        redirectDashboard(res, token, { kind: 'error', text: stats.reason ?? 'Embeddings are disabled. Add OPENAI_API_KEY first.' });
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
    if (!run.queuedTaskId) {
      redirectDashboard(res, token, { kind: 'error', text: `Run ${id} is not linked to a background task.` });
      return;
    }

    const task = getBackgroundTask(run.queuedTaskId);
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
        await assistant.getRuntime().resolveApproval(id, true);
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
        await assistant.getRuntime().resolveApproval(id, false);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
      const result = await assistant.getRuntime().resolveApproval(id, true);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Webhook approval approve failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/approvals/:id/reject', requireAuth, async (req, res) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await assistant.getRuntime().resolveApproval(id, false);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Webhook approval reject failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/approvals', requireAuth, (_req, res) => {
    res.json({ approvals: assistant.getRuntime().listPendingApprovals() });
  });

  app.get('/api/runs', requireAuth, (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 30;
    res.json({ runs: listRuns(Number.isFinite(limit) ? limit : 30) });
  });

  app.get('/api/runs/:id', requireAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = getRun(id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ run });
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
    const server = app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
      logger.info({ port: WEBHOOK_PORT }, 'Webhook server listening');
      resolve();
    });
    server.on('error', (error) => {
      reject(error);
    });
  });
}
