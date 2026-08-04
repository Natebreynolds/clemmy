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
