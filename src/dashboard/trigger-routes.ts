/**
 * Triggers: everything that makes Clem act without the owner typing, on one
 * screen. Schedules and one-shot runs (workflows), webhooks, app and system
 * events, watches, and reminders, with what fires next and what each last
 * did. Read-only projection over the stores that own each kind; the owner's
 * controls (pause, run, cancel) are the existing routes of those stores,
 * plus one for a reminder, which had no door outside chat.
 */
import type { Express, Request, Response } from 'express';
import { WEBHOOK_SECRET } from '../config.js';
import { workflowHookKey } from '../execution/workflow-hook-key.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { listWatchViews } from '../agents/watches.js';
import { cancelTimers, listPendingTimers } from '../runtime/timers.js';
import { upcomingWorkflowOccurrences } from './console-routes.js';
import { readWorkflowRuns } from './state.js';

export interface TriggerWorkflowView {
  name: string;
  slug: string;
  enabled: boolean;
  description: string | null;
  schedule: string | null;
  timezone: string | null;
  onceAt: string | null;
  interval: unknown | null;
  webhookPath: string | null;
  /** The hook's own key, for the address a service holds. */
  webhookKey: string | null;
  events: string[];
  manual: boolean;
  lastRun: { runId: string; at: string | null; status: string | null; outcome: string | null } | null;
}

export interface TriggerReminderView { id: string; message: string; fireAt: string; createdAt: string }

export interface TriggersProjection {
  generatedAt: string;
  workflows: TriggerWorkflowView[];
  upcoming: ReturnType<typeof upcomingWorkflowOccurrences>;
  watches: Awaited<ReturnType<typeof listWatchViews>>;
  reminders: TriggerReminderView[];
  webhookBase: string;
}

/** Workflows that fire on their own, from their definitions and recent runs. */
export function triggerWorkflowViews(
  workflows: ReturnType<typeof listWorkflows>,
  runs: ReturnType<typeof readWorkflowRuns>,
): TriggerWorkflowView[] {
  const latestRunByWorkflow = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    const name = typeof run.workflow === 'string' ? run.workflow : '';
    if (!name) continue;
    const seen = latestRunByWorkflow.get(name);
    const at = typeof run.finishedAt === 'string' ? run.finishedAt : typeof run.startedAt === 'string' ? run.startedAt : typeof run.createdAt === 'string' ? run.createdAt : '';
    const seenAt = seen ? (typeof seen.finishedAt === 'string' ? seen.finishedAt : typeof seen.startedAt === 'string' ? seen.startedAt : typeof seen.createdAt === 'string' ? seen.createdAt : '') : '';
    if (!seen || at > seenAt) latestRunByWorkflow.set(name, run);
  }
  const out: TriggerWorkflowView[] = [];
  for (const entry of workflows) {
    const trigger = entry.data.trigger ?? {};
    const events = Array.isArray(trigger.events) ? trigger.events.map((event) => event.type).filter((type): type is string => typeof type === 'string') : [];
    const fires = Boolean(trigger.schedule || trigger.onceAt || trigger.interval || trigger.webhookPath || events.length > 0);
    if (!fires || entry.data.watch) continue;
    const run = latestRunByWorkflow.get(entry.data.name);
    out.push({
      name: entry.data.name,
      slug: entry.name,
      enabled: entry.data.enabled !== false,
      description: typeof entry.data.description === 'string' && entry.data.description.trim() ? entry.data.description : null,
      schedule: trigger.schedule?.trim() || null,
      timezone: trigger.timezone ?? null,
      onceAt: trigger.onceAt ?? null,
      interval: trigger.interval ?? null,
      webhookPath: trigger.webhookPath ?? null,
      webhookKey: trigger.webhookPath ? workflowHookKey(WEBHOOK_SECRET, trigger.webhookPath) : null,
      events,
      manual: trigger.manual === true,
      lastRun: run ? {
        runId: String(run.id ?? ''),
        at: typeof run.finishedAt === 'string' ? run.finishedAt : typeof run.startedAt === 'string' ? run.startedAt : null,
        status: typeof run.status === 'string' ? run.status : null,
        outcome: typeof run.terminalOutcome === 'string' ? run.terminalOutcome : null,
      } : null,
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

export function registerTriggerRoutes(app: Express, isAuthorized: (req: Request) => boolean): void {
  app.get('/api/console/triggers', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const workflows = listWorkflows();
      const runs = readWorkflowRuns(400);
      const now = new Date();
      const projection: TriggersProjection = {
        generatedAt: now.toISOString(),
        workflows: triggerWorkflowViews(workflows, runs),
        upcoming: upcomingWorkflowOccurrences(workflows, now, 7),
        watches: await listWatchViews(),
        reminders: listPendingTimers(now.getTime()).map((timer) => ({
          id: timer.id, message: timer.message, fireAt: new Date(timer.fireAt).toISOString(), createdAt: new Date(timer.createdAt).toISOString(),
        })),
        webhookBase: `${req.protocol}://${req.get('host') ?? '127.0.0.1'}/api/hooks/workflows/`,
      };
      res.json(projection);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/console/reminders/:id/cancel', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = String(req.params.id ?? '').trim();
    if (!/^timer-[a-f0-9]{8}$/.test(id)) { res.status(400).json({ error: 'invalid reminder id' }); return; }
    const cancelled = cancelTimers({ id });
    if (cancelled.length === 0) { res.status(404).json({ error: 'no such reminder' }); return; }
    res.json({ cancelled: cancelled.map((timer) => timer.id) });
  });
}
