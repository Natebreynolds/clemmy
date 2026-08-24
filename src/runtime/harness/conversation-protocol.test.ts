import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import {
  ConversationProtocolMigrationError,
  conversationProtocolItemBytesSha256,
  inspectConversationProtocol,
  migratePersistedConversationProtocol,
} from './conversation-protocol.js';

function user(text: string): AgentInputItem {
  return { role: 'user', content: [{ type: 'input_text', text }] };
}

function call(callId: string, name = 'records_create'): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: '{}',
    status: 'completed',
  };
}

function result(callId: string, name = 'records_create'): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name,
    output: { type: 'text', text: JSON.stringify({ ok: true, receipt: 'receipt-1' }) },
    status: 'completed',
  };
}

test('repair is inserted before the later source that crossed an open legacy frame', () => {
  const migrated = migratePersistedConversationProtocol({
    history: [user('Search once.'), call('call-before-next', 'records_search'), user('Unrelated next source.')],
    evidenceByCallId: {
      'call-before-next': {
        kind: 'proven_no_crossing',
        executionKind: 'refused_pre_dispatch',
        physicalDispatchCount: 0,
      },
    },
  });

  assert.equal(migrated.disposition, 'ready');
  assert.deepEqual(
    migrated.history.map((item) => (item as { type?: string; role?: string }).type
      ?? (item as { role?: string }).role),
    ['user', 'function_call', 'function_call_result', 'user'],
  );
  assert.deepEqual(inspectConversationProtocol(migrated.history), { status: 'valid', issues: [] });
});

test('settled evidence rejects a mismatched exact JSON-byte digest', () => {
  const exact = result('call-bad-hash');
  assert.throws(
    () => migratePersistedConversationProtocol({
      history: [user('Create once.'), call('call-bad-hash')],
      evidenceByCallId: {
        'call-bad-hash': {
          kind: 'settled_result',
          result: exact,
          resultBytesSha256: '0'.repeat(64),
        },
      },
    }),
    (error: unknown) => error instanceof ConversationProtocolMigrationError
      && error.code === 'settled_result_hash_mismatch',
  );
});

test('effect-unknown stays provider-held across migration replay and exact reconciliation replaces it', () => {
  const crossingEvidence = {
    kind: 'physical_crossing_unreadable' as const,
    physicalDispatchId: 'dispatch-1',
    state: 'unknown' as const,
  };
  const first = migratePersistedConversationProtocol({
    history: [user('Create once.'), call('call-reconcile')],
    evidenceByCallId: { 'call-reconcile': crossingEvidence },
  });
  assert.equal(first.disposition, 'reconciliation_required');
  assert.equal(first.providerHistory, null);

  const replay = migratePersistedConversationProtocol({
    history: first.history,
    evidenceByCallId: {},
  });
  assert.equal(replay.disposition, 'reconciliation_required');
  assert.equal(replay.migration, 'none');
  assert.equal(replay.providerHistory, null);
  assert.deepEqual(replay.history, first.history);

  const exact = result('call-reconcile');
  const resolved = migratePersistedConversationProtocol({
    history: replay.history,
    evidenceByCallId: {
      'call-reconcile': {
        kind: 'settled_result',
        result: exact,
        resultBytesSha256: conversationProtocolItemBytesSha256(exact),
      },
    },
  });
  assert.equal(resolved.disposition, 'ready');
  assert.equal(resolved.migration, 'paired_exact_result');
  assert.ok(resolved.providerHistory);
  assert.deepEqual(resolved.history[resolved.history.length - 1], exact);
});

test('an unmatched call without durable evidence is never guessed or heuristically repaired', () => {
  assert.throws(
    () => migratePersistedConversationProtocol({
      history: [user('Do it.'), call('call-no-evidence')],
      evidenceByCallId: {},
    }),
    (error: unknown) => error instanceof ConversationProtocolMigrationError
      && error.code === 'missing_call_evidence',
  );
});

test('inspector rejects a result whose name or namespace does not match its call', () => {
  const history = [
    {
      ...call('call-identity', 'records_search'),
      namespace: 'local',
    } as AgentInputItem,
    {
      ...result('call-identity', 'records_create'),
      namespace: 'remote',
    } as AgentInputItem,
  ];

  const inspection = inspectConversationProtocol(history);
  assert.equal(inspection.status, 'invalid');
  assert.ok(inspection.issues.some((issue) => (
    issue.code === 'function_result_identity_mismatch'
      && issue.callId === 'call-identity'
      && issue.index === 1
  )));
});

test('exact settled evidence replaces a mismatched existing result identity', () => {
  const exact = {
    ...result('call-identity-repair', 'records_search'),
    namespace: 'local',
  } as AgentInputItem;
  const migrated = migratePersistedConversationProtocol({
    history: [
      {
        ...call('call-identity-repair', 'records_search'),
        namespace: 'local',
      } as AgentInputItem,
      {
        ...result('call-identity-repair', 'records_create'),
        namespace: 'remote',
      } as AgentInputItem,
    ],
    evidenceByCallId: {
      'call-identity-repair': {
        kind: 'settled_result',
        result: exact,
        resultBytesSha256: conversationProtocolItemBytesSha256(exact),
      },
    },
  });

  assert.equal(migrated.disposition, 'ready');
  assert.equal(migrated.migration, 'paired_exact_result');
  assert.deepEqual(migrated.history[1], exact);
  assert.deepEqual(inspectConversationProtocol(migrated.history), { status: 'valid', issues: [] });
});
