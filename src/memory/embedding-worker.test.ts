/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/embedding-worker.test.ts
 *
 * The embedding worker's liveness contract, against a stand-in worker so no
 * model has to load: the worker holds its process open exactly while a caller
 * is waiting on it, and not after. Only a separate process can observe either
 * way of getting this wrong:
 *   - an idle worker that keeps the process alive forever (the regression:
 *     read-path test files whose tests all passed never exited, and the
 *     runner's per-file timeout cancelled them), or
 *   - a worker unref'd outright, so the process exits under an embed() that is
 *     still waiting for its answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the embedding worker holds its process open while a caller waits, and lets it exit once idle', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-embedding-worker-'));
  try {
    // Answers late, so the reply is still in flight while the caller has
    // nothing else keeping its event loop alive.
    const standIn = path.join(dir, 'stand-in.worker.mjs');
    writeFileSync(standIn, [
      "import { parentPort } from 'node:worker_threads';",
      "parentPort.on('message', ({ id, texts }) => {",
      "  setTimeout(() => parentPort.postMessage({ kind: 'result', id, vectors: texts.map(() => new Float32Array([1, 0])) }), 250);",
      '});',
      "parentPort.postMessage({ kind: 'ready', runtime: 'stand-in' });",
    ].join('\n'), 'utf8');

    const script = [
      `const host = await import(${JSON.stringify(new URL('./embedding-worker.ts', import.meta.url).href)});`,
      `host._setEmbeddingWorkerEntryForTest(new URL(${JSON.stringify(pathToFileURL(standIn).href)}));`,
      'const worker = await host.startEmbeddingWorker();',
      "if (!worker) throw new Error('the stand-in worker did not start');",
      "const vectors = await worker.embed(['one']);",
      'console.log(`embedded ${vectors.length} via ${worker.runtime}`);',
    ].join('\n');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLEMENTINE_HOME: path.join(dir, 'home'),
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEMMY_EMBED_WORKER: 'on',
    };
    // This child is a plain script, not a test-runner child.
    delete env.NODE_TEST_CONTEXT;

    const started = Date.now();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - started;

    assert.equal(child.signal, null,
      `killed after ${elapsed} ms: an idle embedding worker is holding the process open\n${child.stderr}`);
    assert.equal(child.status, 0,
      `exit ${child.status}: the process ended while an embed() was still waiting on the worker\n${child.stderr}`);
    assert.match(child.stdout, /embedded 1 via stand-in/, 'the answer in flight must arrive before the process exits');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host admission keeps controls private, preserves shared extensions and bounds pending packets', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-embedding-controls-'));
  try {
    const standIn = path.join(dir, 'controlled.worker.mjs');
    writeFileSync(standIn, [
      "import { parentPort as port } from 'node:worker_threads';",
      'let requests = 0, updates = 0, cancels = 0; const held = new Map();',
      "const result = (id, data) => port.postMessage({kind:'result',id,vectors:[new Float32Array(data)]});",
      "port.on('message', message => {",
      "  if (message.kind === 'cancel') { cancels++; held.delete(message.id); return; }",
      "  if (message.kind === 'update') { updates++; if (held.get(message.id) === 'later') { held.delete(message.id); result(message.id,[2]); } return; }",
      '  requests++; const text = message.texts[0];',
      "  if (text === 'counts') { result(message.id,[requests,updates,cancels]); return; }",
      "  if (text === 'initial') {",
      "    if(message.priority !== 'foreground' || message.deadlineAtMs !== undefined || 'onQueued' in message) { port.postMessage({kind:'error',id:message.id,error:'incorrect private/control packet'}); return; }",
      '    result(message.id,[1]); return;',
      '  }',
      "  if (text === 'hold' || text === 'later') { held.set(message.id,text); return; }",
      "  if (text === 'skipped') { port.postMessage({kind:'skipped',id:message.id,reason:'expired'}); return; }",
      '  result(message.id,[3]);',
      '});',
      "port.postMessage({kind:'ready',runtime:'controlled'});",
    ].join('\n'), 'utf8');
    const script = [
      "import assert from 'node:assert/strict';",
      `const host = await import(${JSON.stringify(new URL('./embedding-worker.ts', import.meta.url).href)});`,
      `host._setEmbeddingWorkerEntryForTest(new URL(${JSON.stringify(pathToFileURL(standIn).href)}));`,
      'const worker = await host.startEmbeddingWorker(); assert.ok(worker);',
      'let queued = 0;',
      "const initial = await worker.embed(['initial'],{priority:'background',deadlineAtMs:Date.now()+10000,onQueued(control){queued++;control.update({priority:'foreground',deadlineAtMs:undefined});}});",
      'assert.equal(queued,1); assert.deepEqual(Array.from(initial[0]),[1]);',
      'let sharedControl;',
      "const shared = worker.embed(['later'],{priority:'background',deadlineAtMs:Date.now()+10000,onQueued(control){sharedControl=control;}});",
      "sharedControl.update({priority:'foreground',deadlineAtMs:undefined}); assert.deepEqual(Array.from((await shared)[0]),[2]);",
      "sharedControl.update({priority:'foreground'}); sharedControl.cancel();",
      "const counts = async () => Array.from((await worker.embed(['counts']))[0]);",
      'assert.equal((await counts())[1],1);',
      'const before = (await counts())[0];',
      "await assert.rejects(worker.embed(['hold'],{onQueued(control){control.cancel();}}), error=>error instanceof host.EmbeddingWorkSkippedError && error.reason==='cancelled');",
      'assert.equal((await counts())[0],before+1);',
      'let expiredQueued = false;',
      "await assert.rejects(worker.embed(['hold'],{deadlineAtMs:Date.now()-1,onQueued(){expiredQueued=true;}}), error=>error.reason==='expired'); assert.equal(expiredQueued,false);",
      "await assert.rejects(worker.embed(['skipped']), error=>error.code==='EMBEDDING_WORK_SKIPPED' && error.reason==='expired');",
      'const controls=[]; const waiting=[];',
      "for(let i=0;i<64;i++)waiting.push(worker.embed(['hold'],{onQueued(control){controls.push(control);}}));",
      'const settled=Promise.allSettled(waiting);',
      "await assert.rejects(worker.embed(['overflow']),error=>error instanceof host.EmbeddingWorkSkippedError && error.reason==='queue_full');",
      'controls.forEach(control=>control.cancel());',
      "assert.ok((await settled).every(row=>row.status==='rejected' && row.reason.reason==='cancelled'));",
      "await assert.rejects(worker.embed(Array(4097).fill('x')),error=>error.reason==='queue_full');",
      "await assert.rejects(worker.embed(['x'.repeat(4000001)]),error=>error.reason==='queue_full');",
      "assert.deepEqual(Array.from((await worker.embed(['default-options']))[0]),[3]);",
      "console.log('host controls, private callback, shared extension, skip classification and bounded admission verified');",
    ].join('\n');
    const env = { ...process.env, CLEMENTINE_HOME: path.join(dir, 'home'), CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_EMBED_WORKER: 'on' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    assert.equal(child.signal, null, `controlled host child timed out\n${child.stderr}`);
    assert.equal(child.status, 0, `controlled host child failed\n${child.stderr}`);
    assert.match(child.stdout, /host controls, private callback, shared extension, skip classification and bounded admission verified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
