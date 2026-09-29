/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/session-project.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-project-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const projects = await import('./project-record.js');
const { setSessionProject, sessionProjectState, projectHandoffNote } = await import('./session-project.js');
const { bindProject, resolveProjectBinding } = await import('./project-binding.js');
const { createAgentRecord, deleteAgentRecord } = await import('../agents/agent-record.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { createSession, getSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');
const composition = await import('../runtime/harness/session-composition.js');

after(() => {
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function project(name: string, extra: Record<string, unknown> = {}) {
  const made = projects.createProject({ name, ...extra });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.project;
}
function agent(name: string, instructions = '') {
  const made = createAgentRecord({ name, handles: `${name} handles`, instructions, createdFrom: 'console' });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.agent;
}

test('a conversation with no project and no agent mounts nothing, byte for byte', () => {
  const session = createSession({ id: 'plain-chat', kind: 'chat' });
  const mount = composition.composeSessionFromStore(session.id);
  assert.equal(mount.agent, null);
  assert.equal(mount.project, null);
  assert.equal(composition.sessionMountContext(mount), '');
  assert.deepEqual(composition.sessionProjectFields(session.id), {});
  assert.deepEqual(mount.pinnedTools, []);
  assert.equal(composition.sessionAgentReviewContext(session.id), '');
});

test('the pointer moves, takes effect on the next read, and remembers where the conversation has worked', () => {
  const sales = project('Weekly Sales', { purpose: 'Prepare the weekly sales briefing.' });
  const hiring = project('Hiring Round');
  const session = createSession({ id: 'moving-chat', kind: 'chat' });

  const first = setSessionProject(session.id, sales.id, { by: 'owner' });
  assert.deepEqual(first, { ok: true, changed: true, projectId: sales.id, projectName: 'Weekly Sales' });
  assert.deepEqual(setSessionProject(session.id, sales.id, { by: 'owner' }),
    { ok: true, changed: false, projectId: sales.id, projectName: 'Weekly Sales' }, 'repeating the call is safe');
  assert.equal(composition.composeSessionFromStore(session.id).project?.project.id, sales.id);

  setSessionProject(session.id, hiring.id, { by: 'clem' });
  const state = sessionProjectState(getSession(session.id)?.metadata);
  assert.deepEqual([state.projectId, state.projectIds], [hiring.id, [sales.id, hiring.id]]);
  assert.equal(getSession(session.id)?.metadata?.projectSetBy, 'clem');

  assert.deepEqual(setSessionProject(session.id, null, { by: 'owner' }), { ok: true, changed: true, projectId: null, projectName: null });
  const cleared = sessionProjectState(getSession(session.id)?.metadata);
  assert.deepEqual([cleared.projectId, cleared.projectIds], [null, [sales.id, hiring.id]]);
  assert.equal(composition.composeSessionFromStore(session.id).project, null);
});

test('a project that cannot be worked in is refused, and so is anything that is not a conversation', () => {
  const archived = project('Put Away');
  projects.archiveProject(archived.id);
  const session = createSession({ id: 'refusing-chat', kind: 'chat' });
  assert.deepEqual(setSessionProject(session.id, archived.id, { by: 'owner' }), { ok: false, reason: 'project_archived' });
  assert.deepEqual(setSessionProject(session.id, 'prj_aaaaaaaaaaaaaa', { by: 'owner' }), { ok: false, reason: 'project_not_found' });
  assert.deepEqual(setSessionProject(session.id, 'Weekly Sales', { by: 'owner' }), { ok: false, reason: 'project_not_found' }, 'a name is not an id');
  assert.deepEqual(setSessionProject('no-such-session', archived.id, { by: 'owner' }), { ok: false, reason: 'session_not_found' });
  const dock = createSession({ id: 'space-fixture-board', kind: 'chat' });
  assert.deepEqual(setSessionProject(dock.id, archived.id, { by: 'owner' }), { ok: false, reason: 'not_a_conversation' });
  const step = createSession({ id: 'workflow:run-1:step-1', kind: 'workflow' });
  assert.deepEqual(setSessionProject(step.id, archived.id, { by: 'owner' }), { ok: false, reason: 'not_a_conversation' });

  // A project archived after the conversation entered it stops applying.
  const live = project('Closing Soon');
  setSessionProject(session.id, live.id, { by: 'owner' });
  projects.archiveProject(live.id);
  assert.equal(composition.composeSessionFromStore(session.id).project, null);
});

test('one agent in two projects gets each project\'s context and never the other\'s', () => {
  const helper = agent('Fixture Analyst', 'Answer with the figures first.');
  const sales = project('Sales Fixture', { purpose: 'Weekly sales briefing.', context: 'A "lead" is an open opportunity.' });
  const hiring = project('Hiring Fixture', { purpose: 'Hire two engineers.', context: 'A "lead" is the hiring manager.' });
  projects.saveResource(sales.id, { kind: 'account', toolkit: 'ledgerscope', accountId: 'acct-sales-east', label: 'East', verifiedAt: '2026-09-29T00:00:00.000Z' });
  projects.saveResource(hiring.id, { kind: 'account', toolkit: 'ledgerscope', accountId: 'acct-people-ops', label: 'People' });
  projects.saveAssignment(sales.id, { agentId: helper.id, agentCreatedAt: helper.createdAt, responsibility: 'Prepare the briefing.', context: 'Exclude unqualified leads.' });
  projects.saveAssignment(hiring.id, { agentId: helper.id, agentCreatedAt: helper.createdAt, responsibility: 'Summarise applicants.', context: 'Never name a candidate in a channel.' });

  const inSales = resolveProjectBinding(sales.id, { agentId: helper.id })!;
  const inHiring = resolveProjectBinding(hiring.id, { agentId: helper.id })!;
  assert.match(inSales.context, /## Project: Sales Fixture/);
  assert.match(inSales.context, /open opportunity/);
  assert.match(inSales.context, /acct-sales-east; verified\)/);
  assert.doesNotMatch(inSales.context, /20\d\d-\d\d-\d\d/, 'no date in the stable prefix: confirming the same account again must not change it');
  assert.match(inSales.context, /### Your part in this project\nResponsible for: Prepare the briefing\./);
  assert.match(inSales.context, /Exclude unqualified leads\./);
  for (const foreign of [/hiring manager/, /acct-people-ops/, /Summarise applicants/, /candidate/, /Hiring Fixture/]) {
    assert.doesNotMatch(inSales.context, foreign, String(foreign));
  }
  assert.match(inHiring.context, /acct-people-ops; not verified/);
  for (const foreign of [/open opportunity/, /acct-sales-east/, /Exclude unqualified/, /Sales Fixture/]) {
    assert.doesNotMatch(inHiring.context, foreign, String(foreign));
  }
  assert.notEqual(inSales.revision, inHiring.revision);

  // The rendering is named by its content: any change to what the work sees changes it.
  const before = inSales.revision;
  projects.saveAssignment(sales.id, { agentId: helper.id, context: 'Exclude unqualified leads. Focus on this week.' });
  assert.notEqual(resolveProjectBinding(sales.id, { agentId: helper.id })!.revision, before);

  // In a conversation: the agent's own context first, then the project's.
  const session = createSession({ id: 'agent-in-project', kind: 'chat' });
  setSessionAgent(session.id, helper.id, { by: 'owner' });
  setSessionProject(session.id, hiring.id, { by: 'owner' });
  const mount = composition.composeSessionFromStore(session.id);
  const text = composition.sessionMountContext(mount);
  assert.ok(text.indexOf('## Working as Fixture Analyst') < text.indexOf('## Project: Hiring Fixture'));
  assert.match(text, /Summarise applicants/);
  assert.doesNotMatch(text, /Sales Fixture|acct-sales-east|open opportunity/);
  const fields = composition.sessionProjectFields(session.id);
  assert.deepEqual([fields.projectId, fields.projectName, fields.projectRevision], [hiring.id, 'Hiring Fixture', mount.project!.revision]);
  assert.match(composition.sessionAgentReviewContext(session.id), /Agent: Fixture Analyst[\s\S]*Project context:\n## Project: Hiring Fixture/);

  // Clem in the same project sees who is assigned, and no one's private part.
  setSessionAgent(session.id, null, { by: 'owner' });
  const asClem = composition.sessionMountContext(composition.composeSessionFromStore(session.id));
  assert.match(asClem, /Agents assigned to this project:\n- Fixture Analyst: Summarise applicants\./);
  assert.doesNotMatch(asClem, /Your part in this project|Never name a candidate/);
});

test('an agent replaced under the same name does not receive the earlier agent\'s part', () => {
  const original = agent('Replaceable Desk');
  const work = project('Replacement Fixture');
  projects.saveAssignment(work.id, { agentId: original.id, agentCreatedAt: '2026-01-01T00:00:00.000Z',
    responsibility: 'Original duty.', context: 'Written for the original.' });
  const bound = bindProject(projects.getProject(work.id)!, { agentId: original.id });
  assert.equal(bound.assignment, null, 'the record now saved under that id was created at another time');
  assert.doesNotMatch(bound.context, /Written for the original/);
  deleteAgentRecord(original.id);
  assert.equal(bindProject(projects.getProject(work.id)!, { agentId: original.id }).assignment, null);
});

test('a task the host delegated mounts its agent and project; other unattended work mounts neither', () => {
  const helper = agent('Delegated Desk', 'Work quietly.');
  const work = project('Delegation Fixture', { purpose: 'Carry a delegated task.' });
  projects.saveAssignment(work.id, { agentId: helper.id, agentCreatedAt: helper.createdAt, responsibility: 'Draft the report.' });
  const identity = { agentId: helper.id, agentName: helper.name, projectId: work.id, projectName: work.name };
  const delegated = createSession({ id: 'background:bg-delegated', kind: 'execution', metadata: { ...identity, delegatedTaskId: 'bg-delegated' } });
  const mounted = composition.composeSessionFromStore(delegated.id);
  assert.equal(mounted.kind, 'execution');
  assert.equal(mounted.agent?.agent.id, helper.id);
  assert.equal(mounted.project?.assignment?.responsibility, 'Draft the report.');
  const unattended = createSession({ id: 'background:bg-plain', kind: 'execution', metadata: identity });
  const plain = composition.composeSessionFromStore(unattended.id);
  assert.deepEqual([plain.agent, plain.project], [null, null], 'identity fields alone are not a delegation');
});

test('a turn after the project changed is told so once, and an unchanged one is told nothing', () => {
  const first = project('Note Fixture One');
  const second = project('Note Fixture Two');
  const session = createSession({ id: 'note-chat', kind: 'chat' });
  const route = (sourceUserSeq: number) => appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'turn_model_routed',
    data: { sourceUserSeq, ...composition.sessionProjectFields(session.id) } });
  const ask = () => appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'fixture' } }).seq;

  const one = ask(); route(one);
  assert.equal(projectHandoffNote(session.id, one), '', 'no earlier turn to differ from');
  setSessionProject(session.id, first.id, { by: 'owner' });
  const two = ask(); route(two);
  assert.match(projectHandoffNote(session.id, two), /^\[project-handoff\] Earlier replies in this conversation were written in no project\. This turn works in the project Note Fixture One/);
  const three = ask(); route(three);
  assert.equal(projectHandoffNote(session.id, three), '');
  setSessionProject(session.id, second.id, { by: 'owner' });
  const four = ask(); route(four);
  assert.match(projectHandoffNote(session.id, four), /written in the project Note Fixture One\. This turn works in the project Note Fixture Two/);
  setSessionProject(session.id, null, { by: 'owner' });
  const five = ask(); route(five);
  assert.match(projectHandoffNote(session.id, five), /This turn works in no project\./);
  assert.equal(projectHandoffNote(null, 5), '');
});
void writeFileSync;
