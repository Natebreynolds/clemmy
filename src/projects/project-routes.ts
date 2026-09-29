/**
 * The projects API, the same on the desktop and the phone.
 *
 * One set of handlers is mounted under each surface's own prefix and
 * authorization, so the two read and change the same records through the
 * same code. The handlers edit records and pass controls to the task owner
 * that already exists; they run nothing themselves.
 *
 * The prefix is `project-records`, never `projects`: that path already
 * serves local code folders.
 */
import type { Request, Response } from 'express';
import { getAgentRecord } from '../agents/agent-record.js';
import {
  cancelBackgroundTask, getBackgroundTask, queueBackgroundTaskInputResolution, resumeBackgroundTask,
} from '../execution/background-tasks.js';
import { correctDelegatedTask } from './task-follow-up.js';
import { updateLinkedFocusAction } from '../memory/focus.js';
import { chooseConnectedAccount, connectedAccountsFor, connectedApps } from './connected-accounts.js';
import {
  archiveProject, createProject, getProject, removeAssignment, removeResource, restoreProject,
  saveAssignment, saveResource, updateProject, type ProjectOrigin, type ProjectResourceKind,
} from './project-record.js';
import {
  agentWork, delegatedTaskById, delegatedTasksForSession, projectLabelsForSessions, projectOverview, projectSummaries,
} from './project-views.js';
import { setSessionProject } from './session-project.js';
import { moveFact } from './memory-scope-views.js';

type Handler = (req: Request, res: Response) => void | Promise<void>;

export interface ProjectRouteMount {
  /** Register one route behind the surface's own authorization. */
  add(method: 'get' | 'post', path: string, handler: Handler): void;
  /** e.g. `/api/console/project-records` */
  projects: string;
  /** e.g. `/api/console/delegated-tasks` */
  tasks: string;
  /** e.g. `/api/console/sessions`; the session id follows. */
  sessions: string;
  /** e.g. `/api/console/agents`; the agent id follows. */
  agents: string;
  /** e.g. `/api/console/memory`. */
  memory: string;
  origin: ProjectOrigin;
  /** Who is recorded as having stopped or corrected a task from here. */
  surfaceName: string;
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function guarded(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: 'PROJECT_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  };
}

const REASON_STATUS: Record<string, number> = {
  name_required: 400, name_taken: 409, not_found: 404, archived: 409,
  project_not_found: 404, project_archived: 409, agent_required: 400,
  resource_incomplete: 400, too_many_resources: 409, conflicting_account: 409,
};

function refuse(res: Response, reason: string, extra: Record<string, unknown> = {}): void {
  res.status(REASON_STATUS[reason] ?? 400).json({ error: reason.toUpperCase(), ...extra });
}

export function registerProjectRecordRoutes(mount: ProjectRouteMount): void {
  const add = (method: 'get' | 'post', path: string, handler: Handler) => mount.add(method, path, guarded(handler));

  add('get', mount.projects, (req, res) => {
    res.json({ projects: projectSummaries({ includeArchived: req.query.archived === '1' }), generatedAt: new Date().toISOString() });
  });

  // Which project each session works in, so that what waits on the owner
  // can say where it came from. Sessions in no project are left out.
  add('get', `${mount.projects}-labels`, (req, res) => {
    const ids = String(req.query.sessions ?? '').split(',');
    res.json({ labels: projectLabelsForSessions(ids) });
  });

  // The apps that have an account connected right now, for choosing one to
  // bind. Read from the live connection list each time.
  add('get', `${mount.projects}-connected-apps`, async (_req, res) => {
    res.json({ apps: await connectedApps() });
  });

  add('post', mount.projects, (req, res) => {
    const input = body(req);
    const saved = createProject({
      name: String(input.name ?? ''),
      purpose: typeof input.purpose === 'string' ? input.purpose : undefined,
      goals: strings(input.goals),
      context: typeof input.context === 'string' ? input.context : undefined,
      createdFrom: mount.origin,
    });
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(saved.project.id) });
  });

  add('get', `${mount.projects}/:id`, (req, res) => {
    const overview = projectOverview(param(req, 'id'));
    if (!overview) { refuse(res, 'project_not_found'); return; }
    res.json({ overview, generatedAt: new Date().toISOString() });
  });

  add('post', `${mount.projects}/:id`, (req, res) => {
    const input = body(req);
    const saved = updateProject(param(req, 'id'), {
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.purpose === 'string' ? { purpose: input.purpose } : {}),
      ...(Array.isArray(input.goals) ? { goals: strings(input.goals) } : {}),
      ...(typeof input.context === 'string' ? { context: input.context } : {}),
    });
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(saved.project.id) });
  });

  add('post', `${mount.projects}/:id/archive`, (req, res) => {
    const saved = archiveProject(param(req, 'id'));
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(saved.project.id) });
  });

  add('post', `${mount.projects}/:id/restore`, (req, res) => {
    const saved = restoreProject(param(req, 'id'));
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(saved.project.id) });
  });

  add('post', `${mount.projects}/:id/agents/:agentId`, (req, res) => {
    const input = body(req);
    const agent = getAgentRecord(param(req, 'agentId'));
    if (!agent) { res.status(404).json({ error: 'AGENT_NOT_FOUND' }); return; }
    const saved = saveAssignment(param(req, 'id'), {
      agentId: agent.id,
      agentCreatedAt: agent.createdAt,
      agentName: agent.name,
      ...(typeof input.responsibility === 'string' ? { responsibility: input.responsibility } : {}),
      ...(typeof input.context === 'string' ? { context: input.context } : {}),
      ...(Array.isArray(input.skills) ? { skills: strings(input.skills) } : {}),
      ...(typeof input.shareMethods === 'boolean' ? { shareMethods: input.shareMethods } : {}),
    });
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(saved.assignment.projectId) });
  });

  add('post', `${mount.projects}/:id/agents/:agentId/remove`, (req, res) => {
    const projectId = param(req, 'id');
    if (!getProject(projectId)) { refuse(res, 'project_not_found'); return; }
    removeAssignment(projectId, param(req, 'agentId'));
    res.json({ overview: projectOverview(projectId) });
  });

  // The accounts connected right now for one app, for the owner to choose from.
  add('get', `${mount.projects}/:id/account-choices`, async (req, res) => {
    if (!getProject(param(req, 'id'))) { refuse(res, 'project_not_found'); return; }
    const toolkit = String(req.query.toolkit ?? '').trim();
    if (!toolkit) { res.status(400).json({ error: 'TOOLKIT_REQUIRED' }); return; }
    const accounts = await connectedAccountsFor(toolkit);
    res.json({ toolkit: toolkit.toLowerCase(), accounts: accounts.map((row) => ({ accountId: row.accountId, label: row.label })) });
  });

  add('post', `${mount.projects}/:id/resources`, async (req, res) => {
    const input = body(req);
    const projectId = param(req, 'id');
    const kind = String(input.kind ?? '') as ProjectResourceKind;
    if (kind === 'account') {
      // An account is bound only from the live connection list, never from
      // what the request says it is called.
      const choice = await chooseConnectedAccount(String(input.toolkit ?? ''), typeof input.accountId === 'string' ? input.accountId : null);
      if (choice.kind === 'not_connected') { res.status(409).json({ error: 'ACCOUNT_NOT_CONNECTED', toolkit: choice.toolkit }); return; }
      if (choice.kind === 'choose') {
        res.status(409).json({ error: 'ACCOUNT_CHOICE_REQUIRED', toolkit: choice.toolkit,
          accounts: choice.choices.map((row) => ({ accountId: row.accountId, label: row.label })) });
        return;
      }
      const saved = saveResource(projectId, {
        kind: 'account', toolkit: choice.account.toolkit, accountId: choice.account.accountId, label: choice.account.label,
        verifiedAt: new Date().toISOString(), verification: { against: 'live_connections', status: 'active' },
      }, { replace: input.replace === true });
      if (!saved.ok) {
        refuse(res, saved.reason, saved.conflict ? { bound: { accountId: saved.conflict.accountId, label: saved.conflict.label } } : {});
        return;
      }
      res.json({ overview: projectOverview(projectId) });
      return;
    }
    const saved = saveResource(projectId, {
      kind, ref: typeof input.ref === 'string' ? input.ref : null, label: typeof input.label === 'string' ? input.label : undefined,
    });
    if (!saved.ok) { refuse(res, saved.reason); return; }
    res.json({ overview: projectOverview(projectId) });
  });

  add('post', `${mount.projects}/:id/resources/:resourceId/remove`, (req, res) => {
    const projectId = param(req, 'id');
    if (!getProject(projectId)) { refuse(res, 'project_not_found'); return; }
    removeResource(projectId, param(req, 'resourceId'));
    res.json({ overview: projectOverview(projectId) });
  });

  // What an agent is assigned to and what it owns right now.
  add('get', `${mount.agents}/:id/assignments`, (req, res) => {
    const agent = getAgentRecord(param(req, 'id'));
    if (!agent) { res.status(404).json({ error: 'AGENT_NOT_FOUND' }); return; }
    res.json({ work: agentWork(agent.id), generatedAt: new Date().toISOString() });
  });

  // Which project a conversation works in from its next turn: a project's
  // id, or null for none. Repeating the same choice is a no-op.
  add('post', `${mount.sessions}/:sessionId/project`, (req, res) => {
    const projectId = body(req).projectId;
    if (projectId !== null && typeof projectId !== 'string') { res.status(400).json({ error: 'INVALID_PROJECT' }); return; }
    const raw = param(req, 'sessionId');
    const sessionId = raw.startsWith('harness:') ? raw.slice('harness:'.length) : raw;
    const result = setSessionProject(sessionId, projectId, { by: 'owner' });
    if (!result.ok) {
      const status = result.reason === 'session_not_found' ? 404 : result.reason === 'project_not_found' ? 400 : 409;
      res.status(status).json({ error: result.reason.toUpperCase() });
      return;
    }
    res.json({ sessionId, projectId: result.projectId, projectName: result.projectName, changed: result.changed });
  });

  add('get', `${mount.sessions}/:sessionId/delegated-tasks`, (req, res) => {
    const raw = param(req, 'sessionId');
    const sessionId = raw.startsWith('harness:') ? raw.slice('harness:'.length) : raw;
    res.json({ tasks: delegatedTasksForSession(sessionId), generatedAt: new Date().toISOString() });
  });

  // Who a memory is for is the owner's to change: to a project, to an agent,
  // to both, or to everywhere (both null).
  add('post', `${mount.memory}/facts/:id/scope`, (req, res) => {
    const id = Number.parseInt(param(req, 'id'), 10);
    if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'INVALID_FACT' }); return; }
    const input = body(req);
    const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;
    const agentId = typeof input.agentId === 'string' && input.agentId.trim() ? input.agentId.trim() : null;
    const moved = moveFact(id, { projectId, agentId });
    if (!moved.ok) {
      res.status(moved.reason === 'already_kept_there' ? 409 : 404).json({ error: moved.reason.toUpperCase() });
      return;
    }
    res.json({ fact: moved.fact });
  });

  add('get', `${mount.tasks}/:taskId`, (req, res) => {
    const task = delegatedTaskById(param(req, 'taskId'));
    if (!task) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
    res.json({ task, generatedAt: new Date().toISOString() });
  });

  // A correction revises the task while it is open. Once the task has ended
  // the correction becomes a task that follows it, for the same owner in the
  // same project; the answer says which happened.
  add('post', `${mount.tasks}/:taskId/steer`, (req, res) => {
    const taskId = param(req, 'taskId');
    if (!delegatedTaskById(taskId)) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
    const input = body(req);
    const policy = input.evidencePolicy === 'preserve' || input.evidencePolicy === 'invalidate' ? input.evidencePolicy : 'revalidate';
    const corrected = correctDelegatedTask(taskId, {
      instruction: typeof input.instruction === 'string' ? input.instruction : '', evidencePolicy: policy, by: 'owner',
    });
    if (corrected.kind === 'refused') {
      const status = corrected.reason === 'instruction_required' ? 400 : corrected.reason === 'task_not_found' ? 404 : 409;
      res.status(status).json({ error: corrected.reason.toUpperCase(), task: delegatedTaskById(taskId) });
      return;
    }
    if (corrected.kind === 'revised') {
      try {
        updateLinkedFocusAction(corrected.task.id, { status: 'running', note: `Course-corrected to request v${corrected.task.contractVersion ?? 1}.` });
      } catch { /* the revision is on the task; the focus note is a convenience */ }
      res.json({ task: delegatedTaskById(taskId), applied: 'revised', resumed: corrected.resumed });
      return;
    }
    res.json({ task: delegatedTaskById(corrected.task.id), applied: 'followed', follows: delegatedTaskById(taskId) });
  });

  add('post', `${mount.tasks}/:taskId/stop`, (req, res) => {
    const taskId = param(req, 'taskId');
    if (!delegatedTaskById(taskId)) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
    cancelBackgroundTask(taskId, `Stopped by the owner from ${mount.surfaceName}.`);
    res.json({ task: delegatedTaskById(taskId) });
  });

  add('post', `${mount.tasks}/:taskId/resume`, (req, res) => {
    const taskId = param(req, 'taskId');
    const view = delegatedTaskById(taskId);
    if (!view) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
    if (!view.controls.canResume) { res.status(409).json({ error: 'TASK_NOT_RESUMABLE', task: view }); return; }
    const resumed = resumeBackgroundTask(taskId);
    if (!resumed) { res.status(409).json({ error: 'TASK_NOT_RESUMABLE', task: delegatedTaskById(taskId) }); return; }
    res.json({ task: delegatedTaskById(taskId) });
  });

  add('post', `${mount.tasks}/:taskId/answer`, (req, res) => {
    const taskId = param(req, 'taskId');
    if (!delegatedTaskById(taskId)) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
    const answer = typeof body(req).answer === 'string' ? String(body(req).answer).trim() : '';
    if (!answer) { res.status(400).json({ error: 'ANSWER_REQUIRED' }); return; }
    const task = getBackgroundTask(taskId);
    if (!task || task.status !== 'awaiting_input' || !task.pendingQuestionId) {
      res.status(409).json({ error: 'TASK_NOT_WAITING', task: delegatedTaskById(taskId) });
      return;
    }
    const queued = queueBackgroundTaskInputResolution(task.pendingQuestionId, answer);
    if (!queued) { res.status(409).json({ error: 'ALREADY_ANSWERED', task: delegatedTaskById(taskId) }); return; }
    res.json({ task: delegatedTaskById(taskId) });
  });
}
