import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { retainedHistoryPrefixProjection } from './retained-history-prefix.js';

const user = (content: string) => ({ role: 'user', content }) as AgentInputItem;

test('historical projection preserves exact current request and growing execution frames', () => {
  const prior = [user('Prior planning constraints'), user('Retained preparation')];
  const replacement = [user('Prior planning constraints'), user('Recall preparation by its retained call ID')];
  const project = retainedHistoryPrefixProjection(prior, replacement);
  const current = user('Execute exact plan digest; newer constraint');
  const call = { type: 'function_call', name: 'read_file', callId: 'current', arguments: '{"path":"current"}' } as AgentInputItem;
  const result = { type: 'function_call_result', callId: 'current', output: { type: 'text', text: 'Current evidence' } } as AgentInputItem;
  const input = [...prior, current, call, result];
  const before = JSON.stringify(input);
  assert.deepEqual(project(input), [...replacement, current, call, result]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(project([...input, user('New steering')]).slice(replacement.length), [...input.slice(prior.length), user('New steering')]);
  assert.deepEqual(project(JSON.parse(before)), [...replacement, current, call, result]);
});

test('changed, missing or previously projected prefixes are not rewritten', () => {
  const original = [user('Original prefix')];
  const project = retainedHistoryPrefixProjection(original, [user('Projected prefix')]);
  for (const input of [[], [user('Changed prefix')], [user('Projected prefix')]]) {
    assert.equal(project(input), input);
  }
});
