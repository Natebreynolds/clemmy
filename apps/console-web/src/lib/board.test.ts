import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boardCardFromRunDetail,
  boardTraceSinceSeq,
  canStopCanonicalRunFromDrawer,
  findBoardCardForRun,
  cardTone,
  isWorkflowCatchupCard,
  intentForDrop,
  pendingActionReviewFacts,
  reconcileOpenBoardCard,
  rejectReason,
  sourceLabel,
  workflowCatchupReadinessFacts,
  workflowCatchupActionPath,
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

test('Tasks approval review retains exact target, risk, preview, rollback, hash, and payload', () => {
  const action = {
    id: 'pa-social-launch',
    title: 'Publish the approved launch post',
    summary: 'One reviewed post to the company page.',
    kind: 'external_send',
    status: 'approval_requested',
    toolName: 'SOCIALS_PUBLISH_POST',
    targetSummary: 'LinkedIn company page',
    preview: 'Clementine 3.0 launches today.',
    risk: 'This publishes externally to all page followers.',
    rollback: 'Delete the post from LinkedIn.',
    payload: {
      account: 'company-page',
      body: 'Clementine 3.0 launches today.',
    },
    payloadHash: 'sha256-launch-proof',
    idempotencyKey: 'social-launch-once',
    approvalId: 'apr-social',
    resultSummary: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
  const queuedCard = card({
    id: 'approval:apr-social',
    sourceKind: 'approval',
    column: 'needs_you',
    status: 'awaiting_approval',
    actions: ['approve', 'reject'],
    pendingAction: action,
  });

  assert.equal(queuedCard.pendingAction, action, 'the frontend BoardCard DTO retains the server view');
  assert.deepEqual(pendingActionReviewFacts(action), {
    title: action.title,
    summary: action.summary,
    status: action.status,
    toolName: action.toolName,
    target: action.targetSummary,
    risk: action.risk,
    preview: action.preview,
    rollback: action.rollback,
    payloadHash: action.payloadHash,
    payloadText: JSON.stringify(action.payload, null, 2),
  });
});

// D (v2.3.0): dragging a waiting card into Running IS the approval gesture
// (owner feedback, 2026-07-23: "park those in task as queued and I can simply drag
// them over"). The drag maps to the same server-gated approve action as the
// card button — and a card WITHOUT an approvable action still snaps back with
// a reason instead of silently approving anything.
test('drag Needs You → Running approves a parked card; non-approvable cards snap back', () => {
  const parked = card({
    id: 'run-parked', column: 'needs_you', status: 'awaiting_approval',
    actions: ['approve', 'reject', 'cancel'], approvalId: 'apr-123',
  });
  assert.equal(intentForDrop(parked, 'running'), 'approve');
  assert.equal(intentForDrop(parked, 'done'), 'cancel');

  const noAction = card({ id: 'run-stuck', column: 'needs_you', status: 'awaiting_approval', actions: [] });
  assert.equal(intentForDrop(noAction, 'running'), null);
  assert.match(rejectReason(noAction, 'running'), /Approve button/);

  // resume/promote still win first for continue-style cards — approve only
  // fires when the card actually carries an approvable action.
  const resumable = card({ id: 'bg-1', column: 'needs_you', status: 'awaiting_continue', actions: ['resume', 'cancel'] });
  assert.equal(intentForDrop(resumable, 'running'), 'resume');
});

test('a held missed schedule has exact Resume/Skip actions without pretending to be a live run', () => {
  const held = card({
    id: 'catchup:sched-held-1',
    sourceKind: 'schedule',
    column: 'needs_you',
    status: 'awaiting_catchup_decision',
    sessionId: null,
    actions: ['resume', 'cancel', 'skip'],
    raw: {
      workflowName: 'Morning prospect outreach',
      workflowSlug: 'morning-prospect-outreach',
      runId: 'sched-held-1',
      occurrenceAtMs: Date.parse('2026-07-28T15:00:00.000Z'),
      scheduledFor: '2026-07-28T15:00:00.000Z',
      missedCount: 3,
    },
  });

  assert.equal(isWorkflowCatchupCard(held), true);
  assert.equal(sourceLabel(held.sourceKind), 'Missed run');
  assert.deepEqual(cardTone(held), { tone: 'warning', label: 'Missed schedule' });
  assert.equal(intentForDrop(held, 'running'), 'resume');
  assert.equal(intentForDrop(held, 'done'), 'cancel',
    'Done uses the existing cancel gesture, translated to a no-effects skip at the action boundary');
  assert.equal(
    workflowCatchupActionPath(held, 'resume'),
    '/api/console/board/workflow-catchups/morning-prospect-outreach/sched-held-1/resume',
  );
  assert.equal(
    workflowCatchupActionPath(held, 'skip'),
    '/api/console/board/workflow-catchups/morning-prospect-outreach/sched-held-1/skip',
  );

  const stale = { ...held, raw: { ...held.raw, runId: undefined } };
  assert.equal(isWorkflowCatchupCard(stale), false, 'a stale card without exact durable identity fails closed');
  assert.equal(workflowCatchupActionPath(stale, 'resume'), null);
});

test('a blocked held schedule keeps actionable readiness while Skip remains available', () => {
  const held = card({
    id: 'catchup:sched-blocked-1',
    sourceKind: 'schedule',
    column: 'needs_you',
    status: 'awaiting_catchup_decision',
    sessionId: null,
    actions: ['resume', 'cancel', 'skip'],
    raw: {
      workflowSlug: 'scripted-brief',
      runId: 'sched-blocked-1',
      readiness: {
        ok: false,
        blockers: [{
          kind: 'script',
          name: 'merge.py',
          status: 'missing',
          reason: 'Workflow script "merge.py" is missing.',
          stepIds: ['merge'],
        }],
        warnings: [{
          kind: 'composio',
          name: 'gmail',
          status: 'unknown',
          reason: 'Gmail connection could not be confirmed.',
          stepIds: ['send'],
        }],
      },
    },
  });

  assert.deepEqual(workflowCatchupReadinessFacts(held), {
    blocked: true,
    blockerCount: 1,
    warningCount: 1,
    blockerMessages: ['Workflow script "merge.py" is missing.'],
    warningMessages: ['Gmail connection could not be confirmed.'],
  });
  assert.ok(held.actions.includes('skip'), 'readiness blockers never remove the no-effects Skip decision');
});

// A parked run must never wear a live "Working" pill — it is waiting on a
// human, and an hours-old false "Working" erodes trust in every other pill.
test('cardTone: parked/awaiting runs in the Running column read as waiting, not working', () => {
  const parked = card({ id: 'wf-parked', column: 'running', status: 'parked' });
  assert.deepEqual(cardTone(parked), { tone: 'warning', label: 'Waiting for your approval' });

  const live = card({ id: 'wf-live', column: 'running', status: 'step: publish' });
  assert.deepEqual(cardTone(live), { tone: 'live', label: 'Working' });

  // Raw harness states never leak verbatim into a pill.
  const capability = card({ id: 'bg-cap', column: 'needs_you', status: 'awaiting_capability' });
  assert.equal(cardTone(capability).label, 'Waiting for a connection');
  const doneOdd = card({ id: 'bg-int', column: 'done', status: 'interrupted' });
  assert.equal(cardTone(doneOdd).label, 'Interrupted — resumable');
});
