import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ProbeError, configureOfflineTransformers, inspectCandidate, parseArguments, privateEnvironment,
  runPackagedEmbeddingProbe, runWorkerProbeChild } from './probe-packaged-embedding-worker.mjs';

const fingerprint = 'a'.repeat(64);
const stamp = { gitSha: 'b'.repeat(40), gitDirty: false, sourceFingerprint: fingerprint, expectedSchemaVersion: 94 };
const marker = Symbol.for('clementine.packaged-embedding-offline');
const PREFIX = 'CLEM_PACKAGED_EMBEDDING_PROBE ';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'packaged-embedding-host-control-'));
  const backend = path.join(root, 'packaged backend'); const cache = path.join(root, 'explicit cache');
  const put = (file, content = 'controlled fixture bytes') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
  const executable = path.join(root, 'Clementine'); put(executable);
  put(path.join(backend, 'package.json'), JSON.stringify({ version: '3.18.39' }));
  put(path.join(backend, 'dist/runtime/build-stamp.json'), JSON.stringify(stamp));
  for (const name of ['embedding-worker.js', 'embedding.worker.js', 'embeddings.js']) put(path.join(backend, 'dist/memory', name));
  const transformers = path.join(backend, 'node_modules/@huggingface/transformers');
  put(path.join(transformers, 'package.json'), JSON.stringify({ version: '4.2.0', exports: { node: { import: { default: './dist/transformers.node.mjs' } } } }));
  for (const name of ['transformers.node.mjs', 'transformers.clementine-wasm.mjs']) put(path.join(transformers, 'dist', name));
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx', 'onnx/model_quantized.onnx']) put(path.join(cache, 'Xenova/bge-small-en-v1.5', name));
  const settings = { runtimeExecutable: executable, backendDir: backend, expectedFingerprint: fingerprint, expectedSchema: 94,
    expectedRuntime: 'native', cacheDir: cache, timeoutMs: 1_000 };
  return { root, backend, cache, settings, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const frame = row => `${PREFIX}${JSON.stringify(row)}\n`;
function result(extra = {}) {
  return { kind: 'result', ...stamp, platform: 'darwin', arch: 'arm64', electronVersion: '39.0.0', runtime: 'native',
    model: 'Xenova/bge-small-en-v1.5', dim: 384, finite: true, nonzero: true, vectorSha256: 'c'.repeat(64), ...extra };
}
function childFixture(onKill = child => queueMicrotask(() => child.emit('close', null))) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), kills: 0, unref() {},
    kill(signal) { assert.equal(signal, 'SIGKILL'); this.kills++; onKill(this); return true; } });
  return child;
}
function successfulSpawn(capture = () => {}, response = result(), guards = true) {
  return (executable, args, options) => {
    capture(executable, args, options);
    const child = childFixture();
    queueMicrotask(() => {
      child.stdout.write('private ignored runtime log\n');
      child.stderr.write('private ignored exception\n');
      if (guards) {
        child.stdout.write(frame({ kind: 'offline_guard', main: true, threadId: 0 }));
        const entry = readFileSync(args[2], 'utf8');
        const workerSha256 = /"workerSha256":"([a-f0-9]{64})"/.exec(entry)?.[1];
        child.stdout.write(frame({ kind: 'offline_guard', main: false, threadId: 1, compiledWorker: true, workerSha256 }));
      }
      child.stdout.write(frame(response)); child.exitCode = 0; child.emit('close', 0);
    });
    return child;
  };
}

test('explicit arguments and all offline prerequisites refuse before child admission', async () => {
  const f = fixture();
  try {
    const args = ['--runtime-executable', f.settings.runtimeExecutable, '--backend-dir', f.backend, '--expected-fingerprint', fingerprint,
      '--expected-schema', '94', '--expected-runtime', 'native', '--cache-dir', f.cache];
    assert.equal(parseArguments(args).timeoutMs, 30_000);
    assert.throws(() => parseArguments([...args, '--expected-schema', '94']), ProbeError);
    assert.throws(() => parseArguments(args.map(value => value === f.cache ? 'relative' : value)), /absolute_paths_required/);
    let launches = 0;
    rmSync(path.join(f.cache, 'Xenova/bge-small-en-v1.5/onnx/model.onnx'));
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: () => { launches++; } }), /offline_model_files_missing/);
    assert.equal(launches, 0);
  } finally { f.cleanup(); }
});

test('candidate stamp mismatch and absent compiled worker refuse without starting a runtime', async () => {
  const f = fixture();
  try {
    assert.throws(() => inspectCandidate({ ...f.settings, expectedSchema: 93 }), /candidate_identity_mismatch/);
    assert.throws(() => inspectCandidate({ ...f.settings, expectedFingerprint: 'd'.repeat(64) }), /candidate_identity_mismatch/);
    rmSync(path.join(f.backend, 'dist/memory/embedding.worker.js'));
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: () => assert.fail('must not spawn') }), /required_file_unavailable/);
  } finally { f.cleanup(); }
});

test('private environment contains no provider, home, proxy, login or preload authority', () => {
  const env = privateEnvironment({ OPENAI_API_KEY: 'private', HF_TOKEN: 'private', NODE_OPTIONS: '--import private', CODEX_HOME: '/private',
    CLAUDE_CONFIG_DIR: '/private', CLEMENTINE_HOME: '/private', HTTPS_PROXY: 'private', PATH: '/private', SystemRoot: 'C:\\Windows' }, '/fixture');
  for (const name of ['OPENAI_API_KEY', 'HF_TOKEN', 'NODE_OPTIONS', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'PATH']) assert.equal(env[name], undefined);
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.CLEMENTINE_HOME, path.join('/fixture', 'clem'));
  assert.equal(env.CLEMMY_REAL_USER_HOME, '/fixture');
  assert.equal(env.CLEMMY_TEST_ISOLATED_HOME, '1');
});

test('offline policy configures the exact ESM environment in both thread contexts and denies downloads', async () => {
  for (const main of [true, false]) {
    const globals = {}; const env = { allowRemoteModels: true, fetch() {} }; const imports = [];
    const guard = await configureOfflineTransformers({ transformerEntry: '/fixture/transformers.node.mjs', cache: '/explicit/cache' },
      { globals, main, threadId: main ? 0 : 2, importModule: async url => { imports.push(url); return { env }; } });
    assert.equal(imports.length, 1); assert.match(imports[0], /transformers\.node\.mjs$/);
    assert.equal(env.allowRemoteModels, false); assert.equal(env.allowLocalModels, true);
    assert.equal(env.localModelPath, '/explicit/cache');
    assert.equal(env.useFSCache, false); assert.equal(env.useWasmCache, false);
    assert.equal(globals[marker], true); assert.equal(guard.main, main);
    await assert.rejects(env.fetch('https://example.invalid/private'), /offline_network_refused/);
    await assert.rejects(globals.fetch('https://example.invalid/private'), /offline_network_refused/);
  }
});

test('real synthetic Node bootstrap inherits the preload into the exact compiled-path worker, with no app or model', () => {
  const f = fixture();
  try {
    const transformerEntry = path.join(f.backend, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs');
    f.put(transformerEntry, 'export const env={allowRemoteModels:true,fetch:globalThis.fetch};');
    const workerEntry = path.join(f.backend, 'dist/memory/embedding.worker.js');
    f.put(path.join(f.backend, 'package.json'), JSON.stringify({ version: '3.18.39', type: 'module' }));
    f.put(workerEntry, `import {parentPort} from 'node:worker_threads';\nimport {env} from ${JSON.stringify(pathToFileURL(transformerEntry).href)};\nlet blocked=false; try{await fetch('https://example.invalid/not-contacted')}catch{blocked=true}\nparentPort.postMessage({offline:env.allowRemoteModels===false,blocked});`);
    const settings = { transformerEntry, cache: f.cache, workerEntry: realpathSync(workerEntry),
      workerSha256: createHash('sha256').update(readFileSync(workerEntry)).digest('hex') };
    const preload = path.join(f.root, 'synthetic-preload.mjs');
    f.put(preload, `import {configureOfflineTransformers} from ${JSON.stringify(new URL('./probe-packaged-embedding-worker.mjs', import.meta.url).href)};\nconst guard=await configureOfflineTransformers(${JSON.stringify(settings)});\nprocess.stdout.write(${JSON.stringify(PREFIX)}+JSON.stringify(guard)+'\\n');`);
    const parent = path.join(f.root, 'synthetic-parent.mjs');
    f.put(parent, `import {Worker} from 'node:worker_threads';\nconst worker=new Worker(${JSON.stringify(workerEntry)});\nworker.once('message',value=>process.stdout.write('BOOTSTRAP_RESULT '+JSON.stringify(value)+'\\n'));`);
    const text = execFileSync(process.execPath, ['--import', preload, parent], {
      env: privateEnvironment(process.env, f.root), cwd: f.root, timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const frames = text.split(/\r?\n/).filter(line => line.startsWith(PREFIX)).map(line => JSON.parse(line.slice(PREFIX.length)));
    assert.ok(frames.some(value => value.main === true && value.threadId === 0));
    assert.ok(frames.some(value => value.main === false && value.compiledWorker === true && value.workerSha256 === settings.workerSha256));
    assert.match(text, /BOOTSTRAP_RESULT \{"offline":true,"blocked":true\}/);
  } finally { f.cleanup(); }
});

test('actual child logic imports only compiled host and permits no main-thread fallback', async () => {
  const f = fixture();
  try {
    const candidate = inspectCandidate(f.settings); const imports = []; let calls = 0;
    const controls = { globals: { [marker]: true }, process: { platform: 'darwin', arch: 'arm64', versions: { electron: '39.0.0' } },
      importModule: async url => { imports.push(url); return { startEmbeddingWorker: async () => ({ runtime: 'native', embed: async (texts, options) => {
        calls++; assert.equal(texts.length, 1); assert.equal(options.priority, 'foreground'); return [Float32Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)];
      } }) }; } };
    const settings = { ...f.settings, host: candidate.host, stampFile: candidate.stampFile };
    assert.equal((await runWorkerProbeChild(settings, controls)).dim, 384);
    assert.equal(fileURLToPath(imports[0]), candidate.host); assert.equal(imports.length, 1); assert.equal(calls, 1);
    await assert.rejects(runWorkerProbeChild(settings, { ...controls, importModule: async () => ({ startEmbeddingWorker: async () => null }) }), /worker_unavailable/);
    for (const [platform, arch, runtime] of [['darwin', 'x64', 'wasm'], ['win32', 'x64', 'native']]) {
      const value = await runWorkerProbeChild({ ...settings, expectedRuntime: runtime }, { ...controls,
        process: { platform, arch, versions: { electron: '39.0.0' } }, importModule: async () => ({ startEmbeddingWorker: async () => ({ runtime,
          embed: async () => [Float32Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)] }) }) });
      assert.equal(value.runtime, runtime);
    }
    await assert.rejects(runWorkerProbeChild(settings, { ...controls, process: { platform: 'linux', arch: 'x64', versions: { electron: '39.0.0' } } }), /unsupported_runtime_target/);
    await assert.rejects(runWorkerProbeChild(settings, { ...controls, process: { platform: 'darwin', arch: 'arm64', versions: {} } }), /packaged_electron_runtime_required/);
  } finally { f.cleanup(); }
});

for (const invalid of ['runtime', 'count', 'dim', 'zero', 'nonfinite']) test(`actual child rejects invalid ${invalid} worker output`, async () => {
  const f = fixture();
  try {
    const candidate = inspectCandidate(f.settings);
    const vectors = invalid === 'count' ? [] : [Float32Array.from({ length: invalid === 'dim' ? 12 : 384 }, (_, index) => invalid === 'zero' ? 0 : index === 0 ? invalid === 'nonfinite' ? Number.NaN : 1 : 0)];
    await assert.rejects(runWorkerProbeChild({ ...f.settings, host: candidate.host, stampFile: candidate.stampFile }, {
      globals: { [marker]: true }, process: { platform: 'darwin', arch: 'arm64', versions: { electron: '39.0.0' } },
      importModule: async () => ({ startEmbeddingWorker: async () => ({ runtime: invalid === 'runtime' ? 'wasm' : 'native', embed: async () => vectors }) }),
    }), invalid === 'runtime' ? /worker_runtime_mismatch/ : /invalid_worker_vector/);
  } finally { f.cleanup(); }
});

test('host admission uses inherited offline preload, explicit compiled entry, sanitized output and immutable digests', async () => {
  const f = fixture();
  try {
    const output = await runPackagedEmbeddingProbe(f.settings, { spawnProcess: successfulSpawn((executable, args, options) => {
      assert.equal(executable, realpathSync(f.settings.runtimeExecutable)); assert.equal(args.length, 3); assert.equal(args[0], '--import');
      assert.equal(options.shell, false); assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(args.some(arg => arg.includes('tsx') || arg.includes('--input-type')), false);
      for (const script of args.slice(1)) {
        const source = readFileSync(script, 'utf8');
        assert.ok(source.includes('\n'), 'generated scripts contain real line breaks');
        new Function(`return async()=>{${source.replace(/^import[^\n]*\n/, '')}}`);
      }
    }) });
    assert.equal(output.offlineGuardMainAndWorker, true); assert.equal(output.expectedSchemaVersion, 94);
    assert.match(output.componentSha256['dist/memory/embedding.worker.js'], /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(output), /private ignored|packaged-embedding-host-control/);
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: successfulSpawn(() => {}, result(), false) }), /offline_worker_guard_unproved/);
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: successfulSpawn(() => {}, result({ sourceFingerprint: 'f'.repeat(64) })) }), /candidate_identity_mismatch/);
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: successfulSpawn(() => f.put(path.join(f.backend, 'dist/memory/embedding.worker.js'), 'changed after launch')) }), /candidate_changed_during_probe/);
  } finally { f.cleanup(); }
});

test('owned child timeout remains failed after zero close, with bounded cleanup and no log leakage', async () => {
  const f = fixture();
  try {
    const child = childFixture(value => queueMicrotask(() => { value.exitCode = 0; value.emit('close', 0); }));
    const error = await runPackagedEmbeddingProbe(f.settings, { tmpDir: f.root, timeoutMs: 5, spawnProcess: () => child }).catch(error => error);
    assert.equal(error.code, 'child_timeout'); assert.equal(error.cleanup, 'complete'); assert.equal(child.kills, 1);
    const stuck = childFixture(() => {});
    const incomplete = await runPackagedEmbeddingProbe(f.settings, { tmpDir: f.root, timeoutMs: 5, cleanupTimeoutMs: 5, spawnProcess: () => stuck }).catch(error => error);
    assert.equal(incomplete.code, 'child_timeout'); assert.equal(incomplete.cleanup, 'incomplete'); assert.equal(stuck.kills, 1);
  } finally { f.cleanup(); }
});

test('canonical runtime is launched and logical model-directory retargeting refuses the receipt', async () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, 'runtime alias');
    symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await runPackagedEmbeddingProbe({ ...f.settings, runtimeExecutable: path.join(alias, 'Clementine') }, {
      spawnProcess: successfulSpawn(executable => assert.equal(executable, realpathSync(f.settings.runtimeExecutable))),
    });
    const logicalModel = path.join(f.cache, 'Xenova/bge-small-en-v1.5');
    const first = path.join(f.cache, 'first model'); const second = path.join(f.cache, 'second model');
    renameSync(logicalModel, first); cpSync(first, second, { recursive: true });
    symlinkSync(first, logicalModel, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runPackagedEmbeddingProbe(f.settings, { spawnProcess: successfulSpawn(() => {
      rmSync(logicalModel); symlinkSync(second, logicalModel, process.platform === 'win32' ? 'junction' : 'dir');
    }) }), /candidate_changed_during_probe/);
  } finally { f.cleanup(); }
});
