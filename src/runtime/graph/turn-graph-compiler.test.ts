import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTurnGraph,
  factorySkipForCompiledRoute,
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

test('factory skip is only the compiled direct_reply without an explicit allowlist', () => {
  assert.equal(factorySkipForCompiledRoute('direct_reply', undefined), true);
  assert.equal(factorySkipForCompiledRoute('direct_reply', []), false);
  assert.equal(factorySkipForCompiledRoute('direct_reply', ['memory_search']), false);
  assert.equal(factorySkipForCompiledRoute('retrieve', undefined), false);
  assert.equal(factorySkipForCompiledRoute('act', undefined), false);
});

test('thanks and closed-world questions compile as direct_reply', () => {
  for (const input of ['thanks', "what's 2x2", 'What’s 2x3', 'what is 15% of 80', 'what is sqrt(144)']) {
    const result = compile(input);
    assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
    assert.equal(result.graph.classification.route, 'direct_reply', input);
    assert.equal(result.graph.fastPath, 'direct_reply', input);
    assert.equal(result.graph.effectCeiling, 'none', input);
    assert.equal(result.graph.nodes.some((node) => node.kind === 'capability_resolve'), false, input);
    assert.equal(result.graph.nodes.some((node) => node.kind === 'retrieve'), false, input);
  }
});

test('a hosted-world follow-up compiles retrieve only when the session already opened that world', () => {
  const alone = compile('what are they slack IDs');
  assert.equal(alone.graph.classification.route, 'direct_reply');
  assert.equal(factorySkipForCompiledRoute(alone.graph.classification.route, undefined), true);

  const continued = compile('what are they slack IDs', {
    signals: { continueHostedWorld: true },
  });
  assert.equal(continued.graph.classification.route, 'retrieve');
  assert.equal(continued.graph.fastPath, 'single_retrieval');
  assert.equal(factorySkipForCompiledRoute(continued.graph.classification.route, undefined), false);
  assert.ok(continued.graph.nodes.some((node) => node.kind === 'retrieve'));

  const mathAfterRetrieve = compile("what's 2x3", {
    signals: { continueHostedWorld: true },
  });
  assert.equal(mathAfterRetrieve.graph.classification.route, 'direct_reply');
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

test('destination-shaped send intent cannot be closed by a read-only observation', () => {
  const result = compile('Send every alpha record to the beta recipients.');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.route, 'act');
  assert.equal(result.graph.classification.externalEffectRequested, true);
  assert.deepEqual(result.graph.classification.externalEffectKinds, ['communication']);
  assert.equal(result.graph.effectCeiling, 'external_write');
});

test('an explicit tool invocation never inflates a read into an external communication write', () => {
  const result = compile([
    'Retrieve the current item feed from the connected local provider.',
    'Call composio_search_tools exactly once, then call composio_execute_tool exactly once.',
    'Return the source marker, revision, item id, title, and status.',
  ].join('\n'));

  assert.equal(result.graph.classification.externalEffectRequested, false);
  assert.deepEqual(result.graph.classification.externalEffectKinds, []);
  assert.notEqual(result.graph.effectCeiling, 'external_write');
});

/** Aggregate construct contract, shared by the collect-then-construct pins.
 * One bounded source read returns the set; ONE execute creates/populates the
 * artifact. True per-item jobs retain the separate fanout contract below. */
function assertAggregateConstruct(result: ReturnType<typeof compile>): void {
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.multiItem.collectThenConstruct, true);
  assert.equal(result.graph.fastPath, 'single_action');
  assert.equal(result.graph.nodes.filter((node) => node.kind === 'retrieve').length, 1,
    'one aggregate source/read phase');
  assert.equal(result.graph.nodes.some((node) => node.kind === 'fanout'), false,
    'returned rows are not host-manufactured worker jobs');
  assert.equal(result.graph.nodes.some((node) => node.kind === 'reduce'), false,
    'an aggregate provider result needs no per-row reducer');
  const executes = result.graph.nodes.filter((node) => node.kind === 'execute');
  assert.equal(executes.length, 1, 'one create/populate artifact phase');
  assert.equal(executes[0]?.effect.kind, 'external_write');
}

test('collect-then-construct compiles one aggregate read then one construct write', () => {
  const result = compile(
    'Find the top 5 widgets based on ratings and add them to a new workbook for me.',
  );
  assertAggregateConstruct(result);
  assert.equal(result.graph.classification.multiItem.detected, false);
});

test('a second domain compiles the same aggregate shape: N accounts into one sheet', () => {
  const result = compile(
    'Find the top 12 accounts by renewal date and add them to a new google sheet for me.',
  );
  assertAggregateConstruct(result);
});

test('a find-lead with a singular counted noun still compiles collect-then-construct', () => {
  const result = compile(
    'Find the page for example.com and scrape their last 5 facebook post and put them in a new workbook for me.',
  );
  assert.equal(result.graph.classification.route, 'act');
  assertAggregateConstruct(result);
});

test('a pronoun count landing in one container compiles collect-then-construct', () => {
  const result = compile(
    'Find the best widgets with the highest ratings 5 of them and put all the info in a workbook for me and give me the link.',
  );
  assertAggregateConstruct(result);
});

test('a find-lead field list landing in one container compiles collect-then-construct', () => {
  const result = compile(
    'Find the official blog for example.com, grab the last 5 blog post, and put the title, date, and link on a new workbook for me.',
  );
  assert.equal(result.graph.classification.route, 'act');
  assertAggregateConstruct(result);
});

test('Pismo reviews into one sheet never compiles per-row fanout', () => {
  const result = compile(
    'Find me the top 5 restaurants in Pismo Beach CA based on Google reviews, give me the review count and phone number for each, and create a new Google Sheet.',
  );
  assert.equal(result.graph.classification.route, 'act');
  assert.equal(result.graph.classification.externalEffectRequested, true);
  assert.equal(result.graph.effectCeiling, 'external_write');
  assert.deepEqual(result.graph.classification.goalConstraints?.collection?.projection, [
    'review count',
    'phone number',
  ]);
  assertAggregateConstruct(result);
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
