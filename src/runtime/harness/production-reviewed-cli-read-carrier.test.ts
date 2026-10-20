/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-reviewed-cli-read-carrier.test.ts */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { CapabilityManifestV1 } from './capability-manifest.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-cli-read-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'c7'.repeat(32);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

// The real production port executes pinned emitted bytes, including its own
// reviewed-CLI leaf. Emit this source tree before any module pins a generation;
// the replay child must inherit the exact same disposable artifact root.
const previousArtifactRoot = process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT;
const artifactRoot = path.join(TEST_HOME, 'implementation-artifacts');
process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT = artifactRoot;
const implementations = await import('./shipped-implementation-identity.js');
implementations.emitShippedImplementationArtifacts(artifactRoot);
implementations.installImplementationArtifactRoot(artifactRoot);

const config = await import('./reviewed-cli-read-config.js');
const acquisition = await import('./production-live-read-acquisition-registry.js');
const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const kernel = await import('./workflow-read-only-call-kernel.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const manifests = await import('./capability-manifest.js');
const capabilityIndex = await import('../../memory/capability-index.js');
const transport = await import('./reviewed-cli-read-transport.js');
const { mergedSpawnEnv } = await import('../spawn-env.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  if (previousArtifactRoot === undefined) delete process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT;
  else process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT = previousArtifactRoot;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const nonce = randomBytes(7).toString('hex');
const operationId = `read_${nonce}_constellation`;
const fieldName = `filter_${nonce}`;
const optionToken = `--${fieldName}`;
const objective = `observe ${nonce} constellation`;
const executable = path.join(TEST_HOME, `bin-${nonce}`);
const counterFile = path.join(TEST_HOME, `counter-${nonce}`);
const shellMarker = path.join(TEST_HOME, `shell-marker-${nonce}`);

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function writeExecutable(extra = ''): void {
  writeFileSync(executable, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `const counter = ${JSON.stringify(counterFile)};`,
    "const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counter, String(n));",
    extra,
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), n }) + '\\n');",
  ].join('\n'), 'utf8');
  chmodSync(executable, 0o700);
}

async function provision(descriptorId = `descriptor-${nonce}`, description = objective) {
  return config.provisionReviewedCliReadDescriptor({
    version: 1,
    descriptorId,
    operationId: descriptorId === `descriptor-${nonce}`
      ? operationId
      : `read_${descriptorId.replace(/[^a-z0-9]/gi, '_')}`,
    displayName: description,
    description,
    effect: 'read',
    accountId: 'reviewed_cli:host',
    executablePath: executable,
    argvPrefix: [`subcommand-${nonce}`],
    arguments: [{
      name: fieldName,
      kind: 'option',
      token: optionToken,
      valueType: 'string',
      required: true,
    }],
    limits: {
      timeoutMs: 2_000,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 4_096,
      maxArgumentBytes: 4_096,
    },
  });
}

function bodyCount(): number {
  return existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
}

async function acquireCurrent(label: string) {
  return acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: `requirement-${label}-${nonce}`,
    objective,
    effect: 'read',
  });
}

async function invokeInstalled(
  manifest: CapabilityManifestV1,
  args: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const port = ports.resolveProductionPortsForManifest(manifest);
  assert.ok(port?.invoke);
  if (!port?.invoke) return null;
  return port.invoke({
    nodeId: `node-${label}-${nonce}`,
    role: 'source',
    payload: args,
    identity: {
      sessionId: `direct-${label}-${nonce}`,
      sourceUserSeq: 1,
      acceptedTaskId: `task-${label}-${nonce}`,
    },
    binding: {
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      args,
      account: manifest.accountId,
      effect: 'read',
      manifestDigest: manifests.capabilityManifestDigest(manifest),
      providerKind: 'reviewed_cli',
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: port.invoke,
    },
  });
}

test('ordinary production acquisition materializes a configured reviewed CLI and the shared kernel replays after reopen with zero second body', async () => {
  writeExecutable();
  process.env.PATH = `${TEST_HOME}${path.delimiter}${process.env.PATH ?? ''}`;
  capabilityIndex.recordCapabilityOperations([{
    identifier: operationId,
    carrierKind: 'cli',
    carrier: 'path-scan',
    displayName: objective,
    description: objective,
    effectClass: 'unknown',
    effectProvenance: 'none',
  }]);

  const unreviewed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: `requirement-unreviewed-${nonce}`,
    objective,
    effect: 'read',
  });
  assert.equal(unreviewed.status, 'blocked');
  if (unreviewed.status === 'blocked') assert.equal(unreviewed.reason, 'missing');
  assert.equal(existsSync(counterFile), false, 'PATH-visible or executable files are not reviewed authority');

  const descriptor = await provision();
  assert.equal(descriptor.executableRealpath, realpathSync(executable));
  assert.equal(config.listReviewedCliReadDescriptors().length, 1);

  const installed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: `requirement-${nonce}`,
    objective,
    effect: 'read',
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status !== 'installed') return;
  assert.equal(installed.manifest.providerKind, 'reviewed_cli');
  assert.equal(installed.manifest.providerIdentity, descriptor.executableRealpath);
  assert.equal(installed.manifest.providerVersion, descriptor.binarySha256);
  assert.equal(installed.manifest.accountId, 'reviewed_cli:host');
  assert.equal(installed.manifest.effect, 'read');
  const port = ports.resolveProductionPortsForManifest(installed.manifest);
  assert.ok(port?.invoke);
  assert.deepEqual(port?.argv, [descriptor.executableRealpath, `subcommand-${nonce}`]);

  const factory = catalogs.peekHostCapabilityCatalogFactory();
  const catalog = factory?.get(installed.manifest.manifestId);
  assert.ok(catalog);
  const identity = catalog ? catalogs.canonicalCatalogIdentityOf(catalog) : null;
  assert.ok(identity);
  if (!identity) return;
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement-${nonce}`,
    logicalCapabilityId: `logical-capability-${nonce}`,
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      [fieldName]: {
        source: { kind: 'workflow_input', key: fieldName },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['result.status', 'result.stdout'],
      nonEmptyPaths: ['result.stdout'],
      minItems: {},
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['result.status'] },
    continuation: { kind: 'none' },
  });
  const sessionId = `workflow-cli-${nonce}`;
  const session = eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const armed = authority.armWorkflowReadOnlyCallAuthority({
    sessionId: session.id,
    workflowId: `workflow-${nonce}`,
    workflowRevision: 1,
    workflowDigest: digest(`workflow:${nonce}`),
    runId: `run-${nonce}`,
    runOccurrenceId: `occurrence-${nonce}`,
    nodeId: `node-${nonce}`,
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(`binding:${nonce}`),
    controlDigest: digest(`control:${nonce}`),
    logicalCallId: `logical-call-${nonce}`,
  });
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  const literal = `literal space ; $(touch ${shellMarker}) | *`;
  const completed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: { [fieldName]: literal },
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  if (completed.status !== 'completed') return;
  const value = completed.result as {
    result?: { status?: string; argv?: string[]; exitCode?: number; stdout?: string };
    complete?: boolean;
  };
  assert.equal(value.complete, true);
  assert.equal(value.result?.status, 'exited');
  assert.equal(value.result?.exitCode, 0);
  assert.deepEqual(value.result?.argv, [
    `subcommand-${nonce}`,
    optionToken,
    literal,
  ], 'spaces and shell metacharacters remain one structured argv token');
  assert.equal(existsSync(shellMarker), false, 'shell syntax in a value is never expanded');
  assert.equal(readFileSync(counterFile, 'utf8'), '1');

  const rows = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND io_claimed_at IS NOT NULL AND state = 'returned') AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS settlement_n,
      (SELECT result_handle_id FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS result_handle_id
  `).get(
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
  ) as { logical_n: number; physical_n: number; settlement_n: number; result_handle_id: string | null };
  assert.deepEqual({
    logical_n: rows.logical_n,
    physical_n: rows.physical_n,
    settlement_n: rows.settlement_n,
  }, { logical_n: 1, physical_n: 1, settlement_n: 1 });
  assert.match(rows.result_handle_id ?? '', /^rh_/);

  eventlog.closeEventLog();
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const replayInput = path.join(TEST_HOME, `replay-${nonce}.json`);
  writeFileSync(replayInput, JSON.stringify({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: { [fieldName]: literal },
  }), 'utf8');
  const kernelUrl = pathToFileURL(path.join(
    process.cwd(),
    'src/runtime/harness/workflow-read-only-call-kernel.ts',
  )).href;
  const replayScript = [
    "import { readFileSync } from 'node:fs';",
    `const input = JSON.parse(readFileSync(${JSON.stringify(replayInput)}, 'utf8'));`,
    `const kernel = await import(${JSON.stringify(kernelUrl)});`,
    'const result = await kernel.executeWorkflowReadOnlyCall(input);',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const replay = JSON.parse(execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', replayScript,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })) as Awaited<ReturnType<typeof kernel.executeWorkflowReadOnlyCall>>;
  assert.equal(replay.status, 'replayed', JSON.stringify(replay));
  if (replay.status === 'replayed') {
    assert.equal(replay.resultHandleId, rows.result_handle_id);
    assert.deepEqual(replay.result, completed.result);
  }
  assert.equal(readFileSync(counterFile, 'utf8'), '1', 'durable replay executes zero second child body');
});

test('descriptor bytes are authority-sealed and argv, schema, or effect tampering retires authority with zero process body', async () => {
  const file = config.reviewedCliReadConfigPath();
  const original = readFileSync(file, 'utf8');
  const before = bodyCount();
  const mutations: Array<(row: Record<string, unknown>) => void> = [
    (row) => {
      const prefix = row.argvPrefix as string[];
      prefix.push(`unreviewed-prefix-${nonce}`);
    },
    (row) => {
      const args = row.arguments as Array<Record<string, unknown>>;
      args[0]!.token = `--unreviewed-${nonce}`;
    },
    (row) => {
      row.effect = 'external_write';
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const parsed = JSON.parse(original) as {
      descriptors: Array<{ descriptor: Record<string, unknown> }>;
    };
    mutate(parsed.descriptors[0]!.descriptor);
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    assert.throws(
      () => config.listReviewedCliReadDescriptors(),
      /not closed reviewed data/,
      `tamper case ${index} must not become reviewed configuration`,
    );
    const blocked = await acquireCurrent(`sealed-tamper-${index}`);
    assert.equal(blocked.status, 'blocked');
    if (blocked.status === 'blocked') assert.equal(blocked.reason, 'carrier_unavailable');
    assert.equal(bodyCount(), before);
    writeFileSync(file, original, 'utf8');
  }
  assert.equal(config.listReviewedCliReadDescriptors().length, 1);
});

test('binary replacement, a symlink replacement, and two matching reviewed descriptors fail closed before dispatch', async () => {
  const before = bodyCount();

  writeExecutable("process.stderr.write('changed-binary');");
  const binaryDrift = await acquireCurrent('binary-drift');
  assert.equal(binaryDrift.status, 'blocked');
  if (binaryDrift.status === 'blocked') assert.equal(binaryDrift.reason, 'carrier_unavailable');
  assert.equal(bodyCount(), before);

  writeExecutable();
  await provision();
  const alternate = path.join(TEST_HOME, `alternate-${nonce}`);
  writeFileSync(alternate, `#!${process.execPath}\nprocess.stdout.write('alternate');\n`, 'utf8');
  chmodSync(alternate, 0o700);
  rmSync(executable);
  symlinkSync(alternate, executable);
  const symlinkDrift = await acquireCurrent('symlink-drift');
  assert.equal(symlinkDrift.status, 'blocked');
  if (symlinkDrift.status === 'blocked') assert.equal(symlinkDrift.reason, 'carrier_unavailable');
  assert.equal(bodyCount(), before);

  rmSync(executable);
  writeExecutable();
  await provision();
  const secondId = `second-descriptor-${nonce}`;
  await provision(secondId, objective);
  const ambiguous = await acquireCurrent('ambiguous');
  assert.equal(ambiguous.status, 'blocked');
  if (ambiguous.status === 'blocked') assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(bodyCount(), before);
  assert.equal(await config.removeReviewedCliReadDescriptor(secondId), true);
});

test('nonzero, timeout, and oversized output retain one honest crossing and a bounded exact failure envelope', async () => {
  const cases: Array<{
    label: string;
    extra: string;
    expected: string;
    adjust?: (raw: Awaited<ReturnType<typeof provision>>) => Promise<void>;
  }> = [
    {
      label: 'nonzero',
      extra: "process.stderr.write('intentional-nonzero'); process.exitCode = 7;",
      expected: 'nonzero_exit',
    },
    {
      label: 'timeout',
      extra: "setTimeout(() => process.stdout.write('late'), 10_000);",
      expected: 'timed_out',
    },
    {
      label: 'oversize',
      extra: "process.stdout.write('x'.repeat(40_000));",
      expected: 'output_limit',
    },
  ];
  for (const fixture of cases) {
    writeExecutable(fixture.extra);
    await provision();
    const installed = await acquireCurrent(fixture.label);
    assert.equal(installed.status, 'installed', JSON.stringify(installed));
    if (installed.status !== 'installed') continue;
    const before = bodyCount();
    let caught: unknown;
    try {
      await invokeInstalled(installed.manifest, { [fieldName]: `value ${fixture.label}; *` }, fixture.label);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, `${fixture.label} must reject`);
    const error = caught as Error & { outcome?: {
      status?: string;
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
    } };
    assert.equal(error.outcome?.status, fixture.expected, error.stack);
    if (fixture.label === 'nonzero') assert.equal(error.outcome?.exitCode, 7);
    if (fixture.label === 'oversize') {
      assert.ok(Buffer.byteLength(error.outcome?.stdout ?? '', 'utf8') <= 16_384);
      assert.equal(error.outcome?.stdoutTruncated, true);
    }
    assert.equal(bodyCount(), before + 1, `${fixture.label} owns exactly one entered child body`);
  }
});

test('a failed reviewed-CLI process names its own fix: the provider\'s structured failure rides in the block reason', () => {
  const base = {
    version: 1 as const,
    status: 'nonzero_exit' as const,
    operationId: 'salesforce_sf_soql_query',
    executableRealpath: '/usr/local/lib/sf/bin/sf',
    argv: ['data', 'query', '--json', '--query', 'SELECT MAX(ActivityDate) FROM Task'],
    exitCode: 1,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const structured = new transport.ReviewedCliProcessError({
    ...base,
    stdout: JSON.stringify({
      status: 1,
      name: 'MALFORMED_QUERY',
      message: '\nType, COUNT(Id) touchCount, MAX(ActivityDate) lastActivity FROM\n     ^\nERROR at Row:1:Column:61\nfield ActivityDate does not support aggregate operator MAX',
    }),
    stderr: ' ›   Warning: @salesforce/cli update available from 2.130.9 to 2.149.9.\n',
  });
  assert.match(structured.message, /^reviewed CLI process nonzero_exit: MALFORMED_QUERY: /);
  assert.match(structured.message, /field ActivityDate does not support aggregate operator MAX$/);
  assert.ok(!/Warning:/.test(structured.message));

  const stderrOnly = new transport.ReviewedCliProcessError({
    ...base,
    stdout: '',
    stderr: ' ›   Warning: update available\nError (1): No authorization information found for nathan@example.com.\n',
  });
  assert.equal(
    stderrOnly.message,
    'reviewed CLI process nonzero_exit: Error (1): No authorization information found for nathan@example.com.',
  );

  const silent = new transport.ReviewedCliProcessError({ ...base, stdout: '', stderr: '' });
  assert.equal(silent.message, 'reviewed CLI process nonzero_exit');
});

test('a reviewed-CLI observation is re-read at every crossing, so freshness is not a fuse lit at acquisition', async () => {
  const acquired = await acquireCurrent('fresh');
  assert.ok('manifest' in acquired && acquired.manifest, JSON.stringify(acquired));
  const account = 'reviewed_cli:host';
  const before = Date.now();
  const first = observations.independentlyObserveCapability(operationId, account);
  assert.ok(first && first.origin === 'independent', JSON.stringify(first));
  assert.ok(first.observedAt >= before, 'first observation is stamped at the crossing, not at acquisition');
  await new Promise((resolve) => setTimeout(resolve, 15));
  const later = Date.now();
  const second = observations.independentlyObserveCapability(operationId, account);
  assert.ok(second && second.origin === 'independent', JSON.stringify(second));
  assert.ok(second.observedAt >= later, 'every crossing re-reads the CLI and stamps its own instant');
  assert.ok(second.observedAt > first.observedAt);
  assert.equal(second.definitionFingerprint, first.definitionFingerprint);
  assert.equal(second.providerVersion, first.providerVersion);
  assert.equal(
    observations.observationIsFresh(second, later + observations.INDEPENDENT_OBSERVATION_FRESHNESS_MS - 1),
    true,
  );
});

test('the pinned reviewed process receives current host CLI declarations without account or model-env authority', async () => {
  const descriptorId = `environment-${nonce}`;
  const environmentOperation = `read_environment_${nonce}`;
  const environmentObjective = 'inspect environment context';
  const profileKey = `CLEMMY_REVIEWED_PROFILE_${nonce.toUpperCase()}`;
  const caseKey = `CLEMMY_REVIEWED_CASE_${nonce.toUpperCase()}`;
  const inheritedKey = `CLEMMY_REVIEWED_INHERITED_${nonce.toUpperCase()}`;
  const privateKey = `CLEMMY_REVIEWED_PRIVATE_${nonce.toUpperCase()}`;
  const keys = [profileKey, caseKey, caseKey.toLowerCase(), inheritedKey, privateKey];
  const previousEnv = new Map<string, string | undefined>(keys.map(key => [key, process.env[key]]));
  const cliEnvFile = path.join(TEST_HOME, 'state', 'cli-env.json');
  const daemonEnvFile = path.join(TEST_HOME, '.env');
  const previousCliEnv = existsSync(cliEnvFile) ? readFileSync(cliEnvFile) : undefined;
  const previousDaemonEnv = existsSync(daemonEnvFile) ? readFileSync(daemonEnvFile) : undefined;
  const environmentCounter = path.join(TEST_HOME, `environment-counter-${nonce}`);
  const literal = 'literal value ; $() | *';
  // Seal the complete controlled program in argv, using the actual native
  // Node executable on each platform rather than a shebang or shell launcher.
  const program = [
    "const fs = require('node:fs');",
    `const counter = ${JSON.stringify(environmentCounter)};`,
    "const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(counter, String(n));",
    `process.stdout.write(JSON.stringify({ profile: process.env[${JSON.stringify(profileKey)}],`,
    `caseUpper: process.env[${JSON.stringify(caseKey)}], caseLower: process.env[${JSON.stringify(caseKey.toLowerCase())}],`,
    `caseKeys: Object.keys(process.env).filter(key => key.toUpperCase() === ${JSON.stringify(caseKey)}).length,`,
    `inherited: process.env[${JSON.stringify(inheritedKey)}], privateDaemon: process.env[${JSON.stringify(privateKey)}] ?? null,`,
    "argv: process.argv.slice(1), n }));",
  ].join('\n');
  let declaredProfile = false;
  const declareProfile = (profile: string): void => {
    const text = JSON.stringify({ [profileKey]: profile, [caseKey.toLowerCase()]: 'declared-case' });
    if (!declaredProfile) {
      writeFileSync(cliEnvFile, text);
      const fixed = new Date('2026-10-16T01:00:00.000Z');
      utimesSync(cliEnvFile, fixed, fixed);
      declaredProfile = true;
      return;
    }
    // A common atomic settings edit preserves timestamps. The fresh emitted
    // crossing must notice the replacement, not rely on a forced mtime tick.
    const before = statSync(cliEnvFile);
    const replacement = `${cliEnvFile}.replacement-${nonce}`;
    writeFileSync(replacement, text);
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, cliEnvFile);
    assert.equal(statSync(cliEnvFile).size, before.size);
    assert.equal(statSync(cliEnvFile).mtimeMs, before.mtimeMs);
  };
  try {
    process.env[profileKey] = 'inherited-profile';
    delete process.env[caseKey.toLowerCase()];
    process.env[caseKey] = 'inherited-case';
    process.env[inheritedKey] = 'synthetic-inherited-credential';
    delete process.env[privateKey];
    writeFileSync(daemonEnvFile, `${privateKey}=synthetic-private-daemon-value\n`);
    declareProfile('declared-profile-a');
    const healthStyleSnapshot = mergedSpawnEnv();
    assert.equal(healthStyleSnapshot[profileKey], 'declared-profile-a');
    const descriptor = await config.provisionReviewedCliReadDescriptor({
      version: 1, descriptorId, operationId: environmentOperation,
      displayName: environmentObjective, description: environmentObjective,
      effect: 'read', accountId: 'reviewed_cli:host', executablePath: process.execPath,
      argvPrefix: ['--eval', program, '--'],
      arguments: [{ name: fieldName, kind: 'option', token: optionToken, valueType: 'string', required: true }],
      limits: { timeoutMs: 2_000, maxStdoutBytes: 16_384, maxStderrBytes: 4_096, maxArgumentBytes: 4_096 },
    });
    const installed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
      requirementId: `environment-requirement-${nonce}`, objective: environmentObjective, effect: 'read',
    });
    assert.equal(installed.status, 'installed', JSON.stringify(installed));
    if (installed.status !== 'installed') return;
    assert.equal(installed.manifest.accountId, 'reviewed_cli:host');
    assert.equal(installed.manifest.providerIdentity, realpathSync(process.execPath));
    const readContext = async (label: string) => {
      const value = await invokeInstalled(installed.manifest, { [fieldName]: literal }, label) as {
        complete: boolean; result: { executableRealpath: string; argv: string[]; stdout: string };
      };
      assert.equal(value.complete, true);
      assert.equal(value.result.executableRealpath, descriptor.executableRealpath);
      assert.deepEqual(value.result.argv, ['--eval', program, '--', optionToken, literal]);
      return JSON.parse(value.result.stdout) as {
        profile: string; caseUpper: string; caseLower: string; caseKeys: number;
        inherited: string; privateDaemon: string | null; argv: string[]; n: number;
      };
    };
    const first = await readContext('environment-first');
    assert.equal(first.profile, healthStyleSnapshot[profileKey], 'health and execution use the same host environment policy');
    assert.equal(first.inherited, 'synthetic-inherited-credential', 'this existing CLI seam remains unsandboxed');
    assert.equal(first.privateDaemon, null, 'the private daemon env file is not copied into CLI children');
    assert.deepEqual(first.argv, [optionToken, literal], 'environment parity adds no shell interpretation');
    assert.equal(first.n, 1);
    if (process.platform === 'win32') {
      assert.equal(first.caseUpper, 'declared-case');
      assert.equal(first.caseLower, 'declared-case');
      assert.equal(first.caseKeys, 1, 'native Windows receives one winning case-insensitive key');
    } else {
      assert.equal(first.caseUpper, 'inherited-case');
      assert.equal(first.caseLower, 'declared-case');
      assert.equal(first.caseKeys, 2, 'POSIX names remain distinct');
    }
    declareProfile('declared-profile-b');
    const second = await readContext('environment-changed');
    assert.equal(second.profile, 'declared-profile-b', 'dispatch captures current declarations rather than replaying a health-time snapshot');
    assert.equal(healthStyleSnapshot[profileKey], 'declared-profile-a');
    assert.equal(second.n, 2);
    assert.equal(installed.manifest.accountId, 'reviewed_cli:host', 'environment parity is not upstream-account authentication');
    assert.equal(transport.observeReviewedCliReadTransport(environmentOperation, 'unverified-upstream-account'), null);
    await assert.rejects(invokeInstalled(installed.manifest,
      { [fieldName]: literal, env: { [profileKey]: 'model-supplied-profile' } }, 'environment-model-override'),
    /closed structured-argv schema/);
    assert.equal(readFileSync(environmentCounter, 'utf8'), '2', 'model environment arguments cannot start a third process');
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (previousCliEnv === undefined) rmSync(cliEnvFile, { force: true }); else writeFileSync(cliEnvFile, previousCliEnv);
    if (previousDaemonEnv === undefined) rmSync(daemonEnvFile, { force: true }); else writeFileSync(daemonEnvFile, previousDaemonEnv);
    await config.removeReviewedCliReadDescriptor(descriptorId);
  }
});

/** A real local process and production host/judge; only the author model and
 * Jev's HTTP transport answer deterministically. No judge function is replaced. */
async function reviewedCliAnswer(label: string, mode: 'records' | 'empty_records' | 'nonzero' | 'missing_stdout' | 'truncated',
  review: 'done' | 'repair' | 'unavailable' = 'done') {
  const { runConversation, _setReviewBeforeDeliveryForTests } = await import('./loop.js');
  // This case tests the review-and-repair loop that runs before delivery.
  _setReviewBeforeDeliveryForTests(true);
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  const jev = await import('../jev/client.js');
  const completion = await import('./host-completion-work.js');
  const handles = await import('./result-handle.js');
  const identities = await import('./attempt-identity.js');
  const terminals = await import('./accepted-source-terminal.js');
  const marker = `controlled_${label}_${nonce}`;
  const operation = `read_${marker}`;
  const descriptorId = `descriptor-${marker}`;
  const bodyLog = path.join(TEST_HOME, `${marker}.body.jsonl`);
  const stdout = mode === 'empty_records'
    ? JSON.stringify({ status: 0, result: { records: [], done: true, totalSize: 0 } })
    : JSON.stringify({ status: 0, result: { records: [{ marker, total: 17 }], done: true, totalSize: 1 } });
  const program = [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(bodyLog)}, JSON.stringify({ argv: process.argv.slice(1) }) + '\\n');`,
    mode === 'missing_stdout' ? '' : mode === 'truncated'
      ? "process.stdout.write('x'.repeat(64_000));"
      : `process.stdout.write(${JSON.stringify(stdout)});`,
    ...(mode === 'nonzero' ? ['process.exitCode = 7;'] : []),
  ].filter(Boolean).join('\n');
  const request = `Use ${operation} to read the controlled fixture and report only its returned marker and total, or say that it returned no records. Do not create, edit or send anything.`;
  const env = { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', CLEMMY_MODEL_ROLES: '[]',
    HARNESS_TOOL_BRACKETS: 'on', CLEMMY_COMPLETION_REVIEW: 'on', CLEMMY_TOOL_JIT: 'on',
    CLEMMY_CODEX_TOOL_SEARCH: 'on', CLEMMY_UNIFIED_RECALL: 'off', CLEMMY_UNIFIED_TURN_PRIMER: 'off',
    CLEMMY_SEMANTIC_RECALL: 'off', CLEMMY_DEBATE_MODE: 'off', CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let unexpectedNetwork = 0;
  const payloads: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> }> = [];
  const frames: unknown[] = [];
  Object.assign(process.env, env);
  globalThis.fetch = async () => { unexpectedNetwork++; throw new Error('No unmocked network is allowed in the CLI answer fixture'); };
  try {
    await config.provisionReviewedCliReadDescriptor({ version: 1, descriptorId, operationId: operation,
      displayName: operation, description: request, effect: 'read', accountId: 'reviewed_cli:host',
      executablePath: process.execPath, argvPrefix: ['--eval', program, '--'], arguments: [],
      limits: { timeoutMs: 2_000, maxStdoutBytes: 16_384, maxStderrBytes: 4_096, maxArgumentBytes: 4_096 } });
    const installed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({ requirementId: `requirement-${marker}`,
      // This controlled request already names the exact operation. Asking the
      // registry for the full prose would also nominate the file's earlier
      // descriptor through its shared fixture nonce and correctly be ambiguous.
      objective: operation, effect: 'read' });
    assert.equal(installed.status, 'installed', installed.status === 'blocked'
      ? `The real registry refused the controlled CLI: ${installed.reason}: ${installed.detail}`
      : 'the real registry must acquire the reviewed CLI before answering');
    if (installed.status !== 'installed') throw new Error('Controlled reviewed CLI acquisition was not installed');
    const capabilityId = installed.manifest.manifestId;
    const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: marker });
    const attempt = eventlog.beginRunAttempt(session.id, { runId: `run-${marker}` });
    const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
      text: request, taskMode: { version: 1, kind: 'normal' },
    } }, { armRunInFlight: true });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq };
    const completionPayloads: typeof payloads = [];
    jev._setTypesafeKeyForTests('ts_controlled_cli_answer');
    jev._setSystemOneFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as typeof payloads[number];
      payloads.push(body);
      if (!body.questions.delivered) {
        // Other existing advisory questions get no positive nomination. They
        // cannot select an account, execution path or task completion here.
        return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0',
          answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === 'choice'
            ? { type: 'choice', choice: 'none', confidence: 0, probabilities: { none: 0 } }
            : { type: 'noul', noul: 0 }])), usage: { input_tokens: 20, output_tokens: 5 } }) };
      }
      completionPayloads.push(body);
      if (review === 'unavailable') throw new Error('Controlled Jev transport unavailable');
      const failedRead = mode === 'nonzero' || mode === 'missing_stdout' || mode === 'truncated';
      const repairFirst = review === 'repair' && completionPayloads.length === 1;
      const scores = { delivered: failedRead || repairFirst ? 0.05 : 0.95,
        unaddressed: repairFirst ? 0.95 : 0.05, unsupported: failedRead || repairFirst ? 0.95 : 0.03,
        computed: 0.03, asksUser: 0.03, cannotFinish: failedRead ? 0.95 : 0.03, deadEnd: 0.03 };
      return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.entries(scores).map(([id, noul]) => [id, { type: 'noul', noul }])),
        usage: { input_tokens: 20, output_tokens: 5 } }) };
    });
    const finalReply = mode === 'empty_records' ? 'The controlled fixture returned no records.' : `Marker ${marker}; total 17.`;
    let calls = 0;
    const model = {
      async getResponse(raw: unknown) {
        frames.push(raw); calls++;
        const owned = authority.acceptedTurnCallAuthorityFor(session.id, source.seq);
        assert.equal(owned.status, 'ok', 'the production host arms exact call authority before the author model runs');
        if (owned.status === 'ok') {
          assert.equal(owned.authority.authorityKind, 'host_v1');
          assert.equal(owned.authority.sourceEventId, source.id);
          assert.equal(owned.authority.identity.sourceUserSeq, source.seq);
        }
        const output = calls === 1 ? [{ type: 'function_call', callId: `${marker}-read`, name: 'work_call',
          arguments: JSON.stringify({ requirement_id: capabilityId, name: operation, args_json: {},
            universe_item_id: null, universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
            text: review === 'repair' && calls === 2 ? `${finalReply} This was also yesterday’s total.` : finalReply }] }];
        return { responseId: `${marker}-${calls}`, output,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] } };
      },
      async *getStreamedResponse(raw: unknown) {
        const response = await this.getResponse(raw);
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const result = await runConversation({ ...identity, input: request, reuseRecordedUserInput: true, runAttemptId: attempt.attemptId,
      turnEngine: 'host_v1', maxSteps: 1, maxTurns: 6, toolCallsPerTurn: 4, judgeCompletion: true, suppressMemoryCapture: true,
      buildAgent: async context => buildOrchestratorAgent({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
        hostFreshPlanning: context.hostFreshPlanning, userInput: request, allowToolJit: true, model: model as never }),
      makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('The legacy runner must not execute'); } }) as never });
    const evidence = completion.sourceSettledReadEvidence(identity);
    const verdicts = eventlog.listEvents(session.id, { types: ['goal_alignment_judged'] })
      .filter(row => row.data.kind === 'completion');
    const terminal = terminals.resolveExactTerminalForAcceptedSource(source);
    const read = evidence.results.find(row => row.toolName === operation);
    const retained = read?.logicalToolCallId ? handles.redeemSuccessfulSettlementResultForHost({ ...identity,
      acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq), logicalToolCallId: read.logicalToolCallId }) : null;
    const bodyLines = existsSync(bodyLog) ? readFileSync(bodyLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const settlements = eventlog.openEventLog().prepare(`SELECT outcome_kind, mutating FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ?`).all(session.id, source.seq) as Array<{ outcome_kind: string; mutating: number }>;
    return { request, finalReply, marker, operation, identity, attempt, source, result, frames, calls,
      evidence, read, retained, verdicts, terminal, completionPayloads, bodyLines, settlements, unexpectedNetwork };
  } finally {
    jev._setSystemOneFetchForTests(undefined); jev._setTypesafeKeyForTests(undefined);
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await config.removeReviewedCliReadDescriptor(descriptorId);
  }
}

function assertCliReadReviewBinding(run: Awaited<ReturnType<typeof reviewedCliAnswer>>): void {
  assert.ok(run.read?.logicalToolCallId, 'the source retains this exact CLI read attempt');
  for (const verdict of run.verdicts) {
    assert.equal(verdict.data.sourceUserSeq, run.source.seq);
    const judged = verdict.data.judgedReadResults as Array<{ toolName?: string; logicalToolCallId?: string; outcome?: string }>;
    assert.ok(Array.isArray(judged) && judged.some(row => row.toolName === run.operation
      && row.logicalToolCallId === run.read!.logicalToolCallId && row.outcome === run.read!.outcome),
    'the actual verdict must include this source’s exact successful or failed CLI read identity');
  }
}

test('reviewed CLI answer reaches the production host and actual completion judge with its own retained stdout', async t => {
  for (const mode of ['records', 'empty_records'] as const) await t.test(mode, async () => {
    const run = await reviewedCliAnswer(`answer_${mode}`, mode);
    assert.equal(run.bodyLines.length, 1, 'one real subprocess body ran');
    assert.equal(run.unexpectedNetwork, 0, 'no provider or second-model network transport was used');
    assert.equal(run.result.publicPresentation?.text, run.finalReply);
    assert.equal(run.terminal.kind, 'terminal');
    if (run.terminal.kind === 'terminal') {
      assert.equal(run.terminal.presentation.status, 'done');
      assert.equal(run.terminal.presentation.text, run.finalReply);
    }
    assert.equal(run.calls, 2);
    assert.equal(run.read?.status, 'verified'); assert.equal(run.read?.contentComplete, true);
    assert.equal(run.retained?.status, 'ok');
    if (run.retained?.status === 'ok') {
      const payload = run.retained.value.rawPayload as { result?: { stdout?: string } };
      const data = JSON.parse(payload.result?.stdout ?? '') as { status: number; result: { records: unknown[]; totalSize: number } };
      assert.equal(data.status, 0); assert.equal(data.result.totalSize, mode === 'records' ? 1 : 0);
      assert.equal(data.result.records.length, mode === 'records' ? 1 : 0);
    }
    assert.equal(run.completionPayloads.length, 1, 'one actual Jev completion read for the candidate');
    const payload = run.completionPayloads[0]!.state;
    assert.equal(payload.request, run.request); assert.equal(payload.response, run.finalReply);
    assert.ok(JSON.stringify(payload).includes(mode === 'records' ? run.marker : 'totalSize'));
    assert.equal(run.verdicts.length, 1); assert.equal(run.verdicts[0]!.data.fulfills, true);
    assertCliReadReviewBinding(run);
    assert.notEqual(run.verdicts[0]!.data.failedOpen, true);
    assert.equal((run.verdicts[0]!.data.jevAttempt as { reviewerStarted?: boolean })?.reviewerStarted, false);
    assert.ok(run.settlements.length > 0 && run.settlements.every(row => row.mutating === 0));
  });
  await t.test('claim repair retains the read without redispatch', async () => {
    const run = await reviewedCliAnswer('answer_repair', 'records', 'repair');
    assert.equal(run.bodyLines.length, 1); assert.equal(run.calls, 3); assert.equal(run.unexpectedNetwork, 0);
    assert.equal(run.result.publicPresentation?.text, run.finalReply);
    assert.equal(run.completionPayloads.length, 2, 'one review of each changed candidate, no confirmation of the old candidate');
    assert.deepEqual(run.verdicts.map(row => row.data.fulfills), [false, true]);
    assertCliReadReviewBinding(run);
    assert.ok(run.verdicts.every(row => row.data.failedOpen !== true
      && (row.data.jevAttempt as { reviewerStarted?: boolean })?.reviewerStarted === false));
    const repairedFrame = JSON.stringify(run.frames[2]);
    assert.ok(repairedFrame.includes(run.marker) && repairedFrame.includes('17'), 'the repair keeps the exact settled read');
    assert.ok(repairedFrame.includes(run.request), 'the whole owner objective remains in the repair');
    assert.ok(run.completionPayloads.every(payload => JSON.stringify(payload.state).includes(run.marker)));
  });
  for (const mode of ['nonzero', 'missing_stdout', 'truncated'] as const) await t.test(mode, async () => {
    const run = await reviewedCliAnswer(`answer_${mode}`, mode);
    assert.equal(run.bodyLines.length, 1); assert.equal(run.unexpectedNetwork, 0);
    if (mode === 'missing_stdout') {
      // Complete means all captured bytes were shown, including an empty
      // stream. It does not prove that the requested information was returned.
      assert.equal(run.read?.contentComplete, true);
      assert.equal(run.retained?.status, 'ok');
      if (run.retained?.status === 'ok') {
        const payload = run.retained.value.rawPayload as { result?: { stdout?: string; stdoutTruncated?: boolean } };
        assert.equal(payload.result?.stdout, ''); assert.equal(payload.result?.stdoutTruncated, false);
      }
      assert.ok(run.completionPayloads.length > 0, 'the actual judge must see and reject the empty captured stream');
      assert.ok(run.verdicts.length > 0 && run.verdicts.every(row => row.data.fulfills === false && row.data.failedOpen !== true),
        'zero captured stdout is not the structured zero-record result proved by the successful empty_records case');
    } else {
      assert.equal(run.evidence.results.some(row => row.status === 'verified' && row.outcome === 'succeeded' && row.contentComplete === true), false,
        'a failed or truncated process result cannot become a complete successful read');
    }
    assert.equal(run.verdicts.some(row => row.data.fulfills === true && row.data.failedOpen !== true), false);
    const blockedBeforeReview = run.terminal.kind === 'terminal' && run.terminal.presentation.status === 'blocked';
    assert.ok(run.verdicts.length > 0 || blockedBeforeReview,
      'an absent review is acceptable only when this exact source has an explicit canonical blocked terminal');
    assert.equal(run.terminal.kind, 'terminal', 'the full loop must retain its exact source terminal');
    if (run.terminal.kind === 'terminal') assert.notEqual(run.terminal.presentation.status, 'done',
      'failed, missing or truncated read output cannot silently become a success terminal');
    if (run.verdicts.length) {
      assert.ok(run.completionPayloads.length > 0, 'retained review rows must come from the actual Jev transport');
      assertCliReadReviewBinding(run);
    }
    assert.ok(run.settlements.length > 0, 'the exact unsuccessful attempt is retained rather than silently omitted');
  });
  await t.test('unavailable Jev is recorded as unreviewed', async () => {
    const run = await reviewedCliAnswer('answer_jev_unavailable', 'records', 'unavailable');
    assert.equal(run.bodyLines.length, 1); assert.equal(run.unexpectedNetwork, 0);
    assert.equal(run.read?.contentComplete, true); assert.equal(run.completionPayloads.length, 1);
    assert.equal(run.verdicts.length, 1); assert.equal(run.verdicts[0]!.data.failedOpen, true);
    assert.equal(run.verdicts[0]!.data.reviewFailure, 'unavailable');
    assert.equal(run.verdicts.some(row => row.data.fulfills === true && row.data.failedOpen !== true), false);
  });
});
