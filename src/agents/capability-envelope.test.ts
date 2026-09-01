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
  appendAgentCapabilityBinding,
  bindAgentCapabilityEnvelope,
  bindAgentCapabilityRevision,
  boundAgentCapabilityEnvelope,
  boundAgentCapabilityRevision,
  sealAgentCapabilityEnvelope,
  sealAgentCapabilityUniverse,
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

test('a description declared turn state is excluded from the fingerprint; parameters still bind', () => {
  // Live 2026-09-01: a crash-resume re-primed plan_task with the disclosures
  // its card had gained; the description-bearing fingerprint changed and the
  // immutable host root read the same source as a changed surface (poison).
  const armed = {
    name: 'plan_task',
    description: 'Admit one plan. Exact host planning catalog: (none yet)',
    parameters: { type: 'object', properties: { topology: {} } },
    descriptionCarriesTurnState: true as const,
  };
  const resumed = { ...armed, description: 'Admit one plan. Exact host planning catalog: [cap:local:a, cap:composio:b]' };
  assert.equal(toolSchemaFingerprint(armed), toolSchemaFingerprint(resumed));
  // The marker survives the harness wrapper's object spread.
  assert.equal(toolSchemaFingerprint(armed), toolSchemaFingerprint({ ...resumed, invoke: () => undefined }));
  assert.notEqual(toolSchemaFingerprint(armed), toolSchemaFingerprint({ ...armed, parameters: { type: 'object' } }));
  // Only an exact `true` declares it; a truthy string or an ordinary tool keeps the full contract.
  assert.notEqual(toolSchemaFingerprint({ ...armed, descriptionCarriesTurnState: 'yes' }), toolSchemaFingerprint({ ...resumed, descriptionCarriesTurnState: 'yes' }));
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

test('the universe seal admits the catalog and records the active surface as revision 1', () => {
  const universe = [
    { name: 'memory_recall', description: 'r', parameters: {} },
    { name: 'write_file', description: 'w', parameters: {} },
    { name: 'deferred_tool', description: 'd', parameters: {} },
  ];
  const sealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-u',
    universeTools: universe,
    activeToolNames: ['memory_recall', 'write_file'],
    policyHash: 'p1',
    budget: BUDGET,
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const { envelope, revision } = sealed as Extract<typeof sealed, { ok: true }>;
  // Universe ⊇ active surface: the deferred tool is ADMITTED but not bound.
  assert.deepEqual(envelope.capabilities.map((c) => c.name).sort(),
    ['deferred_tool', 'memory_recall', 'write_file']);
  assert.equal(revision.revision, 1);
  assert.deepEqual([...revision.bound], ['memory_recall', 'write_file'],
    'revision 1 must be exactly the active surface, in order');
  assert.equal(revision.envelopeDigest, envelope.envelopeDigest,
    'a revision detached from its envelope digest is unenforceable');
});

test('an active surface naming a tool outside the universe refuses with the outsider named', () => {
  const sealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-u',
    universeTools: [{ name: 'memory_recall', description: 'r', parameters: {} }],
    activeToolNames: ['memory_recall', 'ghost_tool'],
    policyHash: 'p1',
    budget: BUDGET,
  });
  assert.equal(sealed.ok, false, 'an active surface wider than its universe sealed anyway');
  assert.match((sealed as Extract<typeof sealed, { ok: false }>).errors.join(' '), /ghost_tool/,
    'the refusal must name the outsider so the pause is actionable');
});

test('an acquisition appends a monotonic revision within the universe and refuses outside it', () => {
  const agent = {};
  const sealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-a',
    universeTools: [
      { name: 'active_tool', parameters: {} },
      { name: 'deferred_tool', parameters: {} },
    ],
    activeToolNames: ['active_tool'],
    policyHash: 'p1',
    budget: BUDGET,
  });
  const { envelope, revision } = sealed as Extract<typeof sealed, { ok: true }>;
  bindAgentCapabilityEnvelope(agent, envelope);
  bindAgentCapabilityRevision(agent, revision);

  const acquired = appendAgentCapabilityBinding(agent, 'deferred_tool');
  assert.equal(acquired?.ok, true, JSON.stringify(acquired));
  assert.equal(acquired.ok && acquired.changed, true, 'first acquisition must append a revision');
  const grown = boundAgentCapabilityRevision(agent)!;
  assert.equal(grown.revision, 2);
  assert.deepEqual([...grown.bound], ['active_tool', 'deferred_tool']);

  // Re-acquiring an already-bound name is idempotent — no revision churn.
  const duplicate = appendAgentCapabilityBinding(agent, 'deferred_tool');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.ok && duplicate.changed, false, 'duplicate acquisition must reuse its revision');
  assert.equal(boundAgentCapabilityRevision(agent)!.revision, 2,
    'a duplicate acquisition minted a new revision');

  const outside = appendAgentCapabilityBinding(agent, 'ghost_tool');
  assert.equal(outside?.ok, false, 'a name outside the sealed universe was bound');
  assert.equal(!outside.ok && outside.kind, 'requires_readmission');
  assert.deepEqual(!outside.ok && outside.outside, ['ghost_tool']);
  assert.match((outside as Extract<typeof outside, { ok: false }>).reason, /ghost_tool/);
  assert.equal(boundAgentCapabilityRevision(agent)!.revision, 2,
    'a refused acquisition mutated the bound revision');

  const unsealed = appendAgentCapabilityBinding({}, 'anything');
  assert.deepEqual(unsealed, {
    ok: false,
    kind: 'requires_readmission',
    outside: ['anything'],
    reason: 'agent has no sealed capability envelope and active binding revision',
  }, 'missing authority must be a typed refusal, never unlimited authority');
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

  const universeSealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-1', universeTools: [{ name: 't', parameters: {} }],
    activeToolNames: ['t'], policyHash: 'p1', budget: BUDGET,
  });
  bindAgentCapabilityRevision(agentA, (universeSealed as Extract<typeof universeSealed, { ok: true }>).revision);
  assert.equal(boundAgentCapabilityRevision(agentA)?.revision, 1);
  assert.equal(boundAgentCapabilityRevision(agentB), null,
    'an unbound agent returned a revision it never earned');
});
