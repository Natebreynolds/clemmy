/**
 * Run: npx tsx --test src/runtime/harness/active-task-context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-active-task-context-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb } = await import('../../memory/db.js');
const { createFocus, patchFocusWorkstate } = await import('../../memory/focus.js');
const { createGoalContract, touchGoalActivity } = await import('../../agents/plan-proposals.js');
const {
  ACTIVE_TASK_CONTEXT_PROMPT_MAX_CHARS,
  resolveActiveTaskContext,
  renderActiveTaskContextForInstructions,
  renderResolvedActiveTaskContext,
} = await import('./active-task-context.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('same-session projection composes FocusWorkstate with the exact active goal deterministically', () => {
  resetMemoryDb();
  const sessionId = 'active-task-same-session';
  const focus = createFocus({
    resourceRef: `session:${sessionId}`,
    title: 'Launch readiness',
    summary: 'Choosing the final release shape.',
    resourceKind: 'thread',
    relatedSessionId: sessionId,
    // This intentionally does not match the real goal. related_goal_id is not
    // authoritative; exact session ownership below is.
    relatedGoalId: 'goal-untrusted-pointer',
  });
  patchFocusWorkstate(focus.id, {
    mode: 'execute',
    objective: 'Ship the release after the smoke suite is green.',
    addConstraints: ['Preserve the rollback path.'],
    addDecisions: ['Use the canary rollout.'],
    openLoops: ['Run the provider parity smoke.'],
    upsertActions: [{
      id: 'smoke',
      label: 'Run provider parity smoke',
      status: 'running',
      kind: 'local',
      ref: 'session:smoke-run',
    }],
  });
  const goal = createGoalContract({
    sessionId,
    objective: 'Ship Clementine after provider parity is proven.',
    successCriteria: ['Codex passes.', 'Claude passes.', 'BYO passes.'],
    nextActions: ['Run all provider smokes.'],
  });
  assert.ok(goal);
  touchGoalActivity(goal!.id, 'Daemon booted on the local test profile.');

  const first = resolveActiveTaskContext({ sessionId, input: 'Keep going on the smoke run.' });
  const second = resolveActiveTaskContext({ sessionId, input: 'Keep going on the smoke run.' });

  assert.deepEqual(second, first);
  assert.match(first.digest, /^[a-f0-9]{24}$/);
  assert.equal(first.focus?.disposition, 'active');
  assert.equal(first.focus?.workstate?.mode, 'execute');
  assert.deepEqual(first.focus?.workstate?.decisions, ['Use the canary rollout.']);
  assert.equal(first.goal?.id, goal!.id);
  assert.equal(first.goal?.sessionId, sessionId);
  assert.deepEqual(first.goal?.successCriteria, ['Codex passes.', 'Claude passes.', 'BYO passes.']);

  const rendered = renderResolvedActiveTaskContext(first);
  assert.equal(rendered, renderActiveTaskContextForInstructions({ sessionId, input: 'Keep going on the smoke run.' }));
  assert.equal((rendered.match(/\[ACTIVE GOAL/g) ?? []).length, 1);
  assert.match(rendered, /Shared workstate v1 · execute/);
  assert.match(rendered, /Ship Clementine after provider parity is proven/);
  assert.match(rendered, /Daemon booted on the local test profile/);
});

test('cross-session work keeps only a non-authoritative focus pointer and never imports another session goal', () => {
  resetMemoryDb();
  const priorSessionId = 'active-task-prior-session';
  const focus = createFocus({
    resourceRef: 'sheet:release-fixture',
    title: 'Release fixture',
    summary: 'Old execution completed with receipt secret-old-receipt.',
    resourceKind: 'sheet',
    relatedSessionId: priorSessionId,
  });
  patchFocusWorkstate(focus.id, {
    addDecisions: ['secret-old-decision'],
    upsertActions: [{ id: 'old-write', label: 'Old write', status: 'done', ref: 'secret-old-action' }],
  });
  createGoalContract({
    sessionId: priorSessionId,
    objective: 'secret-old-goal-objective',
    successCriteria: ['secret-old-criterion'],
  });

  const fresh = resolveActiveTaskContext({
    sessionId: 'active-task-new-session',
    input: 'Perform a fresh write to the release sheet right now.',
  });
  const rendered = renderResolvedActiveTaskContext(fresh);

  assert.equal(fresh.focus?.disposition, 'historical');
  assert.equal(fresh.goal, null);
  assert.match(rendered, /RELATED HISTORICAL focus/);
  assert.doesNotMatch(rendered, /secret-old-receipt|secret-old-decision|secret-old-action|secret-old-goal/);

  const review = resolveActiveTaskContext({
    sessionId: 'active-task-new-session',
    input: 'Review the status of the previous release sheet run.',
  });
  assert.equal(review.focus?.disposition, 'historical');
  assert.match(renderResolvedActiveTaskContext(review), /RELATED HISTORICAL focus|sheet:release-fixture/);
  assert.doesNotMatch(renderResolvedActiveTaskContext(review), /secret-old-receipt|secret-old-decision|secret-old-action/);
  assert.equal(review.goal, null, 'reviewing focus history must not import the prior session goal');
});

test('brand-new Tyler correction suppresses same-session focus and disabled-workflow goal', () => {
  resetMemoryDb();
  const sessionId = 'active-task-tyler-regression';
  const focus = createFocus({
    resourceRef: 'workflow:salesforce-to-airtable-prospect-enrichment',
    title: 'Finish Tyler prospect batch',
    summary: 'Resume Tyler and the disabled salesforce-to-airtable-prospect-enrichment workflow.',
    resourceKind: 'workflow',
    relatedSessionId: sessionId,
  });
  patchFocusWorkstate(focus.id, {
    objective: 'Finish Tyler prospects using the disabled workflow.',
    openLoops: ['Resume the old Tyler batch.'],
  });
  createGoalContract({
    sessionId,
    objective: 'Run salesforce-to-airtable-prospect-enrichment for Tyler.',
    successCriteria: ['Old workflow finishes.'],
  });

  const fresh = resolveActiveTaskContext({
    sessionId,
    input: 'Brand-new prospects from scratch. Run the whole workflow.',
  });
  const freshRendered = renderResolvedActiveTaskContext(fresh);
  assert.equal(fresh.focus, null);
  assert.equal(fresh.goal, null);
  assert.doesNotMatch(freshRendered, /Tyler|salesforce-to-airtable|disabled workflow/i);

  const resumed = resolveActiveTaskContext({ sessionId, input: 'Resume the workflow.' });
  const resumedRendered = renderResolvedActiveTaskContext(resumed);
  assert.equal(resumed.focus?.disposition, 'active');
  assert.match(resumedRendered, /Tyler/);
  assert.match(resumedRendered, /salesforce-to-airtable-prospect-enrichment/);
});

test('stale focus remains a non-authoritative pointer and withholds its workstate', async () => {
  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1';
  try {
    const focus = createFocus({
      resourceRef: 'session:stale-active-task',
      title: 'Stale release plan',
      summary: 'Needs an explicit continuity check.',
      relatedSessionId: 'stale-active-task',
    });
    patchFocusWorkstate(focus.id, { addDecisions: ['Do not expose this as current.'] });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    const context = resolveActiveTaskContext({
      sessionId: 'stale-active-task',
      input: 'hello',
    });
    const rendered = renderResolvedActiveTaskContext(context);
    assert.equal(context.focus?.disposition, 'stale');
    assert.equal(context.focus?.workstate, null);
    assert.match(rendered, /No confirmed active focus/);
    assert.doesNotMatch(rendered, /Do not expose this as current/);
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

test('goal projection obeys the contract kill-switch and hard prompt bounds', () => {
  resetMemoryDb();
  const sessionId = 'active-task-bounds';
  const focus = createFocus({
    resourceRef: `session:${sessionId}`,
    title: 'Bounded active task',
    summary: 's'.repeat(2_000),
    relatedSessionId: sessionId,
  });
  patchFocusWorkstate(focus.id, {
    objective: 'o'.repeat(500),
    upsertCandidates: Array.from({ length: 48 }, (_, index) => ({
      id: `candidate-${index}`,
      label: `Candidate ${index} ${'x'.repeat(190)}`,
      status: 'considering' as const,
      note: `note ${'n'.repeat(250)}`,
    })),
    addConstraints: Array.from({ length: 24 }, (_, index) => `Constraint ${index} ${'c'.repeat(290)}`),
    addDecisions: Array.from({ length: 24 }, (_, index) => `Decision ${index} ${'d'.repeat(290)}`),
    openLoops: Array.from({ length: 24 }, (_, index) => `Loop ${index} ${'l'.repeat(290)}`),
  });
  const goal = createGoalContract({
    sessionId,
    objective: `Bounded goal ${'g'.repeat(4_000)}`,
    successCriteria: Array.from({ length: 8 }, (_, index) => `Criterion ${index} ${'q'.repeat(1_000)}`),
  });
  assert.ok(goal);
  for (let index = 0; index < 10; index += 1) {
    touchGoalActivity(goal!.id, `Ledger ${index} ${'p'.repeat(1_000)}`);
  }

  const rendered = renderActiveTaskContextForInstructions({ sessionId, input: 'continue' });
  assert.ok(
    rendered.length <= ACTIVE_TASK_CONTEXT_PROMPT_MAX_CHARS,
    `active task prompt was ${rendered.length} chars`,
  );
  assert.match(rendered, /\[ACTIVE GOAL/);
  assert.match(rendered, /active goal context truncated/);

  process.env.CLEMMY_GOAL_CONTRACT = 'off';
  try {
    const disabled = resolveActiveTaskContext({ sessionId, input: 'continue' });
    assert.equal(disabled.goal, null);
    assert.doesNotMatch(renderResolvedActiveTaskContext(disabled), /\[ACTIVE GOAL/);
  } finally {
    delete process.env.CLEMMY_GOAL_CONTRACT;
  }
});
