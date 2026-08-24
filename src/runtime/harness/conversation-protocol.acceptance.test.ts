/**
 * Commit-2 RED acceptance contract for provider-neutral conversation history.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/conversation-protocol.acceptance.test.ts
 *
 * The provider canary is assertion-only: it reports malformed canonical
 * history without mutating or repairing it. Historical repair is a separate,
 * evidence-driven migration. Only a model-ready migration may expose
 * `providerHistory`; pending approval and uncertain physical effects stay held.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';

type ProtocolIssueCode =
  | 'unmatched_function_call'
  | 'conversation_advanced_with_open_call'
  | 'orphan_function_result'
  | 'duplicate_function_call_id'
  | 'duplicate_function_result';

interface ProtocolIssue {
  code: ProtocolIssueCode;
  callId?: string;
  index: number;
}

interface ProtocolInspection {
  status: 'valid' | 'invalid';
  issues: ProtocolIssue[];
}

type MigrationEvidence =
  | {
      kind: 'settled_result';
      result: AgentInputItem;
      resultBytesSha256: string;
    }
  | {
      kind: 'proven_no_crossing';
      executionKind: 'refused_pre_dispatch';
      physicalDispatchCount: 0;
    }
  | {
      kind: 'physical_crossing_unreadable';
      physicalDispatchId: string;
      state: 'started' | 'timed_out' | 'unknown';
    }
  | {
      kind: 'pending_approval';
      approvalId: string;
    }
  | {
      kind: 'ambiguous';
      reason: 'reused_call_id' | 'orphan_result';
    };

interface ConversationMigration {
  disposition: 'ready' | 'pending_approval' | 'reconciliation_required';
  migration:
    | 'none'
    | 'paired_exact_result'
    | 'paired_refused_pre_dispatch'
    | 'paired_effect_unknown'
    | 'quarantined';
  history: AgentInputItem[];
  providerHistory: AgentInputItem[] | null;
  quarantine?: {
    originalItems: AgentInputItem[];
    issues: ProtocolIssueCode[];
  };
}

interface ConversationProtocolApi {
  inspectConversationProtocol(history: readonly AgentInputItem[]): ProtocolInspection;
  migratePersistedConversationProtocol(input: {
    history: readonly AgentInputItem[];
    evidenceByCallId: Readonly<Record<string, MigrationEvidence>>;
  }): ConversationMigration;
}

const PROTOCOL_MODULE_PATH = './conversation-protocol.js';
const protocolLoad = await import(PROTOCOL_MODULE_PATH)
  .then((loaded) => ({ loaded: loaded as unknown as Partial<ConversationProtocolApi> }))
  .catch(() => ({ loaded: undefined }));

function protocolApi(): ConversationProtocolApi {
  assert.ok(
    protocolLoad.loaded,
    'COMMIT-2 RED: provider-neutral conversation-protocol seam is not implemented',
  );
  assert.equal(
    typeof protocolLoad.loaded.inspectConversationProtocol,
    'function',
    'COMMIT-2 RED: inspectConversationProtocol is not implemented',
  );
  assert.equal(
    typeof protocolLoad.loaded.migratePersistedConversationProtocol,
    'function',
    'COMMIT-2 RED: migratePersistedConversationProtocol is not implemented',
  );
  return protocolLoad.loaded as ConversationProtocolApi;
}

const PROVIDER_FAMILIES = [
  'Codex Responses',
  'raw Claude Messages',
  'BYO OpenAI-compatible (GLM)',
  'BYO OpenAI-compatible (Kimi)',
] as const;

function user(text: string): AgentInputItem {
  return {
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function assistant(text: string): AgentInputItem {
  return {
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

function call(callId: string, name = 'records_search'): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify({ query: callId }),
    status: 'completed',
  };
}

function result(
  callId: string,
  name = 'records_search',
  output = JSON.stringify({ ok: true, callId }),
): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name,
    output: { type: 'text', text: output },
    status: 'completed',
  };
}

function reasoning(id: string): AgentInputItem {
  return {
    id,
    type: 'reasoning',
    content: [{ type: 'input_text', text: `opaque reasoning ${id}` }],
  };
}

function compaction(id: string): AgentInputItem {
  return {
    id,
    type: 'compaction',
    encrypted_content: `opaque-compaction-${id}`,
    created_by: 'provider',
  };
}

function issueCodes(inspection: ProtocolInspection): ProtocolIssueCode[] {
  return inspection.issues.map((issue) => issue.code);
}

function assertIssue(
  inspection: ProtocolInspection,
  expected: ProtocolIssueCode,
  callId: string,
  label: string,
): void {
  assert.equal(inspection.status, 'invalid', label);
  assert.ok(issueCodes(inspection).includes(expected), `${label}: ${expected}`);
  assert.ok(
    inspection.issues.some((issue) => issue.code === expected && issue.callId === callId),
    `${label}: ${expected} must identify ${callId}`,
  );
}

function assertReady(outcome: ConversationMigration): AgentInputItem[] {
  assert.equal(outcome.disposition, 'ready');
  assert.ok(Array.isArray(outcome.providerHistory), 'ready migration must expose providerHistory');
  return outcome.providerHistory;
}

function resultFor(history: readonly AgentInputItem[], callId: string): Record<string, unknown> {
  const found = history.find((item) => {
    const candidate = item as Record<string, unknown>;
    return candidate.type === 'function_call_result' && candidate.callId === callId;
  });
  assert.ok(found, `missing function_call_result for ${callId}`);
  return found as unknown as Record<string, unknown>;
}

function resultPayload(item: Record<string, unknown>): Record<string, unknown> {
  const output = item.output;
  const text = typeof output === 'string'
    ? output
    : output && typeof output === 'object' && (output as Record<string, unknown>).type === 'text'
      ? (output as Record<string, unknown>).text
      : undefined;
  assert.equal(typeof text, 'string', 'synthetic result must contain JSON text');
  return JSON.parse(text as string) as Record<string, unknown>;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function frozenHistory<T extends AgentInputItem[]>(history: T): T {
  for (const item of history) {
    if (item && typeof item === 'object') Object.freeze(item);
  }
  return Object.freeze(history) as T;
}

test('cross-provider canary rejects an unmatched call and a later conversational message', () => {
  const api = protocolApi();
  for (const provider of PROVIDER_FAMILIES) {
    const open = [user('Find the records.'), call('call-open')];
    assertIssue(
      api.inspectConversationProtocol(open),
      'unmatched_function_call',
      'call-open',
      provider,
    );

    const advanced = [...open, user('Now answer a completely different question.')];
    assertIssue(
      api.inspectConversationProtocol(advanced),
      'conversation_advanced_with_open_call',
      'call-open',
      provider,
    );
  }
});

test('cross-provider canary rejects orphan, duplicate-result, and reused-call-id histories', () => {
  const api = protocolApi();
  const malformed = [
    {
      label: 'orphan result',
      history: [user('Start.'), result('call-orphan')],
      issue: 'orphan_function_result' as const,
      callId: 'call-orphan',
    },
    {
      label: 'duplicate result',
      history: [
        user('Start.'),
        call('call-double-result'),
        result('call-double-result'),
        result('call-double-result'),
      ],
      issue: 'duplicate_function_result' as const,
      callId: 'call-double-result',
    },
    {
      label: 'reused call id',
      history: [
        user('Start.'),
        call('call-reused', 'first_tool'),
        call('call-reused', 'second_tool'),
        result('call-reused', 'first_tool'),
      ],
      issue: 'duplicate_function_call_id' as const,
      callId: 'call-reused',
    },
  ];

  for (const provider of PROVIDER_FAMILIES) {
    for (const fixture of malformed) {
      assertIssue(
        api.inspectConversationProtocol(fixture.history),
        fixture.issue,
        fixture.callId,
        `${provider}: ${fixture.label}`,
      );
    }
  }
});

test('parallel calls remain valid when reasoning and compaction interleave ordered one-to-one results', () => {
  const api = protocolApi();
  const history = [
    user('Read both sources.'),
    reasoning('reasoning-before'),
    call('call-alpha', 'alpha_search'),
    call('call-beta', 'beta_search'),
    reasoning('reasoning-between'),
    compaction('compaction-between'),
    result('call-alpha', 'alpha_search'),
    reasoning('reasoning-after-alpha'),
    result('call-beta', 'beta_search'),
    compaction('compaction-after'),
    assistant('Both reads are complete.'),
  ];

  for (const provider of PROVIDER_FAMILIES) {
    assert.deepEqual(
      api.inspectConversationProtocol(history),
      { status: 'valid', issues: [] },
      provider,
    );
  }
});

test('provider canary is assertion-only and never repairs the canonical history', () => {
  const api = protocolApi();
  const history = frozenHistory([
    user('Run the tool.'),
    call('call-do-not-repair'),
    user('This source must not inherit a poisoned frame.'),
  ]);
  const before = JSON.stringify(history);

  const inspection = api.inspectConversationProtocol(history);

  assert.equal(inspection.status, 'invalid');
  assert.equal(JSON.stringify(history), before, 'the canary must be observational only');
  assert.equal(
    Object.prototype.hasOwnProperty.call(inspection, 'providerHistory'),
    false,
    'the canary must not manufacture a repaired provider projection',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(inspection, 'publicMessage'),
    false,
    'an internal wire assertion is not a user-visible blocking policy',
  );
});

test('exact settled-result evidence restores exact bytes once and unpoisons the next source', () => {
  const api = protocolApi();
  const exactOutput = JSON.stringify({ ok: true, rows: [{ id: 'row-1' }], providerReceipt: 'r-1' });
  const exactResult = result('call-settled', 'records_search', exactOutput);
  const evidence: MigrationEvidence = {
    kind: 'settled_result',
    result: exactResult,
    resultBytesSha256: canonicalSha256(exactResult),
  };
  const first = api.migratePersistedConversationProtocol({
    history: [user('Read the durable result.'), call('call-settled')],
    evidenceByCallId: { 'call-settled': evidence },
  });
  const providerHistory = assertReady(first);
  assert.equal(first.migration, 'paired_exact_result');
  assert.deepEqual(resultFor(providerHistory, 'call-settled'), exactResult);
  assert.equal(resultPayload(resultFor(providerHistory, 'call-settled')).providerReceipt, 'r-1');
  assert.deepEqual(api.inspectConversationProtocol(providerHistory), { status: 'valid', issues: [] });

  const second = api.migratePersistedConversationProtocol({
    history: providerHistory,
    evidenceByCallId: { 'call-settled': evidence },
  });
  assert.equal(second.disposition, 'ready');
  assert.equal(second.migration, 'none', 'migration must be idempotent');
  assert.deepEqual(second.history, providerHistory, 'migration must not duplicate the exact result');

  const nextSource = [...assertReady(second), user('What is the weather instead?')];
  assert.deepEqual(
    api.inspectConversationProtocol(nextSource),
    { status: 'valid', issues: [] },
    'a repaired legacy frame cannot poison an unrelated next source',
  );
});

test('zero-crossing evidence pairs a typed refused/no-effect result and allows model replanning', () => {
  const api = protocolApi();
  const migrated = api.migratePersistedConversationProtocol({
    history: [user('Search the records.'), call('call-refused', 'records_search')],
    evidenceByCallId: {
      'call-refused': {
        kind: 'proven_no_crossing',
        executionKind: 'refused_pre_dispatch',
        physicalDispatchCount: 0,
      },
    },
  });
  const providerHistory = assertReady(migrated);
  assert.equal(migrated.migration, 'paired_refused_pre_dispatch');
  const paired = resultFor(providerHistory, 'call-refused');
  assert.equal(paired.name, 'records_search', 'synthetic result keeps the exact original call name');
  assert.deepEqual(
    {
      disposition: resultPayload(paired).disposition,
      effect: resultPayload(paired).effect,
      retry: resultPayload(paired).retry,
    },
    { disposition: 'refused_pre_dispatch', effect: 'none', retry: 'replan' },
  );
  assert.deepEqual(api.inspectConversationProtocol(providerHistory), { status: 'valid', issues: [] });

  for (const provider of PROVIDER_FAMILIES) {
    assert.deepEqual(
      api.inspectConversationProtocol([...providerHistory, user(`Continue through ${provider}.`)]),
      { status: 'valid', issues: [] },
      `${provider}: a proven no-effect refusal is ordinary model context, not a public gate`,
    );
  }
});

test('an entered but unreadable physical crossing pairs effect-unknown and stays out of every provider', () => {
  const api = protocolApi();
  const migrated = api.migratePersistedConversationProtocol({
    history: [user('Create the record once.'), call('call-unknown', 'records_create')],
    evidenceByCallId: {
      'call-unknown': {
        kind: 'physical_crossing_unreadable',
        physicalDispatchId: 'dispatch-unknown-1',
        state: 'unknown',
      },
    },
  });

  assert.equal(migrated.disposition, 'reconciliation_required');
  assert.equal(migrated.migration, 'paired_effect_unknown');
  assert.equal(migrated.providerHistory, null, 'unknown effects cannot enter a provider retry loop');
  assert.deepEqual(api.inspectConversationProtocol(migrated.history), { status: 'valid', issues: [] });
  const paired = resultFor(migrated.history, 'call-unknown');
  assert.deepEqual(
    {
      disposition: resultPayload(paired).disposition,
      effect: resultPayload(paired).effect,
      retry: resultPayload(paired).retry,
      next: resultPayload(paired).next,
    },
    {
      disposition: 'effect_unknown',
      effect: 'unknown',
      retry: 'do_not_retry',
      next: 'reconcile',
    },
  );
});

test('pending approval remains byte-identical and held until an exact resolved result exists', () => {
  const api = protocolApi();
  const pendingHistory = [
    user('Send the message after I approve.'),
    call('call-awaiting-approval', 'messages_send'),
  ];
  const before = JSON.stringify(pendingHistory);
  const pending = api.migratePersistedConversationProtocol({
    history: pendingHistory,
    evidenceByCallId: {
      'call-awaiting-approval': {
        kind: 'pending_approval',
        approvalId: 'approval-1',
      },
    },
  });

  assert.equal(pending.disposition, 'pending_approval');
  assert.equal(pending.migration, 'none');
  assert.equal(pending.providerHistory, null, 'pending approval is never ordinary model history');
  assert.equal(JSON.stringify(pending.history), before, 'pending state cannot invent a tool result');
  assert.equal(
    pending.history.filter((item) => (item as { type?: string }).type === 'function_call_result').length,
    0,
  );

  const approvedResult = result(
    'call-awaiting-approval',
    'messages_send',
    JSON.stringify({ sent: true, providerMessageId: 'message-1' }),
  );
  const resolved = api.migratePersistedConversationProtocol({
    history: pending.history,
    evidenceByCallId: {
      'call-awaiting-approval': {
        kind: 'settled_result',
        result: approvedResult,
        resultBytesSha256: canonicalSha256(approvedResult),
      },
    },
  });
  assert.equal(resolved.migration, 'paired_exact_result');
  assert.deepEqual(api.inspectConversationProtocol(assertReady(resolved)), { status: 'valid', issues: [] });
});

test('ambiguous duplicate and orphan frames quarantine without poisoning a fresh source', () => {
  const api = protocolApi();
  const safePrefix = [user('Hello.'), assistant('Hello — how can I help?')];
  const poisoned = [
    {
      label: 'reused call id',
      callId: 'call-ambiguous',
      reason: 'reused_call_id' as const,
      invalidFrame: [
        call('call-ambiguous', 'first_tool'),
        call('call-ambiguous', 'second_tool'),
        result('call-ambiguous', 'first_tool'),
      ],
      issue: 'duplicate_function_call_id' as const,
    },
    {
      label: 'orphan result',
      callId: 'call-orphan-legacy',
      reason: 'orphan_result' as const,
      invalidFrame: [result('call-orphan-legacy', 'legacy_tool')],
      issue: 'orphan_function_result' as const,
    },
  ];

  for (const fixture of poisoned) {
    const migrated = api.migratePersistedConversationProtocol({
      history: [...safePrefix, ...fixture.invalidFrame],
      evidenceByCallId: {
        [fixture.callId]: { kind: 'ambiguous', reason: fixture.reason },
      },
    });
    const providerHistory = assertReady(migrated);
    assert.equal(migrated.migration, 'quarantined', fixture.label);
    assert.deepEqual(providerHistory, safePrefix, `${fixture.label}: only the valid prefix remains model-visible`);
    assert.deepEqual(
      migrated.quarantine,
      { originalItems: fixture.invalidFrame, issues: [fixture.issue] },
      `${fixture.label}: exact invalid bytes remain available for audit`,
    );
    assert.deepEqual(
      api.inspectConversationProtocol([...providerHistory, user('Start a clean, unrelated request.')]),
      { status: 'valid', issues: [] },
      `${fixture.label}: quarantine cannot create a generic blocker on the next source`,
    );
  }
});
