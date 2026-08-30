import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-local-carrier-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const carrier = await import('./reviewed-local-tool-carrier.js');
const manifests = await import('./capability-manifest.js');
const planning = await import('./local-planning-capability.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function exactCall(args: Record<string, unknown>) {
  const observed = carrier.observeReviewedLocalTool('artifact_bundle_save');
  assert.ok(observed);
  const manifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  return {
    operationId: 'artifact_bundle_save',
    accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
    args,
    expected: {
      manifestId: observed.manifestId,
      manifestDigest: manifests.capabilityManifestDigest(manifest),
      providerKind: 'local_registry',
      providerIdentity: carrier.REVIEWED_LOCAL_PROVIDER_IDENTITY,
      providerVersion: carrier.REVIEWED_LOCAL_PROVIDER_VERSION,
      operationVersion: carrier.REVIEWED_LOCAL_OPERATION_VERSION,
      definitionFingerprint: observed.definition.envelopeFingerprint,
      invokePortId: observed.invokePortId,
      argumentCompiler: { ...carrier.REVIEWED_LOCAL_ARGUMENT_COMPILER },
    },
  };
}

test('only an explicitly reviewed current local tool exposes execution identity', () => {
  const reviewed = carrier.observeReviewedLocalTool('artifact_bundle_save');
  assert.ok(reviewed);
  assert.equal(reviewed.execution.adapter, 'artifact_bundle_v1');
  assert.equal(reviewed.execution.reconciliation, 'artifact_bundle_v1');
  assert.match(reviewed.definition.envelopeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(carrier.observeReviewedLocalTool('space_save'), null);
  assert.equal(carrier.observeReviewedLocalTool('run_shell_command'), null);
});

test('reviewed execution schema is byte-identical to the configured local planning surface', async () => {
  const reviewed = carrier.observeReviewedLocalTool('artifact_bundle_save');
  assert.ok(reviewed);
  const configured = await planning.observeCurrentLocalPlanningDefinition({
    name: 'artifact_bundle_save',
    carrier: 'work_call',
  });
  assert.equal(configured.ok, true);
  if (!configured.ok) return;
  assert.deepEqual(reviewed.schema, configured.schema);
  assert.equal(reviewed.definition.schemaFingerprint, configured.definition.schemaFingerprint);
  assert.equal(
    reviewed.definition.registrySemanticsFingerprint,
    configured.definition.registrySemanticsFingerprint,
  );
  assert.equal(reviewed.definition.envelopeFingerprint, configured.definition.envelopeFingerprint);
});

test('reviewed local carrier executes exact safe arguments, replays content-addressed bytes, and reconciles', async () => {
  const args = {
    bundle_id: 'carrier-proof',
    mode: 'content_addressed',
    files: [{ path: 'index.html', content: '<h1>Carrier proof</h1>' }],
  };
  const first = await carrier.executeReviewedLocalTool(exactCall(args)) as {
    artifactId: string;
    directory: string;
    created: boolean;
    revisionDigest: string;
  };
  const replay = await carrier.executeReviewedLocalTool(exactCall(args)) as typeof first;
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.artifactId, first.artifactId);
  assert.equal(replay.directory, first.directory);
  assert.equal(existsSync(first.directory), true);

  const reconciled = await carrier.reconcileReviewedLocalTool({
    operationId: 'artifact_bundle_save',
    accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
    artifactId: first.artifactId,
  });
  assert.deepEqual(reconciled, {
    exists: true,
    artifactId: first.artifactId,
    handle: first.directory,
    contentDigest: first.revisionDigest,
    receipt: path.join(first.directory, '.clementine-bundle.json'),
  });
});

test('identity drift and unsafe/invalid arguments refuse before any local artifact exists', async () => {
  const target = path.join(TEST_HOME, 'files', 'bundles', 'must-not-exist');
  const invalidArgs = {
    bundle_id: 'must-not-exist',
    mode: 'overwrite',
    files: [{ path: '../escape', content: 'no' }],
  };
  await assert.rejects(
    carrier.executeReviewedLocalTool(exactCall(invalidArgs)),
    /arguments exceed the declared safe mode/,
  );
  assert.equal(existsSync(target), false);

  const drifted = exactCall({
    bundle_id: 'must-not-exist',
    mode: 'content_addressed',
    files: [{ path: 'index.html', content: 'no' }],
  });
  drifted.expected.definitionFingerprint = 'b'.repeat(64);
  await assert.rejects(
    carrier.executeReviewedLocalTool(drifted),
    /identity changed before dispatch/,
  );
  assert.equal(existsSync(target), false);

  const manifestDrifted = exactCall({
    bundle_id: 'must-not-exist',
    mode: 'content_addressed',
    files: [{ path: 'index.html', content: 'no' }],
  });
  manifestDrifted.expected.manifestDigest = 'c'.repeat(64);
  await assert.rejects(
    carrier.executeReviewedLocalTool(manifestDrifted),
    /identity changed before dispatch/,
  );
  assert.equal(existsSync(target), false);
});
