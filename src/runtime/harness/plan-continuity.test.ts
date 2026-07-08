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

const { surfaceAskingPlan, surfacePlan, listPlanProposals, supersedePlanProposal, rejectPlanProposal, surfaceWorkflowPendingInputs, setWorkflowPendingInputValues, getPlanProposal } =
  await import('../../agents/plan-proposals.js');
const { findOpenQuestionPlan, findOpenWorkflowPendingInputs, buildClassifierPrompt, buildWorkflowInputClassifierPrompt, applySelfContainedGuard, parsePlanContinuityVerdict, parseWorkflowInputVerdict } =
  await import('./plan-continuity.js');

const SHEET_ID = '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz';
function proposalFor(objective: string, questions: string[] = []) {
  return {
    plan: { objective, needsUserInput: questions, steps: [] },
    originatingRequest: objective,
  } as unknown as Parameters<typeof applySelfContainedGuard>[0];
}

test('applySelfContainedGuard: downgrades answers→new_topic when message names a FOREIGN resource', () => {
  const plan = proposalFor('Pull the closed deals into a sheet', ['Which deals?']);
  const msg = `actually send to https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const out = applySelfContainedGuard(plan, msg, { kind: 'answers', answers: msg, confidence: 0.3, reason: 'x' });
  assert.equal(out.kind, 'new_topic');
});

test('applySelfContainedGuard: keeps a plain answer (no resource) as answers', () => {
  const plan = proposalFor('Pull the closed deals into a sheet', ['Which deals?']);
  const out = applySelfContainedGuard(plan, 'the ones from last quarter', { kind: 'answers', answers: '…', confidence: 0.5, reason: 'x' });
  assert.equal(out.kind, 'answers');
});

test('applySelfContainedGuard: keeps answers when the named resource IS the plan target', () => {
  const plan = proposalFor(`Update sheet ${SHEET_ID} with the new rows`, ['Confirm the sheet?']);
  const msg = `yes, https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const out = applySelfContainedGuard(plan, msg, { kind: 'answers', answers: msg, confidence: 0.3, reason: 'x' });
  assert.equal(out.kind, 'answers');
});

test('applySelfContainedGuard: never escalates a non-answers classification', () => {
  const plan = proposalFor('Pull the closed deals', []);
  const out = applySelfContainedGuard(plan, 'cancel that', { kind: 'abandon', confidence: 0.9, reason: 'x' });
  assert.equal(out.kind, 'abandon');
});
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

// ─── workflow ask-then-resume (data-flow, no model) ────────────

test('surfaceWorkflowPendingInputs → findOpenWorkflowPendingInputs round-trips by session', () => {
  surfaceWorkflowPendingInputs({
    workflowName: 'audit-brief',
    requiredInputs: ['url'],
    providedInputs: {},
    sessionId: 'sess-wf-1',
    originatingRequest: 'Run the "audit-brief" workflow',
  });
  const found = findOpenWorkflowPendingInputs('sess-wf-1');
  assert.ok(found, 'pending workflow-inputs record found by session');
  assert.equal(found!.kind, 'workflow_pending_inputs');
  assert.equal(found!.workflowName, 'audit-brief');
  assert.deepEqual(found!.requiredInputs, ['url']);
  // scoped to the session
  assert.equal(findOpenWorkflowPendingInputs('sess-other'), null);
});

test('findOpenQuestionPlan ignores workflow_pending_inputs records (they route by session)', () => {
  surfaceWorkflowPendingInputs({
    workflowName: 'audit-brief',
    requiredInputs: ['url'],
    sessionId: 'sess-wf-2',
    channel: 'desktop',
  });
  // Even on a matching channel, the channel path must not claim it.
  assert.equal(findOpenQuestionPlan('desktop'), null);
});

test('setWorkflowPendingInputValues accumulates supplied values', () => {
  const p = surfaceWorkflowPendingInputs({
    workflowName: 'multi-wf',
    requiredInputs: ['url', 'topic'],
    providedInputs: { url: 'https://x.com' },
    sessionId: 'sess-wf-3',
  });
  setWorkflowPendingInputValues(p.id, { topic: 'SEO' });
  const updated = getPlanProposal(p.id);
  assert.deepEqual(updated!.pendingInputValues, { url: 'https://x.com', topic: 'SEO' });
});

test('buildWorkflowInputClassifierPrompt includes workflow name, missing inputs, and the message', () => {
  const prompt = buildWorkflowInputClassifierPrompt('audit-brief', ['url', 'topic'], 'use https://revill.co.uk');
  assert.match(prompt, /audit-brief/);
  assert.match(prompt, /url, topic/);
  assert.match(prompt, /use https:\/\/revill\.co\.uk/);
});

// ─── plain-text verdict parsers (pure — the schema→marker conversion) ──────
//
// These pin the deterministic parse that replaced the zod outputTypes: the
// marker carries the kind, the tail carries answers/reason, no-marker → null
// (caller applies its existing fail-SAFE "treat as answer" default), and
// lengths are clamped in code so a verbose-but-valid verdict is never rejected.

test('parsePlanContinuityVerdict: ANSWERS carries the extracted answers in the tail', () => {
  const out = parsePlanContinuityVerdict('ANSWERS: last quarter, closed-won only, a new sheet');
  assert.deepEqual(out, { kind: 'answers', answers: 'last quarter, closed-won only, a new sheet', reason: 'last quarter, closed-won only, a new sheet' });
});

test('parsePlanContinuityVerdict: RESUME with an empty tail yields no answers (caller falls back to raw input)', () => {
  const out = parsePlanContinuityVerdict('RESUME:');
  assert.equal(out!.kind, 'resume');
  assert.equal(out!.answers, undefined);
});

test('parsePlanContinuityVerdict: NEW_TOPIC / "NEW TOPIC" / ABANDON, case-insensitive', () => {
  assert.equal(parsePlanContinuityVerdict('new_topic: unrelated ask')!.kind, 'new_topic');
  assert.equal(parsePlanContinuityVerdict('NEW TOPIC: unrelated ask')!.kind, 'new_topic');
  assert.equal(parsePlanContinuityVerdict('Abandon: never mind')!.kind, 'abandon');
});

test('parsePlanContinuityVerdict: no marker → null (caller keeps its fail-safe default)', () => {
  assert.equal(parsePlanContinuityVerdict('sure, sounds good'), null);
  assert.equal(parsePlanContinuityVerdict(''), null);
});

test('parseWorkflowInputVerdict: ANSWERS pulls each named value, tolerating a colon in the value', () => {
  const raw = 'ANSWERS\nurl: https://revill.co.uk\ntopic: SEO';
  const out = parseWorkflowInputVerdict(raw, ['url', 'topic']);
  assert.deepEqual(out, { kind: 'answers', values: { url: 'https://revill.co.uk', topic: 'SEO' } });
});

test('parseWorkflowInputVerdict: only allowed names are captured; unknown lines ignored', () => {
  const out = parseWorkflowInputVerdict('ANSWERS\nurl: https://x.com\nnonsense: foo', ['url']);
  assert.deepEqual(out!.values, { url: 'https://x.com' });
});

test('parseWorkflowInputVerdict: NEW_TOPIC / ABANDON carry no values; no marker → null', () => {
  assert.deepEqual(parseWorkflowInputVerdict('NEW_TOPIC: different ask', ['url']), { kind: 'new_topic', values: {} });
  assert.deepEqual(parseWorkflowInputVerdict('ABANDON: forget it', ['url']), { kind: 'abandon', values: {} });
  assert.equal(parseWorkflowInputVerdict('https://x.com', ['url']), null);
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
