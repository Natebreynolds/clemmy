import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkflowObjective,
  renderDeliverableForJudge,
  judgeWorkflowTarget,
} from './workflow-objective-judge.js';
import type { ObjectiveJudgeVerdict } from '../runtime/harness/objective-judge.js';

const wf = (over: Record<string, unknown> = {}) => ({
  name: 'weekly-seo-brief',
  description: 'Produce a competitive SEO brief for the given law firm prospect.',
  ...over,
}) as Parameters<typeof buildWorkflowObjective>[0];

const judgeReturning = (v: ObjectiveJudgeVerdict) => {
  let calls = 0;
  const fn = async () => { calls += 1; return v; };
  return { fn, calls: () => calls };
};

// ── buildWorkflowObjective ───────────────────────────────────────────────

test('buildWorkflowObjective: includes description, body, synthesis intent, and run inputs', () => {
  const obj = buildWorkflowObjective(
    wf({
      description_body: 'Cover keywords, backlinks, and a recommendation.',
      synthesis: { prompt: 'Assemble a single branded HTML brief.' },
    }),
    { url: 'https://acme-law.com', depth: 3 },
  );
  assert.match(obj, /competitive SEO brief/i);
  assert.match(obj, /keywords, backlinks/i);
  assert.match(obj, /branded HTML brief/i);
  assert.match(obj, /url=https:\/\/acme-law\.com/);
  assert.match(obj, /depth=3/);
});

test('buildWorkflowObjective: falls back to whenToUse when no body', () => {
  const obj = buildWorkflowObjective(wf({ whenToUse: 'before a sales call' }), {});
  assert.match(obj, /When to use: before a sales call/);
});

test('buildWorkflowObjective: empty when nothing declared and no inputs', () => {
  const obj = buildWorkflowObjective(
    { name: 'x', description: '' } as Parameters<typeof buildWorkflowObjective>[0],
    {},
  );
  assert.equal(obj, '');
});

// ── renderDeliverableForJudge ────────────────────────────────────────────

test('renderDeliverableForJudge: passes a string deliverable through', () => {
  assert.equal(renderDeliverableForJudge('the brief is at /tmp/brief.html'), 'the brief is at /tmp/brief.html');
});

test('renderDeliverableForJudge: serializes an object deliverable', () => {
  const out = renderDeliverableForJudge({ url: 'https://x.com', ok: true });
  assert.match(out, /"url": "https:\/\/x\.com"/);
});

test('renderDeliverableForJudge: appends a self-describing marker only when it truncates', () => {
  const big = 'x'.repeat(20000);
  const out = renderDeliverableForJudge(big);
  assert.match(out, /deliverable truncated to 12000 chars for judging — the run's full output is longer and complete/);
  assert.ok(out.startsWith('x'.repeat(12000)), 'keeps the first 12000 chars verbatim');
  // a sub-cap deliverable is untouched (no marker)
  assert.equal(renderDeliverableForJudge('short and complete'), 'short and complete');
});

test('renderDeliverableForJudge: uses the fallback body when finalOutput is empty', () => {
  assert.equal(renderDeliverableForJudge('', 'humanized summary'), 'humanized summary');
  assert.equal(renderDeliverableForJudge(null, 'humanized summary'), 'humanized summary');
});

// ── judgeWorkflowTarget — the gate ───────────────────────────────────────

test('judgeWorkflowTarget: reached when the judge says done', async () => {
  const j = judgeReturning({ done: true, reason: 'brief produced with a real URL' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: { url: 'https://acme-law.com' },
    finalOutput: 'Brief at https://acme-law.com/brief',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, true);
  assert.equal(j.calls(), 1);
});

test('judgeWorkflowTarget: NOT reached when the judge names a specific miss', async () => {
  const j = judgeReturning({ done: false, reason: 'no backlinks section in the brief' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: { url: 'https://acme-law.com' },
    finalOutput: 'partial brief, keywords only',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, false);
  assert.equal(v.judged, true);
  assert.match(v.gap, /backlinks/);
});

test('judgeWorkflowTarget: SKIPS a partial single-step re-run (never false-fails it)', async () => {
  const j = judgeReturning({ done: false, reason: 'should not be consulted' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: {},
    finalOutput: 'one step output',
    isPartialRun: true,
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, false);
  assert.equal(j.calls(), 0, 'judge must not be called for a partial run');
});

test('judgeWorkflowTarget: SKIPS when there is no deliverable to judge', async () => {
  const j = judgeReturning({ done: false, reason: 'should not be consulted' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: {},
    finalOutput: '',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, false);
  assert.equal(j.calls(), 0);
});

test('judgeWorkflowTarget: SKIPS when there is no target to judge against', async () => {
  const j = judgeReturning({ done: false, reason: 'should not be consulted' });
  const v = await judgeWorkflowTarget({
    workflow: { name: 'x', description: '' } as Parameters<typeof buildWorkflowObjective>[0],
    inputs: {},
    finalOutput: 'some output',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, false);
  assert.equal(j.calls(), 0);
});

test('judgeWorkflowTarget: FAILS OPEN when the judge throws (never breaks a good run)', async () => {
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: { url: 'https://acme-law.com' },
    finalOutput: 'a real deliverable',
    judgeFn: async () => { throw new Error('judge model unavailable'); },
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, false, 'fail-open path is recorded as not-judged for telemetry');
});

// ── truncation-artifact guard (the Outlook-brief false-flag) ──────────────

test('judgeWorkflowTarget: SUPPRESSES a truncation-shaped gap when the deliverable was windowed for length', async () => {
  // > JUDGE_RESPONSE_MAX_CHARS (8000) so the judge sees only a head+tail window.
  const bigBrief = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ i, subject: 'email subject '.repeat(8) })) });
  assert.ok(bigBrief.length > 8000, 'fixture must exceed the binding judge cap');
  const j = judgeReturning({ done: false, reason: 'The response is truncated, so there is no complete verifiable evidence of all items.' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: {},
    finalOutput: bigBrief,
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true, 'a self-inflicted truncation gap must not flip the run to needs-attention');
  assert.equal(v.judged, false);
  assert.match(v.gap, /truncation-shaped gap suppressed/);
});

test('judgeWorkflowTarget: a real (non-truncation) miss on a long deliverable still flags', async () => {
  const bigBrief = 'y'.repeat(9000);
  const j = judgeReturning({ done: false, reason: 'the brief is missing the required backlinks section entirely' });
  const v = await judgeWorkflowTarget({ workflow: wf(), inputs: {}, finalOutput: bigBrief, judgeFn: j.fn });
  assert.equal(v.reached, false, 'a genuine target miss must still surface even on a windowed deliverable');
  assert.match(v.gap, /backlinks/);
});

test('judgeWorkflowTarget: a truncation-shaped reason on a SHORT (un-windowed) deliverable is NOT suppressed', async () => {
  const j = judgeReturning({ done: false, reason: 'the output appears to be cut off / incomplete' });
  const v = await judgeWorkflowTarget({ workflow: wf(), inputs: {}, finalOutput: 'short deliverable', judgeFn: j.fn });
  assert.equal(v.reached, false, 'guard only applies when WE windowed the deliverable, not to genuinely short output');
});
