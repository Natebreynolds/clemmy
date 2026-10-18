import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { MeetingResearchCoordinatorOptions, MeetingResearchQuestion, MeetingResearchTask } from './meeting-research.js';
import type { MeetingResearchExecutionPort } from './meeting-research-service.js';

// Every imported singleton binds this disposable home before loading. These
// tests exercise the real source/lease/receipt boundary, never a provider.
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-research-service-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
  OPENAI_AGENTS_DISABLE_TRACING: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true', CLEMMY_EMBEDDINGS: 'off' });
const service = await import('./meeting-research-service.js');
const research = await import('./meeting-research.js');
const documents = await import('./meeting-documents.js');
const capture = await import('./meeting-capture.js');
const boundaryGuard = await import('./meeting-research-boundary.js');
const eventlog = await import('../../runtime/harness/eventlog.js');
const learning = await import('../../memory/turn-learning-policy.js');
const sourceContexts = await import('../../runtime/harness/source-session-context.js');
const facts = await import('../../memory/facts.js');
const memoryDb = await import('../../memory/db.js');
const { completionDataForTurnOutcome } = await import('../../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../../runtime/harness/turn-outcome.js');
const host = await import('../../runtime/harness/host-turn-runner.js');
const executionErrors: unknown[] = [];
afterEach(() => {
  boundaryGuard.installMeetingResearchBoundary(null);
  // The production dispatcher deliberately converts executor failures into a
  // truthful blocked result. That must not swallow assertions in our port.
  if (executionErrors.length) throw new AggregateError(executionErrors.splice(0), 'Controlled executor assertions failed.');
});
after(() => { eventlog.closeEventLog(); memoryDb.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let ordinal = 0;

function fixture(execute: MeetingResearchExecutionPort, options: { useMemory?: boolean; longDocument?: boolean } = {}) {
  const index = ++ordinal;
  let time = Date.now();
  const windowId = `meeting-fixture-service-${index}`;
  const sdkUploadId = `controlled-service-upload-${index}`;
  const questionText = `What is the approved fixturetopic${index} launchnumber?`;
  const initial = capture.noteRecallMeetingDetected({ windowId, sdkUploadId, platform: 'test-fixture',
    title: `Controlled research fixture ${index}`, startedAt: new Date(time - 1_000).toISOString(), status: 'recording' });
  const record = capture.appendRecallTranscriptSegment({ windowId, sdkUploadId, event: 'transcript.data', isFinal: true,
    eventId: `recall-final-${sha(`service-final-${index}`)}`, eventIdentity: 'sdk', text: questionText,
    timestamp: new Date(time).toISOString(), speaker: 'Fixture speaker' });
  assert.equal(record.id, initial.id);
  const before = documents.meetingDocuments.getMeetingDocuments(record.id);
  const document = documents.meetingDocuments.attachMeetingDocument(record.id, { captureDigest: before.captureDigest, expectedVersion: before.snapshotVersion,
    title: 'Selected controlled briefing', text: options.longDocument ? `Controlled briefing fixturetopic${index}. `.repeat(800).slice(0, 31_000) : `Approved fixturetopic${index} launchnumber is seven.` });
  const selected = document.documents[0]!;
  const withUnselected = documents.meetingDocuments.attachMeetingDocument(record.id, { captureDigest: document.captureDigest, expectedVersion: document.snapshotVersion,
    title: 'Unselected controlled briefing', text: `UNSELECTED_SOURCE_MUST_NOT_ENTER_${index}` });
  assert.equal(withUnselected.documents.length, 2);
  const reference = { id: selected.id, revision: selected.revision, digest: selected.digest };
  const directory = path.join(home, `research-${index}`);
  let calls = 0;
  let dispatchInput: Parameters<MeetingResearchCoordinatorOptions['dispatch']>[0] | undefined;
  const dispatch = service.createMeetingResearchTaskDispatch(async input => {
    calls++;
    try { return await execute(input); } catch (error) { executionErrors.push(error); throw error; }
  });
  const coordinatorOptions: MeetingResearchCoordinatorOptions = { directory, readMeeting: capture.loadRecallMeetingById,
    readDocumentRefs: id => documents.meetingDocuments.getMeetingDocuments(id).documents.map(({ id, revision, digest }) => ({ id, revision, digest })),
    now: () => time, dispatch: input => { dispatchInput = input; return dispatch(input); }, observe: async task => service.meetingResearchTaskStatus(task) };
  const coordinator = research.createMeetingResearchCoordinator(coordinatorOptions);
  coordinator.set(record.id, { enabled: true, useMemory: options.useMemory ?? false, maxLookups: 3, documentRefs: [reference], expectedVersion: 0 });
  const question: MeetingResearchQuestion = { offerId: `controlled-service-offer-${index}`, offerDigest: sha(`offer-${index}`),
    sourceDigest: sha(JSON.stringify(record.segments)), question: questionText, quote: questionText, segmentIds: [record.segments[0]!.id] };
  const job = coordinator.enqueue(record.id, question);
  const file = () => path.join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
  return { index, record, reference, directory, coordinator, job, question, file,
    calls: () => calls, dispatchInput: () => dispatchInput!, advance: (ms: number) => { time += ms; },
    reopen: () => research.createMeetingResearchCoordinator(coordinatorOptions) };
}
function taskFromExecution(input: Parameters<MeetingResearchExecutionPort>[0]): MeetingResearchTask {
  const source = eventlog.listEventsAtSequences(input.sessionId, [input.sourceUserSeq])[0]!;
  return { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, attemptId: input.runAttemptId,
    runId: source.data.runId as string, clientRequestId: source.data.clientRequestId as string };
}
const fixtureAnswerText = 'The controlled briefing says seven; this is a fixture answer.';
function typedTerminal(input: Parameters<MeetingResearchExecutionPort>[0], status: 'done' | 'blocked', metadata: Record<string, unknown> = {}) {
  const source = eventlog.listEventsAtSequences(input.sessionId, [input.sourceUserSeq])[0]!;
  const identity = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, turn: source.turn,
    attemptId: input.runAttemptId, runId: source.data.runId as string };
  const outcome = status === 'done'
    ? { version: 2 as const, id: turnOutcomeId(identity), identity, status: 'done' as const, resumable: false as const,
      presentation: { kind: 'answer' as const, text: fixtureAnswerText } }
    : { version: 2 as const, id: turnOutcomeId(identity), identity, status: 'blocked' as const, resumable: false as const,
      presentation: { kind: 'blocked' as const, text: 'The controlled evidence is insufficient.' } };
  return eventlog.appendEvent({ sessionId: input.sessionId, turn: source.turn, role: 'Clem', type: 'conversation_completed',
    data: { ...completionDataForTurnOutcome(outcome), terminalKey: outcome.id, ...metadata } });
}

test('saved answer review is passively projected from exact source policy and verdict evidence, never completion alone', async () => {
  const cases = ['reviewed', 'failed_open', 'abstained', 'missing', 'owner_off', 'surface_not_required',
    'wrong_source', 'wrong_verdict_source', 'wrong_verdict_event', 'changed_reply', 'changed_objective'] as const;
  for (const variant of cases) {
    let task: MeetingResearchTask | undefined;
    const f = fixture(async input => {
      task = taskFromExecution(input);
      const ownerEnabled = variant !== 'owner_off';
      host.captureEffectiveCompletionPolicyOnce({ ...task, enabled: ownerEnabled && variant !== 'surface_not_required', ownerEnabled });
      if (variant === 'owner_off' || variant === 'surface_not_required') {
        typedTerminal(input, 'done', { completionReview: { version: 1, policyEvidence: 'captured',
          disposition: variant === 'owner_off' ? 'disabled_by_owner' : 'not_required' } });
        return;
      }
      if (variant === 'missing') { typedTerminal(input, 'done'); return; }
      const objective = host.acceptedObjectiveForSource(task)!;
      const objectiveDigest = sha(variant === 'changed_objective' ? 'A different controlled objective.' : objective);
      const replyDigest = sha(variant === 'changed_reply' ? 'A different controlled answer.' : fixtureAnswerText);
      const unverified = variant === 'failed_open' || variant === 'abstained';
      const verdict = eventlog.appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
        lane: 'host_v1', kind: 'completion', sourceUserSeq: task.sourceUserSeq + (variant === 'wrong_verdict_source' ? 1 : 0),
        fulfills: variant !== 'abstained', objectiveDigest, replyDigest, settledEvidenceAvailable: true,
        ...(unverified ? { failedOpen: true, reviewFailure: 'invalid', ...(variant === 'abstained' ? { reviewDisposition: 'answered_unqualified' } : {}) } : {}),
      } });
      typedTerminal(input, 'done', { completionVerdictRef: { version: 1,
        sourceUserSeq: task.sourceUserSeq + (variant === 'wrong_source' ? 1 : 0),
        eventId: String(verdict.id), seq: verdict.seq + (variant === 'wrong_verdict_event' ? 1 : 0),
        // Deliberately optimistic metadata cannot override the real verdict,
        // its source binding or its objective/reply digests.
        verified: true, disposition: 'reviewed', policyEvidence: 'captured', fulfills: true,
        deliveredTextIsJudgedText: true, replyMatches: true, objectiveMatches: true, artifactsMatch: true,
        objectiveDigest, replyDigest } });
    });
    const saved = await f.coordinator.drain(f.record.id);
    assert.equal(saved.jobs[0]!.status, 'completed', `${variant}: the answer remains available`);
    const expected = variant === 'reviewed' ? 'reviewed' : variant === 'owner_off' ? 'disabled_by_owner'
      : variant === 'surface_not_required' ? 'not_required' : 'unverified';
    const before = readFileSync(f.file(), 'utf8');
    const eventCount = eventlog.listEvents(task!.sessionId).length;
    const projected = await service.projectMeetingResearchSnapshot(saved);
    assert.equal(projected.jobs[0]!.reviewState, expected, variant);
    assert.deepEqual(projected.jobs[0]!.task, task);
    assert.equal(JSON.stringify(projected).includes(fixtureAnswerText), false, 'projection contains no copied answer text');
    assert.deepEqual(await service.projectMeetingResearchSnapshot(saved), projected, 'polling cannot rejudge or redispatch');
    assert.equal(readFileSync(f.file(), 'utf8'), before); assert.equal(eventlog.listEvents(task!.sessionId).length, eventCount);
    assert.equal(f.calls(), 1);
    assert.equal(await service.meetingResearchResultReview(task!, { meetingId: 'a-different-meeting', jobId: f.job.id }), 'unverified');
  }
});

test('dispatch binds the real receipt, active lease and immutable accepted source before execution, with only selected bounded evidence', async () => {
  let observedTask: MeetingResearchTask | undefined;
  const f = fixture(async input => {
    const task = taskFromExecution(input); observedTask = task;
    const receipt = eventlog.getHarnessChatRequestReceipt(task.clientRequestId)!;
    assert.equal(receipt.sessionId, task.sessionId); assert.equal(receipt.runId, task.runId);
    assert.equal(receipt.inputHash, sha(JSON.stringify({ input: input.input, attachmentIds: [] })));
    const attempt = eventlog.getLatestRunAttemptByRunId(task.sessionId, task.runId)!;
    assert.equal(attempt.attemptId, input.runAttemptId); assert.equal(attempt.sourceUserSeq, input.sourceUserSeq);
    assert.equal(attempt.status, 'active'); assert.equal(attempt.finishedAt, null);
    assert.match(attempt.leaseOwner!, /^meeting-research:/); assert.ok(Date.parse(attempt.leaseExpiresAt!) > Date.now());
    const source = eventlog.getRunAttemptSourceUserEvent(attempt)!;
    assert.equal(source.seq, task.sourceUserSeq); assert.equal(source.data.source, 'meeting_research');
    assert.equal(source.data.text, input.input); assert.equal(source.data.meetingResearchInputDigest, sha(input.input));
    assert.equal(source.data.attemptId, task.attemptId); assert.equal(source.data.clientRequestId, task.clientRequestId);
    assert.deepEqual(f.coordinator.get(f.record.id).jobs[0]!.task, task, 'acceptance is retained before waiting for the executor');
    const context = sourceContexts.readSourceSessionContext(task);
    assert.ok(context, 'the original composition is durably captured before execution');
    assert.equal(context.sessionId, task.sessionId); assert.equal(context.sourceUserSeq, task.sourceUserSeq);
    assert.match(context.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(context.memoryScope, { projectId: null, agentKey: null });
    assert.equal(context.mount.project, null); assert.equal(context.mount.agent, null);
    assert.deepEqual(learning.readTurnLearningPolicyForSource(task), { status: 'excluded', policy: { version: 1, mode: 'exclude', reason: 'owner_opt_out' } });
    const packet = JSON.parse(input.input.split('\n').at(-1)!);
    assert.equal(packet.question, f.question.question); assert.deepEqual(packet.segmentIds, f.question.segmentIds);
    assert.equal(packet.evidence.facts.length, 0); assert.deepEqual(source.data.meetingResearchFactRefs, []);
    assert.equal(packet.evidence.documents.length, 1);
    const document = packet.evidence.documents[0];
    assert.equal(document.id, f.reference.id); assert.equal(document.revision, f.reference.revision); assert.equal(document.digest, f.reference.digest);
    assert.equal(document.text.length, 12_000); assert.equal(document.truncated, true); assert.match(document.citation, /:r1:sha256:/);
    assert.equal(input.input.includes(`UNSELECTED_SOURCE_MUST_NOT_ENTER_${f.index}`), false);
    boundaryGuard.installMeetingResearchBoundary(reference => f.coordinator.verifyResearchBoundary(reference));
    assert.doesNotThrow(() => boundaryGuard.assertMeetingResearchModelAllowed(task.sessionId, task.sourceUserSeq));
    assert.match(boundaryGuard.meetingResearchToolRefusal(task.sessionId, task.sourceUserSeq)!, /Tool execution is not authorized/);
    return { status: 'completed', answer: 'An executor return alone is not a typed completion.' };
  }, { longDocument: true });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(f.calls(), 1); assert.equal(result.jobs[0]!.status, 'blocked');
  assert.equal(service.meetingResearchTaskStatus(observedTask!).status, 'blocked');
  const terminals = eventlog.listEvents(observedTask!.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0]!.data.presentation as { status: string }).status, 'blocked');
  assert.equal((terminals[0]!.data.presentation as { kind: string }).kind, 'blocked');
  assert.match((terminals[0]!.data.presentation as { text: string }).text, /couldn.t finish.*permitted sources/i);
  assert.equal(terminals[0]!.data.sourceUserSeq, observedTask!.sourceUserSeq);
  assert.equal(eventlog.getKillRequest(observedTask!.sessionId, { sourceUserSeq: observedTask!.sourceUserSeq }), null,
    'the exact stop latch is retired when its physical attempt reaches finally');
  assert.equal(eventlog.getLatestRunAttemptByRunId(observedTask!.sessionId, observedTask!.runId)!.status, 'failed');
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1, 'unqualified answers never redispatch');
  assert.deepEqual(f.coordinator.get(f.record.id).jobs[0]!.task, observedTask);
});

test('only the exact typed terminal can qualify completion; a typed blocked outcome cannot become success', async () => {
  for (const status of ['done', 'blocked'] as const) {
    let task: MeetingResearchTask | undefined;
    const f = fixture(async input => { task = taskFromExecution(input); typedTerminal(input, status); return { any: 'untrusted executor value' }; });
    const result = await f.coordinator.drain(f.record.id);
    assert.equal(result.jobs[0]!.status, status === 'done' ? 'completed' : 'blocked');
    assert.equal(service.meetingResearchTaskStatus(task!).status, status === 'done' ? 'completed' : 'blocked');
    await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
    assert.equal(eventlog.listEvents(task!.sessionId, { types: ['user_input_received'] }).length, 1);
    const terminals = eventlog.listEvents(task!.sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1, 'an existing exact typed terminal is never replaced or duplicated');
    assert.equal((terminals[0]!.data.presentation as { status: string }).status, status);
    assert.equal(eventlog.getKillRequest(task!.sessionId, { sourceUserSeq: task!.sourceUserSeq }), null, 'retained canonical terminal needs no failure Stop');
  }
});

test('approved memory evidence is capped at six owner-wide facts, excludes project/agent facts, and carries exact full-content hashes', async () => {
  let expectedIds = new Set<number>();
  const f = fixture(async input => {
    const packet = JSON.parse(input.input.split('\n').at(-1)!);
    assert.equal(packet.evidence.facts.length, 6);
    assert.equal(packet.evidence.facts.every((fact: { id: number }) => expectedIds.has(fact.id)), true);
    assert.equal(input.input.includes('PROJECT_PRIVATE_MARKER'), false); assert.equal(input.input.includes('AGENT_PRIVATE_MARKER'), false);
    const source = eventlog.listEventsAtSequences(input.sessionId, [input.sourceUserSeq])[0]!;
    assert.equal((source.data.meetingResearchFactRefs as unknown[]).length, 6);
    for (const fact of packet.evidence.facts) {
      const full = facts.getFact(fact.id)!;
      assert.ok(fact.text.length <= 1_500); assert.equal(fact.truncated, full.content.length > 1_500);
      assert.equal(fact.digest, sha(full.content)); assert.equal(fact.updatedAt, full.updatedAt);
      assert.equal(fact.citation, `memory-fact:${fact.id}@${sha(full.content)}`);
    }
    typedTerminal(input, 'blocked');
  }, { useMemory: true });
  const topic = `fixturetopic${f.index}`;
  expectedIds = new Set(Array.from({ length: 8 }, (_, index) => facts.rememberFact({ kind: 'reference', scope: null,
    content: `${topic} approved launchnumber owner-wide controlled fact ${index}. ${'Controlled detail. '.repeat(120)}` }).id));
  facts.rememberFact({ kind: 'reference', scope: { projectId: `project-${topic}`, agentKey: null }, content: `${topic} approved launchnumber PROJECT_PRIVATE_MARKER.` });
  facts.rememberFact({ kind: 'reference', scope: { projectId: null, agentKey: `agent-${topic}` }, content: `${topic} approved launchnumber AGENT_PRIVATE_MARKER.` });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(f.calls(), 1); assert.equal(result.jobs[0]!.status, 'blocked');
});

test('expired, revoked, changed-document and corrupt grants never enter execution or create a task receipt', async () => {
  for (const condition of ['expired', 'revoked', 'document_changed', 'corrupt'] as const) {
    const f = fixture(async () => { assert.fail('An invalid grant cannot enter execution.'); });
    if (condition === 'expired') f.advance(2 * 60 * 60_000 + 1);
    if (condition === 'revoked') f.coordinator.stop(f.record.id);
    if (condition === 'document_changed') {
      const current = documents.meetingDocuments.getMeetingDocuments(f.record.id);
      documents.meetingDocuments.attachMeetingDocument(f.record.id, { captureDigest: current.captureDigest, expectedVersion: current.snapshotVersion,
        id: f.reference.id, title: 'Corrected controlled briefing', text: 'A later controlled revision.' });
    }
    if (condition === 'corrupt') {
      const state = JSON.parse(readFileSync(f.file(), 'utf8')); state.grant.digest = '0'.repeat(64); writeFileSync(f.file(), JSON.stringify(state));
      await assert.rejects(async () => f.coordinator.drain(f.record.id), /state_corrupt/);
    } else await f.coordinator.drain(f.record.id);
    assert.equal(f.calls(), 0); assert.equal(eventlog.getHarnessChatRequestReceipt(f.job.clientRequestId), null);
  }
});

test('revocation during execution targets the accepted attempt, retains its source, and cannot stop a later unrelated attempt', async () => {
  let task: MeetingResearchTask | undefined;
  const f = fixture(async input => {
    task = taskFromExecution(input);
    assert.equal(eventlog.getKillRequest(task.sessionId, { sourceUserSeq: task.sourceUserSeq }), null);
    f.coordinator.stop(f.record.id);
    const kill = eventlog.getKillRequest(task.sessionId, { sourceUserSeq: task.sourceUserSeq })!;
    assert.equal(kill.attemptId, task.attemptId); assert.equal(kill.runId, task.runId);
    assert.equal(kill.scopeKey, `attempt:${task.attemptId}`);
    return { status: 'completed' };
  });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(result.enabled, false); assert.equal(result.jobs[0]!.status, 'cancelled');
  assert.deepEqual(result.jobs[0]!.task, task);
  const source = eventlog.listEventsAtSequences(task!.sessionId, [task!.sourceUserSeq])[0]!;
  assert.equal(source.data.meetingResearchInputDigest, sha(source.data.text as string));
  const later = eventlog.beginRunAttempt(task!.sessionId, { runId: 'unrelated-later-controlled-attempt' });
  assert.equal(eventlog.getKillRequest(task!.sessionId, { attemptId: later.attemptId }), null);
  eventlog.finishRunAttempt(later, 'completed');
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
});

test('a durable prior request reservation is never executed again even when its acknowledgement is missing', async () => {
  const f = fixture(async () => { assert.fail('A prior request must not execute again.'); });
  const runId = `meeting-research:${f.job.id}`;
  eventlog.createSession({ id: f.job.privateOriginSessionId, kind: 'chat', channel: 'desktop' });
  eventlog.claimHarnessChatRequest({ requestId: f.job.clientRequestId, sessionId: f.job.privateOriginSessionId,
    runId, inputHash: sha('Earlier controlled request, exact body unavailable.'), sinceSeq: 0 });
  const result = await f.coordinator.drain(f.record.id);
  assert.equal(f.calls(), 0); assert.equal(result.jobs[0]!.status, 'blocked');
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 0);
  assert.equal(eventlog.listEvents(f.job.privateOriginSessionId, { types: ['user_input_received'] }).length, 0);
});

test('dispatch rechecks authority before evidence preparation and after it, so an expired grant cannot produce a source', async () => {
  const f = fixture(async () => { assert.fail('Expired authority cannot enter execution.'); });
  let verifies = 0;
  const port = service.createMeetingResearchTaskDispatch(async () => { assert.fail('No execute.'); });
  const coordinator = research.createMeetingResearchCoordinator({ directory: path.join(home, `double-check-${f.index}`),
    readMeeting: capture.loadRecallMeetingById, readDocumentRefs: () => [f.reference], now: () => Date.now(),
    dispatch: async input => port({ ...input, verify: () => {
      const value = input.verify(); verifies++;
      if (verifies === 2) throw new Error('Controlled grant expired during preparation.');
      return value;
    } }) });
  coordinator.set(f.record.id, { enabled: true, useMemory: false, maxLookups: 1, documentRefs: [f.reference], expectedVersion: 0 });
  const job = coordinator.enqueue(f.record.id, f.question);
  const result = await coordinator.drain(f.record.id);
  assert.equal(verifies, 2); assert.equal(result.jobs[0]!.status, 'blocked');
  assert.equal(eventlog.getHarnessChatRequestReceipt(job.clientRequestId), null);
});

test('source evidence refuses unpermitted, changed, superseded, inactive or moved facts and accepts only the current exact observation', async () => {
  for (const change of ['memory_disabled', 'content_changed', 'superseded', 'inactive', 'moved_project'] as const) {
    let factId = 0;
    const f = fixture(async input => {
      const boundary = f.dispatchInput().verify();
      const source = eventlog.listEventsAtSequences(input.sessionId, [input.sourceUserSeq])[0]!;
      const original = facts.getFact(factId)!;
      const reference = { id: factId, digest: sha(original.content), updatedAt: original.updatedAt };
      if (change === 'memory_disabled') {
        assert.deepEqual(source.data.meetingResearchFactRefs, []);
        assert.doesNotThrow(() => service.verifyMeetingResearchSourceEvidence(boundary, source.data));
        assert.throws(() => service.verifyMeetingResearchSourceEvidence(boundary, { ...source.data, meetingResearchFactRefs: [reference] }), /outside this research permission/);
      } else {
        assert.ok((source.data.meetingResearchFactRefs as { id: number }[]).some(ref => ref.id === factId));
        assert.doesNotThrow(() => service.verifyMeetingResearchSourceEvidence(boundary, source.data));
        if (change === 'content_changed') facts.updateFact(factId, { content: `${original.content} Corrected controlled content.` });
        if (change === 'superseded') facts.supersedeFact(factId, { content: `${original.content} Superseding controlled fact.`, scope: null });
        if (change === 'inactive') facts.forgetFact(factId);
        if (change === 'moved_project') facts.moveFactToScope(factId, { projectId: `private-project-${f.index}`, agentKey: null });
        assert.throws(() => service.verifyMeetingResearchSourceEvidence(boundary, source.data), /memory evidence changed/);
      }
      assert.throws(() => service.verifyMeetingResearchSourceEvidence(boundary, { meetingResearchFactRefs: undefined }));
      assert.throws(() => service.verifyMeetingResearchSourceEvidence(boundary, { meetingResearchFactRefs: Array.from({ length: 7 }, () => reference) }));
      typedTerminal(input, 'blocked');
    }, { useMemory: change !== 'memory_disabled' });
    factId = facts.rememberFact({ kind: 'reference', scope: null,
      content: `fixturetopic${f.index} approved launchnumber controlled source observation.` }).id;
    const result = await f.coordinator.drain(f.record.id);
    assert.equal(f.calls(), 1); assert.equal(result.jobs[0]!.status, 'blocked');
  }
});

test('retained task status rejects a changed receipt hash or source binding even when a typed done terminal exists', async () => {
  let task: MeetingResearchTask | undefined;
  const f = fixture(async input => { task = taskFromExecution(input); typedTerminal(input, 'done'); });
  assert.equal((await f.coordinator.drain(f.record.id)).jobs[0]!.status, 'completed');
  assert.equal(service.meetingResearchTaskStatus(task!).status, 'completed');
  const db = eventlog.openEventLog();
  const receipt = eventlog.getHarnessChatRequestReceipt(task!.clientRequestId)!;
  db.prepare('UPDATE harness_chat_requests SET input_hash = ? WHERE request_id = ?').run(sha('Corrupt fixture receipt.'), task!.clientRequestId);
  assert.equal(service.meetingResearchTaskStatus(task!).status, 'unknown');
  db.prepare('UPDATE harness_chat_requests SET input_hash = ? WHERE request_id = ?').run(receipt.inputHash, task!.clientRequestId);
  const source = eventlog.listEventsAtSequences(task!.sessionId, [task!.sourceUserSeq])[0]!;
  for (const field of ['meetingResearchInputDigest', 'runId', 'attemptId', 'requestId', 'displayText'] as const) {
    db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify({ ...source.data, [field]: 'Corrupt controlled binding.' }), source.seq);
    assert.equal(service.meetingResearchTaskStatus(task!).status, 'unknown', field);
  }
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(source.data), source.seq);
  assert.equal(service.meetingResearchTaskStatus(task!).status, 'completed');
  await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
});

test('expiry or revocation while awaiting execution cannot qualify a late executor result as current research', async () => {
  for (const change of ['expiry', 'revoke'] as const) {
    let task: MeetingResearchTask | undefined;
    const f = fixture(async input => {
      task = taskFromExecution(input);
      if (change === 'expiry') f.advance(2 * 60 * 60_000 + 1);
      else f.coordinator.stop(f.record.id);
      // A late returned object, including a misleading completion label, is
      // not permission to publish or mark the owner-facing research job done.
      return { status: 'completed', answer: 'Late controlled output.' };
    });
    const result = await f.coordinator.drain(f.record.id);
    assert.notEqual(result.jobs[0]!.status, 'completed'); assert.deepEqual(result.jobs[0]!.task, task);
    const attempt = eventlog.getLatestRunAttemptByRunId(task!.sessionId, task!.runId)!;
    assert.ok(attempt.finishedAt); assert.notEqual(attempt.status, 'completed');
    assert.equal(eventlog.getRunAttemptSourceUserEvent(attempt)!.seq, task!.sourceUserSeq);
    const terminals = eventlog.listEvents(task!.sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1);
    const presentation = terminals[0]!.data.presentation as { status: string; kind: string; text: string };
    assert.equal(presentation.status, change === 'revoke' ? 'cancelled' : 'blocked');
    assert.equal(presentation.kind, change === 'revoke' ? 'stopped' : 'blocked');
    assert.match(presentation.text, /recording is unaffected/i);
    assert.equal(terminals[0]!.data.sourceUserSeq, task!.sourceUserSeq);
    assert.equal(eventlog.getKillRequest(task!.sessionId, { sourceUserSeq: task!.sourceUserSeq }), null,
      'finished research leaves no latch that could stop later work');
    await f.reopen().drain(f.record.id); assert.equal(f.calls(), 1);
  }
});
