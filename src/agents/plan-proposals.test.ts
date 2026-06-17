/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-plan-proposals npx tsx --test src/agents/plan-proposals.test.ts
 *
 * Covers the plan-proposal lifecycle:
 *   - surfacePlan validates input, writes a pending proposal, notifies
 *   - listPlanProposals filters by status, sessionId; sorts newest first
 *   - approvePlanProposal stamps resolution metadata; supports editedPlan
 *   - rejectPlanProposal records reason, trims blank reasons
 *   - deletePlanProposal is idempotent
 *   - supersedePlanProposal marks pending → superseded only
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-plan-proposals';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  surfacePlan,
  getPlanProposal,
  listPlanProposals,
  approvePlanProposal,
  rejectPlanProposal,
  deletePlanProposal,
  supersedePlanProposal,
  planNeedsUserInput,
  deriveEnumeratedSends,
} = await import('./plan-proposals.js');
const { listNotifications } = await import('../runtime/notifications.js');
const { getPlanScope, isAutoApprovedByScope, closePlanScope } = await import('./plan-scope.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME + '/state/plan-proposals', { recursive: true, force: true });
});

function aPlan(overrides = {}) {
  return {
    objective: 'Add a refresh token handler to the Composio client.',
    steps: [
      { n: 1, action: 'Read src/integrations/composio/client.ts', rationale: 'Confirm current auth path.', verification: null },
      { n: 2, action: 'Add refreshToken handler', rationale: 'Retry on 401.', verification: null },
    ],
    successCriteria: ['401 responses retry once with a fresh token.'],
    risks: [],
    estimatedComplexity: 'moderate' as const,
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    ...overrides,
  };
}

// ─── surface ───────────────────────────────────────────────────

test('surfacePlan: writes a pending proposal', () => {
  const p = surfacePlan({
    plan: aPlan(),
    originatingRequest: 'Make the Composio client survive token expiry.',
  });
  assert.match(p.id, /^plan-/);
  assert.equal(p.status, 'pending');
  assert.equal(p.proposedByAgent, 'clementine');
  assert.equal(p.plan.objective.startsWith('Add a refresh token'), true);
});

test('surfacePlan: round-trips appliedInstructions onto the persisted proposal', () => {
  const p = surfacePlan({
    plan: aPlan({ appliedInstructions: ['Always CC Dana on client emails (source: user, 2026-05-01)'] }),
    originatingRequest: 'Draft the client update emails.',
  });
  const reloaded = getPlanProposal(p.id);
  assert.deepEqual(reloaded?.plan.appliedInstructions, ['Always CC Dana on client emails (source: user, 2026-05-01)']);
});

test('surfacePlan: renders applied instructions as user-facing context', () => {
  const p = surfacePlan({
    plan: aPlan({
      appliedInstructions: [
        'Never email clients on Fridays (source: feedback)',
        'Generate a complete Scorpion pre-proposal audit brief workflow exists at `00-System/workflows/proposal-audit-brief/SKILL.md`; use relevant research/briefing steps but omit deploy/notify. (source: workflow memory + SKILL.md)',
      ],
    }),
    originatingRequest: 'Send the weekly client digest.',
  });
  const notif = listNotifications(50).find((n) => (n.metadata as { planProposalId?: string })?.planProposalId === p.id);
  assert.ok(notif, 'a plan_proposal notification was queued for this proposal');
  assert.match(notif!.title, /Review before I start/);
  assert.match(notif!.body, /Context I will use/);
  assert.match(notif!.body, /Never email clients on Fridays/);
  assert.match(notif!.body, /Use the relevant saved proposal workflow/);
  assert.doesNotMatch(notif!.body, /Instructions I'm following/);
  assert.doesNotMatch(notif!.body, /source:/i);
  assert.doesNotMatch(notif!.body, /SKILL\.md/);
  assert.doesNotMatch(notif!.body, /Complexity:/);
});

test('surfacePlan: omits the context block when no instructions apply', () => {
  const p = surfacePlan({
    plan: aPlan({ appliedInstructions: [] }),
    originatingRequest: 'A request with no standing instructions in play.',
  });
  const notif = listNotifications(50).find((n) => (n.metadata as { planProposalId?: string })?.planProposalId === p.id);
  assert.ok(notif);
  assert.doesNotMatch(notif!.body, /Context I will use/);
});

test('surfacePlan: rejects plans with unresolved user-input questions', () => {
  assert.equal(planNeedsUserInput(aPlan({ needsUserInput: ['Which local law firm should I brief?'] })), true);
  assert.throws(
    () => surfacePlan({
      plan: aPlan({ needsUserInput: ['Which local law firm should I brief?'] }),
      originatingRequest: 'Prepare a local SEO opportunity brief.',
    }),
    /unresolved needsUserInput/,
  );
});

test('surfacePlan: rejects too-short originatingRequest', () => {
  assert.throws(
    () => surfacePlan({ plan: aPlan(), originatingRequest: 'eh' }),
    /originatingRequest required/,
  );
});

test('surfacePlan: rejects plan without objective or steps', () => {
  assert.throws(
    () => surfacePlan({
      // @ts-expect-error — missing objective on purpose
      plan: { steps: [], successCriteria: [], risks: [], estimatedComplexity: 'trivial', recommendsTrackedExecution: false, needsUserInput: [], appliedInstructions: [] },
      originatingRequest: 'do the thing',
    }),
    /plan must include objective/,
  );
});

test('surfacePlan: preserves session + channel context', () => {
  const p = surfacePlan({
    plan: aPlan(),
    originatingRequest: 'something that needs planning',
    sessionId: 'sess-abc',
    channel: 'discord:user-123',
    context: 'Surface before mutation.',
  });
  assert.equal(p.sessionId, 'sess-abc');
  assert.equal(p.channel, 'discord:user-123');
  assert.equal(p.context, 'Surface before mutation.');
});

// ─── list / get ────────────────────────────────────────────────

test('listPlanProposals: defaults to pending, sorts newest first', async () => {
  const a = surfacePlan({ plan: aPlan({ objective: 'Plan A long enough.' }), originatingRequest: 'request A' });
  await new Promise((r) => setTimeout(r, 5));
  const b = surfacePlan({ plan: aPlan({ objective: 'Plan B long enough.' }), originatingRequest: 'request B' });
  const items = listPlanProposals();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, b.id);
  assert.equal(items[1].id, a.id);
});

test('listPlanProposals: filters by sessionId', () => {
  surfacePlan({ plan: aPlan(), originatingRequest: 'session one request', sessionId: 'sess-1' });
  surfacePlan({ plan: aPlan(), originatingRequest: 'session two request', sessionId: 'sess-2' });
  const sess1 = listPlanProposals({ sessionId: 'sess-1' });
  assert.equal(sess1.length, 1);
  assert.equal(sess1[0].sessionId, 'sess-1');
});

test('listPlanProposals: status=all returns resolved proposals too', () => {
  const a = surfacePlan({ plan: aPlan(), originatingRequest: 'work A' });
  rejectPlanProposal(a.id, 'wrong shape');
  assert.equal(listPlanProposals().length, 0);
  const all = listPlanProposals({ status: 'all' });
  assert.equal(all.length, 1);
});

test('getPlanProposal: returns null for unknown ids', () => {
  assert.equal(getPlanProposal('plan-nonexistent'), null);
});

// ─── approve ───────────────────────────────────────────────────

test('approvePlanProposal: stamps resolution metadata and stores approvedPlan = original by default', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'something' });
  const out = approvePlanProposal(p.id);
  assert.ok(out);
  assert.equal(out.status, 'approved');
  assert.equal(out.resolvedBy, 'user');
  assert.ok(out.resolvedAt);
  // approvedPlan defaults to original.
  assert.deepEqual(out.approvedPlan, p.plan);
});

test('approvePlanProposal: stores edited plan when supplied', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'original work' });
  const edited = aPlan({ objective: 'A refined objective with more clarity.' });
  const out = approvePlanProposal(p.id, { editedPlan: edited });
  assert.ok(out);
  assert.equal(out.approvedPlan?.objective, 'A refined objective with more clarity.');
  // Original plan preserved for audit.
  assert.equal(out.plan.objective, p.plan.objective);
});

test('approvePlanProposal: refuses edited plans that add unresolved user-input questions', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'original work' });
  const edited = aPlan({
    objective: 'A refined objective with a missing target.',
    needsUserInput: ['Which account should I use?'],
  });
  const out = approvePlanProposal(p.id, { editedPlan: edited });
  assert.equal(out, null);
  assert.equal(getPlanProposal(p.id)?.status, 'pending');
});

test('approvePlanProposal: returns null for unknown or already-resolved', () => {
  assert.equal(approvePlanProposal('plan-nope'), null);
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'something' });
  rejectPlanProposal(p.id);
  assert.equal(approvePlanProposal(p.id), null);
});

// ─── reject / delete ───────────────────────────────────────────

test('rejectPlanProposal: records reason and resolves', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'something' });
  const out = rejectPlanProposal(p.id, 'Not what I meant.');
  assert.ok(out);
  assert.equal(out.status, 'rejected');
  assert.equal(out.rejectionReason, 'Not what I meant.');
});

test('rejectPlanProposal: trims blank reasons to undefined', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'something' });
  const out = rejectPlanProposal(p.id, '   ');
  assert.ok(out);
  assert.equal(out.rejectionReason, undefined);
});

test('deletePlanProposal: is idempotent', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'something' });
  assert.equal(deletePlanProposal(p.id), true);
  assert.equal(getPlanProposal(p.id), null);
  assert.equal(deletePlanProposal(p.id), false);
});

// ─── supersede ─────────────────────────────────────────────────

test('supersedePlanProposal: marks pending → superseded only', () => {
  const a = surfacePlan({ plan: aPlan(), originatingRequest: 'first attempt' });
  const out = supersedePlanProposal(a.id, 'plan-newer');
  assert.ok(out);
  assert.equal(out.status, 'superseded');
  assert.equal(out.rejectionReason, 'Replaced by plan-newer');

  // Cannot supersede a resolved one
  const b = surfacePlan({ plan: aPlan(), originatingRequest: 'second' });
  approvePlanProposal(b.id);
  const noop = supersedePlanProposal(b.id);
  assert.ok(noop);
  assert.equal(noop.status, 'approved', 'already-approved proposal stays approved');
});

// ─── goal-bounded send autonomy (2026-06-17) ──────────────────────

test('deriveEnumeratedSends: dedupes slugs; empty for null/no-sends', () => {
  assert.deepEqual(deriveEnumeratedSends(aPlan({ externalSends: null }) as never), []);
  assert.deepEqual(deriveEnumeratedSends(aPlan() as never), []); // field absent
  assert.deepEqual(
    deriveEnumeratedSends(aPlan({
      externalSends: [
        { slug: 'OUTLOOK_SEND_EMAIL', summary: '8 firms', count: 8 },
        { slug: 'OUTLOOK_SEND_EMAIL', summary: 'a follow-up', count: 1 }, // same shape
        { slug: '  ', summary: 'blank slug ignored', count: null },
      ],
    }) as never),
    ['OUTLOOK_SEND_EMAIL'],
  );
});

test('approve with enumerated sends → opens a GOAL-SCOPED scope blessing exactly those sends (no self-drive)', () => {
  const sessionId = 'sess-sendbound-1';
  const p = surfacePlan({
    plan: aPlan({
      objective: 'Send personalized outreach to the 8 market-leader firms.',
      externalSends: [{ slug: 'OUTLOOK_SEND_EMAIL', summary: 'outreach to 8 firms', count: 8 }],
    }),
    originatingRequest: 'Send the 8 Scorpion outreach emails.',
    sessionId,
  });
  const approved = approvePlanProposal(p.id);
  assert.ok(approved);
  // Approval activates the plan as the session goal, so the returned record is the
  // GOAL (status 'active'), not the raw 'approved' proposal — that's the pin.
  assert.equal(approved.status, 'active', 'approved plan becomes the active (pinned) goal');

  const scope = getPlanScope(sessionId);
  assert.ok(scope, 'a scope opened on approval');
  assert.equal(scope.goalScoped?.goalId, p.id, 'scope is GOAL-scoped to the approved goal');
  assert.deepEqual(scope.allowedSends, ['OUTLOOK_SEND_EMAIL'], 'blesses exactly the enumerated send');
  assert.ok(!scope.closedAt, 'scope is open');

  // The blessed send auto-approves; an off-shape send still pauses.
  assert.equal(
    isAutoApprovedByScope(sessionId, 'composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_EMAIL' }, 'send'),
    true,
    'enumerated send auto-approves within the goal scope',
  );
  assert.equal(
    isAutoApprovedByScope(sessionId, 'composio_execute_tool', { tool_slug: 'TWITTER_CREATE_TWEET' }, 'send'),
    false,
    'an off-shape send (not enumerated) still pauses',
  );
  closePlanScope(sessionId, 'test cleanup');
});

test('kill-switch CLEMMY_GOAL_SEND_AUTONOMY=off → enumerated sends do NOT open a goal scope', () => {
  const prev = process.env.CLEMMY_GOAL_SEND_AUTONOMY;
  process.env.CLEMMY_GOAL_SEND_AUTONOMY = 'off';
  try {
    const sessionId = 'sess-sendbound-killswitch';
    const p = surfacePlan({
      plan: aPlan({ externalSends: [{ slug: 'OUTLOOK_SEND_EMAIL', summary: 'x', count: 2 }] }),
      originatingRequest: 'Send two emails.',
      sessionId,
    });
    approvePlanProposal(p.id);
    const scope = getPlanScope(sessionId);
    // Falls back to the time-boxed scope (NOT goal-scoped) — sends are not pre-blessed.
    assert.ok(!scope?.goalScoped, 'no goal-scoped scope when the kill-switch is off');
    if (scope) closePlanScope(sessionId, 'test cleanup');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_GOAL_SEND_AUTONOMY;
    else process.env.CLEMMY_GOAL_SEND_AUTONOMY = prev;
  }
});

test('no enumerated sends → today\'s time-boxed scope (no goal scope, no send blessing)', () => {
  const sessionId = 'sess-no-sends';
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'Local read-only work.', sessionId });
  approvePlanProposal(p.id);
  const scope = getPlanScope(sessionId);
  assert.ok(scope, 'a time-boxed scope still opens for the execution steps');
  assert.ok(!scope.goalScoped, 'but it is NOT goal-scoped');
  assert.ok(!scope.allowedSends || scope.allowedSends.length === 0, 'and blesses no sends');
  closePlanScope(sessionId, 'test cleanup');
});
