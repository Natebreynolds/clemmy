/** Runtime regressions for retrying an interrupted, unaccepted model frame.
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-precontent-stall-retry.red.test.ts
 * Replaces source-spelling assertions with real retry and paid-request checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { hostRunRunner } from './host-turn-runner.js';
import { ModelStreamStalledError } from './model-stall-policy.js';

for (const bufferedRequestInFlight of [false, true]) {
  test(`pre-content stall only retries without an active buffered request: ${bufferedRequestInFlight}`, async () => {
    const prior = process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
    process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '1';
    let requests = 0;
    const runner = new EventEmitter();
    const model = {
      async getResponse(): Promise<never> { throw new Error('streaming model expected'); },
      async *getStreamedResponse() {
        requests += 1;
        if (requests === 1) throw new ModelStreamStalledError(1, true, bufferedRequestInFlight);
        yield { type: 'response_done', response: {
          id: 'recovered', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Recovered.' }] }],
        } };
      },
    };
    try {
      const outcome = await hostRunRunner(runner as never, { model, tools: [] } as never, [], { maxTurns: 2 });
      assert.equal(requests, bufferedRequestInFlight ? 1 : 2);
      if (bufferedRequestInFlight) {
        assert.equal(outcome.terminal?.reason, 'model_stalled');
        assert.equal(outcome.terminal?.status, 'blocked');
      } else {
        assert.equal(outcome.finalOutput, 'Recovered.');
        assert.notEqual(outcome.terminal?.status, 'blocked');
      }
    } finally {
      if (prior === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
      else process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = prior;
    }
  });
}
