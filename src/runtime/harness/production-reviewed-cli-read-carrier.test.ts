/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-reviewed-cli-read-carrier.test.ts */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
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
