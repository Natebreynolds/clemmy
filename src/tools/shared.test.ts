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
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, DEFAULT_TOOL_RESULT_MAX_CHARS, textResult, truncateToolText, updateEnvKey } from './shared.js';
import { getRuntimeEnv } from '../config.js';

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

test('updateEnvKey: a write takes effect LIVE even when the key was already in process.env', () => {
  // Regression: getRuntimeEnv() reads process.env BEFORE the .env file, so a
  // file-only write was invisible this session — the worker/judge role picker
  // (CLEMMY_MODEL_ROLES) appeared to "revert" because the running snapshot kept
  // the stale boot value. updateEnvKey must mirror into process.env so the next
  // getRuntimeEnv() returns the new value with no restart.
  const key = 'CLEMMY_TEST_UPDATE_ENV_KEY_LIVE';
  const prev = process.env[key];
  // Snapshot the real .env so the write (which appends a line) leaves no trace.
  const envPath = path.join(BASE_DIR, '.env');
  const hadFile = existsSync(envPath);
  const original = hadFile ? readFileSync(envPath, 'utf-8') : null;
  try {
    process.env[key] = 'stale-boot-value'; // simulate the value present at boot
    updateEnvKey(key, 'fresh-value');
    assert.equal(process.env[key], 'fresh-value', 'process.env mirrors the write');
    assert.equal(getRuntimeEnv(key), 'fresh-value', 'getRuntimeEnv returns the new value live (no restart)');
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    if (original !== null) writeFileSync(envPath, original, 'utf-8');
    else if (!hadFile && existsSync(envPath)) rmSync(envPath);
  }
});
