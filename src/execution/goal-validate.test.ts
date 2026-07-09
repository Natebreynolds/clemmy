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

const { validateGoal, extractLocalPathFromCriterion, toGoalEvidence, scoreGoalVerdicts } = await import('./goal-validate.js');

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

// ─── scorecard + structured directives (S3) ──────────────────────────────────

test('validateGoal attaches a numeric scorecard: successRatePercent + criteriaMet/Total', async () => {
  const result = await validateGoal(
    {
      objective: 'Outreach prep.',
      successCriteria: ['The brief exists at /tmp/clemmy-gv/present.md', 'The plan exists at /tmp/clemmy-gv/absent.md'],
      evidenceText: 'one of two artifacts written',
    },
    { judge: passingJudge(), fileExists: (p) => p.endsWith('present.md') },
  );
  assert.equal(result.pass, false);
  assert.equal(result.criteriaTotal, 2);
  assert.equal(result.criteriaMet, 1);
  assert.equal(result.successRatePercent, 50);
});

test('successRatePercent is 100 on a full pass', async () => {
  const result = await validateGoal(
    { objective: 'Done.', successCriteria: ['The brief exists at /tmp/clemmy-gv/present.md'], evidenceText: 'x' },
    { judge: passingJudge(), fileExists: () => true },
  );
  assert.equal(result.pass, true);
  assert.equal(result.successRatePercent, 100);
});

test('failedDirectives turn a deterministic file-miss into a concrete "create the missing artifact" fix', async () => {
  const result = await validateGoal(
    { objective: 'Done.', successCriteria: ['The brief exists at /tmp/clemmy-gv/absent.md'], evidenceText: 'x' },
    { judge: passingJudge(), fileExists: () => false },
  );
  assert.equal(result.failedDirectives?.length, 1);
  const d = result.failedDirectives![0];
  assert.equal(d.method, 'deterministic');
  assert.match(d.fix, /Create the missing artifact at \/tmp\/clemmy-gv\/absent\.md/);
});

test('a judge-unavailable failure yields a "re-validate, not a confirmed miss" directive', async () => {
  const result = await validateGoal(
    { objective: 'Outreach.', successCriteria: ['Drafts exist for the top 3 accounts'], evidenceText: 'x' },
    { judge: throwingJudge() },
  );
  assert.equal(result.failedDirectives?.[0].method, 'skipped');
  assert.match(result.failedDirectives![0].fix, /Re-validate/);
});

test('scoreGoalVerdicts is pure and rounds the percentage', () => {
  const s = scoreGoalVerdicts([
    { criterion: 'a', pass: true, method: 'judge' },
    { criterion: 'b', pass: false, method: 'judge' },
    { criterion: 'c', pass: false, method: 'judge' },
  ]);
  assert.equal(s.criteriaMet, 1);
  assert.equal(s.criteriaTotal, 3);
  assert.equal(s.successRatePercent, 33); // round(33.33)
  assert.equal(s.failedDirectives.length, 2);
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

// ─── Per-criterion judge path (real granularity, one call) ───

test('validateGoal: injected judgeCriteria gives INDIVIDUAL verdicts — partial credit is real', async () => {
  const { validateGoal } = await import('./goal-validate.js');
  const seen: { criteria?: string[] } = {};
  const result = await validateGoal(
    { objective: 'do three things', successCriteria: ['thing one done', 'thing two done', 'thing three done'], evidenceText: 'one and three are done with URLs' },
    {
      judgeCriteria: async (_obj, criteria) => {
        seen.criteria = criteria;
        return [
          { pass: true, note: 'url present' },
          { pass: false, note: 'no evidence for two' },
          { pass: true, note: 'url present' },
        ];
      },
      fileExists: () => false,
    },
  );
  assert.equal(seen.criteria?.length, 3, 'ONE call carried all fuzzy criteria');
  assert.equal(result.pass, false);
  assert.equal(result.criteriaMet, 2);
  assert.equal(result.criteriaTotal, 3);
  assert.equal(result.successRatePercent, 67);
  assert.equal(result.failedDirectives?.length, 1);
  assert.match(result.failedDirectives?.[0]?.fix ?? '', /thing two/);
});

test('validateGoal: judgeCriteria infra failure → all fuzzy skipped + judgeFailedOpen (fail-strict preserved)', async () => {
  const { validateGoal } = await import('./goal-validate.js');
  const result = await validateGoal(
    { objective: 'do two things', successCriteria: ['a done', 'b done'], evidenceText: 'evidence' },
    { judgeCriteria: async () => { throw new Error('judge timed out'); }, fileExists: () => false },
  );
  assert.equal(result.pass, false);
  assert.equal(result.judgeFailedOpen, true);
  assert.ok(result.perCriterion.every((c) => c.method === 'skipped'));
});

test('validateGoal: only legacy judge injected → whole-checklist path still used (fakes never bypassed)', async () => {
  const { validateGoal } = await import('./goal-validate.js');
  let checklistSeen = '';
  const result = await validateGoal(
    { objective: 'obj', successCriteria: ['c1', 'c2'], evidenceText: 'evidence' },
    { judge: async (objective) => { checklistSeen = objective; return { done: true, reason: 'all met' }; }, fileExists: () => false },
  );
  assert.match(checklistSeen, /1\. c1/);
  assert.equal(result.pass, true);
  assert.equal(result.perCriterion.length, 2);
});
