#!/usr/bin/env node
/**
 * Release gate for the package users actually install.
 *
 * Prerequisite: build the candidate first (`npm run prepack` in the release
 * flow, or at least `npm run build` for this focused gate). This script never
 * builds or borrows the checkout's node_modules. It packs the current package,
 * installs that tgz into a fresh project, and boots only code from the install.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'clemmy-packed-candidate-'));
const packDir = path.join(scratch, 'pack');
const installDir = path.join(scratch, 'consumer');
const sandboxHome = path.join(scratch, 'user-home');
const runtimeHome = path.join(scratch, 'clementine-home');
const npmCache = path.join(scratch, 'npm-cache');
const CREDENTIAL_ENV_KEY = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION)(?:$|_)/i;

function pathWithoutCheckout(rawPath = '') {
  return rawPath.split(path.delimiter).filter((entry) => {
    if (!entry) return false;
    const relative = path.relative(repoRoot, path.resolve(entry));
    return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
  }).join(path.delimiter);
}

function fail(message, child) {
  const detail = child
    ? `\nstatus=${String(child.status)}\nstdout:\n${child.stdout ?? ''}\nstderr:\n${child.stderr ?? ''}`
    : '';
  throw new Error(`${message}${detail}`);
}

function isolatedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || CREDENTIAL_ENV_KEY.test(key)) continue;
    const lower = key.toLowerCase();
    if (
      key === 'NODE_OPTIONS'
      || key === 'NODE_PATH'
      || key === 'NODE_TEST_CONTEXT'
      || key === 'INIT_CWD'
      || key === 'PWD'
      || key === 'OLDPWD'
      || key === 'AUTH_MODE'
      || key.startsWith('CLEMMY_')
      || key.startsWith('CLEMENTINE_')
      || key.startsWith('CLEM_')
      || key.startsWith('MCP_')
      || lower.startsWith('npm_package_')
      || lower.startsWith('npm_lifecycle_')
      || lower === 'npm_execpath'
      || lower === 'npm_node_execpath'
      || lower === 'npm_config_local_prefix'
      || lower === 'npm_config_prefix'
    ) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH: pathWithoutCheckout(process.env.PATH),
    HOME: sandboxHome,
    USERPROFILE: sandboxHome,
    CLEMENTINE_HOME: runtimeHome,
    MCP_AUTO_IMPORT_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    WEBHOOK_ENABLED: 'false',
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function run(command, args, options = {}) {
  const cwd = path.resolve(options.cwd ?? repoRoot);
  const env = { ...(options.env ?? isolatedEnv()), PWD: cwd };
  delete env.OLDPWD;
  const child = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) fail(`${command} ${args.join(' ')} failed`, child);
  return child;
}

function jsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sha1File(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

function resultLine(child) {
  const prefix = 'PACKED_RUNTIME_PROCESS_RESULT ';
  const line = child.stdout.split('\n').find((row) => row.startsWith(prefix));
  if (!line) fail('installed runtime fixture emitted no retained result', child);
  return JSON.parse(line.slice(prefix.length));
}

function isWithin(candidate, parent) {
  const relative = path.relative(realpathSync(parent), realpathSync(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const installedRuntimeProbeSource = String.raw`
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const installedRoot = process.env.CLEMMY_INSTALLED_ROOT;
if (!installedRoot) throw new Error('packed runtime probe requires CLEMMY_INSTALLED_ROOT');
const phase = process.argv[2];
if (phase !== 'execute' && phase !== 'replay') throw new Error('packed runtime probe requires execute or replay');
const load = (relative) => import(pathToFileURL(path.join(installedRoot, 'dist', relative)).href);
const runner = await load('execution/workflow-runner.js');
const capability = await load('runtime/harness/reviewed-local-workflow-capability.js');
const manifests = await load('runtime/harness/capability-manifest-store.js');
const catalogs = await load('runtime/harness/host-capability-catalog-factory.js');
const ports = await load('runtime/harness/production-capability-ports.js');
const observations = await load('runtime/harness/independent-capability-observation.js');
const approvals = await load('runtime/harness/approval-registry.js');
const eventlog = await load('runtime/harness/eventlog.js');
const shipped = await load('runtime/harness/shipped-implementation-identity.js');

const args = {
  bundle_id: 'packed-candidate-portal',
  mode: 'content_addressed',
  files: [
    { path: 'index.html', content: '<h1>Packed candidate portal</h1>' },
    { path: 'server.mjs', content: 'export const packedCandidate = true;\n' },
  ],
};
const step = {
  id: 'build_bundle',
  prompt: '',
  sideEffect: 'write',
  call: { tool: 'artifact_bundle_save', args },
};
const workflow = {
  name: 'packed-candidate-production-carrier',
  description: 'Exercise the installed production local carrier.',
  enabled: false,
  trigger: { manual: true },
  inputs: {},
  steps: [step],
};
const ctx = {
  workflow,
  workflowSlug: workflow.name,
  runId: 'run-packed-candidate-production-carrier',
  inputs: {},
  stepOutputs: {},
  assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
  completedItems: new Map(),
  forEachFailures: [],
  qualityAdvisories: [],
};
const snapshot = (directory) => ['.clementine-bundle.json', 'index.html', 'server.mjs'].map((relative) => {
  const absolute = path.join(directory, relative);
  const stat = statSync(absolute);
  return {
    relative,
    bytes: readFileSync(absolute).toString('base64'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
});

eventlog.closeEventLog();
manifests.installCapabilityManifestStore(null);
catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
ports.clearProductionCapabilityPorts();
observations.clearIndependentCapabilityObservations();
const materialized = capability.ensureReviewedLocalWorkflowCapability({
  operationId: 'artifact_bundle_save',
  args,
});
if (!materialized.ok) {
  throw new Error('reviewed local capability did not materialize: ' + materialized.reason + ':' + (materialized.detail ?? ''));
}
if (materialized.manifest.providerKind !== 'local_registry'
    || materialized.manifest.operationId !== 'artifact_bundle_save'
    || materialized.manifest.effect !== 'local_write') {
  throw new Error('packed probe materialized the wrong production capability');
}
const productionPort = ports.resolveProductionPortsForManifest(materialized.manifest);
if (!productionPort?.reconcile) throw new Error('emitted production invoke/reconcile port is unavailable');
const provenance = shipped.peekShippedProvenance(productionPort.invoke);
if (!provenance || provenance.kind !== 'invoke') throw new Error('reviewed local port lacks shipped invoke provenance');
const sessionId = 'workflow:' + ctx.runId + ':' + step.id;
if (phase === 'execute') {
  let parked;
  try {
    await runner.executeStep(step, ctx);
  } catch (error) {
    parked = error;
  }
  if (!(parked instanceof runner.ParkRunSignal)) {
    throw new Error('first production call did not park for consent: ' + String(parked));
  }
  const pending = approvals.listPending({ sessionId, status: 'pending' });
  if (pending.length !== 1) throw new Error('expected one pending approval, found ' + pending.length);
  if (pending[0].tool !== 'workflow_v3_call'
      || pending[0].args?.operationId !== 'artifact_bundle_save'
      || pending[0].args?.accountId !== 'local_registry:host'
      || pending[0].args?.effect !== 'local_write') {
    throw new Error('pending approval does not bind the exact reviewed local call');
  }
  const beforeConsent = eventlog.openEventLog();
  const physicalBeforeConsent = beforeConsent.prepare(
    'SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?',
  ).get(sessionId).n;
  if (physicalBeforeConsent !== 0) throw new Error('production body crossed before exact consent');
  if (existsSync(path.join(process.env.CLEMENTINE_HOME ?? '', 'files', 'bundles', args.bundle_id))) {
    throw new Error('local artifact bytes existed before exact consent');
  }
  const resolved = approvals.resolve(pending[0].approvalId, 'approved', 'packed-candidate-process');
  if (!resolved.ok) throw new Error('approval did not resolve: ' + resolved.reason);
}

const completed = await runner.executeStep(step, ctx);
const reconciled = await productionPort.reconcile({
  intendedDigest: completed.revisionDigest,
  artifactId: completed.artifactId,
});
const db = eventlog.openEventLog();
const counts = {
  logical: db.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ?').get(sessionId).n,
  physical: db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?').get(sessionId).n,
  settlements: db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?').get(sessionId).n,
};
process.stdout.write('PACKED_RUNTIME_PROCESS_RESULT ' + JSON.stringify({
  phase,
  capability: {
    providerKind: materialized.manifest.providerKind,
    operationId: materialized.manifest.operationId,
    effect: materialized.manifest.effect,
  },
  completed,
  reconciled,
  snapshot: snapshot(completed.directory),
  counts,
  provenance,
}) + '\n');
eventlog.closeEventLog();
`;

try {
  const candidateStampPath = path.join(repoRoot, 'dist/runtime/build-stamp.json');
  const candidateManifestPath = path.join(
    repoRoot,
    'dist/runtime/harness/implementation-artifacts/emitted/manifest.json',
  );
  if (!existsSync(candidateStampPath) || !existsSync(candidateManifestPath)) {
    fail('candidate is not built; run npm run prepack before the packed-candidate gate');
  }

  const candidateStamp = jsonFile(candidateStampPath);
  const candidateManifest = jsonFile(candidateManifestPath);
  const sourceIdentity = await import(pathToFileURL(path.join(repoRoot, 'dist/runtime/source-fingerprint.js')).href);
  const currentFingerprint = sourceIdentity.fingerprintRuntimeSourceFromGit({ repoRoot });
  assert.equal(
    candidateStamp.sourceFingerprint,
    currentFingerprint,
    'dist build stamp is stale for the current candidate source; rebuild before packing',
  );
  assert.equal(
    candidateStamp.gitSha,
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    'dist build stamp belongs to another commit',
  );
  assert.equal(candidateStamp.implementationManifestDigest, candidateManifest.manifestDigest);

  for (const directory of [packDir, installDir, sandboxHome, runtimeHome, npmCache]) {
    mkdirSync(directory, { recursive: true });
  }

  const packed = run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir,
  ]);
  const packReport = JSON.parse(packed.stdout);
  assert.equal(Array.isArray(packReport), true, 'npm pack did not return its closed JSON report');
  assert.equal(packReport.length, 1, 'npm pack returned more than one candidate');
  const entry = packReport[0];
  const packedFiles = new Set((entry.files ?? []).map((item) => item.path));
  for (const required of [
    'package.json',
    'dist/index.js',
    'dist/runtime/build-stamp.json',
    'dist/runtime/harness/implementation-artifacts/emitted/manifest.json',
  ]) assert.equal(packedFiles.has(required), true, `npm tarball omitted ${required}`);
  const leakedSourceFixture = [...packedFiles].find((file) => (
    file === 'dist/execution/reviewed-local-workflow-v3-process.fixture.js'
    || file === 'dist/runtime/harness/current-capability-manifest.fixture.js'
    || /^dist\/journeys\/.*\.fixture(?:-support)?\.js$/.test(file)
  ));
  assert.equal(
    leakedSourceFixture,
    undefined,
    `test-only source fixture leaked into the production tarball: ${leakedSourceFixture}`,
  );
  assert.equal(
    [...packedFiles].some((file) => file.endsWith('.ts')),
    false,
    'npm tarball unexpectedly contains TypeScript source',
  );
  const packedWebFiles = [];
  for (const app of ['mobile-web', 'console-web']) {
    const index = `apps/${app}/dist/index.html`;
    assert.equal(packedFiles.has(index), true, `npm tarball omitted ${index}`);
    const asset = [...packedFiles]
      .filter((file) => file.startsWith(`apps/${app}/dist/assets/`))
      .sort()[0];
    assert.ok(asset, `npm tarball omitted built ${app} assets`);
    packedWebFiles.push(index, asset);
  }
  const tarball = path.join(packDir, entry.filename);
  assert.equal(existsSync(tarball), true, 'npm pack reported a tarball that does not exist');
  assert.equal(sha1File(tarball), entry.shasum, 'npm tarball bytes do not match npm pack shasum');

  writeFileSync(path.join(installDir, 'package.json'), `${JSON.stringify({
    name: 'clemmy-packed-candidate-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  run('npm', [
    'install',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--omit=optional',
    tarball,
  ], { cwd: installDir, timeout: 600_000 });

  const installedRoot = path.join(installDir, 'node_modules', 'clemmy');
  assert.equal(existsSync(installedRoot), true, 'fresh npm project did not contain clemmy');
  assert.equal(lstatSync(path.join(installDir, 'node_modules')).isSymbolicLink(), false);
  assert.equal(lstatSync(installedRoot).isSymbolicLink(), false, 'npm linked the checkout instead of installing the tgz');
  assert.equal(isWithin(installedRoot, installDir), true, 'installed package escaped its fresh project');
  assert.equal(isWithin(installedRoot, repoRoot), false, 'installed package resolves inside the checkout');
  const installedPackage = jsonFile(path.join(installedRoot, 'package.json'));
  assert.equal(installedPackage.name, entry.name);
  assert.equal(installedPackage.version, entry.version);
  assert.equal(installedPackage.main, 'dist/index.js');
  assert.equal(installedPackage.bin?.clementine, 'dist/index.js');
  for (const relative of packedWebFiles) {
    assert.equal(
      existsSync(path.join(installedRoot, relative)),
      true,
      `fresh install omitted ${relative}`,
    );
  }

  const installedRequire = createRequire(path.join(installDir, 'package.json'));
  const installedSqlite = installedRequire.resolve('better-sqlite3');
  assert.equal(isWithin(installedSqlite, installDir), true, 'runtime dependency resolved outside the fresh install');
  assert.equal(isWithin(installedSqlite, path.join(repoRoot, 'node_modules')), false, 'runtime borrowed repo node_modules');

  const installedStampPath = path.join(installedRoot, 'dist/runtime/build-stamp.json');
  const installedManifestPath = path.join(
    installedRoot,
    'dist/runtime/harness/implementation-artifacts/emitted/manifest.json',
  );
  assert.equal(readFileSync(installedStampPath, 'utf8'), readFileSync(candidateStampPath, 'utf8'));
  assert.equal(readFileSync(installedManifestPath, 'utf8'), readFileSync(candidateManifestPath, 'utf8'));
  const installedStamp = jsonFile(installedStampPath);
  const installedManifest = jsonFile(installedManifestPath);
  assert.equal(installedStamp.sourceFingerprint, currentFingerprint);
  assert.equal(installedStamp.implementationManifestDigest, installedManifest.manifestDigest);
  for (const kind of ['invoke', 'reconcile', 'observer', 'transport', 'transportIsolated']) {
    const artifact = installedManifest.artifacts?.[kind];
    assert.ok(artifact, `installed implementation manifest omitted ${kind}`);
    assert.equal(
      sha256File(path.join(path.dirname(installedManifestPath), artifact.file)),
      artifact.sha256,
      `installed ${kind} bytes do not match their shipped digest`,
    );
    assert.equal(installedStamp.artifacts?.[kind], artifact.sha256, `build stamp omitted ${kind} identity`);
  }

  const installedCli = path.join(installedRoot, 'dist/index.js');
  const installedProbe = path.join(installDir, 'packed-runtime-probe.mjs');
  writeFileSync(installedProbe, installedRuntimeProbeSource);
  const runtimeEnv = { ...isolatedEnv(), CLEMMY_INSTALLED_ROOT: installedRoot };
  const cliFirst = run(process.execPath, [installedCli, 'init-home'], { cwd: installDir, timeout: 60_000 });
  assert.match(cliFirst.stdout, /Initialized Clementine home at/);
  const cliSecond = run(process.execPath, [installedCli, 'init-home'], { cwd: installDir, timeout: 60_000 });
  assert.match(cliSecond.stdout, /Initialized Clementine home at/);

  const first = resultLine(run(process.execPath, [installedProbe, 'execute'], {
    cwd: installDir,
    env: runtimeEnv,
    timeout: 120_000,
  }));
  assert.equal(first.phase, 'execute');
  assert.equal(first.completed.created, true);
  assert.deepEqual(first.counts, { logical: 1, physical: 1, settlements: 1 });
  assert.equal(first.provenance.kind, 'invoke');
  assert.equal(first.provenance.artifactDigest, installedManifest.artifacts.invoke.sha256);
  assert.equal(first.provenance.transportDigest, installedManifest.artifacts.transport.sha256);
  assert.equal(first.provenance.loadGeneration, installedManifest.manifestDigest);
  assert.equal(isWithin(first.provenance.artifactPath, installedRoot), true, 'runtime loaded an artifact outside the install');
  assert.deepEqual(first.capability, {
    providerKind: 'local_registry',
    operationId: 'artifact_bundle_save',
    effect: 'local_write',
  });
  assert.equal(first.reconciled.exists, true);
  assert.equal(first.reconciled.contentDigest, first.completed.revisionDigest);

  // A second OS process reopens the same disposable home. Its model proxy is
  // fail-closed, the only capability is local_registry, and the retained
  // physical/settlement cardinality plus unchanged bytes/times is the replay
  // oracle: no model, provider, or second local body can be hidden here.
  const replay = resultLine(run(process.execPath, [installedProbe, 'replay'], {
    cwd: installDir,
    env: runtimeEnv,
    timeout: 120_000,
  }));
  assert.equal(replay.phase, 'replay');
  assert.deepEqual(replay.completed, first.completed);
  assert.deepEqual(replay.reconciled, first.reconciled);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.deepEqual(replay.counts, { logical: 1, physical: 1, settlements: 1 });
  assert.equal(replay.provenance.artifactDigest, installedManifest.artifacts.invoke.sha256);
  assert.equal(replay.provenance.transportDigest, installedManifest.artifacts.transport.sha256);
  assert.equal(replay.provenance.loadGeneration, installedManifest.manifestDigest);
  assert.equal(isWithin(replay.provenance.artifactPath, installedRoot), true);

  const finalFingerprint = sourceIdentity.fingerprintRuntimeSourceFromGit({ repoRoot });
  assert.equal(finalFingerprint, currentFingerprint, 'candidate source changed while the tarball gate was running');
  assert.equal(finalFingerprint, installedStamp.sourceFingerprint);

  process.stdout.write(`PACKED_CANDIDATE_SMOKE ${JSON.stringify({
    package: `${entry.name}@${entry.version}`,
    tarball: entry.filename,
    packedFiles: packedFiles.size,
    sourceFingerprint: installedStamp.sourceFingerprint,
    implementationManifestDigest: installedManifest.manifestDigest,
    invokeDigest: installedManifest.artifacts.invoke.sha256,
    transportDigest: installedManifest.artifacts.transport.sha256,
    processA: first.counts,
    processB: replay.counts,
    replayAdded: { logical: 0, physical: 0, settlements: 0 },
    modelBodyCrossings: 0,
    providerBodyCrossings: 0,
    localBodyCrossings: 1,
    replayAddedLocalBodyCrossings: 0,
  })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
