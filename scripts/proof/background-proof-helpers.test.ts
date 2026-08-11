import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKGROUND_SETTLEMENT_WALL_MS_LABEL,
  compactManifestChecks,
  dispatchBackground,
  isPassiveOutcomeEvent,
  manifestFor,
  startBackgroundSettlementTimer,
  type ProofBackgroundDetail,
} from './scenarios/background-proof-helpers.js';
import type { DaemonHandle, TurnResult } from './types.js';

function detail(manifest: Record<string, unknown>): ProofBackgroundDetail {
  return {
    task: {
      id: 'bg-proof',
      title: 'proof',
      status: 'running',
      runSessionId: 'background:bg-proof',
    },
    workManifests: [manifest as unknown as ProofBackgroundDetail['workManifests'][number]],
  };
}

test('compact cockpit proof accepts phase totals without the item graph', () => {
  const value = detail({
    manifestId: 'accounts',
    contractVersion: '2',
    phases: [{
      id: 'research', label: 'Research', total: 120, pending: 0, running: 0,
      succeeded: 120, failed: 0, needsValidation: 0, invalidated: 0,
    }],
    total: 120,
    completed: 120,
    remaining: 0,
    evidenceCount: 120,
    staleCheckpoints: 16,
    untrackedCheckpoints: 0,
    anomalies: [],
  });
  assert.equal(manifestFor(value, 'accounts')?.total, 120);
  assert.equal(compactManifestChecks(value, 4_000, 'accounts').every((check) => check.pass), true);
});

test('compact cockpit proof rejects a leaked item graph or oversized payload', () => {
  const value = detail({
    manifestId: 'accounts',
    contractVersion: '1',
    phases: [],
    total: 1,
    completed: 0,
    remaining: 1,
    evidenceCount: 0,
    staleCheckpoints: 0,
    untrackedCheckpoints: 0,
    anomalies: [],
    items: [{ id: 'account-a', evidence: ['huge'] }],
  });
  const checks = compactManifestChecks(value, 60_000, 'accounts');
  assert.equal(checks[0]?.pass, false);
  assert.equal(checks[1]?.pass, false);
});

test('outcome proof counts the passive delivery, not the internal proactive directive', () => {
  const base = {
    type: 'user_input_received',
    data: {
      synthetic: true,
      source: 'outcome',
      sourceId: 'bg-proof',
      status: 'done',
    },
  };
  assert.equal(isPassiveOutcomeEvent({
    ...base,
    data: { ...base.data, deliveryPhase: 'passive' },
  }, 'bg-proof'), true);
  assert.equal(isPassiveOutcomeEvent({
    ...base,
    data: { ...base.data, deliveryPhase: 'directive' },
  }, 'bg-proof'), false);
  assert.equal(isPassiveOutcomeEvent(base, 'bg-proof'), true, 'legacy unmarked deliveries remain readable');
});

test('background timing uses monotonic duration arithmetic and labels observed settlement', () => {
  const timestamps = [1_000, 9_250];
  const timer = startBackgroundSettlementTimer(
    () => timestamps.shift() ?? assert.fail('unexpected clock read'),
  );

  assert.deepEqual(timer.observe('done', 175), {
    observedSettlementWallMs: 8_250,
    dispatchAcknowledgementWallMs: 175,
    terminalStatus: 'done',
    wallMsLabel: BACKGROUND_SETTLEMENT_WALL_MS_LABEL,
  });
});

test('background timing keeps dispatch wall time separate and records a parked terminal status', () => {
  const timestamps = [1_000, 1_100];
  const timer = startBackgroundSettlementTimer(
    () => timestamps.shift() ?? assert.fail('unexpected clock read'),
  );

  assert.deepEqual(timer.observe('awaiting_input', 101), {
    observedSettlementWallMs: 100,
    dispatchAcknowledgementWallMs: 101,
    terminalStatus: 'awaiting_input',
    wallMsLabel: 'request-dispatch-to-observed-settlement',
  });
});

test('background timing rejects a clock that moves backwards', () => {
  const timestamps = [1_000, 999];
  const timer = startBackgroundSettlementTimer(
    () => timestamps.shift() ?? assert.fail('unexpected clock read'),
  );

  assert.throws(
    () => timer.observe('failed', 0),
    /monotonic clock moved backwards/,
  );
});

test('background timing requires the observed terminal status', () => {
  const timestamps = [1_000, 1_010];
  const timer = startBackgroundSettlementTimer(
    () => timestamps.shift() ?? assert.fail('unexpected clock read'),
  );

  assert.throws(
    () => timer.observe('   ', 5),
    /requires an observed terminal status/,
  );
});

test('dispatch anchors settlement timing after board preflight and immediately before chat', async () => {
  const order: string[] = [];
  let boardReads = 0;
  const turn: TurnResult = {
    text: 'Started background task.',
    sessionId: 'origin-session',
    wallMs: 17,
    httpStatus: 200,
  };
  const daemon = {
    request: async (_method: string, apiPath: string) => {
      if (apiPath === '/api/console/board') {
        boardReads += 1;
        order.push(boardReads === 1 ? 'board-preflight' : 'board-after-chat');
        return {
          status: 200,
          json: {
            cards: boardReads === 1 ? [] : [{
              id: 'bg-new',
              sourceKind: 'background',
              title: 'proof',
              column: 'running',
              status: 'running',
              raw: { originSessionId: turn.sessionId },
            }],
          },
        };
      }
      if (apiPath === '/api/console/background-tasks/bg-new') {
        order.push('background-detail');
        return {
          status: 200,
          json: {
            task: {
              id: 'bg-new',
              title: 'proof',
              status: 'running',
              runSessionId: 'background:bg-new',
            },
            workManifests: [],
          },
        };
      }
      return assert.fail(`unexpected request ${apiPath}`);
    },
    chat: async () => {
      order.push('chat');
      return turn;
    },
  } as unknown as DaemonHandle;
  const timestamps = [500, 725];

  const dispatched = await dispatchBackground(daemon, 'origin-session', 'do proof work', {
    monotonicNow: () => {
      order.push(timestamps.length === 2 ? 'timer-start' : 'timer-observe');
      return timestamps.shift() ?? assert.fail('unexpected clock read');
    },
  });

  assert.deepEqual(order, [
    'board-preflight',
    'timer-start',
    'chat',
    'board-after-chat',
    'background-detail',
  ]);
  assert.deepEqual(dispatched.settlementTimer.observe('failed', turn.wallMs), {
    observedSettlementWallMs: 225,
    dispatchAcknowledgementWallMs: 17,
    terminalStatus: 'failed',
    wallMsLabel: BACKGROUND_SETTLEMENT_WALL_MS_LABEL,
  });
  assert.equal(order.at(-1), 'timer-observe');
});
