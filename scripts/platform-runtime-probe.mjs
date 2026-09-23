#!/usr/bin/env node
/**
 * Platform runtime probe: run the durable-storage and child-process paths that
 * a chat turn, a workflow code step, and a Composio transfer take, then boot
 * the daemon the way the desktop supervisor does, all against a BUILT daemon
 * dist under the exact binary that will run it in production.
 *
 *   node scripts/platform-runtime-probe.mjs --dist dist
 *   node scripts/platform-runtime-probe.mjs \
 *     --dist <win-unpacked>/resources/daemon/dist \
 *     --exec <win-unpacked>/Clementine.exe \
 *     --resources <win-unpacked>/resources
 *
 * Every probe runs and reports, so one run on a new platform yields its whole
 * punch list; the process exits 1 if any probe failed. No model is called and
 * no credentials are read: HOME, USERPROFILE and CLEMENTINE_HOME point at a
 * fresh temp directory, and credential-shaped environment keys are dropped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RESULT_PREFIX = 'PLATFORM_RUNTIME_PROBE_RESULT ';
const SCRATCH_ENV = 'CLEMENTINE_PLATFORM_PROBE_SCRATCH';
const CREDENTIAL_ENV_KEY = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION)(?:$|_)/i;
// The desktop supervisor's own readiness window (apps/desktop/src/daemon-supervisor.ts).
const BOOT_READY_TIMEOUT_MS = 90_000;
const BOOT_SETTLE_MS = 3_000;
const PINO_ERROR_LEVEL = 50;
const thisFile = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const options = { child: false, skipBoot: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--child') options.child = true;
    else if (arg === '--skip-boot') options.skipBoot = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--dist') options.dist = path.resolve(value());
    else if (arg === '--exec') options.exec = path.resolve(value());
    else if (arg === '--resources') options.resources = path.resolve(value());
    else if (arg === '--report') options.report = path.resolve(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dist) throw new Error('--dist <daemon dist directory> is required');
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorSummary(error) {
  const summary = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const code = typeof current === 'object' && typeof current.code === 'string' ? `${current.code}: ` : '';
    summary.push(`${code}${current instanceof Error ? current.message : String(current)}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return summary.join(' <- ').slice(0, 1_000);
}

function isolatedEnv(scratch, label) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || CREDENTIAL_ENV_KEY.test(key)) continue;
    if (
      key === 'NODE_OPTIONS'
      || key === 'NODE_PATH'
      || key === 'ELECTRON_RUN_AS_NODE'
      || key.startsWith('CLEMMY_')
      || key.startsWith('CLEMENTINE_')
      || key.startsWith('CLEM_')
      || key.startsWith('MCP_')
    ) continue;
    env[key] = value;
  }
  const userHome = path.join(scratch, label, 'user-home');
  const clementineHome = path.join(scratch, label, 'clementine-home');
  mkdirSync(userHome, { recursive: true });
  mkdirSync(clementineHome, { recursive: true });
  return {
    ...env,
    HOME: userHome,
    USERPROFILE: userHome,
    CLEMENTINE_HOME: clementineHome,
    [SCRATCH_ENV]: scratch,
    MCP_AUTO_IMPORT_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
  };
}

// ---------------------------------------------------------------------------
// Child: the probes themselves, running under the production binary.
// ---------------------------------------------------------------------------

async function runChild(options) {
  const scratch = process.env[SCRATCH_ENV];
  const home = process.env.CLEMENTINE_HOME;
  if (!scratch || !home || !realpathSync(home).startsWith(realpathSync(scratch))) {
    throw new Error('platform probe refuses to run outside its own temp CLEMENTINE_HOME');
  }
  const load = (relative) => import(pathToFileURL(path.join(options.dist, relative)).href);
  const workDir = path.join(scratch, 'storage', 'work');
  mkdirSync(workDir, { recursive: true });
  const probes = [];
  const probe = async (name, body) => {
    const startedAt = Date.now();
    try {
      const outcome = await body();
      const skipped = outcome && typeof outcome === 'object' && outcome.skip;
      probes.push({
        name,
        status: skipped ? 'skip' : 'pass',
        ms: Date.now() - startedAt,
        ...(skipped ? { detail: outcome.skip } : outcome ? { detail: outcome } : {}),
      });
    } catch (error) {
      probes.push({ name, status: 'fail', ms: Date.now() - startedAt, error: errorSummary(error) });
    }
  };

  // The service boot order: seal key, then the home scaffold.
  await probe('authority_seal_key', async () => {
    const seal = await load('runtime/harness/authority-argument-seal.js');
    return { provisioned: seal.provisionAuthoritySealKey() };
  });
  await probe('init_home', async () => {
    const init = await load('setup/init-home.js');
    await init.initHome();
  });

  // Loads the native SQLite binding under this binary's ABI.
  let eventlog = null;
  await probe('sqlite_eventlog', async () => {
    eventlog = await load('runtime/harness/eventlog.js');
    eventlog.openEventLog();
  });

  // Every host turn records its exact model request before dispatch.
  await probe('turn_provenance', async () => {
    const provenance = await load('runtime/harness/model-request-provenance.js');
    const authority = await load('runtime/harness/accepted-turn-call-authority.js');
    const promptCache = await load('runtime/harness/prompt-cache-observation.js');
    const session = eventlog.createSession({ id: `platform-probe-${randomUUID()}`, kind: 'chat' });
    const text = 'Platform probe: record this request exactly as a turn would.';
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text },
    });
    const armed = authority.armHostCallAuthority({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      catalogRevisionDigest: sha256('platform-probe:catalog'),
      bindingRevisionDigest: sha256('platform-probe:binding'),
      maxLogicalCalls: 4,
      maxParallelCalls: 2,
    });
    if (armed.status !== 'armed') throw new Error(`host call authority did not arm: ${JSON.stringify(armed)}`);
    const request = {
      systemInstructions: 'Stable host policy.',
      input: [{ role: 'user', content: text }],
      modelSettings: {},
      tools: [],
      toolsExplicitlyProvided: true,
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };
    const admitted = provenance.recordModelRequestDispatchProvenance({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      request,
      hostProjection: promptCache.canonicalPromptCacheRequest(request),
    });
    const projected = provenance.projectModelRequestProvenance(admitted.record.recordId);
    if (projected.status !== 'ok') throw new Error(`recorded request did not read back: ${projected.reason}`);
  });

  await probe('result_payload_spill', async () => {
    const storage = await load('runtime/harness/result-payload-storage.js');
    const rawJson = JSON.stringify({
      successful: true,
      data: { blob: 'x'.repeat(storage.RESULT_PAYLOAD_INLINE_MAX_BYTES + 64) },
    });
    const digest = sha256(rawJson);
    const byteCount = Buffer.byteLength(rawJson, 'utf8');
    storage.persistSpilledResultPayload({ rawJson, digest, byteCount });
    const read = storage.readDurableResultPayload({
      rawLocation: 'tool_output:platform-probe',
      rawPayloadJson: storage.RESULT_PAYLOAD_SPILL_SENTINEL,
      rawPayloadSha256: digest,
      rawByteCount: byteCount,
      rejectionReason: null,
    });
    if (read.status !== 'ok' || read.storage !== 'spill') {
      throw new Error(`spilled result did not read back: ${read.status} ${read.reason ?? ''}`);
    }
  });

  await probe('artifact_bundle', async () => {
    const bundles = await load('tools/artifact-bundle-core.js');
    const content = '<h1>Platform probe</h1>\n';
    const input = { bundleId: 'platform-probe', files: [{ path: 'index.html', content }] };
    const first = bundles.saveArtifactBundle(input);
    // A second save takes the verify-existing-revision path.
    const second = bundles.saveArtifactBundle(input);
    if (second.revisionDigest !== first.revisionDigest) throw new Error('identical bundle got a new revision');
    if (readFileSync(path.join(first.directory, 'index.html'), 'utf8') !== content) {
      throw new Error('published bundle bytes differ');
    }
  });

  await probe('workspace_snapshot', async () => {
    const snapshots = await load('spaces/workspace-snapshot.js');
    const directory = path.join(workDir, 'workspace');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'view.json');
    snapshots.writeWorkspaceSnapshotFile(file, '{"probe":true}\n');
    if (readFileSync(file, 'utf8') !== '{"probe":true}\n') throw new Error('snapshot bytes differ');
  });

  await probe('composio_staged_blob', async () => {
    const blobs = await load('integrations/composio/staged-file-blob-store.js');
    const root = path.join(workDir, 'staged');
    const store = path.join(root, 'store');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('platform probe staged bytes\n', 'utf8');
    const writer = blobs.createStagedFileBlobWriter({ storeDirectory: store });
    writer.write(bytes);
    const sealed = writer.seal({ sha256: sha256(bytes), byteCount: bytes.byteLength });
    const published = blobs.publishStagedFileBlob({ storeDirectory: store, sealed });
    const destinationDirectory = path.join(root, 'materialized', 'probe');
    const destinationName = '000001-0123456789abcdef-probe.bin';
    blobs.materializeStagedFileBlob({ blob: published, destinationDirectory, destinationName });
    blobs.verifyStagedFileMaterialization({ blob: published, destinationDirectory, destinationName });
  });

  // Workflow code steps: the same interpreter, env and spawn the runner uses.
  const sandbox = await load('runtime/sandboxed-script.js');
  const spawnEnv = await load('runtime/spawn-env.js');
  const runCodeStep = async (fileName, source) => {
    const script = path.join(workDir, fileName);
    writeFileSync(script, source);
    const interp = sandbox.interpreterFor(script, spawnEnv.augmentPath(process.env.PATH));
    if (!interp) return { skip: `no interpreter for ${fileName}` };
    if (!interp.isElectron && !path.isAbsolute(interp.command)) {
      return { skip: `${path.basename(interp.command)} is not installed on this machine` };
    }
    const env = sandbox.scrubbedChildEnv({
      CLEMENTINE_WORKFLOW_RUN_ID: 'platform-probe',
      CLEMENTINE_WORKFLOW_STEP_ID: fileName,
      ...sandbox.electronNodeEnv(interp.command, interp.isElectron),
    });
    const outcome = await sandbox.spawnSandboxedScript({
      command: interp.command,
      args: interp.args,
      cwd: workDir,
      env,
      stdinPayload: '{}',
      timeoutMs: 30_000,
    });
    if (outcome.launchError) throw outcome.launchError;
    if (outcome.timedOut || outcome.code !== 0) {
      throw new Error(`exit ${outcome.code ?? outcome.signal}${outcome.timedOut ? ' (timed out)' : ''}: ${outcome.stderr.trim().slice(-600)}`);
    }
    const parsed = JSON.parse(outcome.stdout.trim());
    if (parsed.ok !== true) throw new Error(`step reported failure: ${outcome.stdout.trim()}`);
    return { command: path.basename(interp.command) };
  };
  await probe('workflow_code_node', () => runCodeStep('probe-step.mjs', [
    "import { createServer } from 'node:net';",
    "import { randomBytes } from 'node:crypto';",
    'const server = createServer();',
    "await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });",
    'server.close();',
    "process.stdout.write(JSON.stringify({ ok: true, random: randomBytes(4).toString('hex') }));",
    '',
  ].join('\n')));
  await probe('workflow_code_python', () => runCodeStep('probe_step.py', [
    'import json, os, socket',
    'sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
    "sock.bind(('127.0.0.1', 0))",
    'sock.close()',
    "print(json.dumps({'ok': True, 'random': os.urandom(4).hex()}))",
    '',
  ].join('\n')));

  try { eventlog?.closeEventLog(); } catch { /* reporting matters more than close */ }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      execPath: process.execPath,
    },
    probes,
  })}\n`);
}

// ---------------------------------------------------------------------------
// Driver: isolate, run the child probes, boot the daemon, report.
// ---------------------------------------------------------------------------

function runStorageProbes(options, scratch, exec) {
  const env = { ...isolatedEnv(scratch, 'storage'), ELECTRON_RUN_AS_NODE: '1' };
  const child = spawnSync(exec, [thisFile, '--child', '--dist', options.dist], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (child.stdout ?? '').split(/\r?\n/).find((row) => row.startsWith(RESULT_PREFIX));
  if (!line) {
    const tail = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim().split(/\r?\n/).slice(-30).join('\n');
    return {
      runtime: null,
      probes: [{
        name: 'storage_probes',
        status: 'fail',
        ms: 0,
        error: `probe child produced no result (status ${child.status ?? child.signal ?? child.error?.message})\n${tail}`,
      }],
    };
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }
}

async function bootDaemon(options, scratch, exec) {
  const startedAt = Date.now();
  const port = await freePort();
  // Mirror the supervisor's packaged launch: `<exec> <dist>/index.js service`,
  // run as Node, cwd at the daemon project root, loopback webhook on a chosen port.
  const env = {
    ...isolatedEnv(scratch, 'boot'),
    ELECTRON_RUN_AS_NODE: '1',
    WEBHOOK_ENABLED: 'true',
    WEBHOOK_PORT: String(port),
    WEBHOOK_HOST: '127.0.0.1',
    ...(options.resources ? { CLEMENTINE_RESOURCES_PATH: options.resources } : {}),
  };
  const child = spawn(exec, [path.join(options.dist, 'index.js'), 'service'], {
    cwd: path.dirname(options.dist),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  const errors = [];
  const collect = (chunk) => {
    for (const row of String(chunk).split(/\r?\n/)) {
      if (!row.trim()) continue;
      lines.push(row);
      if (lines.length > 400) lines.shift();
      try {
        const entry = JSON.parse(row);
        if (typeof entry.level === 'number' && entry.level >= PINO_ERROR_LEVEL) {
          errors.push(`${entry.msg ?? '(no message)'}${entry.err?.message ? `: ${entry.err.message}` : ''}`.slice(0, 400));
        }
      } catch { /* non-JSON output is kept for the tail only */ }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = null;
  child.on('exit', (code, signal) => { exited = code ?? signal; });
  child.on('error', (error) => { exited = error.message; });

  let ready = false;
  const deadline = Date.now() + BOOT_READY_TIMEOUT_MS;
  while (Date.now() < deadline && exited === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) { ready = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (ready) await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS));
  stopTree(child);
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
    setTimeout(resolve, 10_000).unref();
  });

  const ms = Date.now() - startedAt;
  if (!ready) {
    return {
      name: 'daemon_boot',
      status: 'fail',
      ms,
      error: `daemon ${exited === null ? `did not answer /api/status within ${BOOT_READY_TIMEOUT_MS} ms` : `exited before ready (${exited})`}\n${lines.slice(-40).join('\n')}`,
    };
  }
  if (errors.length > 0) {
    return { name: 'daemon_boot', status: 'fail', ms, error: `ready, but boot logged errors:\n${errors.join('\n')}` };
  }
  return { name: 'daemon_boot', status: 'pass', ms };
}

async function runDriver(options) {
  const exec = options.exec ?? process.execPath;
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-platform-probe-')));
  try {
    const storage = runStorageProbes(options, scratch, exec);
    const probes = [...storage.probes];
    if (!options.skipBoot) probes.push(await bootDaemon(options, scratch, exec));
    const failed = probes.filter((entry) => entry.status === 'fail');
    const report = { exec, dist: options.dist, runtime: storage.runtime, probes, ok: failed.length === 0 };

    console.log(`Platform runtime probe: ${storage.runtime ? `${storage.runtime.platform}-${storage.runtime.arch}, node ${storage.runtime.node}${storage.runtime.electron ? `, electron ${storage.runtime.electron}` : ''}` : exec}`);
    for (const entry of probes) {
      const note = typeof entry.detail === 'string' ? `  ${entry.detail}` : '';
      console.log(`  ${entry.status.toUpperCase().padEnd(4)}  ${entry.name.padEnd(22)} ${String(entry.ms).padStart(6)} ms${note}`);
      if (entry.error) console.log(entry.error.split('\n').map((row) => `        ${row}`).join('\n'));
    }
    console.log(failed.length === 0
      ? 'Platform runtime probe: OK'
      : `Platform runtime probe: ${failed.length} of ${probes.length} failed (${failed.map((entry) => entry.name).join(', ')})`);
    if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (options.keep) console.log(`kept probe scratch at ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.child) {
  await runChild(options);
} else {
  process.exitCode = await runDriver(options);
}
