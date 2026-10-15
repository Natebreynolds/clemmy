#!/usr/bin/env node
/** Offline, explicit-path Electron/compiled-worker qualification. Never boots Clem. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';

const PREFIX = 'CLEM_PACKAGED_EMBEDDING_PROBE ';
const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
const MARKER = Symbol.for('clementine.packaged-embedding-offline');
const SELF = import.meta.url;
export class ProbeError extends Error {
  constructor(code, cleanup) { super(code); this.code = code; if (cleanup) this.cleanup = cleanup; }
}
const refuse = code => { throw new ProbeError(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function digestFile(file) {
  const hash = createHash('sha256'); const fd = openSync(file, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let bytes; while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function regular(file) {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) refuse('required_file_unavailable'); return realpathSync(file); }
  catch { refuse('required_file_unavailable'); }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { refuse('invalid_package_metadata'); } }
function checkedStamp(stamp, settings) {
  if (!stamp || stamp.sourceFingerprint !== settings.expectedFingerprint || stamp.expectedSchemaVersion !== settings.expectedSchema
    || !/^[a-f0-9]{40}$/.test(stamp.gitSha ?? '') || typeof stamp.gitDirty !== 'boolean') refuse('candidate_identity_mismatch');
  return { gitSha: stamp.gitSha, gitDirty: stamp.gitDirty, sourceFingerprint: stamp.sourceFingerprint, expectedSchemaVersion: stamp.expectedSchemaVersion };
}

export function parseArguments(argv) {
  const names = { '--runtime-executable': 'runtimeExecutable', '--backend-dir': 'backendDir', '--expected-fingerprint': 'expectedFingerprint',
    '--expected-schema': 'expectedSchema', '--expected-runtime': 'expectedRuntime', '--cache-dir': 'cacheDir', '--timeout-ms': 'timeoutMs' };
  const settings = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || settings[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) refuse('invalid_arguments');
    settings[key] = argv[i + 1];
  }
  if (['runtimeExecutable', 'backendDir', 'expectedFingerprint', 'expectedSchema', 'expectedRuntime', 'cacheDir'].some(key => !settings[key])) refuse('invalid_arguments');
  if (!/^[a-f0-9]{64}$/.test(settings.expectedFingerprint) || !/^\d+$/.test(settings.expectedSchema)) refuse('invalid_arguments');
  settings.expectedSchema = Number(settings.expectedSchema);
  settings.timeoutMs = Number(settings.timeoutMs ?? 30_000);
  if (!Number.isSafeInteger(settings.expectedSchema) || settings.expectedSchema <= 0 || !['native', 'wasm'].includes(settings.expectedRuntime)
    || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1_000 || settings.timeoutMs > 120_000) refuse('invalid_arguments');
  for (const key of ['runtimeExecutable', 'backendDir', 'cacheDir']) if (!path.isAbsolute(settings[key])) refuse('absolute_paths_required');
  return settings;
}

export function inspectCandidate(settings) {
  const backend = realpathSync(settings.backendDir); const cache = realpathSync(settings.cacheDir);
  const files = new Map(); const logicalFiles = new Map();
  const take = (name, file, root) => {
    const actual = regular(file); if (root && !inside(root, actual)) refuse('package_path_escape');
    files.set(name, actual); logicalFiles.set(name, file); return actual;
  };
  take('runtime', settings.runtimeExecutable);
  const stampFile = take('dist/runtime/build-stamp.json', path.join(backend, 'dist/runtime/build-stamp.json'), backend);
  const stamp = checkedStamp(readJson(stampFile), settings);
  const packageFile = take('package.json', path.join(backend, 'package.json'), backend);
  const version = readJson(packageFile).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) refuse('invalid_package_metadata');
  const host = take('dist/memory/embedding-worker.js', path.join(backend, 'dist/memory/embedding-worker.js'), backend);
  take('dist/memory/embedding.worker.js', path.join(backend, 'dist/memory/embedding.worker.js'), backend);
  take('dist/memory/embeddings.js', path.join(backend, 'dist/memory/embeddings.js'), backend);
  const transformersRoot = path.join(backend, 'node_modules/@huggingface/transformers');
  const transformerPackage = take('transformers/package.json', path.join(transformersRoot, 'package.json'), backend);
  const metadata = readJson(transformerPackage);
  // Pin the same ESM module instance production imports; require.resolve would
  // select the distinct CJS entry, whose env cannot disable downloads in ESM.
  const nativeEntry = metadata.exports?.node?.import?.default;
  if (nativeEntry !== './dist/transformers.node.mjs' || typeof metadata.version !== 'string') refuse('unsupported_transformers_layout');
  const transformerEntry = take('transformers/entry', path.join(transformersRoot,
    settings.expectedRuntime === 'wasm' ? 'dist/transformers.clementine-wasm.mjs' : nativeEntry), backend);
  const required = ['config.json', 'tokenizer.json', 'tokenizer_config.json',
    settings.expectedRuntime === 'wasm' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx'];
  for (const relative of required) {
    try { take(`model/${relative}`, path.join(cache, MODEL, relative), cache); }
    catch { refuse('offline_model_files_missing'); }
  }
  const digests = Object.fromEntries([...files].map(([name, file]) => [name, digestFile(file)]));
  return { backend, cache, host, stampFile, stamp, version, transformerEntry, transformersVersion: metadata.version, files, logicalFiles, digests };
}

export function privateEnvironment(parent, home) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^(systemroot|windir|systemdrive|lang|lc_all|tz)$/i.test(key) && typeof value === 'string') env[key] = value;
  }
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    CLEMENTINE_HOME: path.join(home, 'clem'), CLEMMY_REAL_USER_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
    XDG_CACHE_HOME: path.join(home, 'cache'), ELECTRON_RUN_AS_NODE: '1',
    CLEMMY_EMBED_PROVIDER: 'local', CLEMMY_LOCAL_EMBEDDINGS: 'on', CLEMMY_EMBED_WORKER: 'on',
    EMBEDDINGS_DISABLED: 'false', CLEMMY_ONNX_WASM_THREADS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', OPENAI_AGENTS_DISABLE_TRACING: '1',
  });
}

/** This public Transformers policy runs via --import in BOTH main and worker. */
export async function configureOfflineTransformers(settings, controls = {}) {
  const globals = controls.globals ?? globalThis;
  const blockedFetch = async () => { throw new ProbeError('offline_network_refused'); };
  globals.fetch = blockedFetch;
  const module = await (controls.importModule ?? (url => import(url)))(pathToFileURL(settings.transformerEntry).href);
  if (!module.env || !('allowRemoteModels' in module.env) || !('fetch' in module.env)) refuse('offline_policy_unavailable');
  Object.assign(module.env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: settings.cache,
    useFSCache: false, useBrowserCache: false, useCustomCache: false, useWasmCache: false, fetch: blockedFetch });
  globals[MARKER] = true;
  const main = controls.main ?? isMainThread;
  const argv = (controls.process ?? process).argv;
  let compiledWorker = false;
  if (!main && argv?.[1] && settings.workerEntry) {
    try { compiledWorker = regular(argv[1]) === settings.workerEntry && digestFile(argv[1]) === settings.workerSha256; } catch { /* Not the expected worker. */ }
  }
  return { kind: 'offline_guard', main, threadId: controls.threadId ?? threadId, compiledWorker,
    ...(compiledWorker ? { workerSha256: settings.workerSha256 } : {}) };
}

export async function runWorkerProbeChild(settings, controls = {}) {
  const current = controls.process ?? process;
  if (!(controls.globals ?? globalThis)[MARKER]) refuse('offline_policy_missing');
  if (!current.versions?.electron) refuse('packaged_electron_runtime_required');
  const expectedRuntime = current.platform === 'darwin' && current.arch === 'x64' ? 'wasm' : 'native';
  if (!((current.platform === 'darwin' && ['arm64', 'x64'].includes(current.arch)) || (current.platform === 'win32' && current.arch === 'x64'))
    || settings.expectedRuntime !== expectedRuntime) refuse('unsupported_runtime_target');
  const stamp = checkedStamp(readJson(settings.stampFile), settings);
  const host = await (controls.importModule ?? (url => import(url)))(pathToFileURL(settings.host).href);
  if (typeof host.startEmbeddingWorker !== 'function') refuse('compiled_worker_host_missing');
  const worker = await host.startEmbeddingWorker();
  if (!worker) refuse('worker_unavailable'); // No main-thread fallback is permitted.
  if (worker.runtime !== expectedRuntime) refuse('worker_runtime_mismatch');
  const vectors = await worker.embed(['Clementine packaged offline embedding worker qualification.'],
    { priority: 'foreground', deadlineAtMs: Date.now() + settings.timeoutMs });
  const vector = vectors?.[0];
  if (!Array.isArray(vectors) || vectors.length !== 1 || !(vector instanceof Float32Array) || vector.length !== DIM
    || !vector.every(Number.isFinite) || !vector.some(value => value !== 0)) refuse('invalid_worker_vector');
  return { kind: 'result', ...stamp, platform: current.platform, arch: current.arch, electronVersion: current.versions.electron,
    runtime: worker.runtime, model: MODEL, dim: DIM, finite: true, nonzero: true,
    vectorSha256: sha(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)) };
}

async function runOwnedChild(executable, args, options, controls) {
  const launch = controls.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    let child; let timer; let cleanupTimer; let finished = false; let stopping = false; let failureCode; let exited = false; let bytes = 0; const output = [];
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
      if (error) reject(error); else resolve(value);
    };
    const stop = code => {
      if (finished || stopping) return; stopping = true; failureCode = code; clearTimeout(timer);
      if (!child?.pid) return finish(new ProbeError(code, 'not_started'));
      if (exited || child.exitCode != null || child.signalCode != null) return finish(new ProbeError(code, 'incomplete'));
      // Only worker threads are launched by this probe. Kill the exact owned
      // runtime process, never an image name, guessed PID, or another daemon.
      cleanupTimer = setTimeout(() => finish(new ProbeError(code, 'incomplete')), controls.cleanupTimeoutMs ?? 1_000);
      try { child.kill('SIGKILL'); } catch { finish(new ProbeError(code, 'incomplete')); }
    };
    try { child = launch(executable, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(new ProbeError('child_start_failed', 'not_started')); return; }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65_536) stop('child_output_limit'); else output.push(chunk); });
    child.stderr.on('data', () => {}); // Never echo runtime logs or error payloads.
    child.once('exit', () => { exited = true; });
    child.on('error', () => stop('child_start_failed'));
    child.once('close', code => {
      if (stopping) return finish(new ProbeError(failureCode, 'complete'));
      if (code !== 0) return finish(new ProbeError('child_failed'));
      finish(null, Buffer.concat(output).toString('utf8'));
    });
    timer = setTimeout(() => stop('child_timeout'), controls.timeoutMs ?? options.timeoutMs);
  });
}

export async function runPackagedEmbeddingProbe(settings, controls = {}) {
  const candidate = inspectCandidate(settings);
  const home = mkdtempSync(path.join(controls.tmpDir ?? os.tmpdir(), 'clem-packaged-embedding-'));
  for (const relative of ['clem', 'tmp', 'appdata', 'localappdata', 'cache']) mkdirSync(path.join(home, relative), { recursive: true, mode: 0o700 });
  const preload = path.join(home, 'offline-preload.mjs'); const entry = path.join(home, 'probe-entry.mjs');
  const childSettings = { ...settings, host: candidate.host, stampFile: candidate.stampFile, transformerEntry: candidate.transformerEntry, cache: candidate.cache,
    workerEntry: candidate.files.get('dist/memory/embedding.worker.js'), workerSha256: candidate.digests['dist/memory/embedding.worker.js'] };
  writeFileSync(preload, `import {configureOfflineTransformers} from ${JSON.stringify(SELF)};\nconst guard=await configureOfflineTransformers(${JSON.stringify(childSettings)});\nprocess.stdout.write(${JSON.stringify(PREFIX)}+JSON.stringify(guard)+'\\n');\n`, { mode: 0o600 });
  writeFileSync(entry, `import {runWorkerProbeChild} from ${JSON.stringify(SELF)};\ntry { const result=await runWorkerProbeChild(${JSON.stringify(childSettings)}); process.stdout.write(${JSON.stringify(PREFIX)}+JSON.stringify(result)+'\\n'); } catch { process.exitCode=1; }\n`, { mode: 0o600 });
  let retainFixture = false;
  try {
    const text = await runOwnedChild(candidate.files.get('runtime'), ['--import', preload, entry],
      { cwd: home, env: privateEnvironment(controls.environment ?? process.env, home), timeoutMs: settings.timeoutMs }, controls);
    let frames;
    try { frames = text.split(/\r?\n/).filter(line => line.startsWith(PREFIX)).map(line => JSON.parse(line.slice(PREFIX.length))); }
    catch { refuse('invalid_child_receipt'); }
    const results = frames.filter(row => row.kind === 'result');
    if (results.length !== 1 || !frames.some(row => row.kind === 'offline_guard' && row.main === true && row.threadId === 0)
      || !frames.some(row => row.kind === 'offline_guard' && row.main === false && Number.isSafeInteger(row.threadId) && row.threadId > 0
        && row.compiledWorker === true && row.workerSha256 === childSettings.workerSha256)) refuse('offline_worker_guard_unproved');
    const result = results[0]; checkedStamp(result, settings);
    if (result.gitSha !== candidate.stamp.gitSha || result.gitDirty !== candidate.stamp.gitDirty
      || result.runtime !== settings.expectedRuntime || result.dim !== DIM || result.finite !== true || result.nonzero !== true
      || result.model !== MODEL || !/^[a-f0-9]{64}$/.test(result.vectorSha256 ?? '') || typeof result.electronVersion !== 'string'
      || !((result.platform === 'darwin' && ((result.arch === 'arm64' && result.runtime === 'native') || (result.arch === 'x64' && result.runtime === 'wasm')))
        || (result.platform === 'win32' && result.arch === 'x64' && result.runtime === 'native'))) refuse('invalid_child_receipt');
    for (const [name, file] of candidate.files) {
      if (regular(candidate.logicalFiles.get(name)) !== file || regular(file) !== file || digestFile(file) !== candidate.digests[name]) refuse('candidate_changed_during_probe');
    }
    return { ok: true, qualification: 'offline_packaged_worker_only', version: candidate.version, ...candidate.stamp,
      platform: result.platform, arch: result.arch, electronVersion: result.electronVersion, runtime: result.runtime,
      model: MODEL, dim: DIM, vectorSha256: result.vectorSha256, transformersVersion: candidate.transformersVersion,
      offlineGuardMainAndWorker: true, componentSha256: candidate.digests,
      limits: ['Not authenticated serving or installed-app acceptance.', 'No provider/task/cost or latency qualification.'] };
  } catch (error) { retainFixture = error instanceof ProbeError && error.cleanup === 'incomplete'; throw error; }
  finally { if (!retainFixture) rmSync(home, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runPackagedEmbeddingProbe(parseArguments(process.argv.slice(2))))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof ProbeError ? error.code : 'probe_failed',
    ...(error instanceof ProbeError && error.cleanup ? { cleanup: error.cleanup } : {}) })}\n`); process.exitCode = 1; }
}
