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
import {
  BASE_DIR,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  invalidArgumentsTextResult,
  isHarnessRefusalText,
  isInvalidArgumentsTextResult,
  resolveMemoryTarget,
  textResult,
  truncateToolText,
  updateEnvKey,
} from './shared.js';
import { getRuntimeEnv } from '../config.js';
import { VAULT_DIR } from '../memory/vault.js';

test('resolveMemoryTarget accepts absolute evidence paths inside the vault', () => {
  const evidencePath = path.join(VAULT_DIR, '04-Meetings', 'recording.md');
  assert.equal(resolveMemoryTarget(evidencePath), evidencePath);
});

test('resolveMemoryTarget does not let absolute paths escape the vault', () => {
  assert.notEqual(resolveMemoryTarget('/tmp/not-memory.md'), '/tmp/not-memory.md');
});

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

test('invalidArgumentsTextResult carries MCP failure shape plus non-forgeable process identity', () => {
  const marked = invalidArgumentsTextResult('repair these arguments');
  assert.equal(marked.isError, true);
  assert.equal(isInvalidArgumentsTextResult(marked), true);
  assert.equal(isInvalidArgumentsTextResult(structuredClone(marked)), false,
    'serialization-compatible copies cannot forge the in-process marker');
  assert.equal(isInvalidArgumentsTextResult(textResult('ordinary tool failure', { isError: true })), false,
    'arbitrary MCP isError results are not reclassified as invalid arguments');
  assert.equal(isInvalidArgumentsTextResult({
    isError: true,
    content: [{ type: 'text', text: 'repair these arguments' }],
  }), false, 'a provider/model lookalike is not nominal host truth');
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

test('the transport tells the truth: a harness refusal is an error, a real result is not', () => {
  // Live 2026-08-09: a pre-dispatch schema refusal naming the exact missing
  // field arrived as an ordinary successful result, and the identical payload
  // was sent straight back. `claude-agent-sdk.ts` already reads
  // `ok: !result?.isError`; nothing had ever set it, so all four transport
  // truths collapsed into "succeeded".
  assert.equal(isHarnessRefusalText(
    '[provider-dispatch:not-started:invalid-args] ⚠️ Operation validation failed before dispatch',
  ), true, 'a pre-dispatch refusal must read as an error');
  assert.equal(isHarnessRefusalText(
    'Tool call refused by harness: tool-call guardrail block: [harness fan-out check — REFUSED]',
  ), true, 'a guardrail block must read as an error');
  assert.equal(isHarnessRefusalText(
    '{"error":"requires_readmission","outside":["desktop_status"]}',
  ), true, 'a typed dispatcher refusal must read as an error');

  // The direction that matters MORE: a genuine result must never be marked
  // failed, however its DATA happens to read. Detection keys on the harness's
  // own structural markers, not on words appearing anywhere in a payload.
  assert.equal(isHarnessRefusalText(
    '{"data":{"status":"refused","note":"the customer refused delivery"}}',
  ), false, 'a real payload containing "refused" must stay a success');
  assert.equal(isHarnessRefusalText(
    '{"successful":true,"data":{"revision":1}}',
  ), false);
  // Invented tool, randomized name: nothing here can pass by knowing a slug.
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
  assert.equal(isHarnessRefusalText(`{"data":{"tool":"ZZ${nonce}_LIST_THINGS","ok":true}}`), false);
  assert.equal(isHarnessRefusalText(
    `[provider-dispatch:not-started:ambiguous-account] ZZ${nonce} needs a choice`,
  ), true);
});
