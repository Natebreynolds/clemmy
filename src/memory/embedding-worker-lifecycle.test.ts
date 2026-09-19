import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Environment for a child that must actually exercise the local provider.
 *
 * The suite's own preload sets CLEMMY_LOCAL_EMBEDDINGS=off, so every ordinary
 * test runs with this whole path disabled -- which is exactly why the defects
 * below reached CI unnoticed. `npm run bench:gates` and the eval scripts do not
 * use the preload, so they ran with it ON. Turn it back on deliberately here.
 */
function liveEmbeddingEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, CLEMENTINE_HOME: home, CLMMY_UNUSED: '' };
  delete env.OPENAI_API_KEY;
  delete env.CLEMMY_EMBED_PROVIDER;
  env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
  env.CLEMMY_EMBED_WORKER = 'on';
  return env;
}

test('an embedding worker never starts another embedding worker', async () => {
  // embedding.worker.ts imports ./embeddings.js, whose module top level warms
  // the local provider on a no-key install. That warmup calls
  // startEmbeddingWorker(). Without a main-thread guard the worker spawns the
  // next generation, which imports the module and spawns the next -- unbounded,
  // each generation holding a loaded model (~220 MB) and an ONNX thread pool.
  // Observed: ~70 generations, 21 GB, 785 threads, and CI runners killed
  // moments after the job printed its PASS verdict.
  const source = `
    import { parentPort } from 'node:worker_threads';
    const { startEmbeddingWorker } = await import(${JSON.stringify(new URL('./embedding-worker.ts', import.meta.url).href)});
    const handle = await startEmbeddingWorker();
    parentPort.postMessage(handle === null ? 'refused' : 'spawned');
  `;
  const result = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, execArgv: ['--import', 'tsx'] });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('worker did not answer')); }, 60_000);
    worker.once('message', (msg: string) => { clearTimeout(timer); void worker.terminate(); resolve(msg); });
    worker.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  assert.equal(result, 'refused', 'startEmbeddingWorker() off the main thread must return null, not spawn');
});

test('loading the local embedding provider never holds the process open', () => {
  // The module's stated contract is "never hold the process open (the worker is
  // unref'd)". It was not true: unref() ran at spawn, and attaching the
  // 'message' listener afterwards starts -- and so re-refs -- the underlying
  // MessagePort. A finished run's active handles read ["PipeWrap","MessagePort"]
  // and the process sat there. In CI that is a job that never ends.
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-embed-lifecycle-'));
  try {
    const source = `
      const { getEmbeddingProvider } = await import(${JSON.stringify(new URL('./embeddings.ts', import.meta.url).href)});
      await getEmbeddingProvider();
      console.log('LOADED');
    `;
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: liveEmbeddingEnv(home),
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(run.signal, null, `the process had to be killed after ${Date.now() - started} ms -- something still holds the event loop`);
    assert.match(run.stdout, /LOADED/, 'the child must actually have reached the provider');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
