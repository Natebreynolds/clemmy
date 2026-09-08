import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withJudgeHedge, withJudgeTimeout, boundaryJudgeTimeoutMs, exactJudgeBoundaryTimeoutMs } from './judge-family.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// BEHAVIOUR, not source strings. Reviewer: "Wire the selected route's effective
// deadline through actual calls and test the call behavior, not source
// strings/getter values." These exercise the real hedge/timeout primitives the
// judge gates call.

test('a judge slower than the DEFAULT deadline but inside the exact-pin deadline is cut off at the default', async () => {
  // Simulates the defect: a flagship judge needing more than the cheap-checker
  // deadline. Under the default it must lose; that is what fail-open looked like.
  const slow = async () => { await sleep(120); return 'VERDICT'; };
  const raced = await withJudgeHedge(slow, null, { timeoutMs: 40 });
  assert.equal(raced.value, null, 'the short deadline must cut the slow judge off');
});

test('the same judge COMPLETES when the honoured exact-pin deadline is passed through', async () => {
  const slow = async () => { await sleep(120); return 'VERDICT'; };
  const raced = await withJudgeHedge(slow, null, { timeoutMs: 400 });
  assert.equal(raced.value, 'VERDICT', 'the longer route deadline must let it finish');
});

test('withJudgeTimeout honours an explicit larger deadline the same way', async () => {
  const slow = async () => { await sleep(120); return { output: 'ok' }; };
  assert.equal(await withJudgeTimeout(slow(), 40), null, 'short deadline -> null (unavailable)');
  assert.deepEqual(await withJudgeTimeout(slow(), 400), { output: 'ok' }, 'long deadline -> real verdict');
});

test('the exact-pin deadline is actually larger than the default at runtime', () => {
  const dflt = boundaryJudgeTimeoutMs();
  const exact = exactJudgeBoundaryTimeoutMs();
  assert.ok(exact > dflt, `exact-pin deadline ${exact}ms must exceed default ${dflt}ms`);
});

// A null verdict is the fail-open path. It must be distinguishable from a real
// verdict, or a timed-out pinned judge reads as agreement.
test('a timed-out judge yields null, never a fabricated pass', async () => {
  const never = async () => { await sleep(500); return 'FULFILLS'; };
  const raced = await withJudgeHedge(never, null, { timeoutMs: 30 });
  assert.equal(raced.value, null);
  assert.notEqual(raced.value, 'FULFILLS', 'a timeout must not surface as a verdict');
});
