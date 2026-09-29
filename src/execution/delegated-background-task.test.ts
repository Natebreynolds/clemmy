/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/delegated-background-task.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-delegated-task-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const tasks = await import('./background-tasks.js');
const projects = await import('../projects/project-record.js');
const { resolveTaskDelegation } = await import('../projects/task-delegation.js');
const { setSessionProject } = await import('../projects/session-project.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { createAgentRecord } = await import('../agents/agent-record.js');
const { createSession, getSession, listEvents, closeEventLog } = await import('../runtime/harness/eventlog.js');
const composition = await import('../runtime/harness/session-composition.js');
const { projectHarnessEventForPublic } = await import('../runtime/harness/public-presentation.js');

tasks._setBackgroundResponseExecutorForTests((assistant, request) => assistant.respond(request));
after(() => {
  tasks._setBackgroundResponseExecutorForTests(null);
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function agent(name: string, extra: Record<string, unknown> = {}) {
  const made = createAgentRecord({ name, handles: `${name} handles`, instructions: `Standing instructions of ${name}.`, createdFrom: 'console', ...extra });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.agent;
}
function project(name: string, extra: Record<string, unknown> = {}) {
  const made = projects.createProject({ name, ...extra });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.project;
}
const states = (sessionId: string) => listEvents(sessionId, { types: ['delegated_task_state'] }).map((event) => event.data);

const analyst = agent('Briefing Analyst');
const outsider = agent('Outside Desk');
const sales = project('Delegated Sales', { purpose: 'Weekly sales briefing.', context: 'A "lead" is an open opportunity.' });
projects.saveAssignment(sales.id, { agentId: analyst.id, agentCreatedAt: analyst.createdAt, responsibility: 'Prepare the weekly briefing.' });

test('who does the work is decided once: names are checked, the association is explicit, nothing is guessed', async () => {
  const chat = createSession({ id: 'delegating-chat', kind: 'chat' });
  const never = async () => { throw new Error('the router is asked only when nobody was named and someone is assigned'); };

  assert.deepEqual(await resolveTaskDelegation({ sessionId: chat.id, objective: 'Draft the briefing.' }, { selectAgent: never }), { kind: 'none' },
    'a conversation in no project and no agent delegates as it always has');

  const unknownAgent = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x', agent: 'Nobody Saved' }, { selectAgent: never });
  assert.equal(unknownAgent.kind, 'refuse');
  assert.match(unknownAgent.kind === 'refuse' ? unknownAgent.reason : '', /not one of the owner's saved agents, so no task started\. Saved agents: .*Briefing Analyst/);
  const unknownProject = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x', project: 'No Such Project' }, { selectAgent: never });
  assert.match(unknownProject.kind === 'refuse' ? unknownProject.reason : '', /not one of the owner's active projects, so no task started\. Active projects: .*Delegated Sales/);

  const unassigned = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x', agent: 'Outside Desk', project: 'delegated sales' }, { selectAgent: never });
  assert.match(unassigned.kind === 'refuse' ? unassigned.reason : '', /Outside Desk is not assigned to the project Delegated Sales, so no task started\. Assigned to it: Briefing Analyst\./);

  const named = await resolveTaskDelegation({ sessionId: chat.id, sourceUserSeq: 41, objective: 'Draft the briefing.',
    agent: 'briefing analyst', project: sales.id, artifactDestination: '  a draft   here in chat ' }, { selectAgent: never });
  assert.equal(named.kind, 'bound');
  if (named.kind !== 'bound') return;
  assert.deepEqual(named.delegation, { agentId: analyst.id, agentName: 'Briefing Analyst', agentCreatedAt: analyst.createdAt,
    projectId: sales.id, projectName: 'Delegated Sales', artifactDestination: 'a draft here in chat', assignedBy: 'clem', originSourceUserSeq: 41 });
  assert.ok(named.model, 'a delegated task runs on the helper role unless the agent asks for a model');

  // Nobody named: the conversation's own project, and the router's choice among those assigned.
  setSessionProject(chat.id, sales.id, { by: 'owner' });
  const asked: string[][] = [];
  const routed = await resolveTaskDelegation({ sessionId: chat.id, objective: 'Draft the weekly briefing.' }, {
    selectAgent: async (_objective, candidates) => { asked.push(candidates.map((row) => `${row.name}|${row.handles}`)); return { id: analyst.id }; },
  });
  assert.deepEqual(asked, [['Briefing Analyst|Prepare the weekly briefing. · Briefing Analyst handles']]);
  assert.equal(routed.kind === 'bound' && routed.delegation.assignedBy, 'router');
  assert.equal(routed.kind === 'bound' && routed.delegation.agentId, analyst.id);

  const unsure = await resolveTaskDelegation({ sessionId: chat.id, objective: 'Book a flight.' }, { selectAgent: async () => null });
  assert.equal(unsure.kind === 'bound' && unsure.delegation.agentId, null, 'an unsure router hands the task to nobody');
  assert.equal(unsure.kind === 'bound' && unsure.delegation.projectId, sales.id);
  assert.equal(unsure.kind === 'bound' && unsure.model, undefined, 'without an agent the task runs as it always has');
  const invented = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x' }, { selectAgent: async () => ({ id: outsider.id }) });
  assert.equal(invented.kind === 'bound' && invented.delegation.agentId, null, 'an answer outside the list is no answer');

  // The conversation is already in an agent: the owner chose it, the router is not asked.
  setSessionAgent(chat.id, analyst.id, { by: 'owner' });
  const own = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x' }, { selectAgent: never });
  assert.equal(own.kind === 'bound' && own.delegation.assignedBy, 'owner');
  // ...and one that is not assigned to the project does not block the task.
  setSessionAgent(chat.id, outsider.id, { by: 'owner' });
  const notAssigned = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x' }, { selectAgent: async () => null });
  assert.equal(notAssigned.kind === 'bound' && notAssigned.delegation.agentId, null);
});

test('a task nobody delegated is exactly what it was', async () => {
  const origin = createSession({ id: 'plain-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Plain task', prompt: 'do the plain thing', originSessionId: origin.id, source: 'desktop' });
  assert.equal(task.delegation, undefined);
  let prompt = '';
  const assistant = { getRuntime: () => ({}) as never,
    async respond(request: { message: string; sessionId: string }) { prompt = request.message; return { text: 'Done.', sessionId: request.sessionId, stoppedReason: 'success' as const }; } };
  assert.equal(await tasks.processBackgroundTasks(assistant as never, 1), 1);
  assert.doesNotMatch(prompt, /Delegated Task/);
  assert.deepEqual(states(origin.id), []);
  const mount = composition.composeSessionFromStore(task.runSessionId);
  assert.deepEqual([mount.agent, mount.project], [null, null]);
  assert.equal(getSession(task.runSessionId)?.metadata?.delegatedTaskId, undefined);
});

test('a delegated task runs as its agent in its project, and the conversation that delegated it sees each real change', async () => {
  for (const existing of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(existing.id);
  const origin = createSession({ id: 'delegating-origin', kind: 'chat' });
  const delegation = { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt,
    projectId: sales.id, projectName: sales.name, artifactDestination: 'a draft here in chat', assignedBy: 'clem' as const, originSourceUserSeq: 7 };
  const task = tasks.createBackgroundTask({ title: 'Draft the weekly briefing', prompt: 'Objective: Draft the weekly briefing',
    originSessionId: origin.id, source: 'desktop', delegation });
  assert.deepEqual(task.delegation, delegation);

  // The identity is on the run session before anything runs, frozen from the task.
  const before = getSession(task.runSessionId);
  assert.equal(before?.kind, 'execution');
  assert.deepEqual([before?.metadata?.delegatedTaskId, before?.metadata?.agentId, before?.metadata?.projectId, before?.metadata?.delegatedFromSessionId],
    [task.id, analyst.id, sales.id, origin.id]);
  setSessionProject(origin.id, null, { by: 'owner' });

  let prompt = '';
  let mounted = '';
  const assistant = { getRuntime: () => ({}) as never,
    async respond(request: { message: string; sessionId: string }) {
      prompt = request.message;
      mounted = composition.sessionMountContext(composition.composeSessionFromStore(request.sessionId));
      return { text: 'Done. The draft briefing is attached with its sources.', sessionId: request.sessionId, stoppedReason: 'success' as const };
    } };
  assert.equal(await tasks.processBackgroundTasks(assistant as never, 1), 1);

  assert.match(prompt, /## Delegated Task\nClem delegated this task to you, Briefing Analyst\./);
  assert.match(prompt, /It belongs to the project Delegated Sales, whose context is above\./);
  assert.match(prompt, /Put the result here: a draft here in chat/);
  assert.match(prompt, /saying it is finished does not make it so/);
  assert.ok(mounted.indexOf('## Working as Briefing Analyst') >= 0 && mounted.indexOf('## Project: Delegated Sales') > 0, mounted.slice(0, 200));
  assert.match(mounted, /Responsible for: Prepare the weekly briefing\./);

  const seen = states(origin.id);
  assert.deepEqual(seen.slice(0, 2).map((row) => [row.phase, row.taskId, row.agentName, row.projectName, row.contractVersion, row.sourceUserSeq]), [
    ['dispatched', task.id, 'Briefing Analyst', 'Delegated Sales', 1, 7],
    ['started', task.id, 'Briefing Analyst', 'Delegated Sales', 1, 7],
  ]);
  const last = seen.at(-1)!;
  assert.ok(['finished', 'parked', 'failed'].includes(String(last.phase)), `a terminal or parked state is announced: ${String(last.phase)}`);
  assert.equal(last.status, tasks.getBackgroundTask(task.id)?.status, 'the announcement is the record\'s own status');
});

test('a correction revises the same task, is announced with its version, and a stop is announced as a stop', () => {
  const origin = createSession({ id: 'steering-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Draft the briefing', prompt: 'Objective: Draft the briefing', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name, assignedBy: 'owner' } });
  tasks.markBackgroundTaskRunning(task.id);
  const revised = tasks.reviseBackgroundTaskContract(task.id, { instruction: 'Focus on this week and exclude unqualified leads.', evidencePolicy: 'revalidate' });
  assert.equal(revised?.id, task.id);
  assert.equal(revised?.runSessionId, task.runSessionId);
  assert.equal(revised?.contractVersion, 2);
  const asked = tasks.markBackgroundTaskAwaitingInput(task.id, 'q-region', 'Which region should the briefing cover?');
  assert.equal(asked?.status, 'awaiting_input');
  tasks.cancelBackgroundTask(task.id, 'Stopped by the owner.');

  const seen = states(origin.id);
  const revision = seen.find((row) => row.phase === 'revised')!;
  assert.deepEqual([revision.contractVersion, revision.instruction, revision.evidencePolicy, revision.agentName],
    [2, 'Focus on this week and exclude unqualified leads.', 'revalidate', 'Briefing Analyst']);
  assert.deepEqual(seen.map((row) => row.phase).filter((phase) => phase === 'dispatched' || phase === 'started'), ['dispatched', 'started']);
  const waiting = seen.find((row) => row.phase === 'needs_you')!;
  assert.match(String(waiting.question), /Which region should the briefing cover\?/);
  assert.equal(waiting.status, 'awaiting_input');
  assert.equal(seen.at(-1)?.phase, 'stopped');
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'aborted');

  // What reaches a client is bounded and carries nothing it was not given.
  const event = listEvents(origin.id, { types: ['delegated_task_state'] }).find((row) => row.data.phase === 'revised')!;
  const projected = projectHarnessEventForPublic(event);
  assert.deepEqual(Object.keys((projected?.data ?? {}) as Record<string, unknown>).sort(),
    ['agentId', 'agentName', 'contractVersion', 'evidencePolicy', 'instruction', 'phase', 'projectId', 'projectName', 'status', 'taskId', 'title']);
});
