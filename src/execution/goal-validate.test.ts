/**
 * Run: npx tsx --test src/execution/goal-validate.test.ts
 *
 * Goal-contract validation engine (GOAL-CONTRACT-PLAN.md Phase 1):
 *   - deterministic criteria (local file paths) checked without the judge
 *   - fuzzy criteria batched into ONE judge call against the PARKED text
 *   - pass requires ALL criteria
 *   - judge failure → pass:false + judgeFailedOpen (a dead judge can never
 *     auto-satisfy a goal)
 *   - criteria-less goals fall back to judging the objective
 *   - toGoalEvidence maps verdicts to store evidence rows
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateGoal, extractLocalPathFromCriterion, toGoalEvidence } = await import('./goal-validate.js');

function passingJudge(calls: { objective: string; evidence: string }[] = []) {
  return async (objective: string, evidence: string) => {
    calls.push({ objective, evidence });
    return { done: true, reason: 'all visible deliverables verified' };
  };
}

function failingJudge() {
  return async () => ({ done: false, reason: 'no artifact evidence for the draft emails' });
}

function throwingJudge() {
  return async (): Promise<{ done: boolean; reason: string }> => {
    throw new Error('model unavailable');
  };
}

// ─── deterministic path extraction ──────────────────────────────────────────

test('extractLocalPathFromCriterion finds absolute and relative artifact paths', () => {
  assert.equal(
    extractLocalPathFromCriterion('A brief exists at /tmp/clemmy-gv/brief.md with sources listed'),
    '/tmp/clemmy-gv/brief.md',
  );
  assert.equal(
    extractLocalPathFromCriterion('Write the report to ./reports/q2-summary.pdf'),
    './reports/q2-summary.pdf',
  );
  assert.equal(extractLocalPathFromCriterion('Drafts exist for the top 3 accounts'), null);
  assert.equal(extractLocalPathFromCriterion('Publish to https://example.com/page.html'), null, 'URLs are not local paths');
});

// ─── deterministic checks ────────────────────────────────────────────────────

test('deterministic criterion passes/fails on file existence without calling the judge', async () => {
  const judgeCalls: { objective: string; evidence: string }[] = [];
  const result = await validateGoal(
    {
      objective: 'Produce the brief.',
      successCriteria: ['The brief exists at /tmp/clemmy-gv/present.md'],
      evidenceText: 'Done — wrote the brief.',
    },
    { judge: passingJudge(judgeCalls), fileExists: (p) => p === '/tmp/clemmy-gv/present.md' },
  );
  assert.equal(result.pass, true);
  assert.equal(result.perCriterion[0].method, 'deterministic');
  assert.equal(judgeCalls.length, 0, 'no fuzzy criteria → judge never called');

  const missing = await validateGoal(
    {
      objective: 'Produce the brief.',
      successCriteria: ['The brief exists at /tmp/clemmy-gv/absent.md'],
      evidenceText: 'Done — wrote the brief.',
    },
    { judge: passingJudge(), fileExists: () => false },
  );
  assert.equal(missing.pass, false);
  assert.match(missing.perCriterion[0].detail ?? '', /file missing/);
  assert.match(missing.advice ?? '', /unmet/);
});

// ─── judge path ──────────────────────────────────────────────────────────────

test('fuzzy criteria are batched into ONE judge call rendered as a parked checklist', async () => {
  const judgeCalls: { objective: string; evidence: string }[] = [];
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['Drafts exist for the top 3 accounts', 'Each draft names the booking link'],
      evidenceText: 'Created 3 drafts in Outlook; each includes the link.',
    },
    { judge: passingJudge(judgeCalls) },
  );
  assert.equal(result.pass, true);
  assert.equal(judgeCalls.length, 1, 'one judge call for all fuzzy criteria');
  assert.match(judgeCalls[0].objective, /ALL of these success criteria/);
  assert.match(judgeCalls[0].objective, /1\. Drafts exist/);
  assert.match(judgeCalls[0].objective, /2\. Each draft names/);
  assert.equal(result.perCriterion.length, 2);
  assert.ok(result.perCriterion.every((c) => c.method === 'judge'));
});

test('pass requires ALL criteria: one deterministic failure fails the goal even when the judge passes', async () => {
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['The brief exists at /tmp/clemmy-gv/absent.md', 'Drafts exist for the top 3 accounts'],
      evidenceText: 'Drafts created.',
    },
    { judge: passingJudge(), fileExists: () => false },
  );
  assert.equal(result.pass, false);
  const det = result.perCriterion.find((c) => c.method === 'deterministic')!;
  const judged = result.perCriterion.find((c) => c.method === 'judge')!;
  assert.equal(det.pass, false);
  assert.equal(judged.pass, true);
});

test('judge not-done verdict fails the fuzzy criteria with the judge reason', async () => {
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['Drafts exist for the top 3 accounts'],
      evidenceText: 'I will draft them next.',
    },
    { judge: failingJudge() },
  );
  assert.equal(result.pass, false);
  assert.match(result.perCriterion[0].detail ?? '', /no artifact evidence/);
});

// ─── fail-open (the direction that matters) ──────────────────────────────────

test('a throwing judge can NEVER auto-satisfy a goal: pass:false + judgeFailedOpen', async () => {
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['Drafts exist for the top 3 accounts'],
      evidenceText: 'Drafts created.',
    },
    { judge: throwingJudge() },
  );
  assert.equal(result.pass, false);
  assert.equal(result.judgeFailedOpen, true);
  assert.equal(result.perCriterion[0].method, 'skipped');
  assert.match(result.advice ?? '', /judge unavailable/);
});

test('criteria-less goal falls back to judging the objective itself (and fails open on judge error)', async () => {
  const ok = await validateGoal(
    { objective: 'Summarize the meeting.', successCriteria: [], evidenceText: 'Summary: …' },
    { judge: passingJudge() },
  );
  assert.equal(ok.pass, true);
  assert.equal(ok.perCriterion[0].criterion, 'Summarize the meeting.');

  const dead = await validateGoal(
    { objective: 'Summarize the meeting.', successCriteria: [], evidenceText: 'Summary: …' },
    { judge: throwingJudge() },
  );
  assert.equal(dead.pass, false);
  assert.equal(dead.judgeFailedOpen, true);
});

// ─── evidence mapping ────────────────────────────────────────────────────────

test('toGoalEvidence maps verdicts to store rows with attempt + timestamp', async () => {
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['Drafts exist for the top 3 accounts'],
      evidenceText: 'Drafts created.',
    },
    { judge: failingJudge() },
  );
  const at = new Date().toISOString();
  const rows = toGoalEvidence(result, 2, at);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[0].at, at);
  assert.equal(rows[0].pass, false);
  assert.equal(rows[0].method, 'judge');
});
