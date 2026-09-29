/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/project-routes.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-project-routes-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const { registerProjectRecordRoutes } = await import('./project-routes.js');
const projects = await import('./project-record.js');
const accounts = await import('./connected-accounts.js');
const tasks = await import('../execution/background-tasks.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
const { createAgentRecord } = await import('../agents/agent-record.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { createSession, getSession, listEvents, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { buildUnifiedSessionList } = await import('../dashboard/sessions-api.js');

after(() => {
  accounts._setConnectedAccountDirectoryForTests(null);
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

type Handler = (req: any, res: any) => void | Promise<void>;
function surface(prefix: { projects: string; tasks: string; sessions: string; agents: string; memory: string }, origin: 'console' | 'phone') {
  const routes: Array<{ method: string; path: string; keys: string[]; pattern: RegExp; handler: Handler }> = [];
  registerProjectRecordRoutes({
    add: (method, routePath, handler) => {
      const keys: string[] = [];
      const pattern = new RegExp(`^${routePath.replace(/:([A-Za-z]+)/g, (_m, key) => { keys.push(key); return '([^/]+)'; })}$`);
      routes.push({ method, path: routePath, keys, pattern, handler });
    },
    ...prefix, origin, surfaceName: origin === 'phone' ? 'the phone' : 'the desktop',
  });
  return async (method: 'get' | 'post', url: string, body: unknown = undefined) => {
    const [pathname, search = ''] = url.split('?');
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname!);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]));
      const query = Object.fromEntries(new URLSearchParams(search));
      let status = 200;
      let payload: any;
      const res = { headersSent: false, status(code: number) { status = code; return res; }, json(value: unknown) { payload = value; res.headersSent = true; return res; } };
      await route.handler({ params, query, body }, res);
      return { status, body: payload };
    }
    throw new Error(`no route for ${method} ${url}`);
  };
}
const desktop = surface({ projects: '/api/console/project-records', tasks: '/api/console/delegated-tasks', sessions: '/api/console/sessions', agents: '/api/console/agents', memory: '/api/console/memory' }, 'console');
const phone = surface({ projects: '/api/project-records', tasks: '/api/delegated-tasks', sessions: '/api/chat/sessions', agents: '/api/agents', memory: '/api/memory' }, 'phone');

accounts._setConnectedAccountDirectoryForTests(async (toolkit) => [
  { toolkit: 'ledgerscope', accountId: 'conn-east', label: 'East ledger', names: [] },
  { toolkit: 'ledgerscope', accountId: 'conn-west', label: 'West ledger', names: [] },
].filter((row) => row.toolkit === toolkit));
const made = createAgentRecord({ name: 'Route Analyst', handles: 'Reporting.', createdFrom: 'console' });
if (!made.ok) throw new Error('fixture agent');
const analyst = made.agent;

test('a project made on the desktop is the same project on the phone, with the same work and the same decision', async () => {
  const created = await desktop('post', '/api/console/project-records', { name: 'Route Sales', purpose: 'Weekly briefing.', goals: ['Draft by Monday'] });
  assert.equal(created.status, 200);
  const id = created.body.overview.project.id as string;
  assert.equal(created.body.overview.project.createdFrom, 'console');
  assert.deepEqual((await desktop('post', '/api/console/project-records', { name: 'route sales' })).body, { error: 'NAME_TAKEN' });

  // Assigned from the phone, seen on the desktop.
  const assigned = await phone('post', `/api/project-records/${id}/agents/${analyst.id}`, { responsibility: 'Prepare the briefing.', skills: [], shareMethods: false });
  assert.equal(assigned.status, 200);
  assert.deepEqual((await desktop('get', `/api/console/project-records/${id}`)).body.overview.agents.map((row: any) => [row.agentName, row.responsibility, row.available]),
    [['Route Analyst', 'Prepare the briefing.', true]]);
  assert.equal((await phone('post', `/api/project-records/${id}/agents/nobody`, {})).status, 404);

  // An account comes only from what is connected, and a second one is never swapped in.
  const choices = await desktop('get', `/api/console/project-records/${id}/account-choices?toolkit=LedgerScope`);
  assert.deepEqual(choices.body.accounts, [{ accountId: 'conn-east', label: 'East ledger' }, { accountId: 'conn-west', label: 'West ledger' }]);
  const ambiguous = await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'account', toolkit: 'ledgerscope' });
  assert.deepEqual([ambiguous.status, ambiguous.body.error], [409, 'ACCOUNT_CHOICE_REQUIRED']);
  const invented = await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'account', toolkit: 'ledgerscope', accountId: 'conn-made-up' });
  assert.equal(invented.body.error, 'ACCOUNT_CHOICE_REQUIRED', 'an account that is not connected is never bound');
  assert.equal((await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'account', toolkit: 'ledgerscope', accountId: 'conn-east' })).status, 200);
  const bound = (await phone('get', `/api/project-records/${id}`)).body.overview.resources;
  assert.deepEqual(bound.map((row: any) => [row.kind, row.toolkit, typeof row.appName === 'string' && row.appName.length > 0]), [['account', 'ledgerscope', true]]);
  accounts._setConnectedAppsForTests(async () => [{ toolkit: 'ledgerscope', name: 'LedgerScope', accounts: [{ accountId: 'conn-east', label: 'East ledger' }] }]);
  assert.deepEqual((await phone('get', '/api/project-records-connected-apps')).body,
    (await desktop('get', '/api/console/project-records-connected-apps')).body);
  assert.deepEqual((await phone('get', '/api/project-records-connected-apps')).body.apps.map((row: any) => [row.toolkit, row.name, row.accounts.length]),
    [['ledgerscope', 'LedgerScope', 1]]);
  accounts._setConnectedAppsForTests(null);
  const rival = await phone('post', `/api/project-records/${id}/resources`, { kind: 'account', toolkit: 'ledgerscope', accountId: 'conn-west' });
  assert.deepEqual([rival.status, rival.body.error, rival.body.bound], [409, 'CONFLICTING_ACCOUNT', { accountId: 'conn-east', label: 'East ledger' }]);

  // A conversation enters the project from the phone; the desktop's list says so.
  const chat = createSession({ id: 'route-chat', kind: 'chat', title: 'Briefing chat' });
  assert.deepEqual((await phone('post', `/api/chat/sessions/${chat.id}/project`, { projectId: id })).body,
    { sessionId: chat.id, projectId: id, projectName: 'Route Sales', changed: true });
  assert.equal((await desktop('post', `/api/console/sessions/harness:${chat.id}/project`, { projectId: id })).body.changed, false);
  assert.equal((await desktop('post', `/api/console/sessions/${chat.id}/project`, { projectId: 7 })).status, 400);
  assert.equal((await desktop('post', '/api/console/sessions/no-such/project', { projectId: id })).status, 404);
  const listed = buildUnifiedSessionList({ limit: 50 }).find((row) => row.id.endsWith(chat.id));
  assert.deepEqual([listed?.projectId, listed?.projectName], [id, 'Route Sales']);

  // A delegated task: the same view on both, and its question is the project's one decision.
  setSessionAgent(chat.id, null, { by: 'owner' });
  const task = tasks.createBackgroundTask({ title: 'Draft the briefing', prompt: 'Objective: Draft the briefing', originSessionId: chat.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: id, projectName: 'Route Sales', assignedBy: 'clem' } });
  tasks.markBackgroundTaskRunning(task.id);
  const onDesktop = (await desktop('get', `/api/console/delegated-tasks/${task.id}`)).body.task;
  const onPhone = (await phone('get', `/api/delegated-tasks/${task.id}`)).body.task;
  assert.deepEqual(onDesktop, onPhone);
  assert.deepEqual([onDesktop.phase, onDesktop.owner.agentName, onDesktop.project.name, onDesktop.requestVersion, onDesktop.controls],
    ['working', 'Route Analyst', 'Route Sales', 1, { canSteer: true, canStop: true, canResume: false, canAnswer: false }]);
  assert.deepEqual((await phone('get', `/api/chat/sessions/${chat.id}/delegated-tasks`)).body.tasks.map((row: any) => row.taskId), [task.id]);

  // Steered from the phone: the same task, the next version, announced in the conversation.
  assert.equal((await phone('post', `/api/delegated-tasks/${task.id}/steer`, { instruction: 'no' })).status, 400);
  const steering = await phone('post', `/api/delegated-tasks/${task.id}/steer`, { instruction: 'Focus on this week and exclude unqualified leads.' });
  assert.equal(steering.body.applied, 'revised');
  const steered = steering.body.task;
  assert.deepEqual([steered.taskId, steered.requestVersion, steered.correctionPending, steered.revisions.at(-1).instruction],
    [task.id, 2, true, 'Focus on this week and exclude unqualified leads.']);
  assert.ok(listEvents(chat.id, { types: ['delegated_task_state'] }).some((event) => event.data.phase === 'revised' && event.data.contractVersion === 2));

  // It asks; the project shows one decision; answered on the phone, settled on the desktop.
  tasks.markBackgroundTaskAwaitingInput(task.id, 'q-region', 'Which region should the briefing cover?', { options: ['East', 'West'] });
  const waiting = (await desktop('get', `/api/console/project-records/${id}`)).body.overview;
  assert.deepEqual(waiting.decisions.map((row: any) => [row.kind, row.taskId, row.detail, row.owner, row.options]),
    [['question', task.id, 'Which region should the briefing cover?', 'Route Analyst', ['East', 'West']]]);
  assert.equal((await phone('get', '/api/project-records')).body.projects.find((row: any) => row.id === id).needsYou, 1);
  assert.equal((await desktop('post', `/api/console/delegated-tasks/${task.id}/answer`, { answer: ' ' })).status, 400);
  const answered = await phone('post', `/api/delegated-tasks/${task.id}/answer`, { answer: 'East' });
  assert.equal(answered.status, 200);
  assert.equal((await desktop('get', `/api/console/project-records/${id}`)).body.overview.decisions.length, 0);
  assert.equal((await desktop('post', `/api/console/delegated-tasks/${task.id}/answer`, { answer: 'West' })).status, 409, 'a question is answered once');

  // An approval asked by the task's own run belongs to the project too.
  const approval = approvals.register({ sessionId: task.runSessionId, subject: 'Save the draft to the shared folder', tool: 'fixture_write', args: { path: 'draft.md' } });
  assert.deepEqual((await phone('get', `/api/project-records/${id}`)).body.overview.decisions.map((row: any) => [row.kind, row.approvalId, row.taskId]),
    [['approval', approval.approvalId, task.id]]);
  assert.equal((await phone('get', `/api/project-records/${id}`)).body.overview.decisions[0].formal, true, 'decided on a card');
  approvals.resolve(approval.approvalId, 'rejected', 'mobile-inbox');
  assert.equal((await desktop('get', `/api/console/project-records/${id}`)).body.overview.decisions.length, 0, 'declined on the phone, gone on the desktop');

  // One asked in the conversation's own words is answered there: the project
  // shows the question and where it was asked, and never the id a card decides.
  const replyTo = { type: 'discord_channel' as const, channelId: 'route-consent' };
  const asked = approvals.register({ sessionId: chat.id, subject: 'Send the briefing', tool: 'fixture_send', args: { to: 'owner@example.com' },
    presentation: { version: 1, kind: 'autonomous_send_consent', question: 'Send the briefing to owner@example.com?', actionLabel: 'email',
      target: 'owner@example.com', subject: 'Briefing', bodyPreview: null, resultUrl: null, sourceUserSeq: 1, originReplyTarget: replyTo,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(replyTo), conversationKey: 'discord:route-consent', audienceUserId: 'owner' } });
  assert.deepEqual((await phone('get', `/api/project-records/${id}`)).body.overview.decisions.map((row: any) => [row.kind, row.formal, row.approvalId, row.sessionId, row.detail]),
    [['approval', false, null, chat.id, 'Send the briefing to owner@example.com?']]);
  approvals.resolve(asked.approvalId, 'cancelled_by_system', 'fixture');

  // Stopped from the desktop, resumed from the phone, in place.
  const stopped = (await desktop('post', `/api/console/delegated-tasks/${task.id}/stop`)).body.task;
  assert.ok(['stopped', 'stopping'].includes(stopped.phase), stopped.phase);
  const work = (await phone('get', `/api/agents/${analyst.id}/assignments`)).body.work;
  assert.deepEqual(work.projects.map((row: any) => [row.projectName, row.responsibility]), [['Route Sales', 'Prepare the briefing.']]);
  if (stopped.phase === 'stopped') {
    assert.deepEqual(work.recentOutcomes.map((row: any) => row.taskId), [task.id]);
    const resumed = await phone('post', `/api/delegated-tasks/${task.id}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.task.runSessionId, task.runSessionId, 'the same run, never a copy');
  }
  assert.equal((await desktop('get', '/api/console/delegated-tasks/bg-none')).status, 404);

  // Put away: nothing waits on the owner for it, and no conversation can enter it.
  assert.equal((await desktop('post', `/api/console/project-records/${id}/archive`)).body.overview.project.status, 'archived');
  assert.deepEqual((await phone('get', '/api/project-records')).body.projects.map((row: any) => row.id).includes(id), false);
  assert.equal((await phone('get', '/api/project-records?archived=1')).body.projects.some((row: any) => row.id === id), true);
  const other = createSession({ id: 'route-chat-2', kind: 'chat' });
  assert.deepEqual((await phone('post', `/api/chat/sessions/${other.id}/project`, { projectId: id })).body, { error: 'PROJECT_ARCHIVED' });
  void getSession;
});

test('an assignment whose agent is gone still says who it was, and says it is unavailable', async () => {
  const { deleteAgentRecord } = await import('../agents/agent-record.js');
  const temp = createAgentRecord({ name: 'Departing Clerk', handles: 'Filing.', createdFrom: 'console' });
  if (!temp.ok) throw new Error('fixture agent');
  const made = await desktop('post', '/api/console/project-records', { name: 'Route Archive Room' });
  const id = made.body.overview.project.id as string;
  assert.equal((await desktop('post', `/api/console/project-records/${id}/agents/${temp.agent.id}`, { responsibility: 'Files the records.' })).status, 200);
  assert.equal(deleteAgentRecord(temp.agent.id), true);
  assert.deepEqual((await phone('get', `/api/project-records/${id}`)).body.overview.agents.map((row: any) => [row.agentName, row.available, row.responsibility]),
    [['Departing Clerk', false, 'Files the records.']]);
});

test('a project links to a local project from the machine\'s own list, and to nothing else', async () => {
  const local = await import('./local-projects.js');
  const { bindProject } = await import('./project-binding.js');
  const roster = [
    { name: 'harbor-app', path: '/fixture/code/harbor-app', type: 'node', description: 'The app.', git: true },
    { name: 'harbor-site', path: '/fixture/code/harbor-site', type: 'node', description: 'The site.', git: false },
    { name: 'harbor-site', path: '/fixture/archive/harbor-site', type: 'node', description: 'An old copy.', git: true },
  ];
  local._setLocalProjectsForTests(() => roster);
  try {
    const made = await desktop('post', '/api/console/project-records', { name: 'Route Local Work' });
    const id = made.body.overview.project.id as string;
    assert.deepEqual((await phone('get', '/api/project-records-local-projects')).body.localProjects.map((row: any) => row.path), roster.map((row) => row.path));

    // By name, when the name is one folder.
    const linked = await phone('post', `/api/project-records/${id}/resources`, { kind: 'folder', ref: 'Harbor-App' });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.overview.resources.map((row: any) => [row.kind, row.label, row.ref, Boolean(row.verifiedAt), row.localProject.name, row.localProject.path]),
      [['folder', 'harbor-app', '/fixture/code/harbor-app', true, 'harbor-app', '/fixture/code/harbor-app']]);
    assert.equal(linked.body.overview.resources[0].localProject.present, false, 'a folder that is not on disk is said to be missing');
    // Twice is once.
    assert.equal((await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'folder', ref: '/fixture/code/harbor-app' })).body.overview.resources.length, 1);

    // A name two folders share is a question, with exactly those two.
    const shared = await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'folder', ref: 'harbor-site' });
    assert.deepEqual([shared.status, shared.body.error, shared.body.localProjects.map((row: any) => row.path)],
      [409, 'LOCAL_PROJECT_CHOICE_REQUIRED', ['/fixture/code/harbor-site', '/fixture/archive/harbor-site']]);
    // A folder that is not on the list is never linked, whatever it is called.
    const invented = await desktop('post', `/api/console/project-records/${id}/resources`, { kind: 'folder', ref: '/etc' });
    assert.deepEqual([invented.status, invented.body.error, invented.body.localProjects.length], [409, 'LOCAL_PROJECT_NOT_FOUND', 3]);
    assert.equal((await desktop('get', `/api/console/project-records/${id}`)).body.overview.resources.length, 1);

    // Work inside the project is told where its files are.
    const bound = bindProject(projects.getProject(id)!, { agentId: null });
    assert.match(bound.context, /- local project: harbor-app at \/fixture\/code\/harbor-app/);
    assert.deepEqual((await desktop('get', `/api/console/project-records/${id}`)).body.overview.codingRuns, []);
  } finally {
    local._setLocalProjectsForTests(null);
  }
});

test('a linked local project says what it offers, to the work and on both surfaces', async () => {
  const { mkdirSync: makeDir, writeFileSync: write } = await import('node:fs');
  const local = await import('./local-projects.js');
  const views = await import('./project-views.js');
  const { bindProject } = await import('./project-binding.js');
  const folder = path.join(HOME, 'fixture-audits');
  makeDir(path.join(folder, '.claude', 'commands'), { recursive: true });
  write(path.join(folder, 'AGENTS.md'), '# How this folder is worked in', 'utf8');
  write(path.join(folder, '.claude', 'commands', 'build-report.md'), '# Build the report', 'utf8');
  write(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: {
    'Fixture Search': { command: 'npx', env: { FIXTURE_TOKEN: 'fixture-secret-value' } },
    'fixture-hosting': { command: 'npx' },
  } }), 'utf8');
  local._setLocalProjectsForTests(() => [{ name: 'fixture-audits', path: folder, type: 'node', description: '', git: false }]);
  views._setConnectedToolServersForTests(() => ['fixture-hosting']);
  try {
    const made = await desktop('post', '/api/console/project-records', { name: 'Route Offered Work' });
    const id = made.body.overview.project.id as string;
    const linked = await phone('post', `/api/project-records/${id}/resources`, { kind: 'folder', ref: 'fixture-audits' });
    assert.equal(linked.status, 200);
    const expected = {
      name: 'fixture-audits', path: folder, present: true, git: false,
      instructions: ['AGENTS.md'], commands: ['build-report'],
      // 'Fixture Search' is not a name a server can have here, so it is not listed at all.
      toolServers: [{ name: 'fixture-hosting', connected: true }],
    };
    assert.deepEqual(linked.body.overview.resources[0].localProject, expected);
    assert.deepEqual((await desktop('get', `/api/console/project-records/${id}`)).body.overview.resources[0].localProject, expected);
    views._setConnectedToolServersForTests(() => []);
    assert.deepEqual((await desktop('get', `/api/console/project-records/${id}`)).body.overview.resources[0].localProject.toolServers,
      [{ name: 'fixture-hosting', connected: false }], 'a server Clem is not connected to is said to be missing');

    const bound = bindProject(projects.getProject(id)!, { agentId: null });
    assert.match(bound.context, /- local project: fixture-audits at .*fixture-audits\n  its own instructions, to read before working in it: AGENTS\.md\n  commands it names.*build-report \(\.claude\/commands\/build-report\.md\)\n  tool servers it declares: fixture-hosting\./);
    assert.ok(!/fixture-secret-value|FIXTURE_TOKEN/.test(bound.context + JSON.stringify(linked.body)), 'nothing of a declaration but its name leaves the file');
    // The context changes when the folder does, and its revision with it.
    write(path.join(folder, '.claude', 'commands', 'second-report.md'), '# Another', 'utf8');
    const again = bindProject(projects.getProject(id)!, { agentId: null });
    assert.match(again.context, /build-report \(.*\), second-report \(/);
    assert.notEqual(again.revision, bound.revision);
  } finally {
    local._setLocalProjectsForTests(null);
    views._setConnectedToolServersForTests(null);
  }
});

test('a task nobody delegated is not a delegated task on any surface', async () => {
  const plain = tasks.createBackgroundTask({ title: 'Plain', prompt: 'plain', source: 'desktop' });
  assert.equal((await desktop('get', `/api/console/delegated-tasks/${plain.id}`)).status, 404);
  assert.equal((await phone('post', `/api/delegated-tasks/${plain.id}/stop`)).status, 404);
  assert.equal(tasks.getBackgroundTask(plain.id)?.status, 'pending', 'and these routes cannot touch it');
});

test('the owner sees who each memory is for, by name, and can move it', async () => {
  const { rememberFact, factScope } = await import('../memory/facts.js');
  const { agentScopeKey } = await import('../memory/memory-scope.js');
  const { withScopeViews, listFactsByScope, describeScope } = await import('./memory-scope-views.js');
  const made = projects.createProject({ name: 'Memory Views' });
  if (!made.ok) throw new Error('fixture');
  const inProject = rememberFact({ kind: 'project', content: 'Memory Views closes its books on the fifth.', scope: { projectId: made.project.id, agentKey: null } });
  const byAgentThere = rememberFact({ kind: 'feedback', content: 'Route Analyst rounds to whole numbers in Memory Views.',
    scope: { projectId: made.project.id, agentKey: agentScopeKey(analyst) } });
  const everywhere = rememberFact({ kind: 'reference', content: 'The office printer is on the second floor.', scope: null });

  assert.deepEqual(withScopeViews([inProject, byAgentThere, everywhere]).map((fact) => [fact.scope.kind, fact.scope.projectName, fact.scope.agentName]), [
    ['project', 'Memory Views', null], ['project_agent', 'Memory Views', 'Route Analyst'], ['user', null, null]]);
  assert.deepEqual(listFactsByScope({ everywhereOnly: false, projectId: made.project.id, agentId: null }, { limit: 20 }).facts.map((fact) => fact.id).sort(),
    [inProject.id, byAgentThere.id].sort(), 'a project lists what its agents learned in it too');
  assert.deepEqual(listFactsByScope({ everywhereOnly: false, projectId: null, agentId: analyst.id }, { limit: 20 }).facts.map((fact) => fact.id), [byAgentThere.id]);
  assert.ok(listFactsByScope({ everywhereOnly: true, projectId: null, agentId: null }, { limit: 50 }).facts.every((fact) => fact.id !== inProject.id));
  assert.equal(describeScope({ projectId: null, agentKey: 'route-analyst@1999-01-01T00:00:00.000Z' }).agentName, null,
    'a memory kept for an earlier agent of the same name is not shown under the new one\'s name');

  const moved = await phone('post', `/api/memory/facts/${inProject.id}/scope`, { projectId: null, agentId: null });
  assert.deepEqual([moved.status, moved.body.fact.scope.kind], [200, 'user']);
  assert.deepEqual(factScope(inProject.id), { projectId: null, agentKey: null });
  const back = await desktop('post', `/api/console/memory/facts/${inProject.id}/scope`, { projectId: made.project.id, agentId: analyst.id });
  assert.deepEqual([back.body.fact.scope.kind, back.body.fact.scope.agentName], ['project_agent', 'Route Analyst']);
  assert.equal((await desktop('post', '/api/console/memory/facts/999999/scope', { projectId: null, agentId: null })).status, 404);
  assert.equal((await desktop('post', `/api/console/memory/facts/${inProject.id}/scope`, { projectId: 'prj_aaaaaaaaaaaaaa', agentId: null })).body.error, 'PROJECT_NOT_FOUND');
  assert.equal((await desktop('post', '/api/console/memory/facts/nope/scope', {})).status, 400);
});
