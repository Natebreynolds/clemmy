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
} = await import('./plan-proposals.js');

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
      plan: { steps: [], successCriteria: [], risks: [], estimatedComplexity: 'trivial', recommendsTrackedExecution: false, needsUserInput: [] },
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
