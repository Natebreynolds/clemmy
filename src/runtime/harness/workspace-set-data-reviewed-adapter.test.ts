/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/workspace-set-data-reviewed-adapter.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-set-data-reviewed-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const carrier = await import('./reviewed-local-tool-carrier.js');
const manifests = await import('./capability-manifest.js');
const adapters = await import('./production-capability-adapters.js');
const reviewed = await import('./reviewed-local-workflow-capability.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const receiptProof = await import('./host-local-write-commit.js');
const datasetContract = await import('../../spaces/workspace-set-data-contract.js');

test.after(() => {
  workspaceDb.closeWorkspaceDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const args = {
  slug: 'scheduled-dashboard',
  source_id: 'dashboard',
  data_json: JSON.stringify({ headline: { open: 7 }, rows: [{ id: 'opp-1' }] }),
};

function exactSurface() {
  const observed = carrier.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  assert.equal(observed.execution.adapter, 'workspace_dataset_v1');
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

test('SpaceStore remains cold-importable without entering the reviewed dataset carrier cycle', () => {
  const child = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    "await import('./src/spaces/store.ts')",
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CLEMENTINE_HOME: path.join(TEST_HOME, 'cold-import') },
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
});

test('reviewed adapter commits one active Workspace once, replays without a write, and reconciles exact content', async () => {
  store.spaceStore.save({
    id: args.slug,
    title: 'Scheduled dashboard',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>Scheduled dashboard</title>',
    dataSources: [],
    actions: [],
  });
  const { manifest } = exactSurface();
  const invoke = adapters.invokeForSealedManifest(manifest);
  const first = await invoke({
    nodeId: 'refresh',
    role: 'update',
    payload: args,
    identity: { sessionId: 'workflow:test', sourceUserSeq: 1, acceptedTaskId: 'scheduled-run' },
    binding: binding(manifest),
  }) as {
    artifactId: string;
    created: boolean;
    contentDigest: string;
    observationId: string;
    hostFileCommit?: string;
    handle: string;
  };
  assert.equal(first.created, true);
  assert.ok(first.handle.endsWith('#source=dashboard'));
  const fileReceipt = datasetContract.workspaceDatasetHostFileCommit(JSON.stringify(first));
  const fileFacts = receiptProof.parseHostLocalWriteCommitFacts(fileReceipt);
  assert.ok(fileFacts, 'actual attested host carrier retains the whole-file receipt beside source identity');
  assert.equal(fileFacts.handle, `spaces/${args.slug}/data.json`);
  assert.equal(receiptProof.readCommittedArtifactContent(fileFacts).verified, true);
  assert.match(first.artifactId, /^workspace-dataset:v1:/);
  const dataFile = store.resolveInSpace(args.slug, 'data.json');
  const before = {
    file: readFileSync(dataFile, 'utf8'),
    mtimeMs: statSync(dataFile).mtimeMs,
    observations: workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length,
    audit: readFileSync(store.resolveInSpace(args.slug, 'audit.jsonl'), 'utf8'),
  };

  const replay = await invoke({
    nodeId: 'refresh',
    role: 'update',
    payload: args,
    identity: { sessionId: 'workflow:test', sourceUserSeq: 1, acceptedTaskId: 'scheduled-run' },
    binding: binding(manifest),
  }) as typeof first;
  assert.equal(replay.created, false);
  assert.equal(replay.hostFileCommit, first.hostFileCommit, 'exact unchanged replay retains the same file proof');
  assert.equal(replay.artifactId, first.artifactId);
  assert.equal(replay.observationId, first.observationId);
  assert.equal(readFileSync(dataFile, 'utf8'), before.file);
  assert.equal(statSync(dataFile).mtimeMs, before.mtimeMs);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length,
    before.observations,
  );
  assert.equal(readFileSync(store.resolveInSpace(args.slug, 'audit.jsonl'), 'utf8'), before.audit);

  const reconciled = await adapters.reconcileForSealedManifest(manifest)({
    artifactId: first.artifactId,
    intendedDigest: first.contentDigest,
  });
  assert.equal(reconciled.exists, true);
  assert.equal(reconciled.id, first.artifactId);
  assert.equal(reconciled.contentDigest, first.contentDigest);
  assert.match(reconciled.receipt ?? '', /^workspace-observation:/);
});

test('invalid slug/source/json and foreign arguments refuse before catalog or storage crossing', () => {
  const dataFile = store.resolveInSpace(args.slug, 'data.json');
  const before = readFileSync(dataFile, 'utf8');
  const invalid = [
    { ...args, slug: '../escape' },
    { ...args, source_id: ' dashboard ' },
    { ...args, source_id: '_meta' },
    { ...args, data_json: '{not json' },
    { ...args, foreign: true },
  ];
  for (const candidate of invalid) {
    assert.deepEqual(reviewed.ensureReviewedLocalWorkflowCapability({
      operationId: 'space_set_data',
      args: candidate,
    }), { ok: false, reason: 'arguments_invalid' });
  }
  assert.equal(readFileSync(dataFile, 'utf8'), before);
  assert.equal(workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length, 1);
});
