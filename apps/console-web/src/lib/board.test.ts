import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boardCardFromRunDetail,
  boardTraceSinceSeq,
  canStopCanonicalRunFromDrawer,
  findBoardCardForRun,
  reconcileOpenBoardCard,
  type BoardCard,
} from './board';

function card(input: Partial<BoardCard> & Pick<BoardCard, 'id'>): BoardCard {
  const { id, ...overrides } = input;
  return {
    id,
    sourceKind: 'run',
    title: input.id,
    column: 'running',
    status: 'running',
    progressHint: 'Working',
    sessionId: 'sess-reused',
    ageMs: 0,
    updatedAt: '2026-07-16T12:00:00.000Z',
    actions: ['cancel'],
    raw: {},
    ...overrides,
  };
}

test('Environment handoff selects the exact canonical attempt, never a same-session neighbor', () => {
  const previous = card({
    id: 'harness:attempt-a',
    attemptId: 'attempt-a',
    runScopeId: 'sess-reused::brain:run-a',
  });
  const current = card({
    id: 'harness:attempt-b',
    attemptId: 'attempt-b',
    runScopeId: 'sess-reused::brain:run-b',
  });

  assert.equal(findBoardCardForRun([previous, current], {
    select: 'sess-reused',
    attemptId: 'attempt-b',
    runScopeId: 'sess-reused::brain:run-b',
  })?.id, current.id);
  assert.equal(findBoardCardForRun([previous], {
    select: 'sess-reused',
    attemptId: 'attempt-b',
    runScopeId: 'sess-reused::brain:run-b',
  }), undefined, 'exact identity fails closed instead of opening the older attempt');
});

test('legacy Tasks links retain id/session/run lineage fallback', () => {
  const legacy = card({ id: 'run-legacy', sessionId: 'legacy-session', raw: { runId: 'provider-run' } });
  assert.equal(findBoardCardForRun([legacy], { select: 'run-legacy' }), legacy);
  assert.equal(findBoardCardForRun([legacy], { select: 'legacy-session' }), legacy);
  assert.equal(findBoardCardForRun([legacy], { select: 'provider-run' }), legacy);
});

test('an open trace adopts fresh terminal state and drops stale cancellation', () => {
  const open = card({
    id: 'harness:attempt-live',
    attemptId: 'attempt-live',
    runScopeId: 'sess-reused::brain:run-live',
  });
  const settled = card({
    ...open,
    column: 'done',
    status: 'completed',
    progressHint: 'Done',
    actions: [],
    cancelEndpoint: undefined,
    updatedAt: '2026-07-16T12:01:00.000Z',
  });

  const reconciled = reconcileOpenBoardCard(open, [settled]);
  assert.equal(reconciled?.status, 'completed');
  assert.equal(reconciled?.column, 'done');
  assert.deepEqual(reconciled?.actions, []);
  assert.equal(reconciled?.cancelEndpoint, undefined);
});

test('canonical trace replay starts at the accepted turn while legacy cards keep the session fallback', () => {
  assert.equal(boardTraceSinceSeq(card({
    id: 'harness:attempt-scoped',
    attemptId: 'attempt-scoped',
    sourceUserSeq: 417,
  })), 416);
  assert.equal(boardTraceSinceSeq(card({ id: 'legacy-session-card', sourceUserSeq: 417 })), undefined);
});

test('an exact out-of-page deep link can be materialized from authoritative run detail', () => {
  const selection = {
    select: 'sess-preview-135-call-run',
    attemptId: 'attempt-preview',
    runScopeId: 'sess-preview-135-call-run::brain:preview',
  };
  const resolved = boardCardFromRunDetail({
    id: selection.select,
    sessionId: selection.select,
    title: 'Research Northstar Legal and create the client brief',
    status: 'running',
    live: true,
    liveLine: 'Verifying the finished client brief…',
    updatedAt: new Date().toISOString(),
    canCancel: true,
    cancelEndpoint: '/api/console/harness-sessions/sess-preview-135-call-run/cancel?attemptId=attempt-preview',
    runEnvironmentMeta: {
      attemptId: selection.attemptId,
      runScopeId: selection.runScopeId,
      sourceUserSeq: 401,
    },
  }, selection);

  assert.equal(resolved?.id, 'harness:attempt-preview');
  assert.equal(resolved?.column, 'running');
  assert.equal(resolved?.attemptId, selection.attemptId);
  assert.equal(resolved?.runScopeId, selection.runScopeId);
  assert.equal(resolved?.sourceUserSeq, 401);
  assert.deepEqual(resolved?.actions, ['cancel']);

  assert.equal(boardCardFromRunDetail({
    id: selection.select,
    title: 'A newer turn',
    status: 'running',
    runEnvironmentMeta: { attemptId: 'attempt-newer', runScopeId: 'scope-newer' },
  }, selection), undefined, 'same session with a different current attempt fails closed');
});

test('the trace drawer offers Stop only for a canonical run with a safe projected endpoint', () => {
  const endpoint = '/api/console/harness-sessions/sess-reused/cancel?attemptId=attempt-live';
  const canonical = card({
    id: 'harness:attempt-live',
    sourceKind: 'run',
    attemptId: 'attempt-live',
    cancelEndpoint: endpoint,
  });

  assert.equal(canStopCanonicalRunFromDrawer(canonical), true);
  assert.equal(canStopCanonicalRunFromDrawer({ ...canonical, cancelEndpoint: 'https://example.com/cancel' }), false);
  assert.equal(canStopCanonicalRunFromDrawer({ ...canonical, actions: [] }), false);
  assert.equal(canStopCanonicalRunFromDrawer({ ...canonical, sourceKind: 'background' }), false,
    'background controls remain in the task cockpit');
  assert.equal(canStopCanonicalRunFromDrawer({ ...canonical, sourceKind: 'approval' }), false,
    'approval controls remain unchanged');
});
