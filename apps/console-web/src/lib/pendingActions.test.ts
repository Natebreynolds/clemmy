import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canOfferStandingSendTrust,
  reconcilePendingActionExecutionFailure,
  resolvePendingActionExecutionPresentation,
  type PendingActionExecuteResult,
} from './pendingActions';

test('standing send trust is offered only for recipient-scoped external sends', () => {
  assert.equal(canOfferStandingSendTrust({ kind: 'external_send' }), true);
  assert.equal(canOfferStandingSendTrust({ kind: 'external_write' }), false);
  assert.equal(canOfferStandingSendTrust({ kind: 'deploy' }), false);
  assert.equal(canOfferStandingSendTrust(undefined), false);
});

function skipped(status: string, resultSummary: string | null = null): PendingActionExecuteResult {
  return {
    ok: false,
    status: 'skipped',
    resultSummary: `No second dispatch for ${status}.`,
    record: {
      id: 'pa-one',
      status,
      resultSummary,
      payloadHash: 'sha256:one',
    },
  };
}

test('pending-action UI refreshes a competing execution claim and never asks the model to approve again', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => {
      refreshes += 1;
      return {
        ok: true,
        status: 'executed',
        resultSummary: 'Durable provider receipt: message-42.',
      };
    },
  );

  assert.equal(refreshes, 1);
  assert.equal(presentation.mode, 'durable');
  assert.equal(presentation.phase, 'executed');
  assert.equal(presentation.note, 'Durable provider receipt: message-42.');
});

test('pending-action UI treats skipped executed/failed records as durable truth, not conversational follow-ups', async () => {
  for (const [status, phase] of [
    ['executed', 'executed'],
    ['failed', 'failed'],
  ] as const) {
    const presentation = await resolvePendingActionExecutionPresentation(
      skipped(status, `Stored ${status} result.`),
      async () => {
        throw new Error('refresh unavailable');
      },
    );
    assert.equal(presentation.mode, 'durable', `${status} must suppress onApprove`);
    assert.equal(presentation.phase, phase);
    assert.equal(presentation.note, `Stored ${status} result.`);
  }
});

test('pending-action UI preserves the conversational path only for a genuinely non-executable queued card', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('queued'),
    async () => {
      refreshes += 1;
      return { ok: true, status: 'queued', resultSummary: null };
    },
  );
  assert.equal(refreshes, 0);
  assert.deepEqual(presentation, { mode: 'conversational', phase: 'idle' });
});

test('pending-action UI polls a competing execution claim until durable terminal truth arrives', async () => {
  const statuses = ['executing', 'executing', 'executed'] as const;
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => ({
      ok: true,
      status: statuses[refreshes++] ?? 'executed',
      resultSummary: refreshes >= 3 ? 'Durable receipt: provider-99.' : null,
    }),
    { pollDelaysMs: [0, 0, 0], wait: async () => {} },
  );

  assert.equal(refreshes, 3);
  assert.deepEqual(presentation, {
    mode: 'durable',
    phase: 'executed',
    note: 'Durable receipt: provider-99.',
  });
});

test('pending-action UI ends bounded executing reconciliation as explicit uncertainty, never a refusal', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => {
      refreshes += 1;
      return { ok: true, status: 'executing', resultSummary: null };
    },
    { pollDelaysMs: [0, 0], wait: async () => {} },
  );

  assert.equal(refreshes, 2);
  assert.equal(presentation.mode, 'durable');
  assert.equal(presentation.phase, 'uncertain');
  assert.match(presentation.note ?? '', /outcome is not confirmed/i);
  assert.match(presentation.note ?? '', /do not retry/i);
  assert.doesNotMatch(presentation.note ?? '', /refused|didn.t send/i);
});

test('rejected, expired, and cancelled actions are terminal and never re-enter conversational approval', async () => {
  for (const status of ['rejected', 'expired', 'cancelled'] as const) {
    let refreshes = 0;
    const presentation = await resolvePendingActionExecutionPresentation(
      skipped(status, `Durable ${status}.`),
      async () => {
        refreshes += 1;
        return { ok: true, status, resultSummary: `Durable ${status}.` };
      },
    );
    assert.equal(refreshes, 0);
    assert.deepEqual(presentation, {
      mode: 'durable',
      phase: status,
      note: `Durable ${status}.`,
    });
  }
});

test('terminal rejection does not echo an executor suggestion to approve again', async () => {
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('rejected'),
    async () => {
      throw new Error('terminal decisions do not refresh');
    },
  );
  assert.deepEqual(presentation, { mode: 'durable', phase: 'rejected' });
});

test('lost approve-execute response reconciles durable execution rather than claiming it did not send', async () => {
  const presentation = await reconcilePendingActionExecutionFailure(
    async () => ({
      ok: true,
      status: 'executed',
      resultSummary: 'Recovered durable receipt: provider-101.',
    }),
    { pollDelaysMs: [0], wait: async () => {} },
  );
  assert.deepEqual(presentation, {
    mode: 'durable',
    phase: 'executed',
    note: 'Recovered durable receipt: provider-101.',
  });
});

test('lost approve-execute response with unavailable durable truth is bounded uncertainty', async () => {
  let refreshes = 0;
  const presentation = await reconcilePendingActionExecutionFailure(
    async () => {
      refreshes += 1;
      throw new Error('connection lost');
    },
    { pollDelaysMs: [0, 0, 0], wait: async () => {} },
  );
  assert.equal(refreshes, 3);
  assert.equal(presentation.phase, 'uncertain');
  assert.match(presentation.note ?? '', /do not retry/i);
  assert.doesNotMatch(presentation.note ?? '', /refused|didn.t send/i);
});
