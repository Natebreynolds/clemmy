/** Bounded observer lifecycle. No synchronous inventory or stale-idle fallback. */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { classifyRuntimeToolEffect } from '../runtime/harness/tool-effect.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import { extractExternalWriteIdentityKeys } from '../runtime/harness/grounding-gate.js';
import { parseResolvedCallAuthority } from '../runtime/harness/resolved-call-authority.js';
import { unverifiedInstallQuiescence } from './install-quiescence-read.js';
import { ACTIVE_WORK_OBSERVER_LIMITS as limits, observationDigest, observationIdentityDigest, policyInput, policyMapDigest,
  type ObservationIdentity, type PolicyInput, type PolicyValue, type ObserverToMain, type ActiveWorkSnapshot } from './active-work-observer-protocol.js';

export function resolveActiveWorkWorkerEntry(moduleUrl: string, daemonEntry?: string): URL {
  const module = fileURLToPath(moduleUrl);
  if (module.endsWith('.ts')) return new URL('./active-work-observer.worker.ts', moduleUrl);
  if (path.basename(module) === 'active-work-observer.js') return new URL('./active-work-observer.worker.js', moduleUrl);
  // Emitted artifacts rewrite import.meta.url to the actual bundle location.
  // Never resolve a sibling beside that bundle or fall back to TS source.
  const normalized = module.split(path.sep).join('/');
  if (/\/dist\/runtime\/harness\/implementation-artifacts\/emitted\/[^/]+\.cjs$/.test(normalized)) {
    return pathToFileURL(path.resolve(path.dirname(module), '../../../../dashboard/active-work-observer.worker.js'));
  }
  if (daemonEntry && /[\\/]dist[\\/]index\.js$/.test(daemonEntry)) {
    return pathToFileURL(path.join(path.dirname(daemonEntry), 'dashboard', 'active-work-observer.worker.js'));
  }
  throw new Error('active_work_worker_entry_unavailable');
}

function unavailable(issue = 'active_work_observation_unverified'): ActiveWorkSnapshot {
  return { ...unverifiedInstallQuiescence(issue), activeSessions: 0, pendingApprovals: 0,
    activeBackgroundTasks: 0, items: [], activityAvailable: false };
}
function validSnapshot(value: unknown, identity: ObservationIdentity): value is ActiveWorkSnapshot {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > limits.dtoBytes) return false;
  const snapshot = value as ActiveWorkSnapshot;
  const q = snapshot.quiescence, w = snapshot.currentWork;
  if (!Number.isSafeInteger(snapshot.total) || snapshot.total < 0 || typeof snapshot.summary !== 'string'
    || !q || !['quiescent', 'work_pending', 'unverified'].includes(q.state)
    || q.observedAt !== new Date(identity.requestedAt).toISOString()
    || !Array.isArray(q.issues) || !q.issues.every(issue => typeof issue === 'string' && /^[a-z0-9_]{1,96}$/.test(issue))
    || !w || !Number.isSafeInteger(w.total) || !Array.isArray(w.items) || w.total !== w.items.length
    || !Array.isArray(snapshot.items) || ![snapshot.activeSessions, snapshot.pendingApprovals, snapshot.activeBackgroundTasks].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
  if (q.state === 'quiescent') return snapshot.total === 0 && w.total === 0 && q.issues.length === 0;
  return q.state === 'unverified' ? snapshot.total >= 1 : snapshot.total === w.total && w.total > 0 && q.issues.length === 0;
}
async function evaluatePolicy(inputs: readonly PolicyInput[], deadline: number): Promise<PolicyValue[]> {
  if (inputs.length > limits.policyInputs || Buffer.byteLength(JSON.stringify(inputs)) > limits.policyBytes) throw new Error('policy_bound');
  const seen = new Set<string>(); const values: PolicyValue[] = [];
  let outputBytes = 2;
  for (let index = 0; index < inputs.length; index++) {
    if (index % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const input = inputs[index];
    if (Date.now() > deadline || !input || !['effect', 'shape', 'targets', 'sealed'].includes(input.kind)
      || input.key !== policyInput(input.kind, input.value).key || seen.has(input.key)
      || Buffer.byteLength(JSON.stringify(input)) > limits.policyItemBytes) throw new Error('policy_invalid');
    seen.add(input.key);
    let output: unknown;
    switch (input.kind) {
      case 'effect': case 'shape': {
        if (!Array.isArray(input.value) || input.value.length !== 2 || typeof input.value[0] !== 'string'
          || input.value[0].length > 512) throw new Error('policy_invalid');
        output = input.kind === 'effect' ? classifyRuntimeToolEffect(input.value[0], input.value[1]) : classifyExternalWrite(input.value[0], input.value[1]);
        break;
      }
      case 'targets': output = extractExternalWriteIdentityKeys(input.value); break;
      case 'sealed': {
        if (typeof input.value !== 'string') throw new Error('policy_invalid');
        output = parseResolvedCallAuthority(input.value); break;
      }
    }
    const value = { key: input.key, output };
    outputBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
    if (outputBytes > limits.policyBytes) throw new Error('policy_bound');
    values.push(value);
  }
  return values;
}

export interface ActiveWorkObserverOptions {
  baseDir: string; workflowDir: string; schema: number;
  /** Explicit module location allows the packaged/bundled boundary to be tested. */
  moduleUrl?: string; daemonEntry?: string;
  timeoutMs?: number;
}

export function createActiveWorkObserver(options: ActiveWorkObserverOptions): { read(): Promise<ActiveWorkSnapshot> } {
  const epoch = randomUUID();
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const timeout = Math.max(1, Math.min(limits.deadlineMs, options.timeoutMs ?? limits.deadlineMs));
  const workerEnvironment = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR']
    .flatMap(key => typeof process.env[key] === 'string' ? [[key, process.env[key]!]] : []));
  let physical: { result: Promise<ActiveWorkSnapshot> } | undefined;
  let followup: { result: Promise<ActiveWorkSnapshot>; resolve(value: ActiveWorkSnapshot): void; expired: boolean; timer: NodeJS.Timeout } | undefined;

  async function readArtifact(file: string): Promise<{ pin: ObservationIdentity['artifacts'][number]; text: string }> {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limits.fileBytes)) throw new Error('worker_entry_bound');
    const generation = [before.dev, before.ino, before.ctimeNs, before.mtimeNs, before.size].join(':');
    const handle = await open(file, 'r');
    let bytes: string;
    try {
      const buffer = Buffer.alloc(Number(before.size) + 1);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== Number(before.size)) throw new Error('artifact_drift');
      bytes = buffer.subarray(0, read.bytesRead).toString('utf8');
    } finally { await handle.close(); }
    const after = await lstat(file, { bigint: true });
    if (generation !== [after.dev, after.ino, after.ctimeNs, after.mtimeNs, after.size].join(':')) throw new Error('artifact_drift');
    return { pin: { file, generation, digest: observationDigest(bytes) }, text: bytes };
  }
  const artifact = async (file: string) => (await readArtifact(file)).pin;
  // Resolve platform aliases (for example macOS /var -> /private/var) before
  // sending the home identity. A selected directory itself may not be a symlink;
  // its generation and canonical selection must still agree at acceptance.
  async function directorySelection(file: string, allowMissing: boolean): Promise<{ file: string; canonical: string; generation: string | null }> {
    file = path.resolve(file);
    const stat = await lstat(file, { bigint: true }).catch(error => {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('observation_directory');
    const generation = stat ? [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size].join(':') : null;
    let ancestor = file; const suffix: string[] = [];
    let canonical: string;
    for (;;) {
      try { canonical = path.join(await realpath(ancestor), ...suffix); break; }
      catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
        suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
    const after = await lstat(file, { bigint: true }).catch(error => {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (generation !== (after ? [after.dev, after.ino, after.ctimeNs, after.mtimeNs, after.size].join(':') : null)
      || after?.isSymbolicLink()) throw new Error('observation_directory_drift');
    return { file, canonical, generation };
  }
  async function buildIdentity(entry: URL): Promise<{ build: string; artifacts: ObservationIdentity['artifacts'] }> {
    const file = fileURLToPath(entry); const worker = await artifact(file);
    if (file.endsWith('.ts')) {
      return { build: observationDigest(['development_worker', worker, options.schema]), artifacts: [worker] };
    }
    const stampPath = path.resolve(path.dirname(file), '../runtime/build-stamp.json');
    const { pin: stampPin, text } = await readArtifact(stampPath);
    const stamp = JSON.parse(text) as Record<string, unknown>;
    if (stamp.gitDirty !== false || typeof stamp.gitSha !== 'string' || typeof stamp.sourceFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(stamp.sourceFingerprint) || stamp.expectedSchemaVersion !== options.schema) throw new Error('worker_stamp_unavailable');
    return { build: observationDigest([stamp.gitSha, stamp.sourceFingerprint, options.schema, worker, stampPin]), artifacts: [worker, stampPin] };
  }

  function start(): Promise<ActiveWorkSnapshot> {
    let resolveResult!: (value: ActiveWorkSnapshot) => void;
    const result = new Promise<ActiveWorkSnapshot>(resolve => { resolveResult = resolve; });
    const deadline = Date.now() + timeout;
    const current = { result }; physical = current;
    let worker: Worker | undefined, settled = false, closed = false;
    let identity: ObservationIdentity | undefined, inputs: PolicyInput[] | undefined, digest = '';
    let candidate: ActiveWorkSnapshot | undefined, accepted: ActiveWorkSnapshot | undefined;
    const settle = (value: ActiveWorkSnapshot) => { if (!settled) { settled = true; resolveResult(value); } };
    const finish = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      settle(accepted ?? unavailable());
      if (physical === current) physical = undefined;
      const next = followup; followup = undefined;
      if (next) { clearTimeout(next.timer); if (!next.expired) void start().then(next.resolve); }
    };
    const fail = () => {
      settle(unavailable());
      // Keep the physical single-flight slot until the thread really exits.
      // A timed-out native query must never overlap another inventory worker.
      if (worker) void worker.terminate().catch(() => {}); else finish();
    };
    const timer = setTimeout(fail, timeout); timer.unref();
    void (async () => {
      try {
        const entry = resolveActiveWorkWorkerEntry(moduleUrl, options.daemonEntry ?? process.argv[1]);
        const build = await buildIdentity(entry);
        const selections = await Promise.all([directorySelection(options.baseDir, false), directorySelection(options.workflowDir, true)]);
        if (settled || Date.now() > deadline) { finish(); return; }
        identity = { nonce: randomUUID(), epoch, build: build.build, artifacts: build.artifacts,
          baseDir: selections[0].canonical, workflowDir: selections[1].canonical,
          schema: options.schema, requestedAt: Date.now(), deadline };
        if (entry.pathname.endsWith('.ts')) {
          worker = new Worker(`const { workerData } = require('node:worker_threads');
            import(workerData.tsxApi).then(({ register }) => { register(); return import(workerData.entry); });`, {
            eval: true, workerData: { ...identity, tsxApi: import.meta.resolve('tsx/esm/api'), entry: entry.href },
            env: { ...workerEnvironment, CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', OPENAI_AGENTS_DISABLE_TRACING: '1' },
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
          });
        } else worker = new Worker(entry, { workerData: identity,
          env: { ...workerEnvironment, CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', OPENAI_AGENTS_DISABLE_TRACING: '1' },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 } });
        worker.on('message', (message: ObserverToMain) => {
          void (async () => {
            if (settled || !identity || !message || observationIdentityDigest(message.identity) !== observationIdentityDigest(identity)) { fail(); return; }
            if (message.type === 'policy') {
              if (inputs) { fail(); return; }
              inputs = message.inputs;
              const values = await evaluatePolicy(inputs, deadline); digest = policyMapDigest(inputs, values);
              if (!settled) worker?.postMessage({ type: 'policy', identity, values, policyDigest: digest });
            } else if (message.type === 'candidate') {
              if (!inputs || candidate || message.policyDigest !== digest || !validSnapshot(message.snapshot, identity)) { fail(); return; }
              candidate = message.snapshot;
              const currentValues = await evaluatePolicy(inputs, deadline);
              if (policyMapDigest(inputs, currentValues) !== digest) { fail(); return; }
              for (const pin of identity.artifacts) if (observationDigest(await artifact(pin.file)) !== observationDigest(pin)) { fail(); return; }
              for (const selection of selections) if (observationDigest(await directorySelection(selection.file, selection.generation === null)) !== observationDigest(selection)) { fail(); return; }
              if (!settled) worker?.postMessage({ type: 'validate', identity, policyDigest: digest });
            } else if (message.type === 'result') {
              if (message.policyDigest === '') { accepted = unavailable(); return; }
              if (!candidate || message.policyDigest !== digest || observationDigest(message.snapshot) !== observationDigest(candidate)
                || !validSnapshot(message.snapshot, identity) || Date.now() > deadline) { fail(); return; }
              accepted = message.snapshot;
            } else fail();
          })().catch(fail);
        });
        worker.once('error', fail);
        worker.once('exit', code => { if (code !== 0) accepted = undefined; finish(); });
      } catch { fail(); }
    })();
    return result;
  }
  return { read() {
    if (!physical) return start();
    if (!followup) {
      let resolve!: (value: ActiveWorkSnapshot) => void;
      const result = new Promise<ActiveWorkSnapshot>(done => { resolve = done; });
      const next = { result, resolve, expired: false, timer: setTimeout(() => {
        next.expired = true; next.resolve(unavailable('active_work_observer_busy'));
      }, timeout) };
      next.timer.unref(); followup = next;
    }
    return followup.result;
  } };
}
