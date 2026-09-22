/**
 * Run: npx tsx --test src/execution/revision-judge.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRevisionApplied, parseRevisionModelVerdict, REVISION_JUDGE_TIMEOUT_MS } from './revision-judge.js';

const note = "Add one sentence to Dana's email offering a free local SEO audit. Keep Marcus and Priya exactly as they are.";

function evaluateWith(choice: string, confidence: number) {
  return (async (input: { state: unknown; channel?: string; timeoutMs?: number }) => {
    assert.equal(input.channel, 'jev-revision');
    assert.equal(input.timeoutMs, REVISION_JUDGE_TIMEOUT_MS);
    const state = input.state as { changeRequest: string; previousDraft?: string; revisedDraft: string };
    assert.equal(state.changeRequest, note);
    assert.match(state.revisedDraft, /Dana/);
    return { ok: true, answers: { verdict: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence } } };
  }) as never;
}

test('a confident "applied" and a confident "not_applied" are verdicts; the rest is unverified', async () => {
  const applied = await judgeRevisionApplied({ note, previous: 'old', revised: [{ name: 'Dana', body: 'Hi Dana … free local SEO audit …' }], evaluate: evaluateWith('applied', 0.9) });
  assert.equal(applied.verdict, 'applied');
  assert.equal(applied.judge, 'jev');
  const missed = await judgeRevisionApplied({ note, revised: [{ name: 'Dana', body: 'Hi Dana …' }], evaluate: evaluateWith('not_applied', 0.8) });
  assert.equal(missed.verdict, 'not_applied');
  assert.match(missed.reason, /does not apply the change request/);
  const noModel = async () => ({ verdict: 'unverified' as const, reason: 'no judge model bound' });
  const unsure = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: evaluateWith('applied', 0.3), modelJudge: noModel });
  assert.equal(unsure.verdict, 'unverified');
  assert.match(unsure.reason, /not sure; the judge model could not decide either/);
  const down = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: (async () => ({ ok: false, reason: 'no key' })) as never, modelJudge: noModel });
  assert.equal(down.verdict, 'unverified');
  assert.equal(down.judge, 'none');
  const threw = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: (async () => { throw new Error('boom'); }) as never, modelJudge: noModel });
  assert.equal(threw.verdict, 'unverified');
});

test('when Jev is absent, slow or unsure, the judge model backstops with a one-line verdict', async () => {
  // Live 1790098950580: Jev took 2.9 s against a 2.5 s cap on three revised
  // posts, so a correct revision was reported as "could not confirm".
  const applied = await judgeRevisionApplied({
    note, revised: [{ name: 'Dana', body: '… free local SEO audit …' }],
    evaluate: (async () => ({ ok: false, reason: 'slow' })) as never,
    modelJudge: async () => ({ verdict: 'applied', reason: 'the audit sentence is present and nothing else changed', modelId: 'judge-x' }),
  });
  assert.equal(applied.verdict, 'applied');
  assert.equal(applied.judge, 'model');
  assert.equal(applied.modelId, 'judge-x');
  const missed = await judgeRevisionApplied({
    note, revised: [{ name: 'Dana' }],
    evaluate: evaluateWith('applied', 0.2),
    modelJudge: async () => ({ verdict: 'not_applied', reason: 'the sentence is missing', modelId: 'judge-x' }),
  });
  assert.equal(missed.verdict, 'not_applied');
  assert.deepEqual(parseRevisionModelVerdict('APPLIED: the sentence is there'), { verdict: 'applied', reason: 'the sentence is there' });
  assert.deepEqual(parseRevisionModelVerdict('NOT_APPLIED: subject changed'), { verdict: 'not_applied', reason: 'subject changed' });
  assert.equal(parseRevisionModelVerdict('maybe').verdict, 'unverified');
  assert.equal(parseRevisionModelVerdict('').reason, 'judge timeout');
});
