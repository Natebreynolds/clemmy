import express from 'express';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClementineAssistant } from '../assistant/core.js';
import { BASE_DIR, WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';
import { DASHBOARD_CRON_RUNS_DIR, buildDashboardSnapshot, loadWorkflows, readDaemonState, readRecentJsonLines, readWorkflowRuns } from '../dashboard/state.js';
import { renderDashboardHtml } from '../dashboard/page.js';
import {
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

const logger = pino({ name: 'clementine-next.webhook' });
const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

export async function startWebhookServer(assistant: ClementineAssistant): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

  app.get('/api/dashboard', requireAuth, (_req, res) => {
    res.json(buildDashboardSnapshot());
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

  app.get('/dashboard', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.type('html').send(renderDashboardHtml(assistant.getRuntime().listPendingApprovals(), queryToken));
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
  });

  app.post('/dashboard/actions/notifications/:id/read', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    markNotificationRead(id);
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
  });

  app.post('/dashboard/actions/notifications/:id/retry', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    requeueNotificationDelivery(id);
    const token = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
    res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
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
      const response = await assistant.respond({
        message: body.text,
        sessionId,
        userId: body.user_id,
        channel: 'webhook',
        model: body.model,
      });

      res.json({
        response: response.text,
        session_id: response.sessionId,
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

  await new Promise<void>((resolve) => {
    app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
      logger.info({ port: WEBHOOK_PORT }, 'Webhook server listening');
      resolve();
    });
  });
}
