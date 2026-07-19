/**
 * Run: npx tsx --test src/runtime/mcp-prewarm.test.ts
 * Pre-warm retry/backoff regression: a single cold-connect attempt at boot
 * can be starved by the daemon's synchronous DB work; the retry loop re-attempts
 * (the gap clears the shim's early connect backoff) until servers connect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prewarmWithRetry } from './mcp-servers.js';

const noSleep = async () => { /* deterministic: don't actually wait */ };

test('stops at the FIRST attempt when everything connects', async () => {
  let calls = 0;
  const r = await prewarmWithRetry(async () => { calls += 1; return true; }, { attempts: 3, sleep: noSleep });
  assert.equal(calls, 1);
  assert.deepEqual(r, { attempts: 1, allConnected: true });
});

test('retries and SUCCEEDS once a later attempt connects', async () => {
  let calls = 0;
  const r = await prewarmWithRetry(async () => { calls += 1; return calls >= 2; }, { attempts: 3, sleep: noSleep });
  assert.equal(calls, 2, 'one retry');
  assert.deepEqual(r, { attempts: 2, allConnected: true });
});

test('exhausts all attempts when servers never connect', async () => {
  let calls = 0;
  const r = await prewarmWithRetry(async () => { calls += 1; return false; }, { attempts: 3, sleep: noSleep });
  assert.equal(calls, 3);
  assert.deepEqual(r, { attempts: 3, allConnected: false });
});

test('a throwing pre-warm is treated as not-connected and still bounded', async () => {
  let calls = 0;
  const r = await prewarmWithRetry(async () => { calls += 1; throw new Error('boom'); }, { attempts: 2, sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(r.allConnected, false);
});

test('sleeps BETWEEN attempts but not after the last (gap count = attempts-1)', async () => {
  const gaps: number[] = [];
  await prewarmWithRetry(async () => false, { attempts: 3, gapMs: 500, sleep: async (ms) => { gaps.push(ms); } });
  assert.deepEqual(gaps, [500, 500], 'two gaps for three failed attempts');
});

test('attempts is floored at 1 even if asked for 0', async () => {
  let calls = 0;
  const r = await prewarmWithRetry(async () => { calls += 1; return false; }, { attempts: 0, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
});
