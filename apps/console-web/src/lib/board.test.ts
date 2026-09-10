import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boardCardFromRunDetail,
  boardDropHighlight,
  boardLaneId,
  boardLanes,
  boardNeedsYouGroup,
  presentBoardWorkingNow,
  boardTraceSinceSeq,
  canStopFromDrawer,
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

test('the trace drawer offers Stop for anything the card itself says can be cancelled', () => {
  const endpoint = '/api/console/harness-sessions/sess-reused/cancel?attemptId=attempt-live';
  const canonical = card({
    id: 'harness:attempt-live',
    sourceKind: 'run',
    attemptId: 'attempt-live',
    cancelEndpoint: endpoint,
  });

  assert.equal(canStopFromDrawer(canonical), true);
  assert.equal(canStopFromDrawer({ ...canonical, cancelEndpoint: 'https://example.com/cancel' }), false,
    'a projected endpoint that is not ours is never called');
  assert.equal(canStopFromDrawer({ ...canonical, actions: [] }), false,
    'the card decides whether it can be cancelled at all');
  assert.equal(canStopFromDrawer({ ...canonical, cancelEndpoint: undefined }), false,
    'a run projects its endpoint only while live, so absence means there is nothing to stop');

  // Reported 2026-09-10: a background task's only Cancel lived in the Task
  // cockpit, which scrolls away under a live feed pinned to its newest row —
  // the user watching the work could not reach the button that stops it.
  assert.equal(
    canStopFromDrawer({ ...canonical, sourceKind: 'background', cancelEndpoint: undefined }), true,
    'a running background task is stoppable from the header while you watch it',
  );
  assert.equal(
    canStopFromDrawer({ ...canonical, sourceKind: 'workflow', cancelEndpoint: undefined }), true,
    'so is an in-flight workflow run',
  );
  assert.equal(
    canStopFromDrawer({ ...canonical, sourceKind: 'execution', cancelEndpoint: undefined }), true,
    'and tracked execution work',
  );

  assert.equal(canStopFromDrawer({ ...canonical, sourceKind: 'approval' }), false,
    'an approval is approve/reject, not a stop');
  assert.equal(canStopFromDrawer({ ...canonical, sourceKind: 'schedule' }), false,
    'a missed schedule has not started; its choice is Resume or Skip');
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

// ─── "Needs you" is two different asks ───────────────────────────────────────
// BLOCKED cannot be cleared by deciding anything — a fact, an auth or a
// reconciliation is missing. READY FOR REVIEW is one approve from carrying on.
// Nine unread approvals and one run stuck on missing auth are not one backlog.

test('needs-you splits on what the human actually has to do, not on the offered buttons', () => {
  // The trap: the board route gives a BLOCKED background task the same
  // ['resume','cancel'] allowlist as an awaiting_continue one, so the actions
  // cannot separate them — the status word has to lead.
  const blockedTask = card({
    id: 'bg-blocked', sourceKind: 'background', column: 'needs_you',
    status: 'blocked', actions: ['resume', 'cancel'],
  });
  const continuable = card({
    id: 'bg-continue', sourceKind: 'background', column: 'needs_you',
    status: 'awaiting_continue', actions: ['resume', 'cancel'],
  });
  assert.equal(boardNeedsYouGroup(blockedTask), 'blocked');
  assert.equal(boardNeedsYouGroup(continuable), 'review');

  // A question needs an answer typed, not a decision clicked.
  assert.equal(boardNeedsYouGroup(card({
    id: 'bg-ask', sourceKind: 'background', column: 'needs_you',
    status: 'awaiting_input', actions: ['cancel'],
  })), 'blocked');

  // Gates and bindings stopped the work before anything was sent.
  for (const status of ['blocked_capability', 'blocked_mutation', 'needs_binding']) {
    assert.equal(
      boardNeedsYouGroup(card({ id: `wf-${status}`, sourceKind: 'workflow', column: 'needs_you', status, actions: [] })),
      'blocked',
      `${status} is a wall, not a review`,
    );
  }

  // A standalone approval is the review case.
  assert.equal(boardNeedsYouGroup(card({
    id: 'approval:a1', sourceKind: 'approval', column: 'needs_you',
    status: 'awaiting_approval', actions: ['approve', 'reject'], approvalId: 'a1',
  })), 'review');

  // A flagged run that still carries its approval is reviewable: the offered
  // approve outranks the status word.
  assert.equal(boardNeedsYouGroup(card({
    id: 'run-attn', column: 'needs_you', status: 'needs_attention',
    actions: ['approve', 'reject'], raw: { pendingApprovalId: 'a2' },
  })), 'review');

  // An unrecognised wait fails closed — under-promising is survivable, calling
  // a wall "ready for review" is not.
  assert.equal(boardNeedsYouGroup(card({
    id: 'run-unknown', column: 'needs_you', status: 'awaiting_something_new', actions: [],
  })), 'blocked');
});

test('a held missed schedule is a decision to review, not a wall', () => {
  const held = card({
    id: 'catchup:run-9', sourceKind: 'schedule', column: 'needs_you',
    status: 'missed_schedule', actions: ['resume', 'cancel', 'skip'],
    raw: { workflowSlug: 'weekly-review', runId: 'run-9' },
  });
  assert.equal(boardNeedsYouGroup(held), 'review');
});

// ─── One answer to "what is running" ─────────────────────────────────────────
// The badge that sends you to /tasks and the board you land on used to be two
// answers to the same question: the badge asked the shared Working-Now
// presenter, /tasks read the server column raw.

/** The card the board route actually emits for a workflow parked on approval
 *  consumption (console-routes.ts): the server calls it Running, its status is
 *  `parked`, and its actions carry NO approve — the approve lives on the
 *  separate `approval:` card. Every assertion below is against this shape. */
const parkedWorkflowCard = () => card({
  id: 'wf:prospects:run-7', sourceKind: 'workflow', column: 'running', status: 'parked',
  progressHint: 'Waiting for your approval on step send-1', sessionId: null,
  actions: ['cancel'], primaryAction: 'none',
  raw: { workflowSlug: 'prospects', runId: 'run-7' },
});

/** The card that DOES carry the approve — its own row, in Needs you. */
const approvalCard = () => card({
  id: 'approval:apr-7', sourceKind: 'approval', column: 'needs_you', status: 'awaiting_approval',
  actions: ['approve', 'reject'], primaryAction: 'approve', approvalId: 'apr-7',
});

test('the board routes its live rows through the ONE Working-Now presenter', () => {
  const generatedAt = '2026-07-16T12:05:00.000Z';
  const live = card({ id: 'run-live', column: 'running', status: 'running', ageMs: 180_000 });
  const parked = parkedWorkflowCard();
  const queued = card({ id: 'bg-queued', column: 'queued', status: 'pending' });
  const finished = card({ id: 'run-done', column: 'done', status: 'completed' });

  const view = presentBoardWorkingNow([live, parked, queued, finished], generatedAt);
  assert.equal(view.total, 2, 'queued has not started and done is history');
  assert.equal(view.running, 1);
  assert.equal(view.needsYou, 1, 'a parked run is waiting on a person, not working');
  assert.equal(view.label, '1 running · 1 needs you');

  const [presentedLive, presentedParked] = view.entries;
  // The board feed carries no lease, so it may not mint the pulse certificate:
  // its Running column is a step id, which says a step was STARTED, not that
  // anything is still holding it. The card is still current work — it just does
  // not claim a heartbeat nobody took.
  assert.equal(presentedLive.presentation, 'waiting');
  assert.equal(presentedLive.pulse, false, 'the board never manufactures the pulse certificate');
  // And it carries no start time either: `ageMs` is time since the card was
  // last TOUCHED (pending.lastEventAt / updatedAt / guestUpdatedAt), so a run
  // three hours in whose last event was 30s ago would read '<1m'. No elapsed is
  // the honest answer.
  assert.equal(presentedLive.elapsed, '', 'an unknown start is rendered as unknown, not as "just now"');
  assert.equal(presentedParked.presentation, 'needs_you');
  assert.equal(presentedParked.pulse, false);
});

test('a parked run leaves Running for the review lane, and dropping it back on Running says nothing', () => {
  const parked = parkedWorkflowCard();
  assert.equal(boardLaneId(parked), 'needs_you_review');
  // The real parked card offers cancel and nothing else, so there is no intent
  // to fire — but the drop moves it NOWHERE (the server already has it in
  // Running), and a no-op must stay silent. Before the lanes split, target ===
  // card.column made this silent; a red "Nothing to start or resume here" toast
  // on a gesture that changes nothing is a regression, not a rejection.
  assert.equal(intentForDrop(parked, 'running'), null);
  assert.equal(rejectReason(parked, 'running'), '', 'a drop onto the column the server already has it in is a no-op');
  assert.equal(boardDropHighlight(parked, 'running'), 'none', 'and the lane must not flash reject for it');
  assert.equal(intentForDrop(parked, 'needs_you_review'), null, 'a drop back into its own lane is a no-op');
  assert.equal(rejectReason(parked, 'needs_you_review'), '');
  assert.equal(boardDropHighlight(parked, 'needs_you_review'), 'none', "a card's own rendered lane never flashes red");
  assert.equal(rejectReason(parked, 'needs_you_blocked'), '', 'sliding between the two needs-you lanes says nothing');
  // Cancel is the one thing it does offer, and the drag still reaches it.
  assert.equal(intentForDrop(parked, 'done'), 'cancel');
  assert.equal(boardDropHighlight(parked, 'done'), 'accept');

  // The approve-by-drag gesture lives on the card that actually carries the
  // approve, and comparing against the RENDERED lane is what keeps it alive.
  const approval = approvalCard();
  assert.equal(boardLaneId(approval), 'needs_you_review');
  assert.equal(intentForDrop(approval, 'running'), 'approve');
  assert.equal(boardDropHighlight(approval, 'running'), 'accept');

  assert.equal(boardLaneId(card({ id: 'run-live', column: 'running', status: 'running' })), 'running');
  assert.equal(boardLaneId(card({ id: 'bg-queued', column: 'queued', status: 'pending' })), 'queued');
  assert.equal(boardLaneId(card({ id: 'run-done', column: 'done', status: 'completed' })), 'done');
  assert.equal(
    boardLaneId(card({ id: 'bg-ask', column: 'needs_you', status: 'awaiting_input', actions: ['cancel'] })),
    'needs_you_blocked',
  );
});

test('the whole-board lane pass and the single-card one cannot give different answers', () => {
  const cards = [
    card({ id: 'run-live', column: 'running', status: 'running' }),
    parkedWorkflowCard(),
    card({ id: 'bg-queued', column: 'queued', status: 'pending' }),
    card({ id: 'run-done', column: 'done', status: 'completed' }),
    card({ id: 'bg-ask', column: 'needs_you', status: 'awaiting_input', actions: ['cancel'] }),
    approvalCard(),
  ];
  const { laneOf } = boardLanes(cards, '2026-07-16T12:05:00.000Z');
  assert.equal(laneOf.size, cards.length, 'every card lands in exactly one lane');
  for (const one of cards) {
    assert.equal(laneOf.get(one.id), boardLaneId(one), `${one.id} lanes the same both ways`);
  }
  assert.deepEqual([...laneOf.values()].sort(), [
    'done', 'needs_you_blocked', 'needs_you_review', 'needs_you_review', 'queued', 'running',
  ]);
});
