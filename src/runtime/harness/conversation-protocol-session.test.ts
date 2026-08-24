import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-conversation-protocol-session-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const identities = await import('./attempt-identity.js');
const protocol = await import('./conversation-protocol.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function user(text: string): AgentInputItem {
  return { role: 'user', content: text } as AgentInputItem;
}

function call(callId: string, name: string, args: unknown): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  } as AgentInputItem;
}

function orphan(callId: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'legacy_tool',
    output: { type: 'text', text: '{}' },
    status: 'completed',
  } as AgentInputItem;
}

function acceptedSession(text = 'Read alpha records.') {
  const session = HarnessSession.create({
    id: `conversation-protocol-${++serial}`,
    kind: 'chat',
  });
  const source = session.recordUserInput(text, 1);
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    session,
    source,
    task: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    },
  };
}

function rawMetadataJson(sessionId: string): string {
  return (eventlog.openEventLog().prepare(
    'SELECT metadata_json FROM sessions WHERE id = ?',
  ).get(sessionId) as { metadata_json: string }).metadata_json;
}

test('exact durable settlement/result authority repairs once and clears the stale response chain', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession();
  const logicalToolCallId = 'call-settled-result';
  const physicalDispatchId = 'dispatch-settled-result';
  const tool = 'alpha_records_search';
  const args = { query: 'alpha' };
  const payload = { successful: true, data: { records: [{ id: 'alpha-1' }] } };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...fixture.task,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: fixture.task.sessionId,
      sourceUserSeq: fixture.task.sourceUserSeq,
      acceptedTaskId: fixture.task.acceptedTaskId,
      logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: false, mutating: false },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));

  fixture.session.recordTurnResult({
    history: [user('Read alpha records.'), call(logicalToolCallId, tool, args)],
    lastResponseId: 'stale-provider-chain',
    turn: 1,
  });
  const prepared = fixture.session.prepareProviderHistory();
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.equal(prepared.migration, 'paired_exact_result');
  assert.equal(prepared.providerHistory.length, 3);
  const result = prepared.providerHistory[2] as unknown as Record<string, unknown>;
  assert.equal(result.callId, logicalToolCallId);
  assert.equal(result.name, tool);
  assert.deepEqual(protocol.inspectConversationProtocol(prepared.providerHistory), {
    status: 'valid',
    issues: [],
  });
  assert.equal(fixture.session.previousResponseId(), undefined);

  const replay = fixture.session.prepareProviderHistory();
  assert.equal(replay.status, 'ready');
  assert.equal(replay.migration, 'none');
  assert.deepEqual(replay.history, prepared.history);
});

test('settled zero-crossing refusal becomes an ordinary paired replan result', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession('Search for the unavailable connector.');
  const callId = 'call-refused';
  const tool = 'tool_search';
  const args = { query: 'unavailable connector' };
  const identity = { ...fixture.task, logicalToolCallId: callId };
  assert.equal(dispatch.admitLogicalCall({ identity, tool, args }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: tool, args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
    recovery: { businessCall: false, mutating: false },
    observer: { lane: 'agents_runner', callId, turn: 1 },
  }).status, 'committed');
  fixture.session.recordTurnResult({
    history: [user('Search.'), call(callId, tool, args)],
    lastResponseId: 'stale-refusal-chain',
    turn: 1,
  });

  const prepared = fixture.session.prepareProviderHistory();
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.equal(prepared.migration, 'paired_refused_pre_dispatch');
  const result = prepared.providerHistory[2] as unknown as { output?: { text?: string } };
  const payload = JSON.parse(result.output?.text ?? '{}') as Record<string, unknown>;
  assert.equal(payload.disposition, 'refused_pre_dispatch');
  assert.equal(payload.effect, 'none');
  assert.equal(payload.retry, 'replan');
});

test('entered physical crossing becomes effect-unknown, persists once, and remains provider-held', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession('Create the record once.');
  const callId = 'call-unknown';
  const tool = 'alpha_records_create';
  const args = { id: 'alpha-1' };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...fixture.task,
      logicalToolCallId: callId,
      physicalDispatchId: 'dispatch-unknown',
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(started.status, 'inserted');
  fixture.session.recordTurnResult({
    history: [user('Create the record once.'), call(callId, tool, args)],
    lastResponseId: 'stale-unknown-chain',
    turn: 1,
  });

  const first = fixture.session.prepareProviderHistory();
  assert.equal(first.status, 'held');
  assert.equal(first.disposition, 'reconciliation_required');
  assert.equal(first.providerHistory, null);
  assert.equal(first.history.length, 3);
  const firstBytes = JSON.stringify(first.history);
  const second = fixture.session.prepareProviderHistory();
  assert.equal(second.status, 'held');
  assert.equal(second.disposition, 'reconciliation_required');
  assert.equal(JSON.stringify(second.history), firstBytes);
  assert.equal(fixture.session.previousResponseId(), undefined);
});

test('pending approval holds without changing one metadata byte', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession('Send the message after approval.');
  fixture.session.recordTurnResult({
    history: [user('Send the message after approval.')],
    lastResponseId: 'response-before-approval',
    turn: 1,
  });
  fixture.session.saveInterruptState(JSON.stringify({
    __clemHostInterrupt: 2,
    history: [user('Send the message after approval.')],
    pending: [{
      callId: 'call-pending',
      name: 'send_message',
      rawItem: { callId: 'call-pending', name: 'send_message', arguments: '{}' },
    }],
    turnEngine: 'host_v1',
  }));
  const before = rawMetadataJson(fixture.session.id);

  const prepared = fixture.session.prepareProviderHistory();
  assert.equal(prepared.status, 'held');
  assert.equal(prepared.disposition, 'pending_approval');
  assert.equal(prepared.providerHistory, null);
  assert.equal(rawMetadataJson(fixture.session.id), before);
  assert.equal(fixture.session.previousResponseId(), 'response-before-approval');
});

test('ambiguous historical suffix is quarantined atomically and a fresh source remains appendable', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession('Legacy source.');
  const legacyPrefix = user('Legacy source.');
  const poisoned = orphan('call-orphan');
  fixture.session.recordTurnResult({
    history: [legacyPrefix, poisoned],
    lastResponseId: 'stale-orphan-chain',
    turn: 1,
  });

  const prepared = fixture.session.prepareProviderHistory();
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.equal(prepared.migration, 'quarantined');
  assert.deepEqual(prepared.providerHistory, [legacyPrefix]);
  const row = eventlog.getSession(fixture.session.id)!;
  const quarantine = row.metadata.__conversation_protocol_quarantine as Array<{
    originalItems: AgentInputItem[];
    issues: string[];
  }>;
  assert.equal(quarantine.length, 1);
  assert.equal(JSON.stringify(quarantine[0]!.originalItems), JSON.stringify([poisoned]));
  assert.deepEqual(quarantine[0]!.issues, ['orphan_function_result']);
  assert.equal(fixture.session.previousResponseId(), undefined);

  const fresh = user('Completely unrelated fresh source.');
  assert.deepEqual(protocol.inspectConversationProtocol([...prepared.providerHistory, fresh]), {
    status: 'valid',
    issues: [],
  });
  const afterFirst = rawMetadataJson(fixture.session.id);
  const replay = fixture.session.prepareProviderHistory();
  assert.equal(replay.status, 'ready');
  assert.equal(replay.migration, 'none');
  assert.equal(rawMetadataJson(fixture.session.id), afterFirst, 'migration is idempotent');
  assert.equal(
    createHash('sha256').update(JSON.stringify(quarantine[0]!.originalItems)).digest('hex'),
    createHash('sha256').update(JSON.stringify([poisoned])).digest('hex'),
  );
});

test('unmatched history without durable evidence is held and never guessed', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession('Unknown legacy call.');
  fixture.session.recordTurnResult({
    history: [user('Unknown legacy call.'), call('call-no-evidence', 'unknown_tool', {})],
    lastResponseId: 'unchanged-no-evidence-chain',
    turn: 1,
  });
  const before = rawMetadataJson(fixture.session.id);

  const prepared = fixture.session.prepareProviderHistory();
  assert.equal(prepared.status, 'held');
  assert.equal(prepared.disposition, 'evidence_unavailable');
  assert.equal(prepared.providerHistory, null);
  assert.equal(rawMetadataJson(fixture.session.id), before);
});
