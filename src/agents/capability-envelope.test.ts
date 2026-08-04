/**
 * Run: npx tsx --test src/agents/capability-envelope.test.ts
 *
 * The sealed agent surface: fingerprints are content identity, effect classes
 * flatten UP and never down, sealing refuses what it cannot honestly admit,
 * and the binding is queryable without ever being reachable from model output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindAgentCapabilityEnvelope,
  boundAgentCapabilityEnvelope,
  sealAgentCapabilityEnvelope,
  toolEffectClass,
  toolSchemaFingerprint,
} from './capability-envelope.js';

const BUDGET = { maxUncachedTokens: 100_000, maxModelCalls: 50, maxToolCalls: 200, maxElapsedMs: 600_000 };

test('the schema fingerprint is content identity — description included', () => {
  const base = { name: 'memory_recall', description: 'Recall facts.', parameters: { type: 'object' } };
  assert.equal(toolSchemaFingerprint(base), toolSchemaFingerprint({ ...base }));
  assert.notEqual(toolSchemaFingerprint(base), toolSchemaFingerprint({ ...base, description: 'Recall ALL facts.' }),
    'the description the model sees is part of the contract');
  assert.notEqual(toolSchemaFingerprint(base), toolSchemaFingerprint({ ...base, parameters: { type: 'object', required: ['q'] } }));
});

test('effect classes flatten UP, never down', () => {
  // The classifier already fails closed; the mapping must not undo that.
  assert.equal(toolEffectClass('memory_recall'), 'read');
  assert.equal(toolEffectClass('write_file'), 'write');
  assert.equal(toolEffectClass('some_tool_nobody_classified_yet'), 'send',
    'an unknown tool flattened DOWN below the ceiling');
});

test('sealing admits a real surface and refuses a dishonest one', () => {
  const sealed = sealAgentCapabilityEnvelope({
    sessionId: 'sess-1',
    tools: [
      { name: 'memory_recall', description: 'r', parameters: {} },
      { name: 'write_file', description: 'w', parameters: {} },
    ],
    policyHash: 'p1',
    budget: BUDGET,
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const envelope = (sealed as Extract<typeof sealed, { ok: true }>).envelope;
  assert.equal(envelope.capabilities.length, 2);
  assert.ok(envelope.capabilities.every((c) => c.schemaFingerprint.length === 64),
    'a capability shipped without its schema fingerprint');
  assert.equal(envelope.effectCeiling, 'send');

  const nameless = sealAgentCapabilityEnvelope({
    sessionId: 'sess-1', tools: [{ description: 'ghost' }], policyHash: 'p1', budget: BUDGET,
  });
  assert.equal(nameless.ok, false, 'a nameless tool was admitted');

  const duplicated = sealAgentCapabilityEnvelope({
    sessionId: 'sess-1',
    tools: [{ name: 'x', parameters: {} }, { name: 'x', parameters: { different: true } }],
    policyHash: 'p1',
    budget: BUDGET,
  });
  assert.equal(duplicated.ok, false, 'two admissions of one name for one account sealed anyway');
});

test('the binding is per-agent and null means unknown, not unlimited', () => {
  const agentA = {};
  const agentB = {};
  const sealed = sealAgentCapabilityEnvelope({
    sessionId: 'sess-1', tools: [{ name: 't', parameters: {} }], policyHash: 'p1', budget: BUDGET,
  });
  bindAgentCapabilityEnvelope(agentA, (sealed as Extract<typeof sealed, { ok: true }>).envelope);
  assert.ok(boundAgentCapabilityEnvelope(agentA));
  assert.equal(boundAgentCapabilityEnvelope(agentB), null,
    'an unbound agent returned an envelope it never sealed');
});
