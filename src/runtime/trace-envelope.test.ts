/**
 * Run: npx tsx --test src/runtime/trace-envelope.test.ts
 *
 * R2/C2+C3 biting suite: the explicit trace envelope with its
 * missing-span certification rule, and the versioned atomic budget contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  certifyPerformanceSample,
  createSpanRecorder,
  sealTraceEnvelope,
} from './trace-envelope.js';
import {
  createBudgetMeter,
  sealBudgetContract,
  type BudgetResource,
  type RuntimeBudgetCeilings,
} from './budget-contract.js';

// ─── C2: envelope and spans ──────────────────────────────────────────────────

test('an envelope carries identity, never content — content-shaped values refuse', () => {
  const sealed = sealTraceEnvelope({
    acceptedSource: 'discord:msg-01', logicalTurnId: 'turn-7', attemptId: 'at-1',
    admissionDigest: 'a'.repeat(64), lane: 'chat', brain: 'claude',
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));

  const leaking = sealTraceEnvelope({
    acceptedSource: 'please schedule a meeting with\nBrett tomorrow about the invite blast',
  });
  assert.equal(leaking.ok, false, 'message content entered telemetry as identity');

  const empty = sealTraceEnvelope({ toolCallId: '   ' });
  assert.equal(empty.ok, false);
});

test('a lane is never forced to invent fields it cannot have', () => {
  // A cron lane has no client acknowledgement, no tool call — absence is lawful.
  const sealed = sealTraceEnvelope({ acceptedSource: 'cron:morning-briefing', lane: 'cron' });
  assert.equal(sealed.ok, true);
});

test('C2 certification: a missing required span makes the sample uncertifiable, visibly', () => {
  const record = {
    envelope: { acceptedSource: 's-1', lane: 'chat' },
    spans: [
      { name: 'model_total' as const, ms: 900 },
      { name: 'terminal_commit' as const, ms: 40 },
    ],
  };
  const certified = certifyPerformanceSample(record, ['model_total', 'terminal_commit']);
  assert.deepEqual(certified, { certified: true });

  const missingTtft = certifyPerformanceSample(record, ['model_ttft', 'model_total']);
  assert.equal(missingTtft.certified, false);
  assert.deepEqual((missingTtft as Extract<typeof missingTtft, { certified: false }>).missing, ['model_ttft']);

  // A non-finite duration is missing, not zero — it cannot flatten a percentile.
  const broken = certifyPerformanceSample(
    { envelope: {}, spans: [{ name: 'model_total', ms: Number.NaN }] },
    ['model_total'],
  );
  assert.equal(broken.certified, false);
});

test('the span recorder measures through the injected clock; unclosed spans stay absent', () => {
  const clock = { now: 100 };
  const recorder = createSpanRecorder(() => clock.now);
  recorder.mark('model_total');
  clock.now = 1_350;
  recorder.finish('model_total');
  recorder.mark('delivery'); // never finished — absent, so certification reports it
  recorder.record('model_ttft', 210);
  assert.deepEqual(recorder.spans(), [
    { name: 'model_total', ms: 1_250 },
    { name: 'model_ttft', ms: 210 },
  ]);
});

// ─── C3: versioned atomic budgets ────────────────────────────────────────────

const CEILINGS: RuntimeBudgetCeilings = {
  uncachedInputTokens: 10_000, outputTokens: 2_000, modelCalls: 3, toolCalls: 5,
  discoveryCalls: 1, validationRepairs: 0, retries: 1, artifactBytes: 1_000_000,
  artifactCount: 10, expansions: 0, effects: 0, elapsedMs: 60_000, concurrency: 2,
};

function meterWith(over: Partial<RuntimeBudgetCeilings> = {}) {
  const sealed = sealBudgetContract({ ...CEILINGS, ...over });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  return createBudgetMeter((sealed as Extract<typeof sealed, { ok: true }>).contract);
}

test('a non-finite ceiling refuses to seal — an infinite budget is the runaway loop', () => {
  const sealed = sealBudgetContract({ ...CEILINGS, modelCalls: Number.POSITIVE_INFINITY });
  assert.equal(sealed.ok, false);
});

test('every resource refuses at ceiling + 1 BEFORE the unit is consumed', () => {
  for (const resource of Object.keys(CEILINGS) as BudgetResource[]) {
    const meter = meterWith();
    const ceiling = CEILINGS[resource];
    if (ceiling > 0) {
      assert.equal(meter.debit(resource, ceiling).ok, true, `${resource}: the ceiling itself must be spendable`);
    }
    const over = meter.debit(resource, 1);
    assert.equal(over.ok, false, `${resource}: ceiling + 1 was dispensed`);
    assert.equal(meter.spent(resource), ceiling, `${resource}: a refused debit still consumed`);
  }
});

test('parallel debits interleave without overspending', async () => {
  const meter = meterWith({ toolCalls: 100 });
  const results = await Promise.all(
    Array.from({ length: 150 }, async () => meter.debit('toolCalls', 1)),
  );
  assert.equal(results.filter((result) => result.ok).length, 100, 'parallel debit overspent the ceiling');
  assert.equal(meter.spent('toolCalls'), 100);
});

test('a retry/repair is charged to the same logical attempt exactly once', () => {
  const meter = meterWith({ retries: 1 });
  assert.equal(meter.chargeOnce('retries', 'attempt-7', 1).ok, true);
  // The same logical attempt retried again: no second charge, no refusal.
  assert.equal(meter.chargeOnce('retries', 'attempt-7', 1).ok, true);
  assert.equal(meter.spent('retries'), 1);
  // A DIFFERENT attempt is new spend and hits the ceiling honestly.
  assert.equal(meter.chargeOnce('retries', 'attempt-8', 1).ok, false);
});

test('parking is resumable: a continuation gets fresh ceilings while lifetime spend carries forward', () => {
  const first = meterWith({ modelCalls: 2 });
  assert.equal(first.debit('modelCalls', 2).ok, true);
  const parked = first.debit('modelCalls', 1);
  assert.equal(parked.ok, false, 'the activation ceiling did not park');

  const continuation = createBudgetMeter(first.contract, first.snapshot());
  assert.equal(continuation.spent('modelCalls'), 0, 'a continuation must open a FRESH finite activation');
  assert.equal(continuation.lifetime('modelCalls'), 2, 'prior spend was erased');
  assert.equal(continuation.debit('modelCalls', 1).ok, true);
  assert.equal(continuation.lifetime('modelCalls'), 3, 'lifetime telemetry stopped accumulating');
});
