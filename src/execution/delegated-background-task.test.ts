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
  assert.equal(own.kind === 'bound' && own.model, undefined, 'a task from a conversation already in the agent keeps the model it always ran on');
  // ...and one that is not assigned to the project does not block the task,
  // and is not replaced by somebody the router would have suggested.
  setSessionAgent(chat.id, outsider.id, { by: 'owner' });
  const notAssigned = await resolveTaskDelegation({ sessionId: chat.id, objective: 'x' }, { selectAgent: never });
  assert.equal(notAssigned.kind === 'bound' && notAssigned.delegation.agentId, null);
  assert.equal(notAssigned.kind === 'bound' && notAssigned.delegation.projectId, sales.id);
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

test('a correction to work that has ended goes to the same owner as a task that follows it', async () => {
  for (const existing of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(existing.id);
  const { correctDelegatedTask } = await import('../projects/task-follow-up.js');
  const origin = createSession({ id: 'follow-origin', kind: 'chat' });
  const first = tasks.createBackgroundTask({ title: 'Draft the briefing', prompt: 'Objective: Draft the briefing from the ledger', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name, assignedBy: 'clem', originSourceUserSeq: 3 } });

  // Open: the same task, the next version.
  tasks.markBackgroundTaskRunning(first.id);
  const revised = correctDelegatedTask(first.id, { instruction: 'Use whole numbers only.', by: 'owner' });
  assert.equal(revised.kind, 'revised');
  assert.equal(revised.kind === 'revised' && revised.task.id, first.id);
  assert.equal(revised.kind === 'revised' && revised.task.contractVersion, 2);
  assert.equal(tasks.listBackgroundTasks({ includeArchived: false }).filter((task) => task.originSessionId === origin.id).length, 1);

  // Ended: a task that follows it, for the same agent in the same project.
  assert.equal(tasks.markBackgroundTaskDone(first.id, 'Draft saved. Total 367,000 across 26 records.')?.status, 'done');
  const followed = correctDelegatedTask(first.id, { instruction: 'Focus on this week and exclude unqualified leads.', sourceUserSeq: 9, by: 'owner' });
  assert.equal(followed.kind, 'followed');
  if (followed.kind !== 'followed') return;
  assert.notEqual(followed.task.id, first.id);
  assert.deepEqual([followed.task.delegation?.agentId, followed.task.delegation?.projectId, followed.task.delegation?.followsTaskId,
    followed.task.delegation?.assignedBy, followed.task.delegation?.originSourceUserSeq, followed.task.originSessionId],
    [analyst.id, sales.id, first.id, 'owner', 9, origin.id]);
  assert.match(followed.task.prompt, /Correction: Focus on this week and exclude unqualified leads\./);
  assert.match(followed.task.prompt, /Correction v2: Use whole numbers only\./, 'what the first task was already told still stands');
  assert.match(followed.task.prompt, /Its report began:\nDraft saved\. Total 367,000/);
  assert.equal(tasks.getBackgroundTask(first.id)?.status, 'done', 'the finished task is not reopened or rewritten');
  assert.equal(tasks.getBackgroundTask(first.id)?.contractVersion, 2);
  assert.equal(getSession(followed.task.runSessionId)?.metadata?.agentId, analyst.id);

  // Said twice, or corrected again while the follow-up is open: the same follow-up, its next version.
  const again = correctDelegatedTask(first.id, { instruction: 'And round to thousands.', by: 'owner' });
  assert.deepEqual([again.kind, again.kind === 'followed' && again.task.id, again.kind === 'followed' && again.task.contractVersion],
    ['followed', followed.task.id, 2]);
  assert.equal(tasks.listBackgroundTasks({ includeArchived: false }).filter((task) => task.originSessionId === origin.id).length, 2,
    'one finished task and one follow-up, however often the correction is sent');

  let prompt = '';
  const assistant = { getRuntime: () => ({}) as never,
    async respond(request: { message: string; sessionId: string }) { prompt = request.message; return { text: 'Done. Corrected draft saved.', sessionId: request.sessionId, stoppedReason: 'success' as const }; } };
  assert.equal(await tasks.processBackgroundTasks(assistant as never, 1), 1);
  assert.match(prompt, new RegExp(`This follows task ${first.id}, which you finished\\. The owner has corrected it\\.`));
  assert.ok(states(origin.id).some((row) => row.taskId === followed.task.id && row.followsTaskId === first.id && row.phase === 'dispatched'));

  assert.deepEqual(correctDelegatedTask(first.id, { instruction: 'no', by: 'owner' }), { kind: 'refused', reason: 'instruction_required' });
  assert.deepEqual(correctDelegatedTask('bg-none', { instruction: 'anything at all', by: 'owner' }), { kind: 'refused', reason: 'task_not_found' });
  const plain = tasks.createBackgroundTask({ title: 'Plain', prompt: 'plain', source: 'desktop' });
  assert.deepEqual(correctDelegatedTask(plain.id, { instruction: 'anything at all', by: 'owner' }), { kind: 'refused', reason: 'not_delegated' });
});

test('work that stopped before it finished is corrected in place, and only the owner restarts it', async () => {
  for (const existing of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(existing.id);
  const { correctDelegatedTask } = await import('../projects/task-follow-up.js');
  const origin = createSession({ id: 'cut-off-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Send the summaries', prompt: 'Objective: Send the summaries', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name, assignedBy: 'clem' } });
  tasks.markBackgroundTaskRunning(task.id);
  assert.equal(tasks.markBackgroundTaskFailed(task.id, 'The app restarted while this was running.', 'interrupted')?.status, 'interrupted');
  assert.equal(states(origin.id).filter((row) => row.taskId === task.id).at(-1)?.phase, 'parked', 'cut off by a restart is not shown as a failure');

  // Relayed by the model: nothing restarts, nothing new starts.
  assert.deepEqual(correctDelegatedTask(task.id, { instruction: 'Leave out the draft ones.', by: 'clem' }), { kind: 'refused', reason: 'resume_first' });
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'interrupted');

  // From the owner: the same task and run take the correction.
  const corrected = correctDelegatedTask(task.id, { instruction: 'Leave out the draft ones.', by: 'owner' });
  assert.equal(corrected.kind, 'revised');
  if (corrected.kind !== 'revised') return;
  assert.deepEqual([corrected.task.id, corrected.task.runSessionId, corrected.resumed, corrected.task.contractRevisions?.at(-1)?.instruction],
    [task.id, task.runSessionId, true, 'Leave out the draft ones.']);
  assert.ok(!['interrupted', 'failed', 'aborted', 'done'].includes(corrected.task.status), corrected.task.status);
  assert.deepEqual(tasks.listBackgroundTasks({ includeArchived: false }).filter((row) => row.originSessionId === origin.id).map((row) => row.id), [task.id],
    'no second task exists to repeat what the first already wrote');
});

test('a delegated run given to one agent does not mount another saved later under the same name', () => {
  const session = createSession({ id: 'background:bg-renamed-0a0a0a', kind: 'execution',
    metadata: { delegatedTaskId: 'bg-renamed-0a0a0a', agentId: analyst.id, agentName: analyst.name, delegatedAgentCreatedAt: '1999-01-01T00:00:00.000Z' } });
  const mount = composition.composeSession({ sessionId: session.id, sessionKind: session.kind, metadata: getSession(session.id)?.metadata ?? null });
  assert.equal(mount.agent, null);
});


test('work moved to the background from a project finds its agent once, when it starts', async () => {
  for (const existing of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(existing.id);
  const { enqueueDurableChatTask } = await import('./background-promote.js');
  const { _setOpenAgentChooserForTests } = await import('../projects/inherited-delegation.js');
  const { delegatedWorkPointers } = await import('../projects/delegated-work-pointers.js');
  const origin = createSession({ id: 'promoted-origin', kind: 'chat' });
  setSessionProject(origin.id, sales.id, { by: 'owner' });

  const queued = enqueueDurableChatTask({ message: 'Have the Briefing Analyst draft the weekly briefing.', sessionId: origin.id, source: 'desktop' });
  assert.deepEqual([queued.delegation?.projectId, queued.delegation?.agentId, queued.delegation?.agentChoice], [sales.id, null, 'open']);

  const asked: string[] = [];
  _setOpenAgentChooserForTests(async (objective, candidates) => { asked.push(`${objective}|${candidates.map((row) => row.name).join(',')}`); return { id: analyst.id }; });
  let prompt = '';
  const assistant = { getRuntime: () => ({}) as never,
    async respond(request: { message: string; sessionId: string }) { prompt = request.message; return { text: 'Done. Draft saved.', sessionId: request.sessionId, stoppedReason: 'success' as const }; } };
  try {
    assert.equal(await tasks.processBackgroundTasks(assistant as never, 1), 1);
  } finally {
    _setOpenAgentChooserForTests(null);
  }
  assert.deepEqual(asked, ['Have the Briefing Analyst draft the weekly briefing.|Briefing Analyst']);
  const ran = tasks.getBackgroundTask(queued.id)!;
  assert.deepEqual([ran.delegation?.agentId, ran.delegation?.assignedBy, ran.delegation?.agentChoice], [analyst.id, 'router', undefined]);
  assert.match(prompt, /Clem delegated this task to you, Briefing Analyst\./);
  assert.equal(getSession(ran.runSessionId)?.metadata?.agentId, analyst.id);

  // The conversation is told what was delegated, who owns it, and what to do with a correction.
  const pointers = delegatedWorkPointers(origin.id);
  assert.match(pointers, new RegExp(`- ${queued.id} ".*": Briefing Analyst in Delegated Sales, `));
  assert.match(pointers, /hand the change to the task: delegated_task_correct with id \(the task id below\) and instruction/);
  assert.match(pointers, /unless the owner asks you to do it here yourself; then do it here\./,
    'the owner can still have Clem do a piece of the work in the conversation');
  // Another conversation in the same project is told too; one outside it is not.
  const sibling = createSession({ id: 'promoted-sibling', kind: 'chat' });
  setSessionProject(sibling.id, sales.id, { by: 'owner' });
  assert.match(delegatedWorkPointers(sibling.id), new RegExp(queued.id));
  assert.equal(delegatedWorkPointers(createSession({ id: 'promoted-outsider', kind: 'chat' }).id), '');
});

test('the conversation is told where unfinished delegated work lands and why it stopped', async () => {
  for (const existing of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(existing.id);
  const { delegatedWorkPointers } = await import('../projects/delegated-work-pointers.js');
  const origin = createSession({ id: 'paused-output-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Build the briefing page', prompt: 'Objective: Build the briefing page', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name,
      assignedBy: 'clem', artifactDestination: '/tmp/briefing-page' } });
  assert.match(delegatedWorkPointers(origin.id), /waiting to start\. Its output goes to: \/tmp\/briefing-page \(may be partial\)/);
  tasks.markBackgroundTaskRunning(task.id);
  const { RETAINED_WORK_TERMINAL_HEADER } = await import('../runtime/harness/retained-work-checkpoint.js');
  tasks.markBackgroundTaskFailed(task.id, `Two evidence items failed.\n${RETAINED_WORK_TERMINAL_HEADER}\n- handle-1`, 'interrupted');
  const pointers = delegatedWorkPointers(origin.id);
  assert.match(pointers, /Its output goes to: \/tmp\/briefing-page \(may be partial\); stopped because: Two evidence items failed\./);
  assert.doesNotMatch(pointers, /handle-1/, 'the reason, without the saved-work handles');
});

test('the agent running a delegated job checks in with the conversation that handed it over, under its own name', async () => {
  const origin = createSession({ id: 'lead-check-in-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Build the fixture audit', prompt: 'Objective: Build the fixture audit', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name, assignedBy: 'owner' } });
  // The run's own session carries the job it is doing.
  const run = createSession({ id: 'background:lead-check-in-run', kind: 'execution', metadata: { delegatedTaskId: task.id } } as never);
  const { registerAutonomyActionTools } = await import('../tools/autonomy-action-tools.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
  registerAutonomyActionTools({ tool(name: string, _d: unknown, _s: unknown, handler: never) { handlers.set(name, handler); } } as never);
  const posted = await withToolOutputContext({ sessionId: run.id }, () => handlers.get('check_in')!({ note: 'Plan: four workers — rankings, competitors, backlinks, site QA.' }));
  assert.match(posted.content[0]!.text, /posted to the conversation that handed you this job/);
  tasks.recordDelegatedCheckIn(task.id, '3 of 4 done; backlinks partial.');

  const record = tasks.getBackgroundTask(task.id)!;
  assert.deepEqual(record.checkIns?.map((entry) => entry.note), ['Plan: four workers — rankings, competitors, backlinks, site QA.', '3 of 4 done; backlinks partial.']);
  const said = states(origin.id).filter((state) => state.phase === 'check_in');
  assert.deepEqual(said.map((state) => [state.agentName, state.note]), [
    ['Briefing Analyst', 'Plan: four workers — rankings, competitors, backlinks, site QA.'],
    ['Briefing Analyst', '3 of 4 done; backlinks partial.'],
  ]);
  const projected = listEvents(origin.id, { types: ['delegated_task_state'] }).filter((event) => event.data.phase === 'check_in')
    .map((event) => projectHarnessEventForPublic(event as never));
  assert.equal((projected.at(-1) as { data?: { note?: string } } | null)?.data?.note ?? (projected.at(-1) as { note?: string } | null)?.note,
    '3 of 4 done; backlinks partial.', 'the check-in reaches the apps through the public stream');
  const { delegatedTaskView } = await import('../projects/project-views.js');
  assert.deepEqual(delegatedTaskView(record).checkIns.map((entry) => entry.note).at(-1), '3 of 4 done; backlinks partial.');

  const plain = tasks.createBackgroundTask({ title: 'Plain', prompt: 'do it', originSessionId: origin.id, source: 'desktop' });
  assert.equal(tasks.recordDelegatedCheckIn(plain.id, 'note'), null, 'a task nobody was handed has no one to check in with');
});

test('a worker inside a lead run does not post check-ins or notifications; it returns what it found', async () => {
  const origin = createSession({ id: 'worker-post-origin', kind: 'chat' });
  const task = tasks.createBackgroundTask({ title: 'Lead job', prompt: 'Objective: lead job', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: analyst.id, agentName: analyst.name, agentCreatedAt: analyst.createdAt, projectId: sales.id, projectName: sales.name, assignedBy: 'owner' } });
  const run = createSession({ id: 'background:worker-post-run', kind: 'execution', metadata: { delegatedTaskId: task.id } } as never);
  const { registerAutonomyActionTools } = await import('../tools/autonomy-action-tools.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
  registerAutonomyActionTools({ tool(name: string, _d: unknown, _s: unknown, handler: never) { handlers.set(name, handler); } } as never);
  const asWorker = <T>(work: () => Promise<T>) => harnessRunContextStorage.run({ sessionId: run.id, workerScope: true } as never,
    () => withToolOutputContext({ sessionId: run.id }, work) as Promise<T>);
  const checkIn = await asWorker(() => handlers.get('check_in')!({ note: 'worker progress' }));
  const notify = await asWorker(() => handlers.get('notify_user')!({ title: 'x', body: 'y' }));
  for (const result of [checkIn, notify]) assert.match(result.content[0]!.text, /A worker does not post/);
  assert.equal(tasks.getBackgroundTask(task.id)?.checkIns, undefined);
  assert.deepEqual(states(origin.id).filter((state) => state.phase === 'check_in'), []);
});
