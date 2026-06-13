/**
 * Run: npx tsx --test src/agents/goal-contract.test.ts
 *
 * Goal-contract lifecycle (GOAL-CONTRACT-PLAN.md Phase 1) — the parked-goal
 * extension of the plan-proposals store:
 *   - activateGoal: approved → active; pending (/goal-direct) → active;
 *     refuses rejected/satisfied; enforces ONE active per session (supersede)
 *   - getActiveGoalForSession / listActiveGoalContracts
 *   - touchGoalActivity: bumps lastActivityAt, appends bounded ledger lines
 *   - recordGoalValidation: appends evidence, bumps attempt
 *   - satisfyGoal / expireGoal: terminal transitions from active only
 *   - reapExpiredGoals: 24h idle TTL for chat goals, workflow-origin exempt,
 *     mid-flight expiry notifies ONCE, terminal >7d purge, existing proposal
 *     statuses untouched
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-goal-contract';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  surfacePlan,
  surfaceAskingPlan,
  getPlanProposal,
  listPlanProposals,
  approvePlanProposal,
  activateGoal,
  getActiveGoalForSession,
  listActiveGoalContracts,
  touchGoalActivity,
  appendGoalLedgerForSession,
  getCurrentGoalStage,
  advanceGoalStage,
  recordGoalValidation,
  satisfyGoal,
  expireGoal,
  reapExpiredGoals,
} = await import('./plan-proposals.js');
const { listNotifications } = await import('../runtime/notifications.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME + '/state/plan-proposals', { recursive: true, force: true });
});

function aPlan(overrides = {}) {
  return {
    objective: 'Build the Q2 outreach list and draft the emails.',
    steps: [
      { n: 1, action: 'Pull the accounts from Salesforce', rationale: 'Source of truth.', verification: null },
      { n: 2, action: 'Draft the outreach emails', rationale: 'The deliverable.', verification: null },
    ],
    successCriteria: ['A local markdown brief exists.', 'Drafts exist for the top 3 accounts.'],
    stages: null,
    risks: [],
    estimatedComplexity: 'moderate' as const,
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    ...overrides,
  };
}

/** Approval now AUTO-ACTIVATES chat plans (Phase 3) — returns the ACTIVE goal. */
function surfaceApproved(sessionId: string) {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'do the outreach prep', sessionId });
  return approvePlanProposal(p.id, { allowedTools: [] })!;
}

// ─── activate ────────────────────────────────────────────────────────────────

test('approval auto-activates: approved chat plan becomes the ACTIVE goal with fields initialized', () => {
  const active = surfaceApproved('sess-g1');
  assert.ok(active);
  assert.equal(active!.status, 'active');
  assert.equal(active!.origin?.kind, 'chat');
  assert.equal(active!.attempt, 0);
  assert.equal(typeof active!.maxAttempts, 'number');
  assert.ok(active!.lastActivityAt);
  assert.deepEqual(active!.evidence, []);
  assert.deepEqual(active!.progressLedger, []);
});

test('activateGoal: pending (/goal-direct) proposals activate too', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'direct goal', sessionId: 'sess-g2' });
  const active = activateGoal(p.id, { origin: { kind: 'chat' } });
  assert.ok(active);
  assert.equal(active!.status, 'active');
});

test('activateGoal: refuses terminal proposals and unresolved questions', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'will be satisfied', sessionId: 'sess-g3' });
  activateGoal(p.id);
  satisfyGoal(p.id);
  assert.equal(activateGoal(p.id), null, 'satisfied goal cannot re-activate');

  const withQuestion = { ...aPlan(), needsUserInput: ['Which sheet?'] };
  const askingStored = surfaceAskingPlan({ plan: withQuestion, originatingRequest: 'needs input', sessionId: 'sess-g3d' });
  assert.equal(activateGoal(askingStored.id), null, 'a plan with open questions cannot become an active goal');
});

test('activateGoal: ONE active goal per session — prior active is superseded, other sessions untouched', () => {
  const a = surfaceApproved('sess-g4');
  const other = surfaceApproved('sess-g4-other');
  const activatedB = surfaceApproved('sess-g4'); // approval auto-activates + supersedes

  assert.equal(activatedB.status, 'active');
  assert.equal(getPlanProposal(a.id)!.status, 'superseded', 'prior active goal superseded');
  assert.equal(getPlanProposal(other.id)!.status, 'active', 'other session goal untouched');
  assert.equal(getActiveGoalForSession('sess-g4')!.id, activatedB.id);
});

// ─── reads ───────────────────────────────────────────────────────────────────

test('getActiveGoalForSession: null without a session or active goal', () => {
  assert.equal(getActiveGoalForSession(''), null);
  assert.equal(getActiveGoalForSession('sess-none'), null);
});

test('listActiveGoalContracts lists active goals across sessions', () => {
  surfaceApproved('sess-g5a');
  surfaceApproved('sess-g5b');
  const all = listActiveGoalContracts();
  assert.equal(all.length, 2);
  assert.ok(all.every((g) => g.status === 'active'));
});

// ─── progress + validation bookkeeping ───────────────────────────────────────

test('touchGoalActivity bumps lastActivityAt and bounds the ledger at 20 lines', () => {
  const g = surfaceApproved('sess-g6');
  for (let i = 0; i < 25; i++) touchGoalActivity(g.id, `step ${i} done`);
  const after = getPlanProposal(g.id)!;
  assert.equal(after.progressLedger!.length, 20, 'ledger bounded');
  assert.equal(after.progressLedger![19], 'step 24 done', 'newest kept');
  assert.ok(after.lastActivityAt! >= g.lastActivityAt!);
});

test('appendGoalLedgerForSession targets the session active goal; no-op without one', () => {
  const g = surfaceApproved('sess-led1');
  const updated = appendGoalLedgerForSession('sess-led1', 'pulled 12 accounts');
  assert.ok(updated, 'returns the updated record');
  assert.equal(getPlanProposal(g.id)!.progressLedger!.at(-1), 'pulled 12 accounts');
  // A session with no active goal is a clean no-op (never throws).
  assert.equal(appendGoalLedgerForSession('sess-no-goal', 'orphan line'), null);
  // Empty lines are ignored.
  assert.equal(appendGoalLedgerForSession('sess-led1', '   '), null);
});

// ─── stages ──────────────────────────────────────────────────────────────────

const stagedPlan = () => aPlan({
  stages: [
    { title: 'Research', criteria: ['A local markdown brief exists.'] },
    { title: 'Draft', criteria: ['Drafts exist for the top 3 accounts.'] },
  ],
});

test('activation materializes authored stages into pending GoalStage records', () => {
  const p = surfacePlan({ plan: stagedPlan(), originatingRequest: 'staged work', sessionId: 'sess-st1' });
  const active = approvePlanProposal(p.id, { allowedTools: [] })!;
  assert.equal(active.stages!.length, 2);
  assert.equal(active.stages![0].id, 's1');
  assert.equal(active.stages![0].status, 'pending');
  assert.equal(active.stages![0].title, 'Research');
  assert.equal(getCurrentGoalStage(active)!.id, 's1', 'current = first pending');
});

test('a goal with no authored stages stays unstaged', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'unstaged', sessionId: 'sess-st2' });
  const active = approvePlanProposal(p.id, { allowedTools: [] })!;
  assert.equal(active.stages, undefined);
  assert.equal(getCurrentGoalStage(active), null);
});

test('advanceGoalStage is single-fire, resets attempt, and walks to the next stage', () => {
  const p = surfacePlan({ plan: stagedPlan(), originatingRequest: 'staged', sessionId: 'sess-st3' });
  const active = approvePlanProposal(p.id, { allowedTools: [] })!;
  // burn an attempt so we can prove the reset
  recordGoalValidation(active.id, [{ at: new Date().toISOString(), attempt: 1, criterion: 'A local markdown brief exists.', pass: false }]);
  assert.equal(getPlanProposal(active.id)!.attempt, 1);

  const advanced = advanceGoalStage(active.id, 's1')!;
  assert.equal(advanced.stages![0].status, 'done');
  assert.ok(advanced.stages![0].completedAt && advanced.stages![0].checkinAt, 'completion + checkin stamped');
  assert.equal(advanced.attempt, 0, 'attempt budget reset for the next stage');
  assert.equal(getCurrentGoalStage(advanced)!.id, 's2', 'current advanced to s2');

  // second call on the same stage is a no-op (the latch)
  assert.equal(advanceGoalStage(active.id, 's1'), null, 'already-done stage does not re-fire');
});

test('autonomous approval opens a goal-scoped scope + self-driving, and the scope dies with the goal', async () => {
  const { getPlanScope } = await import('./plan-scope.js');
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'auto run', sessionId: 'sess-auto1' });
  const active = approvePlanProposal(p.id, {
    allowedTools: ['*'], autonomous: true, allowedSends: ['GMAIL_SEND_EMAIL'],
  })!;
  assert.equal(active.selfDriving, true, 'autonomous approval flags the goal self-driving');
  const scope = getPlanScope('sess-auto1');
  assert.ok(scope?.goalScoped, 'a goal-scoped scope opened');
  assert.equal(scope!.goalScoped!.goalId, active.id);
  assert.deepEqual(scope!.allowedSends, ['GMAIL_SEND_EMAIL']);

  // Satisfying the goal closes the scope (no orphaned auto-approval window).
  satisfyGoal(active.id, 'done');
  const after = getPlanScope('sess-auto1');
  assert.ok(after?.closedAt, 'goal-scoped scope closed when the goal resolved');
});

test('advanceGoalStage refuses unknown stage and non-active goals', () => {
  const p = surfacePlan({ plan: stagedPlan(), originatingRequest: 'staged', sessionId: 'sess-st4' });
  const active = approvePlanProposal(p.id, { allowedTools: [] })!;
  assert.equal(advanceGoalStage(active.id, 'nope'), null, 'unknown stage id');
  satisfyGoal(active.id, 'done');
  assert.equal(advanceGoalStage(active.id, 's1'), null, 'terminal goal cannot advance');
});

test('recordGoalValidation appends evidence and bumps attempt', () => {
  const g = surfaceApproved('sess-g7');
  recordGoalValidation(g.id, [
    { at: new Date().toISOString(), attempt: 1, criterion: 'A local markdown brief exists.', pass: false, method: 'deterministic', detail: 'file missing' },
  ]);
  const after = getPlanProposal(g.id)!;
  assert.equal(after.attempt, 1);
  assert.equal(after.evidence!.length, 1);
  assert.equal(after.evidence![0].pass, false);
});

test('satisfy/expire transition only from active', () => {
  const g = surfaceApproved('sess-g8');
  const satisfied = satisfyGoal(g.id, 'all criteria met');
  assert.equal(satisfied!.status, 'satisfied');
  assert.equal(satisfied!.doneReason, 'all criteria met');
  assert.equal(expireGoal(g.id), null, 'terminal goal cannot expire again');
  assert.equal(satisfyGoal(g.id), null, 'terminal goal cannot re-satisfy');
});

// ─── reaper ──────────────────────────────────────────────────────────────────

function backdateGoal(id: string, hoursAgo: number) {
  // Backdate the on-disk record directly — the store has no API for moving
  // time, and the reaper must read what's on disk.
  const record = getPlanProposal(id)!;
  const past = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  const filePath = `${TEST_HOME}/state/plan-proposals/${id}.json`;
  writeFileSync(filePath, JSON.stringify({ ...record, lastActivityAt: past, resolvedAt: record.resolvedAt ? past : record.resolvedAt }, null, 2));
}

test('reapExpiredGoals: idle chat goal expires; fresh and workflow-origin goals survive', () => {
  const idle = surfaceApproved('sess-r1');
  const fresh = surfaceApproved('sess-r2');
  const wf = activateGoal(surfacePlan({ plan: aPlan(), originatingRequest: 'wf goal', sessionId: 'sess-r3' }).id, { origin: { kind: 'workflow', runId: 'run-1' } })!;
  backdateGoal(idle.id, 30);
  backdateGoal(wf.id, 30);

  const stats = reapExpiredGoals();
  assert.equal(stats.expired, 1, 'only the idle chat goal expired');
  assert.equal(getPlanProposal(idle.id)!.status, 'expired');
  assert.equal(getPlanProposal(fresh.id)!.status, 'active');
  assert.equal(getPlanProposal(wf.id)!.status, 'active', 'workflow-origin exempt from idle TTL');
});

test('reapExpiredGoals: mid-flight expiry notifies once; untouched expiry is silent', () => {
  const midFlight = surfaceApproved('sess-r4');
  touchGoalActivity(midFlight.id, 'pulled the accounts');
  const untouched = surfaceApproved('sess-r5');
  backdateGoal(midFlight.id, 30);
  backdateGoal(untouched.id, 30);

  const beforeCount = listNotifications().filter((n) => String(n.metadata?.kind) === 'goal_expired').length;
  const stats = reapExpiredGoals();
  const afterCount = listNotifications().filter((n) => String(n.metadata?.kind) === 'goal_expired').length;

  assert.equal(stats.expired, 2);
  assert.equal(stats.notified, 1, 'only the mid-flight goal notifies');
  assert.equal(afterCount - beforeCount, 1);
});

test('reapExpiredGoals: terminal records older than 7 days purge; pending/approved proposals untouched', () => {
  const old = surfaceApproved('sess-r6');
  satisfyGoal(old.id);
  backdateGoal(old.id, 8 * 24);

  const pendingP = surfacePlan({ plan: aPlan(), originatingRequest: 'still pending', sessionId: 'sess-r7' });
  const freshActive = surfaceApproved('sess-r8');

  const stats = reapExpiredGoals();
  assert.equal(stats.purged, 1);
  assert.equal(getPlanProposal(old.id), null, 'purged from disk');
  assert.equal(getPlanProposal(pendingP.id)!.status, 'pending', 'pending proposal untouched');
  assert.equal(getPlanProposal(freshActive.id)!.status, 'active', 'fresh active goal untouched');
});

// ─── back-compat ────────────────────────────────────────────────────────────

test('existing proposal flow is unchanged: default list filter still pending-only', () => {
  const p = surfacePlan({ plan: aPlan(), originatingRequest: 'plain proposal', sessionId: 'sess-bc1' });
  surfaceApproved('sess-bc1');
  const pendingOnly = listPlanProposals({ sessionId: 'sess-bc1' });
  assert.equal(pendingOnly.length, 1);
  assert.equal(pendingOnly[0].id, p.id);
});
