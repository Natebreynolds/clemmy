import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-learning-consumers-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const events = await import('../runtime/harness/eventlog.js');
const memory = await import('./db.js');
const capture = await import('./auto-capture.js');
const strategies = await import('../runtime/harness/host-run-strategy-learning.js');
const strategyStore = await import('./run-strategy-store.js');
const skillChoices = await import('./skill-choice-store.js');
const { gatherSessionSkills } = await import('../runtime/harness/skill-execution.js');
const composition = await import('../runtime/harness/source-session-context.js');
const { createAutomaticMemoryOrigin } = await import('./memory-destination.js');
const { enqueueAutoCaptureCandidates, drainDurableConsolidationCandidates } = await import('./durable-consolidation.js');
const { runPostTurnHooks } = await import('../runtime/harness/post-turn.js');
const { recordRecallRun } = await import('./recall-usage.js');
const { rememberFact, getFact } = await import('./facts.js');
const { settleVerifiedComposioRead } = await import('../tools/composio-read-settlement.js');
const intake = await import('./learning-intake.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const { presentationEventForOutcome } = await import('../runtime/harness/turn-outcome.js');
const { redeemSuccessfulSettlementResultForHost } = await import('../runtime/harness/result-handle.js');
const excluded = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
let count = 0;
function accepted(data: Record<string, unknown> = {}) {
  const session = events.createSession({ id: `learning-consumer-${++count}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Inspect the ${count} amber ledger and summarize its entries.`, ...data } });
  return { sessionId: session.id, sourceUserSeq: source.seq, source };
}
function settleRead(source: ReturnType<typeof accepted>, options: { tool?: string; args?: Record<string, unknown>; payload?: unknown } = {}) {
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq };
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...identity, turn: 1 } }));
  const task = { ...identity, acceptedTaskId: identities.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  const logicalToolCallId = `learning-read-${source.sourceUserSeq}`;
  const args = options.args ?? { path: '/tmp/controlled-ledger.txt' };
  const tool = options.tool ?? 'read_file';
  events.appendEvent({ sessionId: source.sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: {
    sourceUserSeq: source.sourceUserSeq, tool, callId: logicalToolCallId, arguments: JSON.stringify(args), effect: 'read' } });
  const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId,
    physicalDispatchId: `${logicalToolCallId}:1`, ordinal: 0 }, tool, args,
    ...(tool === 'skill_read' ? { executionSite: 'host' as const } : {}) });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('fixture read admission failed');
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool, outcome: 'returned' }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId },
    contract: { toolName: tool, args }, execution: { kind: tool === 'skill_read' ? 'local_execution' : 'provider_execution' },
    result: { payload: options.payload ?? { records: [{ name: 'Amber ledger', amount: 7 }] } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'byo', callId: logicalToolCallId, turn: 1 } });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  return identity;
}
function complete(source: ReturnType<typeof accepted>) {
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq, turn: 1 };
  const outcome = { version: 2 as const, id: `turn:${source.sourceUserSeq}`, identity,
    status: 'done' as const, resumable: false as const, presentation: { kind: 'answer' as const, text: 'The ledger contains one entry.' } };
  return events.appendEvent({ sessionId: source.sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: {
    presentation: presentationEventForOutcome(outcome), turnOutcome: outcome,
    sourceUserSeq: source.sourceUserSeq, terminalKey: outcome.id, logicalTerminalVersion: 1 } });
}
after(() => { events.closeEventLog(); memory.closeMemoryDb(); rmSync(testHome, { recursive: true, force: true }); });

test('typed exclusion blocks automatic candidates/profile capture even if the caller omits the source policy copy', () => {
  const message = 'Remember that the amber ledger owner is Morgan Vale.';
  const source = accepted({ text: message, learningPolicy: excluded });
  const forgedCopy = { ...source.source, data: { text: message } };
  const captured = capture.captureInteractionSignals({ message, sessionId: source.sessionId,
    sourceEventId: `user-source:${source.sourceUserSeq}`, sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(forgedCopy) });
  assert.deepEqual(captured.candidates, []);
  assert.deepEqual(captured.queuedCandidateIds ?? [], []);
  assert.equal(captured.profilePatch, undefined);
  const direct = capture.captureInteractionSignals({ message,
    sourceProvenance: capture.autoCaptureProvenanceFromDirectUserInput('chat', excluded) });
  assert.deepEqual(direct.candidates, []);
  const ordinary = capture.captureInteractionSignals({ message,
    sourceProvenance: capture.autoCaptureProvenanceFromDirectUserInput('chat') });
  assert.ok(ordinary.candidates.length > 0, 'the same owner words remain eligible without the typed exclusion');
  assert.equal((memory.openMemoryDb().prepare('SELECT count(*) AS n FROM memory_reflection_candidates').get() as { n: number }).n, 0);
});

test('an already queued excluded source cannot dispatch consolidation after restart', async () => {
  const message = 'Remember that the indigo ledger owner is Aria Vale.';
  const source = accepted({ text: message, learningPolicy: excluded });
  const context = composition.captureFreshSourceSessionContext(source);
  assert.ok(context);
  const claimText = 'the indigo ledger owner is Aria Vale.';
  const start = message.indexOf(claimText);
  const origin = createAutomaticMemoryOrigin({ source: { authority: 'accepted_user_input', sessionId: source.sessionId,
    eventId: source.source.id, eventSeq: source.sourceUserSeq, eventType: 'user_input_received', ownerText: message,
    context: { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: context.digest, memoryScope: context.memoryScope } },
    claim: { start, end: start + claimText.length }, claimMode: 'complete', candidate: { kind: 'project', text: claimText } });
  // Represents durable intake created by an older producer that lacked the
  // policy gate. The current materializer must not trust that old admission.
  const queued = enqueueAutoCaptureCandidates({ message, sessionId: source.sessionId,
    sourceEventId: `user-source:${source.sourceUserSeq}`,
    candidates: [{ kind: 'project', content: claimText, reason: 'explicit remember request' }], origins: [origin] });
  assert.equal(queued.candidateIds.length, 1);
  events.closeEventLog(); memory.closeMemoryDb();
  let reviewerCalls = 0;
  const result = await drainDurableConsolidationCandidates({ ids: queued.candidateIds,
    standingReviewer: async () => { reviewerCalls += 1; throw new Error('excluded source reached a model reviewer'); } });
  assert.equal(reviewerCalls, 0);
  assert.equal(result.promoted, 0);
  assert.equal(result.skipped, 1);
  assert.equal((memory.openMemoryDb().prepare('SELECT count(*) AS n FROM consolidated_facts').get() as { n: number }).n, 0);
});

test('automatic recall credit is excluded by exact source while an ordinary sibling still learns', () => {
  const source = accepted({ learningPolicy: excluded });
  const normal = events.appendEvent({ sessionId: source.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Who owns the amber ledger?' } });
  const fact = rememberFact({ kind: 'project', content: 'Morgan Vale owns the amber ledger.' });
  const recall = recordRecallRun({ objective: 'ledger owner', surface: 'memory_search_facts', answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }], sessionId: source.sessionId });
  const hooks = { sessionId: source.sessionId, turn: 1, userInput: 'Who owns the ledger?', detectCorrection: false,
    recallIds: [recall.id], replyText: `Morgan Vale owns it [fact:${fact.id}].` };
  runPostTurnHooks({ ...hooks, sourceUserSeq: source.sourceUserSeq });
  assert.equal(getFact(fact.id)?.utilityCount, 0);
  runPostTurnHooks({ ...hooks, sourceUserSeq: normal.seq });
  assert.equal(getFact(fact.id)?.utilityCount, 1);
  runPostTurnHooks({ ...hooks, learningPolicy: excluded });
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'the explicit legacy direct boundary is restrictive too');
});

test('an ordinary source cannot learn from an excluded prior skill read, but its own verified load still learns', () => {
  const skillName = 'amber-ledger-review';
  const skillDir = path.join(testHome, 'skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Review amber ledger entries and reconcile totals.\n---\nReview the ledger entries and compare totals.\n`);
  const source = accepted({ text: 'Review amber ledger entries and reconcile totals.', learningPolicy: excluded });
  settleRead(source, { tool: 'skill_read', args: { name: skillName }, payload: '# amber-ledger-review\n---\nReview the ledger entries and compare totals.' });
  const normal = events.appendEvent({ sessionId: source.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Review amber ledger entries and reconcile totals.' } });
  const hooks = { sessionId: source.sessionId, sourceUserSeq: normal.seq, turn: 2, userInput: normal.data.text,
    detectCorrection: false, recallIds: [], replyText: 'The ledger entries reconcile.', toolArgTexts: ['{"ledger":"amber"}'] };
  assert.equal(gatherSessionSkills(source.sessionId, { sourceUserSeq: normal.seq }).length, 1, 'the retained prior reference exists; the negative is not an empty-inventory pass');
  runPostTurnHooks(hooks);
  assert.equal(skillChoices.listSkillChoices().filter(row => row.skill === skillName).length, 0, 'a prior excluded read is not current learning evidence');
  settleRead({ ...source, sourceUserSeq: normal.seq, source: normal }, { tool: 'skill_read', args: { name: skillName },
    payload: '# amber-ledger-review\n---\nReview the ledger entries and compare totals.' });
  runPostTurnHooks(hooks);
  assert.equal(skillChoices.listSkillChoices().filter(row => row.skill === skillName).length, 1, 'a verified current source load remains eligible');
});

test('proven excluded work keeps its task receipts but creates neither strategy nor terminal learning intake', () => {
  const source = accepted({ learningPolicy: excluded });
  const normal = accepted();
  const deniedIdentity = settleRead(source);
  const ordinaryIdentity = settleRead(normal);
  complete(source); complete(normal);
  assert.equal(strategies.learnHostRunStrategyForAcceptedTask(deniedIdentity).status, 'not_proven');
  assert.equal(strategies.learnHostRunStrategyForAcceptedTask(ordinaryIdentity).status, 'learned');
  const ownStrategies = strategyStore.listVerifiedRunStrategies().filter(row => row.toolsUsed.includes('read_file'));
  assert.equal(ownStrategies.length, 1, 'only ordinary completed work teaches the shared strategy');
  const report = intake.discoverTerminalLearningBatches();
  assert.equal(report.failures, 0);
  assert.equal(report.skippedTerminals, 1);
  assert.equal(report.batchesCreated, 1);
  const db = memory.openMemoryDb();
  assert.equal((db.prepare('SELECT count(*) AS n FROM memory_learning_batches WHERE session_id=? AND source_user_seq=?')
    .get(source.sessionId, source.sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM memory_learning_batches WHERE session_id=? AND source_user_seq=?')
    .get(normal.sessionId, normal.sourceUserSeq) as { n: number }).n, 1);
  assert.equal((events.openEventLog().prepare('SELECT count(*) AS n FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?')
    .get(source.sessionId, source.sourceUserSeq) as { n: number }).n, 1, 'execution accounting remains intact');
  assert.equal(events.listEvents(source.sessionId, { types: ['run_strategy_learned'] }).length, 0);
  assert.equal(intake.discoverTerminalLearningBatches().terminalsScanned, 0, 'an excluded immutable terminal does not churn the durable scan');
});

test('a delayed Composio settlement cannot borrow an ordinary newer active source', () => {
  const source = accepted({ learningPolicy: excluded });
  const attempt = events.beginRunAttempt(source.sessionId, {});
  events.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: { text: 'Read a different ordinary ledger.' } });
  const common = { toolSlug: 'SCHEDULERCO_LIST_EVENTS', sessionId: source.sessionId,
    result: { successful: true, data: { items: [{ id: 'controlled-row' }] } } };
  assert.equal(settleVerifiedComposioRead({ ...common, sourceUserSeq: source.sourceUserSeq }).queued, false);
  const ambiguous = settleVerifiedComposioRead(common);
  assert.equal(ambiguous.queued, false);
  if (!ambiguous.queued) assert.equal(ambiguous.reason, 'no exact accepted source identity');
});

test('a preexisting unstructured learning projection cannot expose excluded source text to a deferred extractor', () => {
  const denied = accepted({ learningPolicy: excluded });
  const normal = accepted();
  const narrative = 'The amber ledger has seven reviewed entries, each with its own recorded reconciliation evidence. '.repeat(12);
  const payload = { text: narrative };
  settleRead(denied, { payload }); settleRead(normal, { payload });
  const oldTerminal = complete(denied); complete(normal);
  const report = intake.discoverTerminalLearningBatches();
  assert.equal(report.batchesCreated, 1);
  const db = memory.openMemoryDb();
  const normalBatch = db.prepare('SELECT batch_id FROM memory_learning_batches WHERE session_id=? AND source_user_seq=?')
    .get(normal.sessionId, normal.sourceUserSeq) as { batch_id: string };
  const original = intake.listMemoryLearningMemberReceipts(normalBatch.batch_id)[0]!;
  assert.equal(original.disposition, 'unstructured');
  const expected = intake.selectedLearningSource(original);
  assert.ok(expected, 'the ordinary source has retrievable canonical result text');
  const deniedTaskId = identities.acceptedTaskIdFor(denied.sessionId, denied.sourceUserSeq);
  const logicalToolCallId = `learning-read-${denied.sourceUserSeq}`;
  const canonical = redeemSuccessfulSettlementResultForHost({ sessionId: denied.sessionId,
    sourceUserSeq: denied.sourceUserSeq, acceptedTaskId: deniedTaskId, logicalToolCallId });
  assert.equal(canonical.status, 'ok');
  if (canonical.status !== 'ok') throw new Error('fixture has no canonical excluded result');
  const terminalRow = events.openEventLog().prepare('SELECT rowid AS terminal_event_rowid, id AS terminal_event_id, session_id, data_json FROM events WHERE id=?')
    .get(oldTerminal.id) as { terminal_event_rowid: number; terminal_event_id: string; session_id: string; data_json: string };
  const terminal = intake._testOnlyLearningIntake.completedTerminal(terminalRow)!;
  const batchId = `preexisting-excluded-batch:${denied.sourceUserSeq}`;
  // Simulate an old producer's already-persisted projection. The source,
  // successful settlement and raw result handle all remain real and exact;
  // a worker must recheck exclusion rather than trusting old queue admission.
  db.prepare(`INSERT INTO memory_learning_batches
    (batch_id,session_id,source_user_seq,accepted_task_id,terminal_event_id,terminal_event_rowid,
     terminal_digest,member_manifest_hash,member_count,shard_count,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,member_manifest_hash,member_count,shard_count,status,created_at,updated_at
      FROM memory_learning_batches WHERE batch_id=?`)
    .run(batchId, denied.sessionId, denied.sourceUserSeq, deniedTaskId, oldTerminal.id,
      terminal.terminalEventRowid, terminal.terminalDigest, normalBatch.batch_id);
  const oldMember = { ...original, batchId, logicalToolCallId,
    resultHandleId: canonical.value.resultHandleId, resultDigest: canonical.value.rawPayloadSha256 };
  assert.equal(intake.selectedLearningSource(oldMember), null, 'excluded data must not reach deferred semantic model input');
  assert.equal(intake.selectedLearningSource(original), expected, 'an ordinary neighboring source remains available');
});

test('unavailable source A is durably held without starving ordinary sibling B, with audited restart replay', () => {
  const unknown = accepted({ learningPolicySource: { sessionId: 'unavailable-background-parent', sourceUserSeq: 0 } });
  const row = events.appendEvent({ sessionId: unknown.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the ordinary neighboring amber ledger.' } });
  const ordinary = { ...unknown, sourceUserSeq: row.seq, source: row };
  settleRead(unknown); settleRead(ordinary);
  const terminal = complete(unknown); complete(ordinary);
  const harness = events.openEventLog();
  harness.exec(`CREATE TEMP TRIGGER refuse_learning_hold BEFORE INSERT ON events
    WHEN NEW.type = 'memory_learning_intake_held' BEGIN SELECT RAISE(ABORT, 'controlled audit storage failure'); END`);
  const deniedAudit = intake.discoverTerminalLearningBatches();
  assert.equal(deniedAudit.failures, 1, 'a failed durable hold cannot advance the shared cursor');
  assert.equal(deniedAudit.batchesCreated, 0);
  harness.exec('DROP TRIGGER refuse_learning_hold');
  const resumed = intake.discoverTerminalLearningBatches();
  assert.equal(resumed.failures, 0, 'an immutable unavailable source is isolated rather than a permanent global failure');
  assert.equal(resumed.heldTerminals, 1);
  assert.equal(resumed.batchesCreated, 1, 'ordinary B still reaches the actual learning intake');
  const holds = events.listEvents(unknown.sessionId, { types: ['memory_learning_intake_held'] });
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.parentEventId, terminal.id);
  assert.equal(holds[0]!.data.sourceUserSeq, unknown.sourceUserSeq);
  assert.equal(holds[0]!.data.terminalEventId, terminal.id);
  assert.match(String(holds[0]!.data.terminalDigest), /^[a-f0-9]{64}$/);
  assert.equal(holds[0]!.data.reason, 'learning_lineage_unavailable');
  assert.equal(holds[0]!.data.disposition, 'held');
  const db = memory.openMemoryDb();
  assert.equal((db.prepare('SELECT count(*) AS n FROM memory_learning_batches WHERE session_id=? AND source_user_seq=?')
    .get(unknown.sessionId, unknown.sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM memory_learning_batches WHERE session_id=? AND source_user_seq=?')
    .get(ordinary.sessionId, ordinary.sourceUserSeq) as { n: number }).n, 1);
  assert.equal((harness.prepare('SELECT count(*) AS n FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?')
    .get(unknown.sessionId, unknown.sourceUserSeq) as { n: number }).n, 1, 'unqualified A keeps its canonical task evidence');
  const terminalRowid = (harness.prepare('SELECT rowid AS n FROM events WHERE id=?').get(terminal.id) as { n: number }).n;
  // Private-fixture cursor rollback simulates a restored memory projection
  // beside an already durable canonical audit. Replay must not duplicate it.
  db.prepare('UPDATE memory_learning_scan_state SET terminal_event_rowid=? WHERE id=1').run(terminalRowid - 1);
  events.closeEventLog(); memory.closeMemoryDb();
  const replayed = intake.discoverTerminalLearningBatches();
  assert.equal(replayed.heldTerminals, 1);
  assert.equal(replayed.batchesCreated, 0);
  assert.equal(replayed.batchesReplayed, 1);
  assert.equal(events.listEvents(unknown.sessionId, { types: ['memory_learning_intake_held'] }).length, 1);
  assert.equal(intake.discoverTerminalLearningBatches().terminalsScanned, 0);
});
