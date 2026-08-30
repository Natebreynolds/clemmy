import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-local-v3-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runner = await import('./workflow-runner.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');

import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

test.beforeEach(() => {
  eventlog.closeEventLog();
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
});

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function workflowFixture(args: Record<string, unknown>) {
  const fixtureId = String(args.bundle_id ?? 'unknown');
  const step: WorkflowStepInput = {
    id: 'build_bundle',
    prompt: '',
    sideEffect: 'write',
    call: { tool: 'artifact_bundle_save', args },
  };
  const workflow: WorkflowDefinition = {
    name: `reviewed-local-bundle-v3-${fixtureId}`,
    description: 'Commit one exact local bundle through workflow v3.',
    enabled: false,
    trigger: { manual: true },
    inputs: {},
    steps: [step],
  };
  const ctx = {
    workflow,
    workflowSlug: workflow.name,
    runId: `run-reviewed-local-bundle-v3-${fixtureId}`,
    inputs: {},
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];
  return { step, workflow, ctx };
}

type ProcessResult = {
  phase: 'execute' | 'replay';
  completed: {
    artifactId: string;
    directory: string;
    manifestPath: string;
    revisionDigest: string;
    created: boolean;
  };
  reconciled: {
    exists: boolean;
    id?: string;
    handle?: string;
    receipt?: string;
    contentDigest?: string;
  };
  snapshot: Array<{
    relative: string;
    bytes: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>;
  counts: { logical: number; physical: number; settlements: number };
  provenance: { kind: string; transportDigest: string; artifactDigest: string };
};

function runProductionProcess(phase: 'execute' | 'replay'): ProcessResult {
  const childEnv = {
    ...process.env,
    CLEMENTINE_HOME: TEST_HOME,
    MCP_AUTO_IMPORT_ENABLED: 'false',
  };
  delete childEnv.CLEMMY_TEST_ISOLATED_HOME;
  delete childEnv.NODE_TEST_CONTEXT;
  const fixture = fileURLToPath(new URL('./reviewed-local-workflow-v3-process.fixture.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, phase], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const line = child.stdout.split('\n').find((row) => row.startsWith('REVIEWED_LOCAL_PROCESS_RESULT '));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice('REVIEWED_LOCAL_PROCESS_RESULT '.length)) as ProcessResult;
}

test('emitted production port waits for exact consent, commits once, settles, reconciles, and replays in process B with zero additional bytes', () => {
  const first = runProductionProcess('execute');
  assert.equal(first.completed.created, true);
  assert.equal(existsSync(first.completed.directory), true);
  assert.deepEqual(first.counts, { logical: 1, physical: 1, settlements: 1 });
  assert.deepEqual(first.reconciled, {
    exists: true,
    id: first.completed.artifactId,
    handle: first.completed.directory,
    receipt: first.completed.manifestPath,
    contentDigest: first.completed.revisionDigest,
  });

  const emitted = JSON.parse(readFileSync(path.join(
    process.cwd(),
    'src/runtime/harness/implementation-artifacts/emitted/manifest.json',
  ), 'utf8')) as { artifacts: { transport: { sha256: string } } };
  assert.equal(first.provenance.kind, 'invoke');
  assert.equal(
    first.provenance.transportDigest,
    emitted.artifacts.transport.sha256,
    'the crossing used the emitted production transport, never transportIsolated or a fixture',
  );

  const replay = runProductionProcess('replay');
  assert.deepEqual(replay.completed, first.completed);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.deepEqual(replay.counts, { logical: 1, physical: 1, settlements: 1 });
  assert.equal(replay.provenance.transportDigest, emitted.artifacts.transport.sha256);
  assert.deepEqual(replay.reconciled, first.reconciled);
});

test('invalid reviewed local arguments fail before approval, activation, physical claim, or bytes', async () => {
  const args = {
    bundle_id: 'invalid-v3-portal',
    mode: 'overwrite',
    files: [{ path: '../escape', content: 'no' }],
  };
  const fixture = workflowFixture(args);
  const sessionId = `workflow:${fixture.ctx.runId}:${fixture.step.id}`;
  await assert.rejects(
    runner.executeStep(fixture.step, fixture.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /workflow_reviewed_local_capability_arguments_invalid/.test(error.reason),
  );
  assert.equal(approvals.listPending({ sessionId, status: 'any' }).length, 0);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 0);
  assert.equal(existsSync(path.join(TEST_HOME, 'files', 'bundles', 'invalid-v3-portal')), false);
});
