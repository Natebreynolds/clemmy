/**
 * Plan-continuity unit tests.
 *
 * Covers (no live model calls):
 *   - findOpenQuestionPlan: returns the open question-plan for a channel,
 *     ignores empty-needsUserInput / resolved / superseded / other-channel.
 *   - listPlanProposals channel filter.
 *   - planContinuityEnabled reflects the env flag.
 *   - buildClassifierPrompt includes objective + questions + message.
 *
 * The classifier itself is a model call and is NOT unit-tested live.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-plan-continuity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const { surfaceAskingPlan, surfacePlan, listPlanProposals, supersedePlanProposal, rejectPlanProposal } =
  await import('../../agents/plan-proposals.js');
const { findOpenQuestionPlan, planContinuityEnabled, buildClassifierPrompt } =
  await import('./plan-continuity.js');
const { shouldUsePlanFirst } = await import('./plan-first.js');

function aPlan(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Pull the deals we closed and put them in a sheet.',
    steps: [
      { n: 1, action: 'Query Salesforce for closed-won opportunities', rationale: 'Source the deals.', verification: null },
      { n: 2, action: 'Write the rows into a Google Sheet', rationale: 'Deliver the output.', verification: null },
    ],
    successCriteria: ['A sheet contains the closed-won deals.'],
    risks: [],
    estimatedComplexity: 'moderate' as const,
    recommendsTrackedExecution: false,
    needsUserInput: ['Which time window?', 'Which deal stage?', 'New or existing sheet?'],
    appliedInstructions: [],
    ...overrides,
  };
}

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
});

beforeEach(() => {
  rmSync(path.join(TEST_HOME, 'state', 'plan-proposals'), { recursive: true, force: true });
});

// ─── findOpenQuestionPlan ──────────────────────────────────────

test('findOpenQuestionPlan: returns the pending plan that has open questions', () => {
  surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'get me the deals we closed and put them somewhere',
    channel: 'discord:chan-1',
  });
  const found = findOpenQuestionPlan('discord:chan-1');
  assert.ok(found, 'an open question-plan should be found');
  assert.equal(found!.channel, 'discord:chan-1');
  assert.ok(found!.plan.needsUserInput.length > 0);
});

test('findOpenQuestionPlan: ignores plans with no open questions', () => {
  // surfacePlan only accepts fully-specified plans (no needsUserInput).
  surfacePlan({
    plan: aPlan({ needsUserInput: [] }),
    originatingRequest: 'a fully specified request that needs no input',
    channel: 'discord:chan-2',
  });
  assert.equal(findOpenQuestionPlan('discord:chan-2'), null);
});

test('findOpenQuestionPlan: ignores resolved / superseded plans', () => {
  const a = surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'first asking plan that will be superseded',
    channel: 'discord:chan-3',
  });
  supersedePlanProposal(a.id);
  assert.equal(findOpenQuestionPlan('discord:chan-3'), null);

  const b = surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'second asking plan that will be rejected',
    channel: 'discord:chan-3',
  });
  rejectPlanProposal(b.id);
  assert.equal(findOpenQuestionPlan('discord:chan-3'), null);
});

test('findOpenQuestionPlan: scopes to the channel', () => {
  surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'an asking plan on another channel entirely',
    channel: 'discord:other',
  });
  assert.equal(findOpenQuestionPlan('discord:chan-4'), null);
  assert.ok(findOpenQuestionPlan('discord:other'));
});

test('findOpenQuestionPlan: returns the most recent open plan', async () => {
  surfaceAskingPlan({ plan: aPlan({ objective: 'Older asking plan objective here.' }), originatingRequest: 'older request needing input', channel: 'discord:chan-5' });
  await new Promise((r) => setTimeout(r, 5));
  const newer = surfaceAskingPlan({ plan: aPlan({ objective: 'Newer asking plan objective here.' }), originatingRequest: 'newer request needing input', channel: 'discord:chan-5' });
  const found = findOpenQuestionPlan('discord:chan-5');
  assert.equal(found!.id, newer.id);
});

// ─── listPlanProposals channel filter ──────────────────────────

test('listPlanProposals: filters by channel', () => {
  surfaceAskingPlan({ plan: aPlan(), originatingRequest: 'request on channel A here', channel: 'discord:A' });
  surfaceAskingPlan({ plan: aPlan(), originatingRequest: 'request on channel B here', channel: 'discord:B' });
  const a = listPlanProposals({ channel: 'discord:A' });
  assert.equal(a.length, 1);
  assert.equal(a[0].channel, 'discord:A');
});

// ─── flag gating ───────────────────────────────────────────────

test('planContinuityEnabled: reflects the env flag', () => {
  const prev = process.env.CLEMMY_PLAN_CONTINUITY;
  try {
    delete process.env.CLEMMY_PLAN_CONTINUITY;
    assert.equal(planContinuityEnabled(), true);
    process.env.CLEMMY_PLAN_CONTINUITY = 'off';
    assert.equal(planContinuityEnabled(), false);
    process.env.CLEMMY_PLAN_CONTINUITY = 'on';
    assert.equal(planContinuityEnabled(), true);
    process.env.CLEMMY_PLAN_CONTINUITY = 'ON';
    assert.equal(planContinuityEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PLAN_CONTINUITY;
    else process.env.CLEMMY_PLAN_CONTINUITY = prev;
  }
});

// ─── force-replan removal contract ─────────────────────────────
//
// routeOpenQuestionPlan used to pass `force: true` into
// runPlanFirstPreflight, which bypassed shouldUsePlanFirst and re-surfaced
// a formal plan card for ANY resumed/answered request. Since plan-first is
// now opt-in (commit 396ba57), `force` was removed so re-entry is gated by
// shouldUsePlanFirst(openPlan.originatingRequest) exactly like every other
// caller. These pure tests pin that contract: an ORDINARY originating
// request must NOT re-engage the planner (preflight returns surfaced:false →
// handled:false → caller runs the normal conversational turn), while an
// EXPLICIT-plan originating request still does.

test('continuity re-entry gate: an ordinary originating request does NOT force a plan', () => {
  const ordinary = surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'get me the deals we closed and put them in a sheet',
    channel: 'discord:gate-ordinary',
  });
  // This is the value continuity now feeds runPlanFirstPreflight (no force).
  assert.equal(
    shouldUsePlanFirst({ input: ordinary.originatingRequest, freshSession: false }),
    false,
    'ordinary resumed/answered request must fall through to the conversational orchestrator, not a plan card',
  );
});

test('continuity re-entry gate: an EXPLICIT-plan originating request still engages the planner', () => {
  const explicit = surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'Draft me a plan first to pull the closed deals into a sheet.',
    channel: 'discord:gate-explicit',
  });
  assert.equal(
    shouldUsePlanFirst({ input: explicit.originatingRequest, freshSession: false }),
    true,
    'an explicit-plan originating request must still re-surface the plan when resumed',
  );
});

// ─── classifier prompt builder (pure) ──────────────────────────

test('buildClassifierPrompt: includes objective, questions, and the message', () => {
  const proposal = surfaceAskingPlan({
    plan: aPlan(),
    originatingRequest: 'get me the deals we closed and put them somewhere',
    channel: 'discord:chan-p',
  });
  const prompt = buildClassifierPrompt(proposal, 'Last week, a new Google sheet, closed won only');
  assert.match(prompt, /Pull the deals we closed/);
  assert.match(prompt, /Which time window\?/);
  assert.match(prompt, /Which deal stage\?/);
  assert.match(prompt, /Last week, a new Google sheet, closed won only/);
});
