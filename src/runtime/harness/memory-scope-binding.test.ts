/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/memory-scope-binding.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-scope-binding-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_EMBEDDINGS = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

await import('./memory-scope-binding.js');
const scope = await import('../../memory/memory-scope.js');
const facts = await import('../../memory/facts.js');
const strategies = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { buildUnifiedTurnPrimer } = await import('../../memory/turn-primer.js');
const { recallMemory } = await import('../../memory/recall-memory.js');
const projects = await import('../../projects/project-record.js');
const { setSessionProject } = await import('../../projects/session-project.js');
const { setSessionAgent } = await import('../../agents/session-agent.js');
const { createAgentRecord, deleteAgentRecord } = await import('../../agents/agent-record.js');
const { createSession, closeEventLog } = await import('./eventlog.js');
const { harnessRunContextStorage } = await import('./brackets.js');

after(() => {
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function project(name: string) {
  const made = projects.createProject({ name });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.project;
}
const madeAgent = createAgentRecord({ name: 'Scope Analyst', handles: 'Reporting.', createdFrom: 'console' });
if (!madeAgent.ok) throw new Error('fixture agent');
const analyst = madeAgent.agent;
const sales = project('Scope Sales');
const hiring = project('Scope Hiring');
for (const each of [sales, hiring]) projects.saveAssignment(each.id, { agentId: analyst.id, agentCreatedAt: analyst.createdAt });

function conversation(id: string, where: { project?: string; agent?: string } = {}) {
  createSession({ id, kind: 'chat' });
  if (where.agent) assert.equal(setSessionAgent(id, where.agent, { by: 'owner' }).ok, true);
  if (where.project) assert.equal(setSessionProject(id, where.project, { by: 'owner' }).ok, true);
  return id;
}
const plain = conversation('scope-plain');
const clemInSales = conversation('scope-clem-sales', { project: sales.id });
const analystInSales = conversation('scope-analyst-sales', { project: sales.id, agent: analyst.id });
const analystInHiring = conversation('scope-analyst-hiring', { project: hiring.id, agent: analyst.id });
const analystAlone = conversation('scope-analyst-alone', { agent: analyst.id });
const key = scope.agentScopeKey(analyst);

test('a session\'s scope is its own project and agent, and a helper run has its parent\'s', () => {
  assert.deepEqual(scope.scopeOfSession(plain), { projectId: null, agentKey: null });
  assert.deepEqual(scope.scopeOfSession(clemInSales), { projectId: sales.id, agentKey: null });
  assert.deepEqual(scope.scopeOfSession(analystInSales), { projectId: sales.id, agentKey: key });
  assert.deepEqual(scope.scopeOfSession(analystAlone), { projectId: null, agentKey: key });
  assert.equal(scope.scopeOfSession('no-such-session'), null);

  createSession({ id: 'sess-worker-fixture', kind: 'agent', metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: analystInSales } });
  assert.deepEqual(scope.scopeOfSession('sess-worker-fixture'), { projectId: sales.id, agentKey: key });
  createSession({ id: 'background:bg-scope', kind: 'execution', metadata: { delegatedTaskId: 'bg-scope', agentId: analyst.id, agentName: analyst.name, projectId: hiring.id, projectName: hiring.name } });
  assert.deepEqual(scope.scopeOfSession('background:bg-scope'), { projectId: hiring.id, agentKey: key });
  createSession({ id: 'background:bg-plain', kind: 'execution', metadata: { agentId: analyst.id, projectId: hiring.id } });
  assert.deepEqual(scope.scopeOfSession('background:bg-plain'), { projectId: null, agentKey: null }, 'unattended work nobody delegated has no scope');
  createSession({ id: 'space-scope-board', kind: 'chat', metadata: { projectId: sales.id } });
  assert.deepEqual(scope.scopeOfSession('space-scope-board'), { projectId: null, agentKey: null });

  // Moving the conversation moves what its next read sees, at once.
  const moving = conversation('scope-moving', { project: sales.id });
  assert.equal(scope.scopeOfSession(moving)?.projectId, sales.id);
  setSessionProject(moving, hiring.id, { by: 'owner' });
  assert.equal(scope.scopeOfSession(moving)?.projectId, hiring.id);
  setSessionProject(moving, null, { by: 'owner' });
  assert.equal(scope.scopeOfSession(moving)?.projectId, null);
});

test('one agent, two projects with the same word meaning different things: each turn is given its own', async () => {
  facts.rememberFact({ kind: 'project', content: 'In this work a lead means an open sales opportunity in the east ledger.', sessionId: analystInSales });
  facts.rememberFact({ kind: 'project', content: 'In this work a lead means the hiring manager who owns the role.', sessionId: analystInHiring });
  facts.rememberFact({ kind: 'reference', content: 'The reporting account for this work is acct-sales-east.', sessionId: clemInSales });
  facts.rememberFact({ kind: 'reference', content: 'The reporting account for this work is acct-people-ops.', sessionId: analystInHiring });
  facts.rememberFact({ kind: 'feedback', content: 'Scope Analyst should put totals in the first line of any report.', sessionId: analystAlone });

  const primer = async (sessionId: string, query: string): Promise<string> => {
    const built = await buildUnifiedTurnPrimer({ query, surface: 'automatic_primer', sessionId, limit: 12, maxChars: 4_000, timeoutMs: 5_000 });
    return (built as { text?: string }).text ?? '';
  };
  const inSales = await primer(analystInSales, 'what does a lead mean and which reporting account do we use');
  assert.match(inSales, /open sales opportunity/);
  assert.match(inSales, /acct-sales-east/);
  assert.doesNotMatch(inSales, /hiring manager|acct-people-ops/);
  const inHiring = await primer(analystInHiring, 'what does a lead mean and which reporting account do we use');
  assert.match(inHiring, /hiring manager/);
  assert.match(inHiring, /acct-people-ops/);
  assert.doesNotMatch(inHiring, /open sales opportunity|acct-sales-east/);
  const outside = await primer(plain, 'what does a lead mean and which reporting account do we use');
  assert.doesNotMatch(outside, /open sales opportunity|hiring manager|acct-sales-east|acct-people-ops/);

  // What the agent knows wherever it works goes with it; Clem outside a project is not handed it.
  assert.match(await primer(analystInHiring, 'how should a report start totals first line'), /totals in the first line/);
  assert.match(await primer(analystInSales, 'how should a report start totals first line'), /totals in the first line/);
  assert.doesNotMatch(await primer(plain, 'how should a report start totals first line'), /totals in the first line/);

  // Clem inside the project sees what its agent learned there.
  assert.match(await primer(clemInSales, 'what does a lead mean'), /open sales opportunity/);

  // The same through the run context a tool call has, with no session passed.
  const counter = { count: 0 } as never;
  const viaTool = await harnessRunContextStorage.run({ sessionId: analystInHiring, counter } as never, async () =>
    (await recallMemory('what does a lead mean', { limit: 10 })).hits.map((hit) => hit.text).join('\n'));
  assert.match(viaTool, /hiring manager/);
  assert.doesNotMatch(viaTool, /open sales opportunity/);
  const unrestricted = (await recallMemory('what does a lead mean', { limit: 10 })).hits.map((hit) => hit.text).join('\n');
  assert.match(unrestricted, /open sales opportunity/);
  assert.match(unrestricted, /hiring manager/);
});

test('a method proved in one project is offered there and nowhere else, and evidence does not cross', () => {
  const receipt = (sessionId: string, sourceId: string) => evaluateLearningCandidate({
    target: 'strategy', authority: 'background_delivery_verifier', sessionId, sourceId, terminalSuccess: true, controllerValidation: true,
  }).receipt!;
  const inSales = strategies.recordRunStrategy({ objective: 'prepare the weekly pipeline briefing from the ledger', toolsUsed: ['ledgerscope__query'],
    workerCount: 0, durationMs: 9_000, learningReceipt: receipt(analystInSales, 'm-1') })!;
  assert.deepEqual(inSales.keptFor, { projectId: sales.id, agentKey: key });
  const inHiring = strategies.recordRunStrategy({ objective: 'prepare the weekly pipeline briefing from the ledger', toolsUsed: ['peoplescope__find'],
    workerCount: 0, durationMs: 9_000, learningReceipt: receipt(analystInHiring, 'm-2') })!;
  assert.notEqual(inHiring.id, inSales.id, 'the same request in another project is another method');
  const everywhere = strategies.recordRunStrategy({ objective: 'look up the office calendar for next week', toolsUsed: ['calendarscope__list'],
    workerCount: 0, durationMs: 3_000, learningReceipt: receipt(plain, 'm-3') })!;
  assert.equal(everywhere.keptFor, undefined);

  const offered = (sessionId: string) => scope.withSessionMemoryScope(sessionId, () =>
    strategies.listMatchingRunStrategies('prepare the weekly pipeline briefing', 8).map((row) => row.strategy.toolsUsed[0]));
  assert.deepEqual(offered(analystInSales), ['ledgerscope__query']);
  assert.deepEqual(offered(analystInHiring), ['peoplescope__find']);
  assert.deepEqual(offered(clemInSales), ['ledgerscope__query']);
  assert.deepEqual(offered(plain), []);
  assert.deepEqual(offered(analystAlone), []);
  for (const sessionId of [plain, analystInSales, analystInHiring]) {
    assert.ok(scope.withSessionMemoryScope(sessionId, () => strategies.listVerifiedRunStrategies()).some((row) => row.id === everywhere.id));
  }
  assert.equal(strategies.listVerifiedRunStrategies().length, 3, 'maintenance sees all of them');
});

test('an agent deleted and saved again under the same name starts with nothing the first one learned', () => {
  const first = createAgentRecord({ name: 'Replaced Desk', handles: 'x', createdFrom: 'console' });
  if (!first.ok) throw new Error('fixture');
  const before = conversation('scope-replaced-1', { agent: first.agent.id });
  const learned = facts.rememberFact({ kind: 'feedback', content: 'Replaced Desk keeps its reports under two hundred words.', sessionId: before });
  assert.deepEqual(facts.factScope(learned.id), { projectId: null, agentKey: scope.agentScopeKey(first.agent) });
  deleteAgentRecord(first.agent.id);
  // The record has no creation time of its own until it is saved again.
  const again = createAgentRecord({ name: 'Replaced Desk', handles: 'x', createdFrom: 'console' });
  if (!again.ok) throw new Error('fixture');
  assert.equal(again.agent.id, first.agent.id);
  const after = conversation('scope-replaced-2', { agent: again.agent.id });
  if (scope.agentScopeKey(again.agent) !== scope.agentScopeKey(first.agent)) {
    assert.equal(scope.withSessionMemoryScope(after, () => facts.searchFactsByText('reports two hundred words', 5)).length, 0);
  }
});

test('a request keeps the project it began in when the conversation is moved while it runs', async () => {
  const { _forgetPinnedMemoryScopesForTests } = await import('./memory-scope-binding.js');
  _forgetPinnedMemoryScopesForTests();
  const moving = conversation('scope-moving-in-flight', { project: sales.id });
  const run = { sessionId: moving, sourceUserSeq: 7, counter: { count: 0 } } as never;
  harnessRunContextStorage.run(run, () => {
    assert.equal((scope.currentMemoryReadScope() as { projectId: string | null }).projectId, sales.id);
    assert.equal(setSessionProject(moving, hiring.id, { by: 'owner' }).ok, true);
    assert.equal((scope.currentMemoryReadScope() as { projectId: string | null }).projectId, sales.id, 'the request in flight stays where it began');
    const learned = facts.rememberFact({ kind: 'reference', content: 'Moving: the quarter closes on the fifth.', sessionId: moving });
    assert.equal(facts.factScope(learned.id).projectId, sales.id);
  });
  // The next request works in the new project.
  harnessRunContextStorage.run({ sessionId: moving, sourceUserSeq: 9, counter: { count: 0 } } as never, () => {
    assert.equal((scope.currentMemoryReadScope() as { projectId: string | null }).projectId, hiring.id);
  });
});

test('work moved to the background stays in the project and with the agent of its conversation', async () => {
  const { inheritedTaskDelegation } = await import('../../projects/inherited-delegation.js');
  assert.equal(inheritedTaskDelegation(plain), null, 'a conversation in no project and no agent hands on nothing');
  assert.deepEqual(inheritedTaskDelegation(clemInSales, 4), { agentId: null, agentName: null, agentCreatedAt: null,
    projectId: sales.id, projectName: 'Scope Sales', assignedBy: 'clem', originSourceUserSeq: 4, agentChoice: 'open' },
  'nobody was named and the project has an agent assigned: who it belongs to is asked when it starts');
  const both = inheritedTaskDelegation(analystInSales);
  assert.deepEqual([both?.agentId, both?.projectId, both?.assignedBy], [analyst.id, sales.id, 'owner']);
  assert.equal(both?.agentChoice, undefined, 'a conversation already in an agent has made the choice');
  const alone = inheritedTaskDelegation(analystAlone);
  assert.deepEqual([alone?.agentId, alone?.projectId], [analyst.id, null]);
  assert.equal(inheritedTaskDelegation('no-such-session'), null);
});
