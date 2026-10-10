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
import { spawn } from 'node:child_process';
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
import { admitLocalProject, chooseLocalProject, foundLocalProjects, localProjects } from './local-projects.js';
import { localPageContentPolicy, pageImageIsBlank, pageMadeBySession, pageOfProject, pagesMadeInProject, readPageDocument } from './local-pages.js';
import {
  LARGEST_SESSION_FILE_CONTENT_BYTES, LARGEST_SHOWN_IMAGE_BYTES, LARGEST_SHOWN_TEXT_BYTES, SESSION_FILE_CONTENT_POLICY,
  listSessionFiles, readSessionFile, readSessionFileContent, sessionFileHtmlPreview,
} from './session-files.js';
import { moveFact } from './memory-scope-views.js';
import { launchWindowsDefaultApp } from '../runtime/windows-powershell.js';

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

/** A conversation id as the surfaces send it, with or without its lane prefix. */
function sessionParam(req: Request): string {
  const raw = param(req, 'sessionId');
  return raw.startsWith('harness:') ? raw.slice('harness:'.length) : raw;
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

type PageRenderer = (input: { file: string; width?: number; height?: number; offsetY?: number; scale?: 1 | 2 }) =>
  Promise<{ ok: true; png: Buffer; width: number; height: number; offsetY: number } | { ok: false; reason: string }>;
type PageOpener = (file: string) => { ok: true } | { ok: false; reason: string };
let pageRendererForTests: PageRenderer | null = null;
let pageOpenerForTests: PageOpener | null = null;

/** Test seams. Null restores the machine's own browser and opener. */
export function _setPageRendererForTests(renderer: PageRenderer | null): void { pageRendererForTests = renderer; }
export function _setPageOpenerForTests(opener: PageOpener | null): void { pageOpenerForTests = opener; }

// One page is rendered at a time: each render starts a browser.
let rendering: Promise<unknown> = Promise.resolve();
function renderPage(input: Parameters<PageRenderer>[0]): ReturnType<PageRenderer> {
  const next = rendering.then(async () => {
    if (pageRendererForTests) return pageRendererForTests(input);
    const { renderLocalPagePreview } = await import('../spaces/space-preview.js');
    return renderLocalPagePreview(input);
  });
  rendering = next.catch(() => undefined);
  return next;
}

function openPage(file: string): ReturnType<PageOpener> {
  if (pageOpenerForTests) return pageOpenerForTests(file);
  if (process.platform === 'win32') {
    // The default app for the page (its browser), like `open` on macOS; the
    // hand-off is not awaited, the same as the detached `open` below.
    void launchWindowsDefaultApp(file).catch(() => undefined);
    return { ok: true };
  }
  if (process.platform !== 'darwin') return { ok: false, reason: 'not_supported_here' };
  // Detached, so a slow hand-off to the browser never holds the answer.
  const child = spawn('open', [file], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
  return { ok: true };
}

function wholeNumber(value: unknown, smallest: number, largest: number): number | undefined {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) ? Math.min(largest, Math.max(smallest, Math.round(parsed))) : undefined;
}

function fromThisMachine(req: Request): boolean {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '';
}

const REASON_STATUS: Record<string, number> = {
  name_required: 400, name_taken: 409, not_found: 404, archived: 409,
  project_not_found: 404, project_archived: 409, agent_required: 400,
  page_not_found: 404, page_too_large: 413, page_not_rendered: 503, not_supported_here: 501,
  file_not_found: 404, file_not_an_image: 415, file_not_openable: 415, file_too_large: 413,
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

  // The local projects on this machine, for linking one to a project, and
  // the project folders found where people keep them that are not work
  // folders yet (linking one of those adds it).
  add('get', `${mount.projects}-local-projects`, (_req, res) => {
    res.json({ localProjects: localProjects(), foundProjects: foundLocalProjects() });
  });

  // The pages work in the project wrote into its linked local projects.
  add('get', `${mount.projects}/:id/pages`, (req, res) => {
    if (!projectOverview(param(req, 'id'))) { refuse(res, 'project_not_found'); return; }
    res.json({ pages: pagesMadeInProject(param(req, 'id')) });
  });

  // A page rendered on this machine at the asked width, one part at a time.
  // `end` says the part shows nothing, which is how a reader finds the end.
  add('get', `${mount.projects}/:id/pages/:pageId/image`, async (req, res) => {
    const page = pageOfProject(param(req, 'id'), param(req, 'pageId'));
    if (!page.ok) { refuse(res, page.reason === 'too_large' ? 'page_too_large' : 'page_not_found'); return; }
    const rendered = await renderPage({
      file: page.file,
      width: wholeNumber(req.query.width, 360, 2000),
      height: wholeNumber(req.query.height, 480, 2000),
      offsetY: wholeNumber(req.query.offset, 0, 20_000),
      // A picture for a person, on a fine screen.
      scale: 2,
    });
    if (!rendered.ok) { refuse(res, 'page_not_rendered', { message: rendered.reason }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      page: page.view,
      image: rendered.png.toString('base64'),
      mimeType: 'image/png',
      width: rendered.width, height: rendered.height, offsetY: rendered.offsetY,
      end: pageImageIsBlank(rendered.png),
    });
  });

  if (mount.origin === 'console') {
    // The document itself, for the desktop to frame. The answer carries its
    // own policy: no origin, nothing it can call, nothing it can be framed by
    // but the app. Only this machine is answered.
    add('get', `${mount.projects}/:id/pages/:pageId/document`, (req, res) => {
      if (!fromThisMachine(req)) { res.status(403).json({ error: 'THIS_MACHINE_ONLY' }); return; }
      const page = pageOfProject(param(req, 'id'), param(req, 'pageId'));
      if (!page.ok) { refuse(res, page.reason === 'too_large' ? 'page_too_large' : 'page_not_found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', localPageContentPolicy());
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(readPageDocument(page.file));
    });

    // Open the page in the owner's own browser, on this machine.
    add('post', `${mount.projects}/:id/pages/:pageId/open`, (req, res) => {
      if (!fromThisMachine(req)) { res.status(403).json({ error: 'THIS_MACHINE_ONLY' }); return; }
      const page = pageOfProject(param(req, 'id'), param(req, 'pageId'));
      // A page too large to frame is still the owner's to open.
      if (!page.ok && page.reason === 'not_found') { refuse(res, 'page_not_found'); return; }
      const opened = openPage(page.file);
      if (!opened.ok) { refuse(res, opened.reason); return; }
      res.json({ ok: true, page: page.view });
    });
  }

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
      ...(typeof input.lead === 'boolean' ? { lead: input.lead } : {}),
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
    if (kind === 'folder') {
      // A local project is linked only from the machine's own roster, by the
      // one folder the name or path means.
      const choice = chooseLocalProject(typeof input.ref === 'string' ? input.ref : null);
      if (choice.kind !== 'found') {
        res.status(409).json({
          error: choice.kind === 'choose' ? 'LOCAL_PROJECT_CHOICE_REQUIRED' : 'LOCAL_PROJECT_NOT_FOUND',
          named: choice.named, localProjects: choice.choices,
        });
        return;
      }
      let project;
      try { project = admitLocalProject(choice.project); }
      catch (error) { refuse(res, 'local_project_not_added', { detail: error instanceof Error ? error.message : String(error) }); return; }
      const saved = saveResource(projectId, {
        kind: 'folder', ref: project.path, label: project.name,
        verifiedAt: new Date().toISOString(),
        verification: { against: 'local_projects', type: project.type, git: project.git },
      });
      if (!saved.ok) { refuse(res, saved.reason); return; }
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

  // The page behind a saved-file card: the card knows the file's name and
  // folder, never its path.
  add('get', `${mount.sessions}/:sessionId/page`, (req, res) => {
    const found = pageMadeBySession(param(req, 'sessionId'), String(req.query.name ?? ''), String(req.query.folder ?? ''));
    if (!found) { refuse(res, 'page_not_found'); return; }
    res.json(found);
  });

  // Files in this conversation's bounded record, including branches and workers.
  // The opaque id disambiguates names without accepting a caller-supplied path.
  add('get', `${mount.sessions}/:sessionId/files`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const files = listSessionFiles(sessionParam(req));
    res.json({ files: mount.origin === 'console' ? files : files.map(file => ({ ...file, openable: false })) });
  });

  // A file the conversation's own work saved, by id or its card's name and
  // folder, for the panel beside the conversation. Bounded text comes with it.
  add('get', `${mount.sessions}/:sessionId/file`, (req, res) => {
    const found = readSessionFile(sessionParam(req), String(req.query.name ?? ''), String(req.query.folder ?? ''), String(req.query.fileId ?? ''));
    if (!found.ok) { refuse(res, found.reason); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ file: mount.origin === 'console' ? found.view : { ...found.view, openable: false } });
  });

  // This route shares the surface's existing authentication, including the
  // phone's signed request proof. Clients fetch first, then preview local bytes.
  add('get', `${mount.sessions}/:sessionId/file/content`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const found = readSessionFileContent(sessionParam(req), String(req.query.name ?? ''), String(req.query.folder ?? ''), String(req.query.fileId ?? ''));
    if (!found.ok) {
      refuse(res, found.reason, found.reason === 'file_too_large' ? { maxBytes: LARGEST_SESSION_FILE_CONTENT_BYTES } : {});
      return;
    }
    const download = req.query.download === '1' || found.view.kind === 'other';
    const fallbackName = found.view.name.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const encodedName = encodeURIComponent(found.view.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', SESSION_FILE_CONTENT_POLICY);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    const content = found.view.kind === 'html' && !download
      ? Buffer.from(sessionFileHtmlPreview(found.content.subarray(0, LARGEST_SHOWN_TEXT_BYTES).toString('utf8')))
      : found.content;
    res.send(content);
  });

  // The same file's picture, when it is one.
  add('get', `${mount.sessions}/:sessionId/file/image`, (req, res) => {
    const found = readSessionFileContent(sessionParam(req), String(req.query.name ?? ''), String(req.query.folder ?? ''), String(req.query.fileId ?? ''));
    if (!found.ok) { refuse(res, found.reason); return; }
    if (found.view.kind !== 'image' || found.content.length > LARGEST_SHOWN_IMAGE_BYTES) { refuse(res, 'file_not_an_image'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ file: mount.origin === 'console' ? found.view : { ...found.view, openable: false }, image: found.content.toString('base64'), mimeType: found.mimeType });
  });

  if (mount.origin === 'console') {
    // Open the file in the app made for its type, on this machine. Scripts,
    // apps and installers are never opened: opening one runs it.
    add('post', `${mount.sessions}/:sessionId/file/open`, (req, res) => {
      if (!fromThisMachine(req)) { res.status(403).json({ error: 'THIS_MACHINE_ONLY' }); return; }
      const found = readSessionFile(sessionParam(req), String(req.query.name ?? ''), String(req.query.folder ?? ''), String(req.query.fileId ?? ''));
      if (!found.ok) { refuse(res, found.reason); return; }
      if (!found.view.openable) { refuse(res, 'file_not_openable'); return; }
      const opened = openPage(found.file);
      if (!opened.ok) { refuse(res, opened.reason); return; }
      res.json({ ok: true, file: found.view });
    });
  }

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
      const code = corrected.reason === 'not_resumable' || corrected.reason === 'resume_first'
        ? 'TASK_NOT_RESUMABLE' : corrected.reason.toUpperCase();
      res.status(status).json({ error: code, task: delegatedTaskById(taskId) });
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
