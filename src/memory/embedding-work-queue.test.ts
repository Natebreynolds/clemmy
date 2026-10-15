import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Execute the actual worker message handler and scheduler. Only its port,
// extractor, clocks and event-loop queue are synthetic: no model or provider
// module is loaded, and no alternate scheduling algorithm lives in the test.
async function queueFixture() {
  const replies: any[] = [], calls: string[] = [], immediates: Array<() => void> = [];
  let listener!: (message: any) => void;
  let wall = 10_000, monotonic = 100;
  let extract = async (_text: string): Promise<{ data: number[] }> => ({ data: [1, 0] });
  const port = { on(event: string, callback: typeof listener) { assert.equal(event, 'message'); listener = callback; }, postMessage(message: any) { replies.push(message); } };
  const source = readFileSync(new URL('./embedding.worker.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, require(name: string) {
    if (name === 'node:worker_threads') return { parentPort: port };
    if (name === './embeddings.js') return { createLocalExtractor: async () => ({ runtime: 'fake', extractor: async ([text]: string[]) => { calls.push(text!); return extract(text!); } }) };
    throw new Error(`Unexpected worker dependency: ${name}`);
  }, Error, performance: { now: () => monotonic }, Date: { now: () => wall }, setImmediate(callback: () => void) { immediates.push(callback); } });
  await flush(); assert.equal(replies[0]?.kind, 'ready');
  return { replies, calls, exports,
    send(message: any) { listener(message); },
    async step() { const next = immediates.shift(); assert.ok(next, 'actual scheduler must yield an event-loop turn'); next(); await flush(); },
    async flush() { await flush(); },
    setExtractor(next: typeof extract) { extract = next; },
    advance(ms: number) { wall += ms; monotonic += ms; },
    jumpWall(ms: number) { wall += ms; },
    get wall() { return wall; },
    response(id: number) { return replies.filter(reply => reply.id === id); },
  };
}

test('foreground work runs between background batch items and batches preserve input order', async () => {
  const f = await queueFixture(); const first = deferred<{ data: number[] }>();
  f.setExtractor(async text => text === 'background-a' ? first.promise : ({ data: [text === 'foreground' ? 7 : 2] }));
  f.send({ id: 1, texts: ['background-a', 'background-b'], priority: 'background' }); await f.step();
  f.send({ id: 2, texts: ['foreground'] }); first.resolve({ data: [1] }); await f.flush();
  await f.step(); await f.step();
  assert.deepEqual(f.calls, ['background-a', 'foreground', 'background-b']);
  assert.deepEqual(f.replies.filter(reply => reply.kind === 'result').map(reply => reply.id), [2, 1]);
  assert.deepEqual(Array.from(f.response(1)[0].vectors as Float32Array[], vector => Array.from(vector)), [[1], [2]]);
});

test('expired queued work is skipped without inference or fabricated empty success', async () => {
  const f = await queueFixture(); const first = deferred<{ data: number[] }>();
  f.setExtractor(async () => first.promise);
  f.send({ id: 1, texts: ['already-running'] }); await f.step();
  f.send({ id: 2, texts: ['expired-unshared'], deadlineAtMs: f.wall + 5 }); f.advance(10);
  first.resolve({ data: [1] }); await f.flush(); await f.step();
  assert.deepEqual(f.calls, ['already-running']);
  assert.deepEqual(f.response(2).map(reply => [reply.kind, reply.reason]), [['skipped', 'expired']]);
});

test('expiry discards a queued batch remainder and never returns partial vectors', async () => {
  const f = await queueFixture(); const first = deferred<{ data: number[] }>(); f.setExtractor(async () => first.promise);
  f.send({ id: 1, texts: ['first', 'never-started'], priority: 'background', deadlineAtMs: f.wall + 5 }); await f.step();
  f.advance(10); first.resolve({ data: [1] }); await f.flush(); await f.step();
  assert.deepEqual(f.calls, ['first']); assert.deepEqual(f.response(1).map(reply => [reply.kind, reply.reason]), [['skipped', 'expired']]);
});

test('a complete native item already running may finish after its deadline', async () => {
  const f = await queueFixture(); const current = deferred<{ data: number[] }>(); f.setExtractor(async () => current.promise);
  f.send({ id: 1, texts: ['running'], deadlineAtMs: f.wall + 5 }); await f.step(); f.advance(10);
  current.resolve({ data: [1] }); await f.flush(); assert.equal(f.response(1)[0]?.kind, 'result');
});

test('a later shared caller can promote and extend queued work; earlier budgets cannot tighten it', async () => {
  const f = await queueFixture(); const current = deferred<{ data: number[] }>();
  f.setExtractor(async text => text === 'running' ? current.promise : ({ data: [2] }));
  f.send({ id: 1, texts: ['running'] }); await f.step();
  f.send({ id: 2, texts: ['shared'], priority: 'background', deadlineAtMs: f.wall + 5 });
  f.send({ id: 3, texts: ['other-background'], priority: 'background' });
  f.send({ kind: 'update', id: 2, priority: 'foreground', deadlineAtMs: f.wall + 100 });
  f.send({ kind: 'update', id: 2, priority: 'background', deadlineAtMs: f.wall + 1 });
  f.advance(10); current.resolve({ data: [1] }); await f.flush(); await f.step(); await f.step();
  assert.deepEqual(f.calls, ['running', 'shared', 'other-background']); assert.equal(f.response(2)[0]?.kind, 'result');
});

test('an unbounded shared subscriber removes the queued deadline', async () => {
  const f = await queueFixture(); const current = deferred<{ data: number[] }>();
  f.setExtractor(async text => text === 'running' ? current.promise : ({ data: [2] }));
  f.send({ id: 1, texts: ['running'] }); await f.step();
  f.send({ id: 2, texts: ['shared'], deadlineAtMs: f.wall + 5 });
  f.send({ kind: 'update', id: 2, deadlineAtMs: undefined }); f.advance(1_000_000);
  current.resolve({ data: [1] }); await f.flush(); await f.step(); assert.equal(f.response(2)[0]?.kind, 'result');
});

test('cancel retires only the exact request, including a running batch, without partial results', async () => {
  const f = await queueFixture(); const current = deferred<{ data: number[] }>();
  f.setExtractor(async text => text === 'running' ? current.promise : ({ data: [2] }));
  f.send({ id: 1, texts: ['running', 'cancelled-remainder'] }); await f.step();
  f.send({ id: 2, texts: ['queued-cancel'] }); f.send({ id: 3, texts: ['survivor'] });
  f.send({ kind: 'cancel', id: 2 }); f.send({ kind: 'cancel', id: 1 }); f.send({ kind: 'cancel', id: 1 });
  current.resolve({ data: [1] }); await f.flush(); await f.step();
  assert.deepEqual(f.calls, ['running', 'survivor']);
  for (const id of [1, 2]) assert.deepEqual(f.response(id).map(reply => [reply.kind, reply.reason]), [['skipped', 'cancelled']]);
  assert.equal(f.response(3)[0]?.kind, 'result');
});

test('queue limits cover request count, text count and character count before extraction', async () => {
  const f = await queueFixture(); const current = deferred<{ data: number[] }>(); f.setExtractor(async () => current.promise);
  f.send({ id: 1, texts: ['running'] }); await f.step();
  for (let id = 2; id <= 64; id++) f.send({ id, texts: ['queued'] });
  f.send({ id: 65, texts: ['overflow'] }); assert.equal(f.response(65)[0]?.reason, 'queue_full');
  f.send({ kind: 'cancel', id: 2 }); f.send({ id: 66, texts: ['freed-slot'] }); assert.equal(f.response(66).length, 0);
  const texts = await queueFixture(); texts.send({ id: 1, texts: Array(4097).fill('x') }); assert.equal(texts.response(1)[0]?.reason, 'queue_full');
  const chars = await queueFixture(); chars.send({ id: 1, texts: ['x'.repeat(4_000_001)] }); assert.equal(chars.response(1)[0]?.reason, 'queue_full');
  assert.deepEqual(texts.calls, []); assert.deepEqual(chars.calls, []); assert.deepEqual(f.calls, ['running']);
});

test('queued deadlines use monotonic time after admission despite wall-clock corrections', async () => {
  for (const [wallJump, advance, expected] of [[1_000_000, 1, 'result'], [-1_000_000, 101, 'skipped']] as const) {
    const f = await queueFixture(); f.send({ id: 1, texts: ['clock-control'], deadlineAtMs: f.wall + 100 });
    f.jumpWall(wallJump); f.advance(advance); await f.step(); assert.equal(f.response(1)[0]?.kind, expected);
  }
});

test('real extractor errors propagate, malformed packets are safe, and subsequent work still completes', async () => {
  const f = await queueFixture(); f.setExtractor(async text => { if (text === 'bad') throw new Error('controlled inference failure'); return { data: [1] }; });
  f.send({ id: 1, texts: ['bad', 'unused'] }); await f.step();
  assert.deepEqual(f.response(1).map(reply => [reply.kind, reply.error]), [['error', 'controlled inference failure']]);
  f.send({ id: 2, texts: [null] }); assert.equal(f.response(2)[0]?.error, 'invalid embedding request');
  f.send({ id: 3, texts: ['good'] }); await f.step(); assert.equal(f.response(3)[0]?.kind, 'result');
});
