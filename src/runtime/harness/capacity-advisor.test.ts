import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityAdvice } from './capacity-advisor.js';

test('plan-limit shape (the $20-plan weekly case) gets the guided fix in plain words', () => {
  const a = capacityAdvice({ reason: 'Codex 429 usage_limit_reached', preparedNote: 'All 30 drafts are prepared and saved.' });
  assert.equal(a.shape, 'plan_limit');
  assert.match(a.copy, /All 30 drafts are prepared and saved\. Nothing was lost/);
  assert.match(a.copy, /may not reset for days/);
  assert.match(a.copy, /2-minute setup/);
  assert.match(a.copy, /resumes automatically when your limit resets/);
  assert.doesNotMatch(a.copy, /certif|judge|fail-closed|override/i, 'no developer-speak');
});

test('short-reset shape retries automatically with a human time', () => {
  const a = capacityAdvice({ reason: '429 Too Many Requests', retryAtIso: new Date(Date.now() + 5 * 60_000).toISOString() });
  assert.equal(a.shape, 'short_reset');
  assert.match(a.copy, /retry automatically at about/);
  const b = capacityAdvice({ reason: 'provider overloaded' });
  assert.match(b.copy, /retry automatically in a few minutes/);
});

test('total: garbage input classifies short_reset, never throws', () => {
  assert.equal(capacityAdvice({ reason: '' }).shape, 'short_reset');
  assert.equal(capacityAdvice({ reason: undefined as unknown as string }).shape, 'short_reset');
});
