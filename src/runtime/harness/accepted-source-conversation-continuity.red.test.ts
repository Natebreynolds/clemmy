/** The mobile retry keeps the authored deliverable, while a clean successor
 * still owns no parent calls, approvals, or provider replay state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-successor-context-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'a'.repeat(64);
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { selectSessionForAcceptedSource, claimSessionForAcceptedSource, sameConversationAncestorSessionIds } = await import('./accepted-source-session-branch.js');
const { runTurn } = await import('./loop.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { createFocus } = await import('../../memory/focus.js');
const { renderHarnessMemoryContext } = await import('../../agents/harness-context.js');
const { buildAgentContextPacket } = await import('./context-packet.js');
const { resolveActiveTaskContext, renderResolvedActiveTaskContext } = await import('./active-task-context.js');
const memoryDatabase = await import('../../memory/db.js');
const provenance = await import('./model-request-provenance.js');

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
});

const continuity = { provider: 'mobile', scopeId: null, conversationId: 'phone-conversation', audienceId: 'phone-owner' };
let serial = 0;
function parentSession() {
  return HarnessSession.create({
    id: `parent-conversation-${++serial}`,
    kind: 'chat', channel: 'mobile', userId: continuity.audienceId,
    metadata: { source: 'mobile', channelId: continuity.conversationId, userId: continuity.audienceId },
  });
}

function completedExchange(parent: InstanceType<typeof HarnessSession>, request: string, reply: string, turn: number, reason = 'success') {
  const source = parent.recordUserInput(request, turn);
  const terminal = eventlog.appendEvent({
    sessionId: parent.id, turn, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, reply, reason },
  });
  return { source, terminal };
}

function prepareFailure(parent: InstanceType<typeof HarnessSession>) {
  parent.recordTurnResult({
    turn: 7,
    history: [{
      type: 'function_call', callId: 'unsafe-parent-call', name: 'external_send',
      arguments: '{"secret":"DO-NOT-COPY-OLD-CALL"}', status: 'completed',
    }],
    lastResponseId: 'DO-NOT-COPY-PROVIDER-CHAIN',
  });
  parent.markStatus('failed');
}

async function captureModelRequest(child: InstanceType<typeof HarnessSession>, input: string, turn = 1) {
  const source = child.recordUserInput(input, turn);
  const requests: unknown[] = [];
  const model = {
    async getResponse(request: unknown): Promise<never> {
      requests.push(request);
      throw new Error('fixture captured first successor request');
    },
    async *getStreamedResponse(request: unknown): AsyncGenerator<never> {
      await this.getResponse(request);
    },
  };
  const agent = { model, tools: [], instructions: renderHarnessMemoryContext({ sessionId: child.id, focusInput: input }) };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: child.id, universeTools: [], activeToolNames: [], policyHash: 'successor-context-v1',
    budget: { maxUncachedTokens: 30_000, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 10_000 },
  });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  await runTurn({
    sessionId: child.id, input, sourceUserSeq: source.seq, reuseRecordedUserInput: true,
    turnEngine: 'host_v1', agent: agent as never, judgeCompletion: false,
    suppressMemoryCapture: true, suppressAutomaticMemoryForRequest: true,
    makeRunner: () => new EventEmitter() as never,
    maxTurns: 1,
  });
  assert.equal(requests.length, 1, 'reach the actual first model boundary');
  return { source, wire: JSON.stringify(requests[0]) };
}

test('first successor model request retains all three long drafts and ignores other-session stale/parked work', async () => {
  memoryDatabase.resetMemoryDb();
  const parent = parentSession();
  const drafts = ['Denlea', 'McGlone', 'Oxendine'].map((name, index) => (
    `Draft ${index + 1}: ${name}\nSubject: ${name} follow-up\n${`${name} grounded body. `.repeat(145)}\nEND-${name}`
  )).join('\n\n');
  const authored = completedExchange(parent, 'Compose three follow-ups for Brett, do not send.', drafts, 1);
  for (let turn = 2; turn <= 11; turn += 1) {
    completedExchange(parent, 'Add these to my drafts please.', 'The previous attempt failed before dispatch.', turn, 'failed');
  }
  prepareFailure(parent);
  const before = JSON.stringify(parent.sessionRow.metadata);

  createFocus({ resourceRef: 'session:other-old-work', relatedSessionId: 'other-old-work',
    title: 'Five drafts for Tyler Jorgensen', summary: 'Wrong historical work.' });
  createFocus({ resourceRef: 'session:other-stale-work', relatedSessionId: 'other-stale-work',
    title: 'Create five stale drafts', summary: 'Wrong historical five-draft objective.', staleOnCreate: true });

  const selected = claimSessionForAcceptedSource({
    kind: 'ordinary', entrySessionId: parent.id, durableSourceId: 'mobile-retry-with-drafts', continuity,
    receipt: { requestId: 'mobile-retry-request', runId: 'mobile-retry-with-drafts', inputHash: '1'.repeat(64) },
  });
  assert.equal(selected.selection.disposition, 'branched');
  const child = HarnessSession.load(selected.selection.sessionId)!;
  assert.deepEqual(sameConversationAncestorSessionIds({ sessionId: child.id, principalId: continuity.audienceId }), [parent.id]);
  assert.deepEqual(sameConversationAncestorSessionIds({ sessionId: child.id, principalId: 'different-human' }), []);
  assert.deepEqual(child.toInputItems(), []);
  assert.equal(child.previousResponseId(), undefined);
  assert.equal(child.loadInterruptState(), null);
  assert.equal(JSON.stringify(HarnessSession.load(parent.id)!.sessionRow.metadata), before);
  const prefix = eventlog.listEvents(child.id, { types: ['cross_session_prefix'] });
  assert.equal(prefix.length, 1);
  assert.ok(String(prefix[0]!.data.text).includes(drafts), 'all authored bytes, including the third draft, survive');
  assert.ok(JSON.stringify(prefix[0]!.data.sources).includes(authored.terminal.id));
  const provenanceSource = (prefix[0]!.data.sources as Array<Record<string, unknown>>)
    .find((item) => item.terminalEventId === authored.terminal.id)!;
  assert.equal(provenanceSource.sourceDigest, createHash('sha256').update(JSON.stringify(authored.source.data)).digest('hex'));
  assert.equal(provenanceSource.terminalDigest, createHash('sha256').update(JSON.stringify(authored.terminal.data)).digest('hex'));
  assert.doesNotMatch(String(prefix[0]!.data.text), /DO-NOT-COPY|unsafe-parent-call/);
  assert.ok(String(prefix[0]!.data.text).length <= 32_000);

  const input = 'Add these to my drafts now please';
  const { source, wire } = await captureModelRequest(child, input);
  for (const marker of ['END-Denlea', 'END-McGlone', 'END-Oxendine', 'three follow-ups for Brett']) assert.ok(wire.includes(marker), marker);
  assert.doesNotMatch(wire, /Tyler|five stale drafts|Wrong historical|DO-NOT-COPY|unsafe-parent-call/);
  const row = eventlog.openEventLog().prepare('SELECT record_id FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ? AND request_ordinal = 1')
    .get(child.id, source.seq) as { record_id: string };
  assert.ok(row);
  const reopened = provenance.projectModelRequestProvenance(row.record_id);
  assert.equal(reopened.status, 'ok', JSON.stringify(reopened));
  assert.equal(eventlog.listEvents(child.id, { types: ['external_write_succeeded', 'approval_requested'] }).length, 0);

  // The captured model failure leaves this successor failed too. A second
  // split must reach the same parent content, even if its immediate parent
  // has no successful authored answer of its own.
  const next = selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: child.id,
    durableSourceId: 'mobile-second-retry', continuity });
  assert.equal(next.disposition, 'branched');
  const nextPrefix = eventlog.listEvents(next.sessionId, { types: ['cross_session_prefix'] });
  assert.equal(nextPrefix.length, 1);
  assert.ok(String(nextPrefix[0]!.data.text).includes(drafts));
});

test('an active successor created before the fix recovers missing conversation context on its next reused turn', async () => {
  memoryDatabase.resetMemoryDb();
  const parent = parentSession();
  const drafts = 'Draft 1: Brett / Denlea.\nDraft 2: Brett / McGlone.\nDraft 3: Brett / Oxendine.';
  completedExchange(parent, 'Compose three follow-ups for Brett.', drafts, 1);
  prepareFailure(parent);
  const selected = selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id,
    durableSourceId: `pre-fix-${serial}`, continuity });
  const child = HarnessSession.load(selected.sessionId)!;
  // Model the persisted pre-fix branch: several completed blocked turns, an
  // active session, and a valid provider transcript that lacks parent content.
  eventlog.openEventLog().prepare("DELETE FROM events WHERE session_id = ? AND type = 'cross_session_prefix'").run(child.id);
  for (let turn = 1; turn <= 3; turn += 1) {
    completedExchange(child, 'Add these to my drafts.', 'The prior attempt could not proceed.', turn, 'failed');
  }
  child.recordTurnResult({ turn: 3, history: [
    { role: 'user', content: 'Add these to my drafts.' },
    { type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'The prior attempt could not proceed.', annotations: [] }] },
  ] });
  eventlog.openEventLog().prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.__turn', 3) WHERE id = ?").run(child.id);
  const before = JSON.stringify(HarnessSession.load(child.id)!.toInputItems());
  const recovered = selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: child.id,
    durableSourceId: `post-fix-${serial}`, continuity });
  assert.equal(recovered.disposition, 'reused');
  assert.equal(recovered.sessionId, child.id);
  assert.equal(JSON.stringify(HarnessSession.load(child.id)!.toInputItems()), before);
  assert.equal(eventlog.listEvents(child.id, { types: ['cross_session_prefix'] }).length, 1);
  selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: child.id,
    durableSourceId: `post-fix-again-${serial}`, continuity });
  assert.equal(eventlog.listEvents(child.id, { types: ['cross_session_prefix'] }).length, 1, 'recovery seeds once');
  const { wire } = await captureModelRequest(HarnessSession.load(child.id)!, 'Add these to my drafts now please', 4);
  assert.ok(wire.includes(drafts.replaceAll('\n', '\\n')));
  assert.equal(wire.split('[SAME-CONVERSATION CONTEXT]').length - 1, 1);
  assert.doesNotMatch(wire, /DO-NOT-COPY|unsafe-parent-call/);
});

test('a successor does not import another principal, provider, scope, or conversation', () => {
  for (const changed of [
    { audienceId: 'other-human' }, { provider: 'desktop' }, { scopeId: 'other-scope' }, { conversationId: 'other-conversation' },
  ]) {
    const parent = parentSession();
    completedExchange(parent, 'Private request', 'PRIVATE-PARENT-DRAFT', 1);
    prepareFailure(parent);
    const selected = selectSessionForAcceptedSource({
      kind: 'ordinary', entrySessionId: parent.id, durableSourceId: `split-${serial}`, continuity: { ...continuity, ...changed },
    });
    assert.equal(selected.disposition, 'identity_split');
    assert.deepEqual(sameConversationAncestorSessionIds({ sessionId: selected.sessionId,
      principalId: changed.audienceId ?? continuity.audienceId }), []);
    assert.equal(eventlog.listEvents(selected.sessionId, { types: ['cross_session_prefix'] }).length, 0);
    assert.deepEqual(HarnessSession.load(selected.sessionId)!.toInputItems(), []);
  }
});

test('successor excerpts are bounded and exclude synthetic or invalid public ownership', () => {
  const parent = parentSession();
  const authored = completedExchange(parent, 'Compose a long draft.', `LONG-DRAFT-START ${'body '.repeat(10_000)} LONG-DRAFT-END`, 1);
  const synthetic = eventlog.appendEvent({ sessionId: parent.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'PRIVATE-SYNTHETIC-REQUEST', synthetic: true } });
  eventlog.appendEvent({ sessionId: parent.id, turn: 2, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: synthetic.seq, reply: 'PRIVATE-SYNTHETIC-ANSWER', reason: 'success' } });
  const invalid = parent.recordUserInput('INVALID-OWNERSHIP-REQUEST', 3);
  const invalidTerminal = eventlog.appendEvent({ sessionId: parent.id, turn: 3, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: invalid.seq, reply: 'INVALID-OWNERSHIP-ANSWER', reason: 'success' } });
  // Simulate a malformed historical row; today's publication boundary rightly
  // refuses to write this shape, and the continuity reader must refuse it too.
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...invalidTerminal.data, presentation: null }), invalidTerminal.id);
  prepareFailure(parent);
  const selected = selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id,
    durableSourceId: `bounded-${serial}`, continuity });
  const prefix = eventlog.listEvents(selected.sessionId, { types: ['cross_session_prefix'] });
  assert.equal(prefix.length, 1);
  const text = String(prefix[0]!.data.text);
  assert.ok(text.length <= 32_000);
  assert.match(text, /LONG-DRAFT-START/);
  assert.doesNotMatch(text, /LONG-DRAFT-END|PRIVATE-SYNTHETIC|INVALID-OWNERSHIP/);
  assert.ok(text.includes(`session_history for ${parent.id}, source ${authored.source.seq}, before copying omitted content`));
  assert.deepEqual((prefix[0]!.data.sources as Array<Record<string, unknown>>).map((item) => item.truncated), [true]);
});

test('stale and parked focus stay within their conversation; prior details require explicit retrieval', () => {
  memoryDatabase.resetMemoryDb();
  createFocus({ resourceRef: 'session:focus-owner', relatedSessionId: 'focus-owner', title: 'Parked deliverable', summary: 'Parked details.' });
  createFocus({ resourceRef: 'session:focus-owner', relatedSessionId: 'focus-owner', title: 'Stale deliverable', summary: 'Stale details.', staleOnCreate: true });
  const fresh = resolveActiveTaskContext({ sessionId: 'another-conversation', input: 'Add these to my drafts.' });
  assert.equal(fresh.focus, null);
  assert.deepEqual(fresh.parked, []);
  assert.doesNotMatch(buildAgentContextPacket('Add these to my drafts.', { enabled: false, hitCount: 0, injected: false },
    { sessionId: 'another-conversation', suppressSemanticEnrichment: true }).text, /Stale deliverable|Parked deliverable/);
  const same = resolveActiveTaskContext({ sessionId: 'focus-owner', input: 'Add these to my drafts.' });
  assert.equal(same.focus?.disposition, 'stale');
  assert.equal(same.parked.length, 1);
  assert.match(renderResolvedActiveTaskContext(same), /Stale deliverable|Parked deliverable/);
  const review = resolveActiveTaskContext({ sessionId: 'another-conversation', input: 'Review the previous work.' });
  assert.equal(review.focus, null);
  assert.deepEqual(review.parked, []);
});
