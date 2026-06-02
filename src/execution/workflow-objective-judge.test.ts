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
