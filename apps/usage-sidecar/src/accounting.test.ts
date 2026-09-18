import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalCacheAccounting } from './accounting.js';
import { modelsComparable, normalizeModel } from './models.js';

test('exclusive Claude sample matches canonical uncached work', () => {
  const u = canonicalCacheAccounting({
    cacheDialect: 'exclusive',
    inputTokens: 2,
    cachedInputTokens: 18759,
    cacheCreationInputTokens: 33906,
    outputTokens: 4,
    reasoningTokens: 0,
  });
  assert.equal(u.certified, true);
  assert.equal(u.uncachedWorkTokens, 6);
  assert.equal(u.promptTokens, 2 + 18759 + 33906);
  assert.equal(u.cachedReadTokens, 18759);
  assert.equal(u.cacheWriteTokens, 33906);
  assert.ok(Math.abs(u.hitRate - 18759 / u.promptTokens) < 1e-9);
});

test('inclusive Codex sample subtracts cached from work', () => {
  const u = canonicalCacheAccounting({
    cacheDialect: 'inclusive',
    inputTokens: 33323,
    cachedInputTokens: 32000,
    outputTokens: 88,
    totalTokens: 33411,
  });
  assert.equal(u.certified, true);
  assert.equal(u.promptTokens, 33323);
  assert.equal(u.uncachedWorkTokens, 33411 - 32000);
  assert.ok(u.hitRate > 0.9);
});

test('inclusive cached > input is invalid', () => {
  const u = canonicalCacheAccounting({
    cacheDialect: 'inclusive',
    inputTokens: 10,
    cachedInputTokens: 20,
    outputTokens: 1,
  });
  assert.equal(u.certified, false);
  assert.equal(u.invalid, true);
  assert.ok(u.uncachedWorkTokens > 0);
});

test('model family: date suffix matches, opus vs sonnet does not, luna vs terra does not', () => {
  assert.equal(normalizeModel('claude-sonnet-5-20250514'), 'claude-sonnet-5');
  assert.equal(modelsComparable('claude-sonnet-5', 'claude-sonnet-5-20250514'), true);
  assert.equal(modelsComparable('claude-opus-4-6', 'claude-sonnet-5'), false);
  assert.equal(modelsComparable('gpt-5.6-terra', 'gpt-5.6-luna'), false);
  assert.equal(modelsComparable('gpt-5.6-terra', 'gpt-5.6-terra'), true);
});
