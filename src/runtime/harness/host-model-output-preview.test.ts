import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostModelOutputPreview } from './host-model-output-preview.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from './tool-output-format.js';

test('unchanged short results do not require recall-storage identity', async () => {
  let identityReads = 0;
  const text = 'Settled result, unchanged.';
  assert.equal(await hostModelOutputPreview(text, {
    identity: () => { identityReads += 1; throw new Error('no recall storage required'); },
    callId: 'short', toolName: 'read_file', arguments: {},
  }), text);
  assert.equal(identityReads, 0);
});

test('a recallable large result still requires exact source identity before storage', async () => {
  let identityReads = 0;
  const refusal = new Error('exact source identity unavailable');
  await assert.rejects(() => hostModelOutputPreview('x'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 1), {
    identity: () => { identityReads += 1; throw refusal; },
    callId: 'large', toolName: 'tool_search', arguments: {},
  }), (error) => error === refusal);
  assert.equal(identityReads, 1);
});
