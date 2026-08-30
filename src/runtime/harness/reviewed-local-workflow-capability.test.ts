import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-local-capability-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const manifests = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const reviewed = await import('./reviewed-local-workflow-capability.js');
const carrier = await import('./reviewed-local-tool-carrier.js');
const compiler = await import('../../execution/workflow-live-call-compiler.js');

test.beforeEach(() => {
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
});

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const exactArgs = {
  bundle_id: 'workflow-bundle',
  mode: 'content_addressed',
  files: [{ path: 'index.html', content: '<h1>Workflow bundle</h1>' }],
};

test('reviewed local materialization publishes one exact current workflow-v3 identity', () => {
  const ensured = reviewed.ensureReviewedLocalWorkflowCapability({
    operationId: 'artifact_bundle_save',
    args: exactArgs,
  });
  assert.equal(ensured.ok, true);
  if (!ensured.ok) return;
  assert.equal(ensured.manifest.providerKind, 'local_registry');
  assert.equal(ensured.manifest.effect, 'local_write');
  assert.equal(ensured.manifest.accountId, 'local_registry:host');
  assert.equal(ensured.manifest.idempotency.policy, 'key_before_dispatch');
  assert.equal(ensured.manifest.reconciliation.policy, 'exact_artifact');
  assert.ok(ports.resolveProductionPortsForManifest(ensured.manifest));

  const compiled = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'workflow-local-proof',
    nodeId: 'build',
    operationId: 'artifact_bundle_save',
    args: exactArgs,
    expectedEffect: 'write',
  });
  assert.equal(compiled.ok, true);
  if (compiled.ok) {
    assert.equal(compiled.identity.capabilityId, ensured.identity.capabilityId);
    assert.equal(compiled.plan.binding.effect, 'local_write');
    assert.equal(compiled.plan.binding.liveFingerprint, ensured.manifest.definitionFingerprint);
  }
});

test('unreviewed tools and invalid safe-mode arguments never enter the workflow catalog', () => {
  const unreviewed = reviewed.ensureReviewedLocalWorkflowCapability({
    operationId: 'space_save',
    args: { space_id: 'x' },
  });
  assert.deepEqual(unreviewed, { ok: false, reason: 'not_reviewed' });

  const invalid = reviewed.ensureReviewedLocalWorkflowCapability({
    operationId: 'artifact_bundle_save',
    args: { ...exactArgs, mode: 'overwrite' },
  });
  assert.deepEqual(invalid, { ok: false, reason: 'arguments_invalid' });
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
});

test('manifest and observation conflicts refuse before executable port or catalog residue', () => {
  const observed = carrier.observeReviewedLocalTool('artifact_bundle_save');
  assert.ok(observed);
  const exactManifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(exactManifest);

  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore([{
    ...exactManifest,
    purpose: `${exactManifest.purpose}-tampered`,
  }]));
  const manifestConflict = reviewed.ensureReviewedLocalWorkflowCapability({
    operationId: 'artifact_bundle_save',
    args: exactArgs,
  });
  assert.deepEqual(manifestConflict, {
    ok: false,
    reason: 'manifest_conflict',
    detail: 'identity_mismatch',
  });
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);

  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  observations.clearIndependentCapabilityObservations();
  assert.deepEqual(observations.registerIndependentCapabilityObservation({
    operationId: 'artifact_bundle_save',
    accountId: 'local_registry:host',
    definitionFingerprint: 'd'.repeat(64),
    providerVersion: carrier.REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: carrier.REVIEWED_LOCAL_OPERATION_VERSION,
    observedAt: Date.now(),
    origin: 'pack_attested',
  }), { ok: true });
  const observationConflict = reviewed.ensureReviewedLocalWorkflowCapability({
    operationId: 'artifact_bundle_save',
    args: exactArgs,
  });
  assert.deepEqual(observationConflict, {
    ok: false,
    reason: 'observation_conflict',
    detail: 'identity_exists',
  });
  assert.equal(manifests.resolveCapabilityManifestStore().list().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
});
