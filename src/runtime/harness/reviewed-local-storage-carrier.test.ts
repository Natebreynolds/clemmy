/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/reviewed-local-storage-carrier.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Connection pin for the host local-write carrier seam.
 *
 * The shipped invoke/reconcile artifacts are separate module instances from
 * the host. `loadShippedImplementations` binds a forwarder into them; the
 * host binds its concrete carrier when the port registry evaluates. This test
 * proves the whole edge with the real emitted artifacts and the real host
 * store: a Workspace commit through a shipped port lands in the host's own
 * SQLite/data.json (one instance, observable from the host side), replays
 * without a write, reconciles exactly, and the artifact never carries storage.
 */
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-local-storage-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const seam = await import('./implementation-artifacts/host-local-write-carrier.js');
const ports = await import('./production-capability-ports.js');
const storageCarrier = await import('./reviewed-local-storage-carrier.js');
const shipped = await import('./shipped-implementation-identity.js');
const carrier = await import('./reviewed-local-tool-carrier.js');
const manifests = await import('./capability-manifest.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const eventlog = await import('./eventlog.js');

test.after(() => {
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const args = {
  slug: 'shipped-port-dashboard',
  source_id: 'dashboard',
  data_json: JSON.stringify({ headline: { open: 3 }, rows: [{ id: 'opp-7' }] }),
};

function exactSurface() {
  const observed = carrier.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  const manifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  return { observed, manifest };
}

function binding(manifest: ReturnType<typeof exactSurface>['manifest']) {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    args,
    account: manifest.accountId,
    effect: manifest.effect,
    destination: manifest.destination,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
  };
}

test('evaluating the port registry binds the host storage carrier, selected by registry execution contract', () => {
  void ports;
  assert.equal(seam.peekHostLocalWriteCarrier(), storageCarrier.reviewedLocalStorageCarrier);
  const bound = seam.peekHostLocalWriteCarrier()!;
  assert.ok(bound.select({ operationId: 'space_set_data', accountId: carrier.REVIEWED_LOCAL_ACCOUNT }));
  // File-system reviewed writes stay with the attested transport leaf.
  assert.equal(bound.select({ operationId: 'artifact_bundle_save', accountId: carrier.REVIEWED_LOCAL_ACCOUNT }), null);
  // A foreign account or an unreviewed name never selects host storage.
  assert.equal(bound.select({ operationId: 'space_set_data', accountId: 'acct:someone-else' }), null);
  assert.equal(bound.select({ operationId: 'space_save', accountId: carrier.REVIEWED_LOCAL_ACCOUNT }), null);
});

test('a shipped invoke/reconcile port commits the Workspace dataset through the host carrier into the host store', async () => {
  store.spaceStore.save({
    id: args.slug,
    title: 'Shipped port dashboard',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>Shipped port dashboard</title>',
    dataSources: [],
    actions: [],
  });
  const { manifest } = exactSurface();
  const loaded = shipped.loadShippedImplementations();
  const invokeArtifact = readFileSync(shipped.implementationArtifactPath('invoke'), 'utf8');
  assert.doesNotMatch(invokeArtifact, /require\("(?:zod|better-sqlite3|pino)"\)/);

  // The carrier the artifact reaches is resolved at call time through the
  // host's binding: a spy bound on the host side is what the shipped invoke
  // calls, and the exact sealed call crosses it.
  const seen: Array<{ operationId: string; accountId: string; manifestDigest?: string }> = [];
  const real = storageCarrier.reviewedLocalStorageCarrier;
  seam.bindHostLocalWriteCarrier({
    select: (input) => {
      const selected = real.select(input);
      if (!selected) return null;
      return {
        execute: async (call) => {
          seen.push({ operationId: call.operationId, accountId: call.accountId, manifestDigest: call.expected?.manifestDigest });
          return selected.execute(call);
        },
        reconcile: selected.reconcile,
      };
    },
  });
  try {
    const invoke = loaded.invokeForSealedManifest(manifest);
    assert.equal(shipped.isShippedInvoke(invoke), true);
    const first = await invoke({
      nodeId: 'refresh',
      role: 'update',
      payload: args,
      identity: { sessionId: 'workflow:shipped', sourceUserSeq: 1, acceptedTaskId: 'shipped-run' },
      binding: binding(manifest),
    }) as { artifactId: string; created: boolean; contentDigest: string; observationId: string };
    assert.equal(first.created, true);
    assert.match(first.artifactId, /^workspace-dataset:v1:/);
    assert.deepEqual(seen, [{
      operationId: 'space_set_data',
      accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
      manifestDigest: manifests.capabilityManifestDigest(manifest),
    }]);

    // Observable from the host's own module instance: one observation row,
    // one data.json, one audit line.
    const rows = workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, first.observationId);
    const dataFile = store.resolveInSpace(args.slug, 'data.json');
    const dataBefore = readFileSync(dataFile, 'utf8');
    assert.match(dataBefore, /opp-7/);

    const replay = await invoke({
      nodeId: 'refresh',
      role: 'update',
      payload: args,
      identity: { sessionId: 'workflow:shipped', sourceUserSeq: 1, acceptedTaskId: 'shipped-run' },
      binding: binding(manifest),
    }) as typeof first;
    assert.equal(replay.created, false);
    assert.equal(replay.artifactId, first.artifactId);
    assert.equal(workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length, 1);
    assert.equal(readFileSync(dataFile, 'utf8'), dataBefore);

    const reconcile = loaded.reconcileForSealedManifest(manifest);
    assert.equal(shipped.isShippedReconcile(reconcile), true);
    const reconciled = await reconcile({ artifactId: first.artifactId, intendedDigest: first.contentDigest });
    assert.equal(reconciled.exists, true);
    assert.equal(reconciled.id, first.artifactId);
    assert.equal(reconciled.contentDigest, first.contentDigest);
    assert.match(reconciled.receipt ?? '', /^workspace-observation:/);
    assert.deepEqual(
      await reconcile({ artifactId: first.artifactId, intendedDigest: 'e'.repeat(64) }),
      { exists: false },
    );
  } finally {
    seam.bindHostLocalWriteCarrier(real);
  }
});

test('the host carrier itself re-applies the identity bar before any storage crossing', async () => {
  const { observed, manifest } = exactSurface();
  const adapter = storageCarrier.reviewedLocalStorageCarrier.select({
    operationId: 'space_set_data',
    accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
  });
  assert.ok(adapter);
  const expected = {
    manifestId: observed.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: 'local_registry',
    providerIdentity: carrier.REVIEWED_LOCAL_PROVIDER_IDENTITY,
    providerVersion: carrier.REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: carrier.REVIEWED_LOCAL_OPERATION_VERSION,
    definitionFingerprint: observed.definition.envelopeFingerprint,
    invokePortId: observed.invokePortId,
    argumentCompiler: { ...carrier.REVIEWED_LOCAL_ARGUMENT_COMPILER },
  };
  const before = workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length;
  await assert.rejects(
    adapter!.execute({
      operationId: 'space_set_data',
      accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
      args,
      expected: { ...expected, manifestDigest: 'a'.repeat(64) },
    }),
    /identity changed before dispatch/,
  );
  await assert.rejects(
    adapter!.execute({
      operationId: 'space_set_data',
      accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
      args: { ...args, foreign: true },
      expected,
    }),
    /exceed the declared safe mode/,
  );
  assert.deepEqual(
    await adapter!.reconcile({
      operationId: 'space_set_data',
      accountId: carrier.REVIEWED_LOCAL_ACCOUNT,
      artifactId: 'workspace-dataset:v1:anything',
      expected: { ...expected, manifestDigest: 'a'.repeat(64) },
    }),
    { exists: false },
  );
  assert.equal(workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length, before);
});
