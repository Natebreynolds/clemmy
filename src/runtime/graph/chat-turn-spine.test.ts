/**
 * Run: npx tsx --test src/runtime/graph/chat-turn-spine.test.ts
 *
 * The chat spine under the executor: the compiled graph drives phase order,
 * publication happens only at the publish node, a dispatched turn publishes
 * nothing further, and every failure mode of the spine itself degrades to the
 * exact legacy order rather than a dead turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import { driveChatTurnSpine } from './chat-turn-spine.js';

const POLICY = {
  policy: {
    autoApproveScope: 'strict',
    allowComposioActions: true,
    allowComputerActions: false,
    requireWorkflowApprovalForExecution: true,
    batchConfirmThreshold: 5,
  },
  proactiveWorkAllowed: false,
} as unknown as ProactivityPolicySnapshot;

function spine(input: string, over: {
  shouldPublish?: boolean;
  coreFails?: boolean;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    run: () => driveChatTurnSpine({
      identity: { sessionId: 'spine-test', turn: 1, sourceUserSeq: 7 },
      input,
      surface: 'direct',
      policy: POLICY,
      phases: {
        runCore: async () => {
          if (over.coreFails) throw new Error('provider exploded');
          calls.push('core');
          return { answer: '42' };
        },
        shouldPublish: () => over.shouldPublish ?? true,
        publish: () => { calls.push('publish'); },
      },
    }),
  };
}

test('the graph drives the spine: core at compose_reply, publication at publish', async () => {
  const s = spine('hello');
  const result = await s.run();
  assert.equal(result.engine, 'graph', result.compileError ?? '');
  assert.deepEqual(s.calls, ['core', 'publish'], 'phase order was not core-then-publish');
  assert.equal(result.core.answer, '42');
  assert.equal(result.run?.terminal?.status, 'success');

  // The trace is the point: the spine's phases are now durable graph steps.
  const kinds = result.trace!.map((entry) => entry.kind);
  assert.ok(kinds.includes('turn_accepted') && kinds.includes('compose_reply') && kinds.includes('publish'),
    `spine trace is missing phases: ${kinds.join(',')}`);
  assert.ok(kinds.indexOf('compose_reply') < kinds.indexOf('publish'),
    'publish preceded the core in the trace');
});

test('a retrieval-shaped turn walks its longer compiled spine in order', async () => {
  const s = spine('What is the current status of the Acme account?');
  const result = await s.run();
  assert.equal(result.engine, 'graph');
  const kinds = result.trace!.map((entry) => entry.kind);
  for (const expected of ['turn_accepted', 'context_resolve', 'capability_resolve', 'retrieve', 'verify', 'compose_reply', 'publish']) {
    assert.ok(kinds.includes(expected), `retrieval spine lost its ${expected} node`);
  }
  assert.deepEqual(s.calls, ['core', 'publish']);
});

test('a dispatched turn publishes nothing further', async () => {
  const s = spine('hello', { shouldPublish: false });
  const result = await s.run();
  assert.equal(result.engine, 'graph');
  assert.deepEqual(s.calls, ['core'], 'a dispatched turn ran the publication phase');
  // The publish NODE still settles — the graph completed; the phase declined.
  assert.equal(result.run?.status, 'completed');
});

test('a core exception surfaces as the provider error it is — never a swallowed turn', async () => {
  const s = spine('hello', { coreFails: true });
  // The spine must not convert a provider failure into a silent fallback loop:
  // the graph records the failure, and the caller's existing retry/fallover
  // machinery owns what happens next — same contract as before the executor.
  await assert.rejects(s.run(), /provider exploded/);
});

test('an uncompilable turn runs the exact legacy order, loudly', async () => {
  const calls: string[] = [];
  const result = await driveChatTurnSpine({
    // Force compile failure via an invalid identity (sourceUserSeq 0).
    identity: { sessionId: 'spine-test', turn: 1, sourceUserSeq: 0 },
    input: 'hello',
    surface: 'direct',
    policy: POLICY,
    phases: {
      runCore: async () => { calls.push('core'); return { answer: 'still answered' }; },
      shouldPublish: () => true,
      publish: () => { calls.push('publish'); },
    },
  });
  assert.equal(result.engine, 'legacy_order');
  assert.ok(result.compileError, 'the fallback did not say why');
  assert.deepEqual(calls, ['core', 'publish'], 'the legacy order changed');
  assert.equal(result.core.answer, 'still answered');
});

test('the verdict routes are REAL: undelivered fires compose_blocked, publish still commits once', async () => {
  // Phase 1b of the verify extraction. A false delivery verdict must route
  // the blocked branch — compose_reply unreached-by-design — and the single
  // any-join publish node still runs the publication phase exactly once,
  // because a blocked answer is still a public terminal.
  const calls: string[] = [];
  const result = await driveChatTurnSpine({
    identity: { sessionId: 'spine-verdict', turn: 1, sourceUserSeq: 9 },
    input: 'What is the current status of the Acme account?',
    surface: 'direct',
    policy: POLICY,
    phases: {
      runCore: async () => { calls.push('core'); return { blocked: true }; },
      shouldPublish: () => true,
      publish: () => { calls.push('publish'); },
      delivered: () => false,
    },
  });
  assert.equal(result.engine, 'graph');
  const byKind = new Map(result.trace!.map((t) => [t.kind, t]));
  assert.equal(byKind.get('compose_blocked')?.status, 'completed', 'the blocked route did not fire');
  assert.equal(byKind.has('compose_reply'), false, 'the delivered route fired on a false verdict');
  assert.equal(byKind.get('publish')?.status, 'completed', 'the blocked terminal was not published');
  assert.deepEqual(calls, ['core', 'publish']);
  assert.equal(result.trace!.filter((t) => t.kind === 'publish').length, 1, 'publish double-fired');

  // And the delivered verdict routes the other way through the same graph.
  const deliveredCalls: string[] = [];
  const deliveredRun = await driveChatTurnSpine({
    identity: { sessionId: 'spine-verdict', turn: 2, sourceUserSeq: 10 },
    input: 'What is the current status of the Acme account?',
    surface: 'direct',
    policy: POLICY,
    phases: {
      runCore: async () => { deliveredCalls.push('core'); return { blocked: false }; },
      shouldPublish: () => true,
      publish: () => { deliveredCalls.push('publish'); },
      delivered: () => true,
    },
  });
  const kinds2 = new Map(deliveredRun.trace!.map((t) => [t.kind, t]));
  assert.equal(kinds2.get('compose_reply')?.status, 'completed');
  assert.equal(kinds2.has('compose_blocked'), false, 'the blocked route fired on a true verdict');
  assert.equal(kinds2.get('publish')?.status, 'completed');
});

test('the spine grants nothing it does not understand — future gates fail closed', async () => {
  // The compiler emits no input_available/authority_available edges today;
  // this pin exists so that when it DOES, the turn visibly stalls into the
  // legacy-order fallback instead of silently sailing through an unowned
  // gate. A fail-open here is how an approval gate would vanish.
  const { compileTurnGraph, snapshotTurnGraphPolicy } = await import('./turn-graph-compiler.js');
  const compiled = compileTurnGraph({
    identity: { sessionId: 'strict', turn: 1, sourceUserSeq: 3 },
    input: 'What is the current status of the Acme account?',
    sessionKind: 'chat',
    surface: 'direct',
    policy: snapshotTurnGraphPolicy(POLICY),
  });
  const conditions = new Set(compiled.graph.edges.map((edge) => edge.when));
  assert.deepEqual(
    [...conditions].sort(),
    ['evidence_insufficient', 'evidence_sufficient', 'success'],
    'the compiler emits a condition the spine has no real signal for — grant it from its OWN signal, never blanket',
  );
});

test('capability resolves AT the capability_resolve node, exactly once, before any model call', async () => {
  // The capability interior's first real slice: agent/tool assembly is graph
  // work. On shapes WITH the node, construction happens there — a real trace
  // step ordered before the work node; on the direct shape (no node), it
  // happens lazily before the core; on every path it runs exactly once.
  const order: string[] = [];
  const retrieval = await driveChatTurnSpine({
    identity: { sessionId: 'cap-spine', turn: 1, sourceUserSeq: 11 },
    input: 'What is the current status of the Acme account?',
    surface: 'direct',
    policy: POLICY,
    phases: {
      resolveCapability: async () => { order.push('capability'); },
      runCore: async () => { order.push('core'); return { ok: true }; },
      shouldPublish: () => true,
      publish: () => { order.push('publish'); },
      delivered: () => true,
    },
  });
  assert.equal(retrieval.engine, 'graph');
  assert.deepEqual(order, ['capability', 'core', 'publish'], 'capability did not resolve before the core');
  const capabilityStep = retrieval.trace!.find((t) => t.kind === 'capability_resolve')!;
  const hostStep = retrieval.trace!.find((t) => t.kind === 'retrieve')!;
  assert.ok(capabilityStep.wave < hostStep.wave, 'the capability node did not precede the work node in the trace');

  const direct: string[] = [];
  await driveChatTurnSpine({
    identity: { sessionId: 'cap-spine', turn: 2, sourceUserSeq: 12 },
    input: 'hello',
    surface: 'direct',
    policy: POLICY,
    phases: {
      resolveCapability: async () => { direct.push('capability'); },
      runCore: async () => { direct.push('core'); return { ok: true }; },
      shouldPublish: () => true,
      publish: () => {},
    },
  });
  assert.deepEqual(direct, ['capability', 'core'], 'the direct shape did not resolve capability before its core');
});
