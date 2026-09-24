import assert from 'node:assert/strict';
import test from 'node:test';
import { getJudgeMetricsSnapshot, resetJudgeMetricsForTests } from './judge-family.js';
import { parseWorkflowMutationReview, reviewWorkflowMutation, type WorkflowMutationReviewInput } from './workflow-mutation-review.js';

const input: WorkflowMutationReviewInput = {
  sessionId: 'fixture-write-review', instructions: 'Preserve the header. Update only the data row.',
  tool: 'record_update', schema: { type: 'object', properties: { destination: { type: 'string' }, values: { type: 'array' } } }, args: { destination: 'row-2', values: ['today', 2] },
  observations: { complete: true, summary: 'row-1 contains the header; row-2 is the current data row.' },
};
const choice = (confidence: number, verdict = 'compatible') => async () => ({
  ok: true as const, model: 'recording-classifier', usage: { input_tokens: 1, output_tokens: 1 },
  answers: { compatibility: { type: 'choice' as const, choice: verdict, confidence,
    probabilities: { compatible: verdict === 'compatible' ? confidence : 0.01, conflict: verdict === 'conflict' ? confidence : 0.01 } } },
});

test('complete confident compatibility avoids a second model call but remains only a review', async () => {
  resetJudgeMetricsForTests();
  const result = await reviewWorkflowMutation(input, { evaluate: choice(0.95),
    judge: async () => { throw new Error('unexpected full review'); } });
  assert.equal(result.verdict, 'compatible');
  assert.match(result.proposalDigest, /^[a-f0-9]{64}$/);
  assert.equal('consent' in result, false);
  assert.equal(getJudgeMetricsSnapshot().lanes.find(lane => lane.lane === 'mutation_constraints')?.fastDecisions, 1);
});

for (const variant of ['low-confidence', 'conflict', 'missing-key', 'incomplete-observations'] as const) {
  test(`${variant} cannot independently authorize a proposed write`, async () => {
    let called = 0;
    const result = await reviewWorkflowMutation({ ...input,
      observations: { ...input.observations, complete: variant !== 'incomplete-observations' } }, {
      evaluate: variant === 'missing-key' ? async () => ({ ok: false, reason: 'missing_key' })
        : choice(variant === 'low-confidence' ? 0.28 : 0.96, variant === 'conflict' ? 'conflict' : 'compatible'),
      judge: async (_system, prompt, parse) => {
        called++;
        const proposal = JSON.parse(prompt);
        return { value: parse({ verdict: 'conflict', reason: 'The proposed destination overwrites a protected row.',
          proposalDigest: proposal.proposalDigest }), failure: null };
      },
    });
    assert.equal(called, 1);
    assert.equal(result.verdict, 'conflict');
  });
}

test('review outage and malformed or mismatched verdicts remain uncertain', async () => {
  const result = await reviewWorkflowMutation(input, { evaluate: async () => { throw new Error('offline'); },
    judge: async () => ({ value: null, failure: 'error' }) });
  assert.equal(result.verdict, 'uncertain');
  assert.equal(parseWorkflowMutationReview({ verdict: 'compatible', reason: 'ok', proposalDigest: 'foreign' }, result.proposalDigest), null);
  assert.equal(parseWorkflowMutationReview('DONE', result.proposalDigest), null);
});

test('large writes and retained observations stay inspectable, without a partial fast-path decision', async () => {
  const args = { destination: 'row-2', values: Array.from({ length: 500 }, (_, id) => ({ id, value: 'x'.repeat(80) })) };
  let called = 0;
  const result = await reviewWorkflowMutation({ ...input, args, observations: { complete: true,
    summary: 'Original records retained at prior-records.', evidence: {
      refKind: 'authenticated records', refs: () => ['prior-records'],
      resolve: ref => ref === 'prior-records' ? { text: 'original protected rows' } : undefined,
    } } }, {
    evaluate: async () => { throw new Error('large or retained content cannot take fast path'); },
    judge: async (_system, prompt, parse, _isPass, _lane, opts) => {
      called++;
      assert.ok(prompt.length < 1000);
      const pointer = JSON.parse(prompt);
      const exact = opts?.evidence?.resolve(pointer.proposalRef)?.value as { args: unknown };
      assert.deepEqual(exact.args, args);
      assert.equal(opts?.evidence?.resolve('prior-records')?.text, 'original protected rows');
      return { value: parse({ verdict: 'compatible', reason: 'Only the permitted data row changes.', proposalDigest: pointer.proposalDigest }), failure: null };
    },
  });
  assert.equal(called, 1);
  assert.equal(result.verdict, 'compatible');
});

test('large observations do not hide the write or saved constraints behind a lookup', async () => {
  const summary = 'Authenticated result index. '.repeat(600);
  const result = await reviewWorkflowMutation({ ...input, observations: { complete: true, summary } }, {
    evaluate: async () => { throw new Error('large proposal must be reviewed'); },
    judge: async (_system, prompt, parse, _isPass, _lane, opts) => {
      const packet = JSON.parse(prompt);
      assert.equal(packet.instructions, input.instructions);
      assert.equal(packet.tool, input.tool);
      assert.deepEqual(packet.args, input.args);
      assert.equal(packet.observations, summary);
      const full = opts?.evidence?.resolve(packet.proposalRef)?.value as { observations: string };
      assert.equal(full.observations, summary);
      return { value: parse({ verdict: 'compatible', reason: 'Checked the complete proposal.',
        proposalDigest: packet.proposalDigest }), failure: null };
    },
  });
  assert.equal(result.verdict, 'compatible', result.reason);
});
