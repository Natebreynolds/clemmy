/**
 * Continuity after history reduction: an approved plan decision, a user
 * correction, a pending approval and a completed-write receipt survive a
 * forced Layer 1 + Layer 2 compaction and a reopen of storage, and the
 * completed write stays visible as already done so it is never re-issued.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compaction-continuity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_AUTO_COMPACT = 'on';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-compaction-continuity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const store = await import('./logical-call-settlement-store.js');
const { compactSessionIfNeeded, _setCompactionSummarizerForTests } = await import('./compaction.js');
const { HarnessSession } = await import('./session.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const user = (text: string) => ({ role: 'user', content: text }) as unknown as AgentInputItem;
const assistant = (text: string) => ({ role: 'assistant', content: text }) as unknown as AgentInputItem;
const system = (text: string) => ({ role: 'system', content: text }) as unknown as AgentInputItem;
const call = (callId: string, name: string, args: unknown) => ({
  type: 'function_call', id: `fc-${callId}`, callId, name, arguments: JSON.stringify(args), status: 'completed',
}) as unknown as AgentInputItem;
const result = (callId: string, output: string) => ({
  type: 'function_call_result', name: 'x', callId, status: 'completed', output: { type: 'text', text: output },
}) as unknown as AgentInputItem;

test('an approved plan, a user correction, a pending approval and a completed-write receipt survive forced compaction and a reopen', async (t) => {
  t.after(() => _setCompactionSummarizerForTests(null));
  const session = HarnessSession.create({ kind: 'chat', title: 'continuity' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Draft the Q3 inventory memo from the notes file and save it.' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };

  // The completed write: a real settled mutating logical call, retained output.
  const writeArgs = { path: 'memos/q3-inventory.md', content: 'Q3 inventory memo', mode: 'create' };
  const started = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId: 'write-q3', physicalDispatchId: 'write-q3:1', ordinal: 0 },
    tool: 'write_file', args: writeArgs,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool: 'write_file', outcome: 'returned' }).status, 'inserted');
  const receipt = JSON.stringify({ ok: true, committed: true, path: 'memos/q3-inventory.md', receipt: 'file-revision:q3:1' });
  const committed = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'write-q3' },
    contract: { toolName: 'write_file', args: writeArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: receipt },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', callId: 'write-q3', turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'write-q3', tool: 'write_file', output: receipt });

  const items: AgentInputItem[] = [
    user('Draft the Q3 inventory memo from the notes file and save it.'),
    assistant('Plan: read notes, draft memo, save to memos/q3-inventory.md. Approve?'),
    user('Approve the plan.'),
    system('[plan approved] read notes → draft memo → save memos/q3-inventory.md'),
  ];
  // Enough older reads to force Layer 1 to collapse and Layer 2 to summarize.
  for (let i = 0; i < 14; i += 1) {
    const callId = `read-${i}`;
    const body = `notes section ${i} ${'n'.repeat(1200)}`;
    items.push(call(callId, 'read_file', { path: `notes/${i}.md` }), result(callId, body));
    eventlog.writeToolOutput({ sessionId: session.id, callId, tool: 'read_file', output: body });
    items.push(assistant(`Read section ${i}; continuing.`));
  }
  items.push(call('write-q3', 'write_file', writeArgs), result('write-q3', receipt));
  items.push(user('Correction: the memo must cite the Q3 file, not the Q2 one.'));
  items.push(assistant('Understood. Sending the memo to finance needs your approval: send memos/q3-inventory.md to finance@example.test?'));
  items.push(system('[approval pending: apr-send-q3] send memos/q3-inventory.md to finance@example.test'));
  session.updateConversationSnapshot(items);

  _setCompactionSummarizerForTests(async () => ({ summary: '- Earlier: read fourteen note sections [read-0]…[read-13]; drafted memo.', modelUsed: 'fixture-summarizer' }));
  const { result: outcome, nextItems, forkRequest } = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 200_000, layer1ItemThreshold: 10, layer1RetainToolPairs: 2, layer2RetainMessages: 4, forceLayer2: true,
  });
  assert.equal(outcome.layer1.applied, true, JSON.stringify(outcome));
  assert.equal(outcome.layer2.applied, true, JSON.stringify(outcome));
  assert.equal(forkRequest, undefined);
  assert.ok(outcome.afterTokens < outcome.beforeTokens, 'history actually shrank');

  const text = JSON.stringify(nextItems);
  const userTexts = nextItems.filter((item) => (item as { role?: string }).role === 'user').map((item) => String((item as { content?: unknown }).content));
  assert.deepEqual(userTexts, [
    'Draft the Q3 inventory memo from the notes file and save it.',
    'Approve the plan.',
    'Correction: the memo must cite the Q3 file, not the Q2 one.',
  ], 'every user message, including the approval decision and the correction, stays verbatim and in order');
  assert.match(text, /approval pending: apr-send-q3/, 'the pending approval stays in the retained tail');
  const writeVisible = nextItems.some((item) => (item as { callId?: string }).callId === 'write-q3' && (item as { type?: string }).type === 'function_call_result')
    || /Durable completed writes — already done[\s\S]*write-q3/.test(text);
  assert.ok(writeVisible, `the completed write stays visible either verbatim or as an already-done ledger entry: ${text.slice(0, 2000)}`);
  // A collapsed ledger may retain a short excerpt. The full older pair must
  // leave the model history while its original bytes remain recallable.
  assert.ok(!nextItems.some(item => (item as { callId?: string }).callId === 'read-3'),
    'the older read pair is retired rather than replayed in full');
  assert.equal(eventlog.getToolOutput(session.id, 'read-3')?.output,
    `notes section 3 ${'n'.repeat(1200)}`, 'the retired result remains exactly recallable');

  // Reopen storage: the reduced history is what the next turn and a restart see.
  session.updateConversationSnapshot(nextItems);
  eventlog.closeEventLog();
  const reopened = HarnessSession.load(session.id)?.toInputItems() ?? [];
  assert.equal(JSON.stringify(reopened), JSON.stringify(nextItems), 'the reduced history survives reopening storage byte for byte');

  // The completed write is settled durably: the same logical call cannot be committed twice.
  const again = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'write-q3' },
    contract: { toolName: 'write_file', args: writeArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: receipt },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', callId: 'write-q3', turn: 1 },
  });
  assert.notEqual(again.status, 'committed', `a settled write is not committed a second time: ${JSON.stringify(again)}`);
});

test('a scoped durable correction and complete standing context survive forced compaction and reopen after selection changes', async t => {
  const agents = await import('../../agents/agent-record.js');
  const projects = await import('../../projects/project-record.js');
  const { setSessionAgent } = await import('../../agents/session-agent.js');
  const { setSessionProject } = await import('../../projects/session-project.js');
  const contexts = await import('./source-session-context.js');
  const sourceScope = await import('./source-session-context-scope.js');
  const composition = await import('./session-composition.js');
  const memory = await import('../../memory/db.js');
  const scopes = await import('../../memory/memory-scope.js');
  const facts = await import('../../memory/facts.js');
  const corrections = await import('../../memory/fact-correction.js');
  t.after(() => {
    _setCompactionSummarizerForTests(null);
    memory.closeMemoryDb();
    projects._closeProjectStoreForTests();
  });
  const standing = `For controlled reports, preserve the complete project code and the separate footer.\n${'Keep each controlled section in its saved order.\n'.repeat(100)}Draft only; never send a report without my approval.`;
  const projectContext = `Controlled compaction project: keep each saved section.\n${'Retain the controlled context for every section.\n'.repeat(60)}The approved report uses its saved heading and keeps its footer unchanged.`;
  const savedAgent = agents.createAgentRecord({ name: 'Controlled Continuity Editor', instructions: standing, createdFrom: 'console' });
  const savedProject = projects.createProject({ name: 'Controlled Continuity Project', context: projectContext });
  assert.ok(savedAgent.ok); assert.ok(savedProject.ok);
  if (!savedAgent.ok || !savedProject.ok) throw new Error('Controlled standing context was not created.');
  const session = HarnessSession.create({ kind: 'chat', title: 'scoped correction continuity' });
  assert.ok(setSessionAgent(session.id, savedAgent.agent.id, { by: 'owner' }).ok);
  assert.ok(setSessionProject(session.id, savedProject.project.id, { by: 'owner' }).ok);
  const scope = { projectId: savedProject.project.id, agentKey: scopes.agentScopeKey(savedAgent.agent) };
  const original = 'The controlled report heading is COPPER GARDEN. The footer stays IVORY MOON.';
  const revised = original.replace('COPPER GARDEN', 'SILVER ORCHARD');
  const oldFact = facts.rememberFact({ kind: 'project', content: original, scope, sessionId: session.id,
    occurredAt: '2026-01-01T00:00:00.000Z' });
  const neighbor = facts.rememberFact({ kind: 'project', content: 'The separate controlled report code is CEDAR LANTERN.', scope, sessionId: session.id });
  const ownerText = 'Correction: replace the saved report heading COPPER GARDEN with SILVER ORCHARD. Keep the footer and report code unchanged, and prepare a draft only.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: ownerText } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const captured = contexts.captureFreshSourceSessionContext(identity);
  assert.ok(captured); assert.deepEqual(captured.memoryScope, scope);
  const observed = scopes.withMemoryReadScope(scope, () => corrections.readFactObservation(oldFact.id));
  assert.ok(observed);
  const patches = [{ before: 'COPPER GARDEN', after: 'SILVER ORCHARD' }];
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const request = { targetId: oldFact.id, expectedObservationDigest: observed.digest, patches,
    owner: { ...identity, sourceEventId: source.id, sourceContextDigest: captured.digest,
      logicalToolCallId: 'controlled-scoped-correction', argumentsDigest: digest({ targetId: oldFact.id, patches }),
      assessmentDigest: digest({ targetId: oldFact.id, expected: observed.digest, patches }), ownerText, occurredAt: source.createdAt } };
  const corrected = scopes.withMemoryReadScope(scope, () => corrections.correctFactExact(request));
  assert.equal(corrected.status, 'corrected');
  if (corrected.status !== 'corrected') throw new Error('Controlled exact correction did not commit.');
  assert.equal(corrected.proof.after.content, revised);
  assert.deepEqual(corrected.proof.after.scope, scope);
  const proofOutput = JSON.stringify(corrected.proof);
  eventlog.writeToolOutput({ sessionId: session.id, callId: request.owner.logicalToolCallId, tool: 'memory_remember', output: proofOutput });
  const items: AgentInputItem[] = [user(ownerText),
    call(request.owner.logicalToolCallId, 'memory_remember', { kind: 'project', content: revised }),
    result(request.owner.logicalToolCallId, proofOutput)];
  for (let index = 0; index < 16; index++) {
    const callId = `scoped-continuity-read-${index}`;
    const output = `Controlled background notes ${index}: ${'detail '.repeat(200)}`;
    items.push(call(callId, 'read_file', { path: `controlled-notes/${index}.txt` }), result(callId, output), assistant(`Read controlled section ${index}.`));
    eventlog.writeToolOutput({ sessionId: session.id, callId, tool: 'read_file', output });
  }
  const followup = 'Continue the controlled draft. Keep its saved heading, footer and project code; do not send it.';
  items.push(user(followup));
  session.updateConversationSnapshot(items);
  _setCompactionSummarizerForTests(async () => ({ summary: '- Older controlled lookup notes were read.', modelUsed: 'fixture-summarizer' }));
  const compacted = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 200_000, layer1ItemThreshold: 10, layer1RetainToolPairs: 2, layer2RetainMessages: 4, forceLayer2: true,
  });
  assert.equal(compacted.result.layer1.applied, true);
  assert.equal(compacted.result.layer2.applied, true);
  assert.ok(compacted.result.afterTokens < compacted.result.beforeTokens);
  assert.deepEqual(compacted.nextItems.filter(item => (item as { role?: string }).role === 'user')
    .map(item => String((item as { content?: unknown }).content)), [ownerText, followup]);
  session.updateConversationSnapshot(compacted.nextItems);

  const otherAgent = agents.createAgentRecord({ name: 'Controlled Other Editor', instructions: 'FOREIGN_STANDING_CONTEXT' });
  const otherProject = projects.createProject({ name: 'Controlled Other Project', context: 'FOREIGN_PROJECT_CONTEXT' });
  assert.ok(otherAgent.ok); assert.ok(otherProject.ok);
  if (!otherAgent.ok || !otherProject.ok) throw new Error('Controlled alternate selection was not created.');
  assert.ok(setSessionAgent(session.id, otherAgent.agent.id, { by: 'owner' }).ok);
  assert.ok(setSessionProject(session.id, otherProject.project.id, { by: 'owner' }).ok);
  facts.rememberFact({ kind: 'project', content: 'The foreign controlled report heading remains COPPER GARDEN.',
    scope: { projectId: otherProject.project.id, agentKey: scopes.agentScopeKey(otherAgent.agent) }, sessionId: session.id });
  memory.closeMemoryDb(); eventlog.closeEventLog();
  assert.deepEqual(HarnessSession.load(session.id)?.toInputItems(), compacted.nextItems);
  const retained = contexts.readSourceSessionContext(identity, captured.digest);
  assert.ok(retained); assert.deepEqual(retained.memoryScope, scope);
  const replay = scopes.withMemoryReadScope(scope, () => corrections.correctFactExact(request));
  assert.equal(replay.status, 'replayed');
  if (replay.status !== 'replayed') throw new Error('The exact correction receipt was not reopened.');
  assert.equal(replay.currentStateMatches, true);
  assert.deepEqual(replay.proof, corrected.proof);
  sourceScope.withSourceSessionContext(retained, () => scopes.withMemoryReadScope(retained.memoryScope, () => {
    const old = corrections.readFactObservation(oldFact.id);
    assert.equal(old?.active, false); assert.equal(old?.supersededByFactId, corrected.proof.after.id);
    const current = corrections.readFactObservation(corrected.proof.after.id);
    assert.equal(current?.content, revised); assert.deepEqual(current?.scope, scope);
    assert.equal(corrections.readFactObservation(neighbor.id)?.active, true);
    const factsContext = facts.renderFactsForInstructions(10, 6000, 'controlled report heading footer project code');
    assert.ok(factsContext.includes(revised)); assert.ok(factsContext.includes('CEDAR LANTERN'));
    assert.doesNotMatch(factsContext, /COPPER GARDEN|FOREIGN/);
    const mount = composition.composeSessionFromStore(session.id);
    assert.equal(mount.agent?.agent.id, savedAgent.agent.id); assert.equal(mount.project?.project.id, savedProject.project.id);
    const primaryContext = composition.sessionMountContext(mount);
    const reviewerContext = composition.sessionAgentReviewContext(session.id);
    for (const context of [primaryContext, reviewerContext]) {
      assert.ok(context.includes(standing)); assert.ok(context.includes(projectContext));
      assert.doesNotMatch(context, /FOREIGN_STANDING_CONTEXT|FOREIGN_PROJECT_CONTEXT/);
    }
  }));
  assert.equal(composition.composeSessionFromStore(session.id).agent?.agent.id, otherAgent.agent.id,
    'retained task context does not rewrite the owner’s later selection');
});
