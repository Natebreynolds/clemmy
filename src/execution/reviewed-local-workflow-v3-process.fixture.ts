/**
 * Two-process certification fixture for the reviewed local workflow carrier.
 * The parent strips every isolated-test marker before launching this file, so
 * loadShippedImplementations binds the digest-addressed production transport,
 * not transportIsolated and not a fixture callback.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

const phase = process.argv[2];
if (phase !== 'execute' && phase !== 'replay') {
  throw new Error('reviewed local process fixture requires execute or replay');
}

const runner = await import('./workflow-runner.js');
const capability = await import('../runtime/harness/reviewed-local-workflow-capability.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');

const args = {
  bundle_id: 'v3-production-portal',
  mode: 'content_addressed' as const,
  files: [
    { path: 'index.html', content: '<h1>Production V3 portal</h1>' },
    { path: 'server.mjs', content: 'export const productionReady = true;\n' },
  ],
};

function workflowFixture() {
  const step: WorkflowStepInput = {
    id: 'build_bundle',
    prompt: '',
    sideEffect: 'write',
    call: { tool: 'artifact_bundle_save', args },
  };
  const workflow: WorkflowDefinition = {
    name: 'reviewed-local-bundle-v3-production',
    description: 'Commit one exact local bundle through the emitted production port.',
    enabled: false,
    trigger: { manual: true },
    inputs: {},
    steps: [step],
  };
  const ctx = {
    workflow,
    workflowSlug: workflow.name,
    runId: 'run-reviewed-local-bundle-v3-production',
    inputs: {},
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];
  return { step, ctx };
}

function artifactSnapshot(directory: string) {
  return ['.clementine-bundle.json', 'index.html', 'server.mjs'].map((relative) => {
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
}

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
  throw new Error(`reviewed local capability did not materialize: ${materialized.reason}:${materialized.detail ?? ''}`);
}
const productionPort = ports.resolveProductionPortsForManifest(materialized.manifest);
if (!productionPort?.reconcile) throw new Error('emitted production invoke/reconcile port is unavailable');
const provenance = shipped.peekShippedProvenance(productionPort.invoke);
if (!provenance || provenance.kind !== 'invoke') {
  throw new Error('reviewed local port lacks shipped invoke provenance');
}

const fixture = workflowFixture();
const sessionId = `workflow:${fixture.ctx.runId}:${fixture.step.id}`;
if (phase === 'execute') {
  let parked: unknown;
  try {
    await runner.executeStep(fixture.step, fixture.ctx);
  } catch (error) {
    parked = error;
  }
  if (!(parked instanceof runner.ParkRunSignal)) {
    throw new Error(`first production call did not park for consent: ${String(parked)}`);
  }
  const pending = approvals.listPending({ sessionId, status: 'pending' });
  if (pending.length !== 1) throw new Error(`expected one pending approval, found ${pending.length}`);
  if (
    pending[0]!.tool !== 'workflow_v3_call'
    || pending[0]!.args?.operationId !== 'artifact_bundle_save'
    || pending[0]!.args?.accountId !== 'local_registry:host'
    || pending[0]!.args?.effect !== 'local_write'
  ) throw new Error('pending approval does not bind the exact reviewed local call');
  const beforeConsent = eventlog.openEventLog();
  const physicalBeforeConsent = (beforeConsent.prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`,
  ).get(sessionId) as { n: number }).n;
  if (physicalBeforeConsent !== 0) throw new Error('production body crossed before exact consent');
  if (existsSync(path.join(
    process.env.CLEMENTINE_HOME ?? '',
    'files',
    'bundles',
    args.bundle_id,
  ))) throw new Error('local artifact bytes existed before exact consent');
  const resolved = approvals.resolve(pending[0]!.approvalId, 'approved', 'reviewed-local-production-process');
  if (!resolved.ok) throw new Error(`approval did not resolve: ${resolved.reason}`);
}

const completed = await runner.executeStep(fixture.step, fixture.ctx) as {
  artifactId: string;
  directory: string;
  manifestPath: string;
  revisionDigest: string;
  created: boolean;
};
const reconciled = await productionPort.reconcile({
  intendedDigest: completed.revisionDigest,
  artifactId: completed.artifactId,
});
const db = eventlog.openEventLog();
const counts = {
  logical: (db.prepare(`SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ?`)
    .get(sessionId) as { n: number }).n,
  physical: (db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?`)
    .get(sessionId) as { n: number }).n,
  settlements: (db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?`)
    .get(sessionId) as { n: number }).n,
};

process.stdout.write(`REVIEWED_LOCAL_PROCESS_RESULT ${JSON.stringify({
  phase,
  completed,
  reconciled,
  snapshot: artifactSnapshot(completed.directory),
  counts,
  provenance,
})}\n`);
eventlog.closeEventLog();
