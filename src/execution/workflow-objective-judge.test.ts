import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkflowObjective,
  deriveLegacyWorkflowRunGoal,
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
    { url: 'https://acme-law.example', depth: 3 },
  );
  assert.match(obj, /competitive SEO brief/i);
  assert.match(obj, /keywords, backlinks/i);
  assert.match(obj, /branded HTML brief/i);
  assert.match(obj, /url=https:\/\/acme-law\.example/);
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

test('deriveLegacyWorkflowRunGoal: derives provisional goal from intent, inputs, and output contracts', () => {
  const goal = deriveLegacyWorkflowRunGoal(
    wf({
      description_body: 'Cover rankings and citation gaps.',
      synthesis: { prompt: 'Assemble a branded audit page.' },
      steps: [
        {
          id: 'deploy',
          output: {
            type: 'object',
            required_keys: ['url', 'path', 'items'],
            verify: { url_present: ['url'], path_exists: ['path'] },
            non_empty: ['items'],
            min_items: { items: 1 },
          },
        },
      ],
    }),
    { url: 'https://acme-law.example' },
  );
  assert.ok(goal);
  assert.equal(goal!.source, 'legacy');
  assert.equal(goal!.maxAttempts, 1);
  assert.match(goal!.objective, /competitive SEO brief/i);
  assert.match(goal!.objective, /url=https:\/\/acme-law\.example/);
  assert.ok(goal!.successCriteria.some((c) => /synthesis intent/i.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /required keys: url, path, items/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /http\(s\) URL at "url"/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /existing local file path at "path"/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /at least 1 item/.test(c)));
});

test('deriveLegacyWorkflowRunGoal: infers provisional criteria from deliverable prompts when contracts are missing', () => {
  const goal = deriveLegacyWorkflowRunGoal(
    wf({
      description_body: 'Create an audit artifact.',
      steps: [
        {
          id: 'build_and_deploy',
          prompt: 'Build the audit HTML file, deploy it to Netlify, and return the live URL and saved preview path.',
        },
        {
          id: 'pull_rows',
          prompt: 'Generate the list of overdue Salesforce meetings and output the rows.',
        },
      ],
    }),
    {},
  );
  assert.ok(goal);
  assert.ok(goal!.successCriteria.some((c) => /required keys: url, path/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /http\(s\) URL at "url"/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /existing local file path at "path"/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /required keys: items/.test(c)));
  assert.ok(goal!.successCriteria.some((c) => /at least 1 item/.test(c)));
});

test('deriveLegacyWorkflowRunGoal: null when a legacy workflow has no objective source', () => {
  const goal = deriveLegacyWorkflowRunGoal(
    { name: 'x', description: '', steps: [] } as Parameters<typeof deriveLegacyWorkflowRunGoal>[0],
    {},
  );
  assert.equal(goal, null);
});

// ── renderDeliverableForJudge ────────────────────────────────────────────

test('renderDeliverableForJudge: passes a string deliverable through', () => {
  assert.equal(renderDeliverableForJudge('the brief is at /tmp/brief.html'), 'the brief is at /tmp/brief.html');
});

test('renderDeliverableForJudge: serializes an object deliverable', () => {
  const out = renderDeliverableForJudge({ url: 'https://site.example', ok: true });
  assert.match(out, /"url": "https:\/\/site\.example"/);
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
    inputs: { url: 'https://acme-law.example' },
    finalOutput: 'Brief at https://acme-law.example/brief',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, true);
  assert.equal(j.calls(), 1);
});

test('judgeWorkflowTarget: includes provisional legacy success criteria in the judged objective', async () => {
  let seenObjective = '';
  const goal = {
    objective: 'Produce a live audit page.',
    successCriteria: ['A real URL is present.', 'The local HTML file exists.'],
  };
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: {},
    finalOutput: 'Audit at https://example.com',
    goal,
    judgeFn: async (objective) => {
      seenObjective = objective;
      return { done: true, reason: 'ok' };
    },
  });
  assert.equal(v.reached, true);
  assert.match(seenObjective, /Produce a live audit page/);
  assert.match(seenObjective, /Success criteria inferred from the workflow contract and deliverable hints/);
  assert.match(seenObjective, /A real URL is present/);
});

test('judgeWorkflowTarget: accepts structured send evidence without asking the model judge', async () => {
  const j = judgeReturning({ done: false, reason: 'no verifiable evidence the email was sent at 8am' });
  const v = await judgeWorkflowTarget({
    workflow: wf({ description: 'Emails Alex a daily standup brief at 8am.' }),
    inputs: {},
    finalOutput: '## main\n{"sent":true,"to":"alex.chen@corp.example","subject":"Daily Standup","logId":"log_123"}',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, true);
  assert.equal(v.judged, false);
  assert.equal(j.calls(), 0, 'deterministic dispatch proof should bypass a wording-only target miss');
  assert.match(v.gap, /structured dispatch evidence/);
});

test('judgeWorkflowTarget: does not accept negative send evidence', async () => {
  const j = judgeReturning({ done: false, reason: 'the email was not sent' });
  const v = await judgeWorkflowTarget({
    workflow: wf({ description: 'Emails Alex a daily standup brief at 8am.' }),
    inputs: {},
    finalOutput: '{"sent":false,"to":"alex.chen@corp.example","logId":"log_123"}',
    judgeFn: j.fn,
  });
  assert.equal(v.reached, false);
  assert.equal(v.judged, true);
  assert.equal(j.calls(), 1);
});

test('judgeWorkflowTarget: NOT reached when the judge names a specific miss', async () => {
  const j = judgeReturning({ done: false, reason: 'no backlinks section in the brief' });
  const v = await judgeWorkflowTarget({
    workflow: wf(),
    inputs: { url: 'https://acme-law.example' },
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
    inputs: { url: 'https://acme-law.example' },
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
