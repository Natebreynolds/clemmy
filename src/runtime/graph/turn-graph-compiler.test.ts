import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTurnGraph,
  type CompileTurnGraphInput,
} from './turn-graph-compiler.js';
import type { TurnGraphPolicySnapshot } from './turn-graph-ir.js';

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

function compile(
  input: string,
  overrides: Partial<CompileTurnGraphInput> = {},
) {
  return compileTurnGraph({
    identity: { sessionId: 'graph-test', turn: 1, sourceUserSeq: 41 },
    input,
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
    ...overrides,
  });
}

function kinds(input: ReturnType<typeof compile>): string[] {
  return input.graph.nodes.map((node) => node.kind);
}

test('direct chat fast path omits context, capability, tool, fanout, and verifier nodes', () => {
  const result = compile('hello');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.route, 'direct_reply');
  assert.equal(result.graph.fastPath, 'direct_reply');
  assert.deepEqual(kinds(result), [
    'turn_accepted',
    'policy_snapshot',
    'intent_authority',
    'compose_reply',
    'publish',
  ]);
  assert.equal(result.graph.effectCeiling, 'none');
  assert.equal(result.graph.nodes.some((node) => node.runner.kind === 'tool'), false);
});

test('lookup compiles one bounded context/capability/retrieval/evidence path', () => {
  const result = compile('What is the current status of the Acme account?');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.route, 'retrieve');
  assert.equal(result.graph.fastPath, 'single_retrieval');
  assert.deepEqual(kinds(result), [
    'turn_accepted',
    'policy_snapshot',
    'intent_authority',
    'context_resolve',
    'capability_resolve',
    'retrieve',
    'verify',
    'compose_reply',
    'compose_blocked',
    'publish',
  ]);
  const retrieve = result.graph.nodes.find((node) => node.kind === 'retrieve');
  assert.equal(retrieve?.effect.kind, 'read');
  assert.equal(retrieve?.authority.state, 'deferred');
  assert.equal(retrieve?.authority.decisionOwner, 'runtime_tool_boundary');
});

test('direct external effect is only an effect ceiling and never a compiler-granted permission', () => {
  const result = compile('Email alex@example.com with the update.');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.route, 'act');
  assert.equal(result.graph.classification.externalEffectRequested, true);
  assert.deepEqual(result.graph.classification.externalEffectKinds, ['communication']);
  assert.equal(result.graph.effectCeiling, 'external_write');
  const execute = result.graph.nodes.find((node) => node.kind === 'execute');
  assert.equal(execute?.effect.certainty, 'ceiling');
  assert.equal(execute?.effect.idempotency, 'required_before_dispatch');
  assert.equal(execute?.effect.receipt, 'durable_effect_receipt');
  assert.deepEqual(execute?.authority, {
    intentSource: { kind: 'accepted_turn', sourceUserSeq: 41 },
    requirement: 'runtime_tool_admission',
    state: 'deferred',
    decisionOwner: 'runtime_tool_boundary',
  });
});

test('conservative multi-item signal compiles bounded fanout, per-item execution, and reduce', () => {
  const result = compile('Research these firms.', {
    signals: {
      intent: { intent: 'action', confidence: 0.99, reasons: ['test'] },
      externalEffect: { requested: false, kinds: [] },
      multiItem: {
        isMultiItem: true,
        itemCount: 12,
        itemKind: 'firms',
        sameShapeWork: true,
        explicitParallelRequest: true,
      },
    },
  });
  assert.equal(result.graph.fastPath, 'fanout_action');
  // G5a: no execute-with-multiplicity clone. The fanout node is a PLANNER
  // under a runtime-topology contract; workers arrive at execution as a graph
  // patch, one per REAL manifest item, joined at the reducer.
  assert.deepEqual(kinds(result).slice(5, 9), ['fanout', 'reduce', 'verify', 'compose_reply']);
  assert.equal(result.graph.nodes.some((node) => node.kind === 'execute'), false,
    'a worker clone was compiled from an estimated count');
  const fanout = result.graph.nodes.find((node) => node.kind === 'fanout');
  const reduce = result.graph.nodes.find((node) => node.kind === 'reduce');
  assert.equal(fanout?.emitsTopology?.kind, 'per_item_siblings');
  assert.equal(fanout?.emitsTopology?.joinNodeId, reduce?.id, 'the contract does not name the real reducer');
  assert.deepEqual(fanout?.emitsTopology?.workerRunner, { kind: 'model', role: 'worker' });
  assert.equal(fanout?.emitsTopology?.workerEffect.kind, 'unknown');
  assert.equal(fanout?.emitsTopology?.maxConcurrency, 8);
  // Diagnostic only — the executable count comes from the manifest at runtime.
  assert.equal(fanout?.emitsTopology?.estimatedItems, 12);
  // The planner ITSELF performs no external effect; authority defers to patch
  // admission and to the emitted workers, whose effect the contract carries.
  assert.equal(fanout?.authority.state, 'not_required');
  assert.equal(fanout?.emitsTopology?.workerEffect.idempotency, 'required_before_dispatch');
});

test('explicit empty tool authority survives compilation and is not widened', () => {
  const result = compile('Run the requested task.', { allowedToolNames: [] });
  assert.equal(result.graph.toolAuthority.explicit, true);
  assert.deepEqual(result.graph.toolAuthority.allowedToolNames, []);
  assert.ok(result.graph.diagnostics.warnings.includes('explicit_zero_tool_authority'));
  const toolRequirement = result.graph.nodes
    .find((node) => node.kind === 'capability_resolve')
    ?.capabilities.find((capability) => capability.kind === 'tool');
  assert.deepEqual(toolRequirement, { kind: 'tool', resolution: 'explicit', names: [] });
});

test('compiler is deterministic, source-owned, and persists no raw request text', () => {
  const secretText = 'Find project zephyr-secret-9831 and summarize it.';
  const first = compile(secretText, {
    allowedToolNames: ['memory_search', 'tool_search', 'memory_search'],
    excludedToolNames: ['send_email'],
  });
  const second = compile(secretText, {
    allowedToolNames: ['tool_search', 'memory_search'],
    excludedToolNames: ['send_email'],
  });
  assert.equal(first.graph.graphId, 'turn-graph:v1:41');
  assert.equal(first.graph.compiler.graphHash, second.graph.compiler.graphHash);
  assert.deepEqual(first.graph, second.graph);
  assert.equal(JSON.stringify(first.graph).includes('zephyr-secret-9831'), false);
  assert.match(first.graph.source.inputHash, /^[a-f0-9]{64}$/);
  assert.equal('attemptId' in first.graph.identity, false);
  assert.equal('runId' in first.graph.identity, false);
});

test('classifier-derived item nouns and caller-only policy fields never become durable graph data', () => {
  const secret = 'zephyrsecrets';
  const policyWithCallerData = {
    ...POLICY,
    operatorNote: 'do-not-persist-policy-secret-441',
  } as TurnGraphPolicySnapshot;
  const result = compile(`Research these 3 ${secret} for each one in parallel.`, {
    policy: policyWithCallerData,
  });
  assert.equal(result.graph.classification.multiItem.detected, true);
  assert.equal(result.graph.classification.multiItem.itemCount, 3);
  const serialized = JSON.stringify(result.graph);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('do-not-persist-policy-secret-441'), false);
  assert.deepEqual(Object.keys(result.graph.policy).sort(), [
    'allowComposioActions',
    'allowComputerActions',
    'autoApproveScope',
    'batchConfirmThreshold',
    'proactiveWorkAllowed',
    'requireWorkflowApprovalForExecution',
    'version',
  ]);
});

test('provider and transport do not change the compiled plan semantics', () => {
  const home = compile('Research the current Acme account status.', { surface: 'home' });
  const discord = compile('Research the current Acme account status.', { surface: 'discord' });
  assert.deepEqual(home.graph.classification, discord.graph.classification);
  assert.deepEqual(home.graph.nodes, discord.graph.nodes);
  assert.deepEqual(home.graph.edges, discord.graph.edges);
  const serialized = JSON.stringify(home.graph);
  assert.equal(serialized.includes('claude'), false);
  assert.equal(serialized.includes('codex'), false);
  assert.equal(serialized.includes('modelId'), false);
});

test('compiler rejects identities that do not name an accepted source', () => {
  assert.throws(
    () => compile('hello', {
      identity: { sessionId: 'graph-test', turn: 1, sourceUserSeq: 0 },
    }),
    /accepted sourceUserSeq/,
  );
});
