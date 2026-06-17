/**
 * Run: npx tsx --test src/channels/discord-harness-plan-approval.test.ts
 *
 * Gate-unification Step 5: a typed "yes/approve" must resolve a surfaced
 * PlanProposal for the channel's session (the dead-end the user hit — typed
 * consent used to match nothing and become a fresh chat turn). Registry (apr-)
 * approvals must NOT be shadowed.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-discord-plan-approval';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { createSession } = await import('../runtime/harness/eventlog.js');
const { surfacePlan, getPlanProposal, getActiveGoalForSession } = await import('../agents/plan-proposals.js');
const { maybeResolvePendingPlanProposal, __test__ } = await import('./discord-harness.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});
beforeEach(() => {
  rmSync(TEST_HOME + '/state/plan-proposals', { recursive: true, force: true });
});

function aPlan() {
  return {
    objective: 'Send a personalized outreach email to each of the 8 firms.',
    steps: [{ n: 1, action: 'send the emails', rationale: 'the ask', verification: null }],
    successCriteria: ['8 emails sent'],
    stages: null, risks: [], estimatedComplexity: 'moderate' as const,
    recommendsTrackedExecution: false, needsUserInput: [], appliedInstructions: [], externalSends: null,
  };
}

test('typed "approve" resolves the pending plan for the channel session AND activates the goal', () => {
  const sess = createSession({ kind: 'chat' });
  const channelId = 'discord-chan-1';
  __test__.setChannelSessionForTest(channelId, sess.id);
  const proposal = surfacePlan({ plan: aPlan() as never, originatingRequest: 'send the 8 emails', sessionId: sess.id });

  const result = maybeResolvePendingPlanProposal(channelId, 'go ahead');
  assert.equal(result, 'approved');
  // The proposal is resolved (no longer pending) and the goal is now active.
  assert.notEqual(getPlanProposal(proposal.id)?.status, 'pending');
  assert.equal(getActiveGoalForSession(sess.id)?.id, proposal.id, 'approval activated the goal');
});

test('typed "reject" resolves the pending plan as rejected', () => {
  const sess = createSession({ kind: 'chat' });
  const channelId = 'discord-chan-2';
  __test__.setChannelSessionForTest(channelId, sess.id);
  const proposal = surfacePlan({ plan: aPlan() as never, originatingRequest: 'send the 8 emails', sessionId: sess.id });

  assert.equal(maybeResolvePendingPlanProposal(channelId, 'reject'), 'rejected');
  assert.equal(getPlanProposal(proposal.id)?.status, 'rejected');
});

test('a non-approval phrase does nothing (no plan resolved)', () => {
  const sess = createSession({ kind: 'chat' });
  const channelId = 'discord-chan-3';
  __test__.setChannelSessionForTest(channelId, sess.id);
  const proposal = surfacePlan({ plan: aPlan() as never, originatingRequest: 'send the 8 emails', sessionId: sess.id });

  assert.equal(maybeResolvePendingPlanProposal(channelId, 'what is the weather in Denver?'), null);
  assert.equal(getPlanProposal(proposal.id)?.status, 'pending', 'plan stays pending');
});

test('an apr- registry id is NOT shadowed — it returns null (registry path owns it)', () => {
  const sess = createSession({ kind: 'chat' });
  const channelId = 'discord-chan-4';
  __test__.setChannelSessionForTest(channelId, sess.id);
  const proposal = surfacePlan({ plan: aPlan() as never, originatingRequest: 'send the 8 emails', sessionId: sess.id });

  // "approve apr-1a2b" carries an approvalId → it's a registry approval; this
  // helper must ignore it so it can't resolve the wrong thing.
  assert.equal(maybeResolvePendingPlanProposal(channelId, 'approve apr-1a2b'), null);
  assert.equal(getPlanProposal(proposal.id)?.status, 'pending', 'the plan is untouched');
});

test('no pending plan for the channel → null', () => {
  const sess = createSession({ kind: 'chat' });
  const channelId = 'discord-chan-5';
  __test__.setChannelSessionForTest(channelId, sess.id);
  assert.equal(maybeResolvePendingPlanProposal(channelId, 'approve'), null);
});

test('kill-switch CLEMMY_TYPED_PLAN_APPROVAL=off reverts to button-only (null)', () => {
  const prev = process.env.CLEMMY_TYPED_PLAN_APPROVAL;
  process.env.CLEMMY_TYPED_PLAN_APPROVAL = 'off';
  try {
    const sess = createSession({ kind: 'chat' });
    const channelId = 'discord-chan-6';
    __test__.setChannelSessionForTest(channelId, sess.id);
    const proposal = surfacePlan({ plan: aPlan() as never, originatingRequest: 'send the 8 emails', sessionId: sess.id });
    assert.equal(maybeResolvePendingPlanProposal(channelId, 'approve'), null);
    assert.equal(getPlanProposal(proposal.id)?.status, 'pending');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_TYPED_PLAN_APPROVAL;
    else process.env.CLEMMY_TYPED_PLAN_APPROVAL = prev;
  }
});
