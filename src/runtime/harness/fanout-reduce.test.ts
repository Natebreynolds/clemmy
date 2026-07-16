/**
 * Run: npx tsx --test src/runtime/harness/fanout-reduce.test.ts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fanout-reduce-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession, getToolOutput, resetEventLog } = await import('./eventlog.js');
const {
  buildWorkerReturn,
  fanoutReduceDir,
  readShardArtifact,
  reduceShardMembers,
  resetFanoutWindow,
  runShardReduce,
  shardFingerprint,
  sweepFanoutReduce,
  zeroLlmDigest,
  _drainFanoutReduces,
  _setShardReducerForTests,
} = await import('./fanout-reduce.js');

let sessionSeq = 0;
function freshSession(): string {
  sessionSeq += 1;
  const id = `fanout-reduce-test-${Date.now().toString(36)}-${sessionSeq}`;
  try {
    createSession({ id, kind: 'chat' } as never);
  } catch { /* already exists */ }
  return id;
}

afterEach(() => {
  _setShardReducerForTests(null);
  delete process.env.CLEMMY_CHAT_FANOUT_DIGEST;
  delete process.env.CLEMMY_REDUCE_TIER;
  delete process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD;
  delete process.env.CLEMMY_REDUCE_SHARD_SIZE;
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** Mirror the live lanes: the durable worker_result event is appended BEFORE
 *  buildWorkerReturn runs (worker-tools.ts / orchestrator.ts both do this). */
function emitWorkerResult(sessionId: string, n: number, ok = true): void {
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: `item-${n}`, ok, packetKey: `pk${n}` } });
}

async function workerReturn(sessionId: string, n: number, text?: string, opts?: { emitEvent?: boolean }): Promise<string> {
  if (opts?.emitEvent !== false) emitWorkerResult(sessionId, n, !/^\s*ERROR:/i.test(text ?? ''));
  return buildWorkerReturn({
    sessionId,
    parentRunId: sessionId,
    item: `item-${n}`,
    text: text ?? `Result for item-${n}: score ${n * 7}, url https://example.com/${n}.`,
    callId: `call_w_test_${n}`,
  });
}

// ---------------------------------------------------------------------------
// Envelope / digest mode
// ---------------------------------------------------------------------------

test('the first 8 results return byte-identical verbatim; the 9th compresses to an envelope', async () => {
  const sess = freshSession();
  for (let n = 1; n <= 8; n++) {
    const text = `Result for item-${n}: score ${n * 7}.`;
    assert.equal(await workerReturn(sess, n, text), text, `result ${n} must be verbatim (even with worker_result events pre-appended)`);
  }
  const ninth = await workerReturn(sess, 9);
  assert.match(ninth, /✓ DONE: "item-9"/);
  assert.match(ninth, /digest: /);
  assert.match(ninth, /tool_output_query\("call_w_test_9"\)/);
  assert.match(ninth, /RULE: report only figures/);
});

test('the envelope coverage line comes from the window counters (never blended across sessions)', async () => {
  const sess = freshSession();
  for (let n = 1; n <= 8; n++) await workerReturn(sess, n);
  await workerReturn(sess, 9, 'ERROR: worker for "item-9" failed: boom');
  const tenth = await workerReturn(sess, 10);
  assert.match(tenth, /fanout so far: 9 ok \/ 1 FAILED of 10\./);
});

test('digest mode parks the FULL output retrievably under the callId', async () => {
  const sess = freshSession();
  for (let n = 1; n <= 9; n++) await workerReturn(sess, n);
  const big = `Detailed record\n${'row,'.repeat(500)}\nfinal figure: 42199`;
  emitWorkerResult(sess, 99);
  const envelope = await buildWorkerReturn({ sessionId: sess, parentRunId: sess, item: 'big-item', text: big, callId: 'call_w_big' });
  assert.match(envelope, /✓ DONE: "big-item"/);
  const parked = getToolOutput(sess, 'call_w_big');
  assert.ok(parked, 'full output is parked');
  assert.equal(parked!.output, big, 'parked payload is lossless');
});

test('ERROR results are NEVER digested or truncated — the full diagnostic survives at any length', async () => {
  const sess = freshSession();
  for (let n = 1; n <= 12; n++) await workerReturn(sess, n);
  const longErr = `ERROR: worker for "item-13" failed: upstream 404\n${'rejected record detail line\n'.repeat(200)}tail: the load-bearing last line`;
  assert.equal(await workerReturn(sess, 13, longErr), longErr);
});

test('kill-switch CLEMMY_CHAT_FANOUT_DIGEST=off keeps every result verbatim', async () => {
  process.env.CLEMMY_CHAT_FANOUT_DIGEST = 'off';
  const sess = freshSession();
  for (let n = 1; n <= 20; n++) {
    const text = `Result ${n}`;
    assert.equal(await workerReturn(sess, n, text), text);
  }
});

test('a missing sessionId passes through untouched', async () => {
  const text = 'Result with no session';
  assert.equal(
    await buildWorkerReturn({ sessionId: undefined, parentRunId: 'x', item: 'i', text, callId: 'c' }),
    text,
  );
});

// ---------------------------------------------------------------------------
// Window seeding: background resume vs interactive chat (review F1/F3)
// ---------------------------------------------------------------------------

test('BACKGROUND resume: a boundary-scoped session seeds from the ledger without double-counting', async () => {
  const sess = freshSession();
  appendEvent({ sessionId: sess, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { taskId: 't1' } });
  // 10 items completed pre-crash (durable events only; no in-process window).
  for (let n = 1; n <= 10; n++) emitWorkerResult(sess, n);
  // First post-resume completion: its event is appended (as the live lanes do)
  // and the fresh window seeds from the ledger — the seed already includes
  // item 11, so the count must be exactly 11, not 12.
  const out = await workerReturn(sess, 11);
  assert.match(out, /✓ DONE: "item-11"/, 'resume stays in digest mode');
  assert.match(out, /of 11\./, 'no double-count of the seeding item');
});

test('INTERACTIVE chat: no boundary ⇒ no whole-session seeding — a later small fan-out is verbatim again', async () => {
  const sess = freshSession();
  // A prior 12-item fan-out in this session (durable events remain)...
  for (let n = 1; n <= 12; n++) await workerReturn(sess, n);
  // ...window idles out / daemon restarts:
  resetFanoutWindow(sess);
  // A NEW small fan-out in the same chat session must get verbatim exemplars —
  // the prior batch's whole-session ledger must not leak into this one.
  const text = 'Fresh small fan-out result';
  assert.equal(await workerReturn(sess, 21, text), text);
});

test('an 8-item fan-out with pre-appended events stays fully verbatim (the live-lane ordering)', async () => {
  const sess = freshSession();
  appendEvent({ sessionId: sess, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { taskId: 't2' } });
  for (let n = 1; n <= 8; n++) {
    const text = `Result ${n}`;
    assert.equal(await workerReturn(sess, n, text), text, `result ${n} verbatim on the boundary-scoped lane too`);
  }
});

test('zeroLlmDigest preserves head figures and stays bounded', () => {
  const digest = zeroLlmDigest(`Line one has id ACC-9912 and total $14,205.\n${'padding '.repeat(400)}`);
  assert.match(digest, /ACC-9912/);
  assert.match(digest, /\$14,205/);
  assert.ok(digest.length <= 700);
});

// ---------------------------------------------------------------------------
// Shard reduction
// ---------------------------------------------------------------------------

test('the shard summary arrives in-band ON the envelope of the result that fills the shard', async () => {
  process.env.CLEMMY_REDUCE_SHARD_SIZE = '5';
  process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD = '1';
  _setShardReducerForTests(async (prompt) => {
    const keys = [...prompt.matchAll(/<<<ITEM key="([^"]+)" BEGIN/g)].map((m) => m[1]);
    return JSON.stringify({ perItem: keys.map((k) => ({ itemKey: k, gist: `gist of ${k}` })) });
  });
  const sess = freshSession();
  for (let n = 1; n <= 5; n++) await workerReturn(sess, n);
  const filling = await workerReturn(sess, 6); // fills the first shard (items 2-6)
  assert.match(filling, /=== FAN-OUT SHARD 0 \(5 results; machine-generated summary/);
  assert.match(filling, /gist of item-2/);
  const artifact = readShardArtifact(sess, 0);
  assert.ok(artifact, 'shard artifact durable on disk');
  assert.equal(artifact!.items.length, 5);
  assert.equal(artifact!.degraded, false);
  assert.ok(existsSync(path.join(fanoutReduceDir(sess), 'index.json')));
});

test('a slow reducer falls back to piggyback delivery on a later envelope', async () => {
  process.env.CLEMMY_REDUCE_SHARD_SIZE = '5';
  process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD = '1';
  let release: (() => void) | null = null;
  _setShardReducerForTests(() => new Promise((resolve) => {
    release = () => resolve(JSON.stringify({ perItem: [] }));
  }));
  const sess = freshSession();
  for (let n = 1; n <= 5; n++) await workerReturn(sess, n);
  // The filling call waits up to its in-band budget; the stub never resolves
  // within it in this test flow, so we release AFTER to simulate late arrival.
  const fillingPromise = workerReturn(sess, 6);
  // Give the in-band race a moment to arm, then release the reducer.
  await new Promise((r) => setTimeout(r, 50));
  release!();
  const filling = await fillingPromise;
  // Whether it made the in-band window or not, the NEXT envelope must carry it.
  const next = await workerReturn(sess, 7);
  const delivered = /=== FAN-OUT SHARD 0/.test(filling) || /=== FAN-OUT SHARD 0/.test(next);
  assert.ok(delivered, 'the shard block is delivered in-band or on the next envelope');
});

test('laundering guard: hallucinated keys are dropped, omitted members get deterministic gists', async () => {
  _setShardReducerForTests(async () => JSON.stringify({
    perItem: [
      { itemKey: 'alpha', gist: 'reduced alpha' },
      { itemKey: 'NOT-A-MEMBER', gist: 'fabricated item the reducer invented' },
      // 'beta' omitted entirely.
    ],
  }));
  const reduced = await reduceShardMembers([
    { itemKey: 'alpha', callId: 'c1', text: 'alpha result text with figure 111' },
    { itemKey: 'beta', callId: 'c2', text: 'beta result text with figure 222' },
  ]);
  assert.equal(reduced.items.length, 2, 'membership is exactly the input set');
  assert.deepEqual(reduced.items.map((i) => i.itemKey).sort(), ['alpha', 'beta']);
  assert.equal(reduced.items.find((i) => i.itemKey === 'alpha')!.gist, 'reduced alpha');
  assert.match(reduced.items.find((i) => i.itemKey === 'beta')!.gist, /figure 222/, 'omission falls back to the deterministic head');
  assert.ok(!reduced.items.some((i) => i.gist.includes('fabricated')), 'hallucinated entry is discarded');
});

test('a throwing reducer degrades to deterministic gists — never throws, never blocks', async () => {
  _setShardReducerForTests(async () => { throw new Error('reducer backend down'); });
  const reduced = await reduceShardMembers([
    { itemKey: 'a', callId: 'c', text: 'the only fact: 77 units' },
  ]);
  assert.equal(reduced.degraded, true);
  assert.match(reduced.items[0].gist, /77 units/);
});

test('CLEMMY_REDUCE_TIER=off skips the LLM entirely (deterministic gists, no seam calls)', async () => {
  process.env.CLEMMY_REDUCE_TIER = 'off';
  let called = 0;
  _setShardReducerForTests(async () => { called += 1; return '{}'; });
  const reduced = await reduceShardMembers([{ itemKey: 'a', callId: 'c', text: 'value 1' }]);
  assert.equal(called, 0);
  assert.equal(reduced.degraded, true);
});

// ---------------------------------------------------------------------------
// Fingerprint idempotency (the packetKey-trap regression)
// ---------------------------------------------------------------------------

test('shardFingerprint: order-insensitive, content-sensitive, injective on member boundaries', () => {
  const a = [{ itemKey: 'x', text: 'one' }, { itemKey: 'y', text: 'two' }];
  const b = [{ itemKey: 'y', text: 'two' }, { itemKey: 'x', text: 'one' }];
  assert.equal(shardFingerprint(a), shardFingerprint(b), 'member order does not matter');
  const changed = [{ itemKey: 'x', text: 'one CHANGED' }, { itemKey: 'y', text: 'two' }];
  assert.notEqual(shardFingerprint(a), shardFingerprint(changed), 'output change re-fingerprints');
  const boundary1 = [{ itemKey: 'ab', text: 'c' }];
  const boundary2 = [{ itemKey: 'a', text: 'bc' }];
  assert.notEqual(shardFingerprint(boundary1), shardFingerprint(boundary2), 'length-prefixing keeps identity injective');
});

test('runShardReduce is fingerprint-idempotent: an unchanged shard never re-reduces on resume', async () => {
  let calls = 0;
  _setShardReducerForTests(async () => { calls += 1; return JSON.stringify({ perItem: [{ itemKey: 'a', gist: 'g' }] }); });
  const run = `run-idempotent-${Date.now()}`;
  const members = [{ itemKey: 'a', callId: 'c', text: 'stable output' }];
  await runShardReduce(run, 0, members);
  assert.equal(calls, 1);
  await runShardReduce(run, 0, members); // resume: same content
  assert.equal(calls, 1, 'matching fingerprint skips the reducer');
  await runShardReduce(run, 0, [{ itemKey: 'a', callId: 'c', text: 'CHANGED output' }]);
  assert.equal(calls, 2, 'changed content re-reduces');
});

// ---------------------------------------------------------------------------
// Sweep + window reset
// ---------------------------------------------------------------------------

test('sweepFanoutReduce closes a full-but-unstarted shard left by a crash', async () => {
  process.env.CLEMMY_REDUCE_SHARD_SIZE = '5';
  process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD = '1';
  process.env.CLEMMY_REDUCE_TIER = 'off'; // live reduces disabled...
  const sess = freshSession();
  for (let n = 1; n <= 7; n++) await workerReturn(sess, n);
  delete process.env.CLEMMY_REDUCE_TIER; // ...then the delivery sweep runs with the tier on
  _setShardReducerForTests(async () => JSON.stringify({ perItem: [] }));
  await sweepFanoutReduce(sess);
  const artifact = readShardArtifact(sess, 0);
  assert.ok(artifact, 'the crash-left shard is reduced at delivery');
  assert.equal(artifact!.items.length, 5);
});

test('resetFanoutWindow starts a fresh window (run boundary semantics)', async () => {
  process.env.CLEMMY_REDUCE_FANOUT_THRESHOLD = '2';
  const sess = freshSession();
  await workerReturn(sess, 1);
  await workerReturn(sess, 2);
  assert.match(await workerReturn(sess, 3), /✓ DONE/, 'past threshold digests');
  resetFanoutWindow(sess);
  resetEventLog(); // and no durable results to seed from
  const fresh = await workerReturn(sess, 4, 'verbatim again', { emitEvent: false });
  assert.equal(fresh, 'verbatim again', 'a new run boundary restores verbatim exemplars');
});

// ---------------------------------------------------------------------------
// Invariance: the reduce tier never touches durable coverage
// ---------------------------------------------------------------------------

test('digest mode emits no events — worker_result streams are identical on vs off', async () => {
  const { listEvents } = await import('./eventlog.js');
  const on = freshSession();
  for (let n = 1; n <= 12; n++) await workerReturn(on, n);
  process.env.CLEMMY_CHAT_FANOUT_DIGEST = 'off';
  const off = freshSession();
  for (let n = 1; n <= 12; n++) await workerReturn(off, n);

  const onEvents = listEvents(on, { types: ['worker_result'] }).map((e) => ({ ...(e.data as object) }));
  const offEvents = listEvents(off, { types: ['worker_result'] }).map((e) => ({ ...(e.data as object) }));
  assert.deepEqual(onEvents, offEvents, 'the reduce tier adds/removes no worker_result events');
});

// ---------------------------------------------------------------------------
// Workflow-lane digest artifact round-trip
// ---------------------------------------------------------------------------

test('recordReduceDigest / readReduceDigest round-trip in the run workspace', async () => {
  const { recordReduceDigest, readReduceDigest, runWorkspaceDir, reduceDigestArtifactRelPath } = await import('../../execution/workflow-run-workspace.js');
  const digest = {
    stepId: 'enrich',
    fingerprint: 'abc123',
    shards: [{ shardIndex: 0, degraded: false, items: [{ itemKey: 'acme', gist: 'acme summary' }] }],
    digest: 'SHARD-REDUCED DIGEST of step "enrich"...',
    createdAt: new Date().toISOString(),
  };
  recordReduceDigest({ workflowName: 'wf-test', runId: 'run-1', digest });
  const loaded = readReduceDigest('wf-test', 'run-1', 'enrich');
  assert.deepEqual(loaded, digest);
  const abs = path.join(runWorkspaceDir('wf-test', 'run-1'), reduceDigestArtifactRelPath('enrich'));
  assert.ok(existsSync(abs), 'digest artifact is a durable workspace file');
  assert.doesNotThrow(() => JSON.parse(readFileSync(abs, 'utf-8')), 'artifact is JSON (workspace_artifact_query-readable)');
  assert.equal(readReduceDigest('wf-test', 'run-1', 'missing-step'), null);
});
