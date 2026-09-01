/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/plan-task-post-settlement.test.ts */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type {
  ConversationPreambleDeliveryCallback,
  ConversationPreambleDeliveryRequest,
  ConversationPreambleDeliveryResult,
} from '../../types.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-preamble-recovery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { __test__ } = await import('./plan-task-post-settlement.js');

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const REQUEST: ConversationPreambleDeliveryRequest = Object.freeze({
  version: 1,
  sessionId: 'session-recovery',
  sourceUserSeq: 7,
  eventId: 'preamble-event-7',
  eventDigest: 'a'.repeat(64),
  deliveryKey: `preamble-delivery:v1:${'b'.repeat(64)}`,
  text: 'I’ll collect the records and create the requested artifact.',
});

const RECEIPT = Object.freeze({
  version: 1 as const,
  deliveryKey: REQUEST.deliveryKey,
  eventId: REQUEST.eventId,
  eventDigest: REQUEST.eventDigest,
  surface: 'channel_message' as const,
  target: 'discord:channel-1:message-placeholder-1',
});

interface RecoveryState {
  settled: boolean;
  receipt: boolean;
  active: boolean;
  visiblePlaceholders: Set<string>;
  requests: ConversationPreambleDeliveryRequest[];
  edits: string[];
  recordAttempts: number;
  activationAttempts: number;
  modelCalls: number;
  providerCalls: number;
}

function state(input: Partial<Pick<RecoveryState, 'settled' | 'receipt' | 'active'>> = {}): RecoveryState {
  return {
    settled: input.settled ?? true,
    receipt: input.receipt ?? false,
    active: input.active ?? false,
    visiblePlaceholders: new Set(['message-placeholder-1']),
    requests: [],
    edits: [],
    recordAttempts: 0,
    activationAttempts: 0,
    modelCalls: 0,
    providerCalls: 0,
  };
}

function exactOwnedPlaceholderDelivery(current: RecoveryState): ConversationPreambleDeliveryCallback {
  return async (request) => {
    current.requests.push(structuredClone(request));
    current.edits.push('message-placeholder-1');
    assert.equal(current.visiblePlaceholders.size, 1, 'delivery edits the one already-owned placeholder');
    assert.equal(current.modelCalls, 0);
    assert.equal(current.providerCalls, 0, 'presentation never crosses the business provider');
    return { status: 'delivered', receipt: RECEIPT };
  };
}

function recoveryPorts(
  current: RecoveryState,
  input: {
    delivery?: ConversationPreambleDeliveryCallback;
    recordDelivery?: (delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>) => void;
    activate?: () => { status: 'not_ready' | 'activated' | 'replayed' };
  } = {},
) {
  const evidence = { logicalToolCallId: 'settled-plan-call' };
  return {
    winner: () => !current.settled
      ? { status: 'missing' as const }
      : current.receipt
        ? { status: 'ok' as const, evidence }
        : { status: 'delivery_required' as const, evidence },
    ...(input.delivery ? { delivery: input.delivery } : {}),
    deliveryRequest: () => REQUEST,
    recordDelivery: (_evidence: typeof evidence, delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>) => {
      current.recordAttempts += 1;
      assert.equal(current.providerCalls, 0, 'business I/O is impossible before the durable receipt');
      if (input.recordDelivery) return input.recordDelivery(delivery);
      assert.deepEqual(delivery, { status: 'delivered', receipt: RECEIPT });
      current.receipt = true;
    },
    activate: () => {
      current.activationAttempts += 1;
      assert.equal(current.receipt, true, 'activation is downstream of the exact receipt');
      if (input.activate) return input.activate();
      if (current.active) return { status: 'replayed' as const };
      current.active = true;
      return { status: 'activated' as const };
    },
  };
}

test('plan preamble crash matrix replays one exact placeholder edit and never re-enters model/provider work', async (t) => {
  await t.test('before send: a missing callback stays recoverable, then the same request activates', async () => {
    const current = state();
    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current)), {
      status: 'delivery_required',
    });
    assert.equal(current.edits.length, 0);
    assert.equal(current.activationAttempts, 0);

    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, {
      delivery: exactOwnedPlaceholderDelivery(current),
    })), { status: 'activated' });
    assert.deepEqual(current.requests, [REQUEST]);
    assert.deepEqual(current.edits, ['message-placeholder-1']);
    assert.equal(current.visiblePlaceholders.size, 1);
    assert.equal(current.modelCalls, 0);
    assert.equal(current.providerCalls, 0);
  });

  await t.test('send before receipt: restart re-edits the same target with the same content address', async () => {
    const current = state();
    let loseFirstReceipt = true;
    const deliver = exactOwnedPlaceholderDelivery(current);
    const recordDelivery = (delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>) => {
      assert.deepEqual(delivery, { status: 'delivered', receipt: RECEIPT });
      if (loseFirstReceipt) {
        loseFirstReceipt = false;
        throw new Error('simulated crash after edit before receipt commit');
      }
      current.receipt = true;
    };

    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, {
      delivery: deliver,
      recordDelivery,
    })), { status: 'delivery_required' });
    assert.equal(current.receipt, false);
    assert.equal(current.activationAttempts, 0);

    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, {
      delivery: deliver,
      recordDelivery,
    })), { status: 'activated' });
    assert.deepEqual(current.requests, [REQUEST, REQUEST]);
    assert.deepEqual(current.requests.map((request) => request.deliveryKey), [
      REQUEST.deliveryKey,
      REQUEST.deliveryKey,
    ]);
    assert.deepEqual(current.edits, ['message-placeholder-1', 'message-placeholder-1']);
    assert.equal(new Set(current.edits).size, 1);
    assert.equal(current.visiblePlaceholders.size, 1);
    assert.equal(current.modelCalls, 0);
    assert.equal(current.providerCalls, 0);
  });

  await t.test('receipt before settlement: recovery waits, then activates without redelivery', async () => {
    const current = state({ settled: false, receipt: true });
    const delivery = exactOwnedPlaceholderDelivery(current);
    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, { delivery })), {
      status: 'not_pending',
    });
    assert.equal(current.activationAttempts, 0);
    assert.equal(current.edits.length, 0);

    current.settled = true;
    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, { delivery })), {
      status: 'activated',
    });
    assert.equal(current.edits.length, 0, 'the already-bound receipt suppresses a second presentation');
    assert.equal(current.modelCalls, 0);
    assert.equal(current.providerCalls, 0);
  });

  await t.test('settlement before activation: a post-CAS crash restarts as an activation replay', async () => {
    const current = state({ settled: true, receipt: true });
    let crashAfterActivationCas = true;
    const activate = () => {
      if (!current.active) current.active = true;
      if (crashAfterActivationCas) {
        crashAfterActivationCas = false;
        throw new Error('simulated crash after activation CAS');
      }
      return { status: 'replayed' as const };
    };
    await assert.rejects(
      __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, { activate })),
      /simulated crash after activation CAS/,
    );
    assert.equal(current.active, true);
    assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(current, { activate })), {
      status: 'replayed',
    });
    assert.equal(current.edits.length, 0);
    assert.equal(current.modelCalls, 0);
    assert.equal(current.providerCalls, 0);
  });
});

test('failed or malformed recovery delivery stays inactive and retryable', async () => {
  const failed = state();
  assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(failed, {
    delivery: async () => ({ status: 'failed', reason: 'delivery_failed' }),
  })), { status: 'delivery_required' });
  assert.equal(failed.receipt, false);
  assert.equal(failed.activationAttempts, 0);

  const malformed = state();
  assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts(recoveryPorts(malformed, {
    delivery: exactOwnedPlaceholderDelivery(malformed),
    recordDelivery: () => { throw new Error('receipt does not bind exact event'); },
  })), { status: 'delivery_required' });
  assert.equal(malformed.receipt, false);
  assert.equal(malformed.activationAttempts, 0);
  assert.equal(malformed.providerCalls, 0);
});

test('restart presentation ownership auto-recovers durable lanes and holds carrier-owned lanes', async () => {
  const durable = __test__.restartDeliveryForOwner('durable_conversation', undefined);
  assert.ok(durable, 'desktop/mobile/API durable conversation has a restart-safe delivery port');
  assert.deepEqual(await durable(REQUEST), {
    status: 'delivered',
    receipt: {
      version: 1,
      deliveryKey: REQUEST.deliveryKey,
      eventId: REQUEST.eventId,
      eventDigest: REQUEST.eventDigest,
      surface: 'channel_message',
      target: 'durable_conversation',
    },
  });

  assert.equal(
    __test__.restartDeliveryForOwner('carrier_owned', undefined),
    undefined,
    'a missing channel callback never silently substitutes the durable conversation lane',
  );
  assert.deepEqual(await __test__.recoverPlanTaskActivationFromPorts({
    winner: () => ({ status: 'held' as const }),
    deliveryRequest: () => REQUEST,
    recordDelivery: () => { throw new Error('held recovery cannot record delivery'); },
    activate: () => { throw new Error('held recovery cannot activate'); },
  }), { status: 'delivery_required' });
});
