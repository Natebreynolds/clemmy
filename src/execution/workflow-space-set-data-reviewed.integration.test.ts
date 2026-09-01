/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-space-set-data-reviewed.integration.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-space-set-data-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const runner = await import('./workflow-runner.js');
const workflowStore = await import('../memory/workflow-store.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const carrier = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const adapters = await import('../runtime/harness/production-capability-adapters.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const spaces = await import('../spaces/store.js');
const workspaceDb = await import('../spaces/workspace-db.js');

import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

test.after(() => {
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('one accepted scheduled workflow-v3 call updates an existing active Workspace once and replay adds zero writes', async () => {
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();

  const args = {
    slug: 'friday-style-dashboard',
    source_id: 'dashboard',
    data_json: JSON.stringify({ summary: { pipeline: '$125,000' }, rows: [{ id: 'opp-49' }] }),
  };
  spaces.spaceStore.save({
    id: args.slug,
    title: 'Friday-style dashboard',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>Friday-style dashboard</title>',
    dataSources: [],
    actions: [],
  });

  const observed = carrier.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  const manifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: adapters.invokeForSealedManifest(manifest),
      reconcile: adapters.reconcileForSealedManifest(manifest),
    },
  ).ok, true);

  const step: WorkflowStepInput = {
    id: 'refresh_dashboard',
    prompt: '',
    sideEffect: 'write',
    call: { tool: 'space_set_data', args },
  };
  const workflow: WorkflowDefinition = {
    name: 'reviewed-workspace-dataset-scheduled',
    description: 'Commit one reviewed dashboard dataset.',
    enabled: true,
    trigger: { schedule: '0 7 * * *', timezone: 'UTC' },
    inputs: {},
    steps: [step],
  };
  const persisted = workflowStore.writeWorkflow(workflow.name, workflow);
  const occurrenceAtMs = 1_788_200_400_000;
  const triggerReceiptId = `workflow-schedule:v1:${persisted.name}:${occurrenceAtMs}`;
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  assert.ok(queued.id);
  const ctx = {
    workflow: persisted.data,
    workflowSlug: persisted.name,
    runId: queued.id,
    inputs: {},
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];

  const first = await runner.executeStep(step, ctx) as {
    artifactId: string;
    observationId: string;
    contentDigest: string;
    created: boolean;
  };
  assert.equal(first.created, true);
  const dataFile = spaces.resolveInSpace(args.slug, 'data.json');
  const before = {
    bytes: readFileSync(dataFile),
    mtimeMs: statSync(dataFile).mtimeMs,
    observations: workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length,
    audit: readFileSync(spaces.resolveInSpace(args.slug, 'audit.jsonl')),
  };
  assert.equal(before.observations, 1);
  const sessionId = `workflow:${queued.id}:${step.id}`;
  const grants = approvals.listPending({ sessionId, status: 'any' });
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.resolver, 'system:workflow-scheduled_workflow_authority');

  const replay = await runner.executeStep(step, ctx);
  assert.deepEqual(replay, first);
  assert.equal(readFileSync(dataFile).equals(before.bytes), true);
  assert.equal(statSync(dataFile).mtimeMs, before.mtimeMs);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(args.slug, { limit: 20 }).length,
    before.observations,
  );
  assert.equal(readFileSync(spaces.resolveInSpace(args.slug, 'audit.jsonl')).equals(before.audit), true);

  const productionPort = ports.resolveProductionPortsForManifest(manifest);
  assert.ok(productionPort?.reconcile);
  const reconciled = await productionPort!.reconcile!({
    artifactId: first.artifactId,
    intendedDigest: first.contentDigest,
  });
  assert.equal(reconciled.exists, true);
  assert.equal(reconciled.id, first.artifactId);
  assert.equal(reconciled.contentDigest, first.contentDigest);
});

