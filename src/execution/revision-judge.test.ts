/**
 * Run: npx tsx --test src/execution/revision-judge.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRevisionApplied, REVISION_JUDGE_TIMEOUT_MS } from './revision-judge.js';

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
  const unsure = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: evaluateWith('applied', 0.3) });
  assert.equal(unsure.verdict, 'unverified');
  const down = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: (async () => ({ ok: false, reason: 'no key' })) as never });
  assert.equal(down.verdict, 'unverified');
  assert.equal(down.judge, 'none');
  const threw = await judgeRevisionApplied({ note, revised: [{ name: 'Dana' }], evaluate: (async () => { throw new Error('boom'); }) as never });
  assert.equal(threw.verdict, 'unverified');
});
