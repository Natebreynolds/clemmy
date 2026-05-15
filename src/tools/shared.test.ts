/**
 * Run: npx tsx --test src/tools/shared.test.ts
 *
 * Smoke tests for the textResult truncation cap. Most of shared.ts is
 * legacy disk plumbing that other tests cover by side effect; this
 * file just nails down the result-cap contract so a runaway tool can't
 * stuff the model's context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, textResult, truncateToolText } from './shared.js';

test('truncateToolText: passes through short strings unchanged', () => {
  const s = 'hello world';
  assert.equal(truncateToolText(s), s);
});

test('truncateToolText: caps at the default max and appends a truncation marker', () => {
  const big = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 5000);
  const out = truncateToolText(big);
  assert.ok(out.length < big.length, 'output should be shorter than input');
  assert.match(out, /truncated/i);
  assert.match(out, /5,000.*chars omitted/);
  assert.match(out, /re-call with a narrower scope/);
});

test('truncateToolText: respects an explicit maxChars', () => {
  const big = 'a'.repeat(2000);
  const out = truncateToolText(big, 500);
  assert.ok(out.startsWith('a'.repeat(500)));
  assert.match(out, /truncated/);
});

test('textResult: wraps the capped text in MCP content envelope', () => {
  // Use input clearly larger than head+marker so the cap saves bytes.
  const big = 'q'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 5000);
  const result = textResult(big);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.length < big.length);
  assert.match(result.content[0].text, /truncated/);
});

test('textResult: respects explicit maxChars option for callers that need raw fidelity', () => {
  const big = 'p'.repeat(2000);
  const result = textResult(big, { maxChars: 50000 });
  // No truncation when explicit cap exceeds input length.
  assert.equal(result.content[0].text, big);
});

test('truncateToolText: marker mentions the total length', () => {
  const big = 'z'.repeat(20000);
  const out = truncateToolText(big, 1000);
  // Total length is 20,000; output mentions both.
  assert.match(out, /20,000/);
});
