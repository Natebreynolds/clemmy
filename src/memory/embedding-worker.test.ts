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
