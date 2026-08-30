import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const mode = process.env.CLEM_TYPED_INGEST_MODE;
const label = process.env.CLEM_TYPED_INGEST_LABEL;
const counterFile = process.env.CLEM_TYPED_INGEST_COUNTER;
const contextFile = process.env.CLEM_TYPED_INGEST_CONTEXT;
if (!mode || !label || !counterFile || !contextFile) {
  throw new Error('typed ingestion fixture requires mode, label, counter, and context paths');
}

const fixtureLabel = label;
const fixtureCounterFile = counterFile;
const fixtureContextFile = contextFile;

const eventlog = await import('../runtime/harness/eventlog.js');
const pagination = await import('../runtime/harness/workflow-paginated-read-authority.js');
const readKernel = await import('../runtime/harness/workflow-paginated-read-kernel.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
const spaces = await import('../spaces/store.js');
const workspaceBindings = await import('../spaces/canonical-entity-workspace-binding-contract.js');
const surfaceBindings = await import('../spaces/workflow-surface-binding-store.js');
const producer = await import('../execution/canonical-entity-workflow-lineage-producer.js');
const canonicalStore = await import('../execution/canonical-entity-store.js');
const entityResolution = await import('../execution/canonical-entity-resolution.js');
const workspaceProjection = await import('../spaces/canonical-entity-workspace-store-projection.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const runRecords = await import('../execution/workflow-run-record.js');
const runner = await import('../execution/workflow-runner.js');
const shared = await import('../tools/shared.js');

type ResultRoot = import('../execution/canonical-entity-workflow-lineage-producer.js')
  .CanonicalEntityWorkflowResultRootV1;
type ProjectionClaim = import('../spaces/canonical-entity-workflow-finalizer.js')
  .CanonicalEntityWorkflowProjectionClaim;
type QueuedRunRecord = import('../execution/workflow-runner.js').QueuedRunRecord;

type CrashPoint =
  | 'after_provider_settlement_before_batch'
  | 'after_batch_before_coverage'
  | 'after_coverage_before_lineage'
  | 'after_lineage_before_terminal';

interface FixtureContext {
  version: 1;
  label: string;
  workflowId: string;
  runId: string;
  workspaceId: string;
  bindingId: string;
  runFile: string;
  startedAt: string;
  finishedAt: string;
  expectedDatasetId: string;
  expectedRecordCount: number;
  expectedPageCount: number;
  plan: import('../memory/workflow-node-invocation-plan.js').WorkflowNodeInvocationPlanV1;
  root: ResultRoot;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenOf(value: string): string {
  return digest(value).slice(0, 10);
}

function readContext(): FixtureContext {
  return JSON.parse(readFileSync(fixtureContextFile, 'utf8')) as FixtureContext;
}

function writeContext(context: FixtureContext): void {
  writeFileSync(fixtureContextFile, JSON.stringify(context), { encoding: 'utf8', mode: 0o600 });
}

function lineagedReceiptCount(): number {
  const directory = path.join(
    process.env.CLEMENTINE_HOME!,
    'state',
    'canonical-entities',
    'workflow-lineage',
  );
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((entry) => entry.endsWith('.json')).length;
}

function sqliteCount(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function inspect(context: FixtureContext) {
  const harness = eventlog.openEventLog();
  const entities = canonicalStore.openCanonicalEntityStoreDb();
  const workspaces = workspaceDb.openWorkspaceDb();
  const terminal = runRecords.readWorkflowRunRecord<QueuedRunRecord>(context.runFile);
  const dataset = canonicalStore.getCanonicalDataset(context.expectedDatasetId, entities);
  const coverage = dataset
    ? canonicalStore.summarizeStoredDatasetCoverage(context.expectedDatasetId, entities)
    : null;
  const audit = dataset
    ? canonicalStore.auditCanonicalDatasetIntegrity(context.expectedDatasetId, entities)
    : null;
  const head = workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(
    context.bindingId,
    workspaces,
  );
  const surface = surfaceBindings.getWorkspaceRunProjection(context.bindingId, workspaces);
  const pageRows = harness.prepare(`
    SELECT page_ordinal, state, result_handle_id, page_receipt_digest,
           provider_exhausted_truth, item_count
      FROM workflow_paginated_read_pages
     WHERE activation_id = ?
     ORDER BY page_ordinal
  `).all(context.root.activationId) as Array<Record<string, unknown>>;
  const handleIds = pageRows.map((row) => row.result_handle_id);
  const terminalFiles = existsSync(shared.WORKFLOW_RUNS_DIR)
    ? readdirSync(shared.WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).length
    : 0;
  return {
    pid: process.pid,
    provider: {
      physicalCrossings: sqliteCount(harness, `
        SELECT COUNT(*) AS count FROM physical_dispatches
         WHERE state = 'returned' AND io_claimed_at IS NOT NULL
      `),
      resultHandles: sqliteCount(harness, 'SELECT COUNT(*) AS count FROM durable_result_handles'),
      pageCount: pageRows.length,
      pageRows,
      distinctPageHandles: new Set(handleIds).size,
      aggregateReceipts: sqliteCount(
        harness,
        'SELECT COUNT(*) AS count FROM workflow_paginated_aggregate_receipts',
      ),
    },
    canonical: {
      datasets: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_datasets'),
      observations: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_observations'),
      decisions: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_decisions'),
      records: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_records'),
      batches: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_resolution_batches'),
      coveragePages: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_coverage_pages'),
      coverageItems: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_coverage_item_owners'),
      dataset: dataset ? {
        datasetId: dataset.datasetId,
        resolutionRevision: dataset.resolutionRevision,
        resolutionDigest: dataset.resolutionDigest,
        coverageRevision: dataset.coverageRevision,
        coverageDigest: dataset.coverageDigest,
      } : null,
      coverage,
      audit,
    },
    lineageReceipts: lineagedReceiptCount(),
    terminal: terminal ? {
      status: terminal.status ?? null,
      terminalOutcome: terminal.terminalOutcome ?? null,
      finishedAt: terminal.finishedAt ?? null,
      hasClaim: Object.hasOwn(terminal, 'canonicalEntityWorkspaceProjectionClaim'),
      reportBack: terminal.reportBack ?? null,
    } : null,
    terminalFiles,
    space: {
      heads: sqliteCount(
        workspaces,
        'SELECT COUNT(*) AS count FROM workspace_canonical_entity_projection_heads',
      ),
      runProjections: sqliteCount(
        workspaces,
        'SELECT COUNT(*) AS count FROM workspace_run_projections',
      ),
      head: head ? {
        headDigest: head.headDigest,
        runId: head.identity.runId,
        datasetId: head.identity.datasetId,
        observationsCommitted: head.records.observationsCommitted,
        canonicalRecordsCreated: head.records.canonicalRecordsCreated,
        resolutionBatchCount: head.source.resolutionBatchCount,
        coverageStatus: head.coverage.status,
        observed: head.coverage.observed,
        exhaustion: head.coverage.exhaustion,
      } : null,
      surface: surface ? {
        digest: surface.digest,
        runId: surface.projection.runId ?? null,
        runStatus: surface.projection.runStatus ?? null,
        coverageStatus: surface.projection.coverage.status,
        observationsCommitted: surface.projection.records.observationsCommitted,
        canonicalRecords: surface.projection.records.canonicalRecords,
      } : null,
    },
  };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`TYPED_INGEST_FIXTURE:${JSON.stringify({ pid: process.pid, ...payload })}\n`);
}

function crash(point: CrashPoint, detail?: Record<string, unknown>): never {
  const marker = process.env.CLEM_TYPED_INGEST_CRASH_MARKER;
  if (!marker) throw new Error('typed ingestion crash mode requires a marker path');
  writeFileSync(marker, JSON.stringify({ pid: process.pid, point, ...detail }), 'utf8');
  process.kill(process.pid, 'SIGKILL');
  throw new Error(`forced typed ingestion crash: ${point}`);
}

function produce(context: FixtureContext, crashPoint?: CrashPoint) {
  return producer.produceCanonicalEntityWorkflowLineage({
    version: 1,
    root: context.root,
    invocationPlan: context.plan,
    startedAt: context.startedAt,
    proposedFinishedAt: context.finishedAt,
    ...(crashPoint ? {
      hooks: {
        afterDataset: () => {
          if (crashPoint === 'after_provider_settlement_before_batch') crash(crashPoint);
        },
        afterBatch: (pageOrdinal: number) => {
          if (
            crashPoint === 'after_batch_before_coverage'
            && pageOrdinal === context.expectedPageCount - 1
          ) crash(crashPoint, { pageOrdinal });
        },
        afterCoverage: (pageOrdinal: number) => {
          if (
            crashPoint === 'after_coverage_before_lineage'
            && pageOrdinal === context.expectedPageCount - 1
          ) crash(crashPoint, { pageOrdinal });
        },
        afterReceipt: () => {
          if (crashPoint === 'after_lineage_before_terminal') crash(crashPoint);
        },
      },
    } : {}),
  });
}

function publishTerminal(context: FixtureContext, claim: ProjectionClaim): QueuedRunRecord {
  return runner.publishWorkflowRunTerminalForTest(
    context.runFile,
    {
      id: context.runId,
      workflow: context.workflowId,
      workflowSlug: context.workflowId,
      status: 'completed',
      finishedAt: context.finishedAt,
      needsAttention: false,
      canonicalEntityWorkflowResultRoot: context.root,
      canonicalEntityWorkspaceProjectionClaim: claim,
      output: 'Exact generated typed-result ingestion completed.',
    },
    {
      workflowName: context.workflowId,
      outcome: 'done',
      detail: 'Exact generated typed-result ingestion completed.',
    },
  );
}

async function prepare(): Promise<void> {
  const token = tokenOf(fixtureLabel);
  const recordsPath = `set_${token}`;
  const keyField = `key_${token}`;
  const valueField = `value_${token}`;
  const pageField = `page_${token}`;
  const nextField = `next_${token}`;
  const exhaustedField = `done_${token}`;
  const workflowId = `workflow.ingestion.${token}`;
  const runId = `run.ingestion.${token}`;
  const workspaceId = `ingestion-${token}`;
  const bindingId = `binding.ingestion.${token}`;
  const definitionFingerprint = digest(`typed-ingestion-schema:${fixtureLabel}`);
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.ingestion.${token}`,
    providerKind: 'local_registry',
    operationId: `enumerate_${token}`,
    providerIdentity: `generated.carrier.${token}`,
    providerVersion: 'generated.1',
    operationVersion: '1',
    definitionFingerprint,
    effect: 'read',
    accountId: `account.ingestion.${token}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: {
      issuer: `host.generated.${token}`,
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  const secondCursor = `cursor-${token}-2`;
  const registered = ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async (input) => {
        const args = input.payload as Record<string, unknown>;
        const cursor = args.cursor;
        const page = cursor === undefined ? 0 : cursor === secondCursor ? 1 : -1;
        appendFileSync(fixtureCounterFile, `${JSON.stringify({
          pid: process.pid,
          label: fixtureLabel,
          page,
          args,
        })}\n`, 'utf8');
        if (page < 0) throw new Error('generated cursor was not retained exactly');
        const records = page === 0
          ? [
              { [keyField]: `${token}-01`, [valueField]: `value-${token}-a` },
              { [keyField]: `${token}-02`, [valueField]: `value-${token}-b` },
            ]
          : [
              { [keyField]: `${token}-03`, [valueField]: `value-${token}-c` },
              { [keyField]: `${token}-04`, [valueField]: `value-${token}-d` },
            ];
        return {
          [recordsPath]: records,
          [pageField]: {
            [exhaustedField]: page === 1,
            [nextField]: page === 0 ? secondCursor : null,
          },
        };
      },
    },
  );
  if (!registered.ok) throw new Error(`generated fixture port failed: ${registered.reason}`);
  const entry: import('../runtime/harness/host-capability-catalog-factory.js').RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => {
      throw new Error('catalog callback cannot own the generated provider crossing');
    },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  const observedAt = Date.now();
  const observed = observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  });
  if (!observed.ok) throw new Error(`generated capability observation failed: ${observed.reason}`);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  if (!identity) throw new Error('generated catalog identity is absent');

  const resultProjection = projections.createWorkflowCanonicalEntityResultProjection({
    recordsPath,
    fields: [{
      field: keyField,
      recordPath: keyField,
      type: 'string',
      required: true,
      sensitivity: 'public',
      confidence: 1,
    }, {
      field: valueField,
      recordPath: valueField,
      type: 'string',
      required: true,
      sensitivity: 'internal',
      confidence: 0.9,
    }],
    sourceRecord: { idPath: keyField, observedAt: { kind: 'page_settled_at' } },
    entityKind: `entity_${token}`,
    identityRules: [{
      ruleId: `rule_${token}`,
      fields: [keyField],
      normalizers: ['trim', 'unicode_nfkc'],
      exactIdentifierNamespace: `namespace_${token}`,
    }],
    resolutionPolicy: {
      policyId: `policy_${token}`,
      mergeThreshold: 10,
      distinctThreshold: 2,
      ambiguityMargin: 1,
      weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 },
    },
    fieldResolution: {
      kind: 'retain_all_evidence',
      selection: 'highest_confidence_then_newest',
      conflict: 'mark_conflicting_for_review',
    },
    provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
    partition: {
      kind: 'workflow_run',
      coverageItems: 'source_record_occurrences',
      denominator: 'settled_record_count',
      completion: 'closed_authority_exhaustion',
    },
    bounds: {
      maxPages: 2,
      maxRecordsPerPage: 2,
      maxRecords: 4,
      maxPageBytes: 100_000,
      maxRecordBytes: 10_000,
      maxTotalBytes: 200_000,
    },
  });
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.${token}`,
    logicalCapabilityId: `capability.${token}`,
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
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
      cursor: {
        source: { kind: 'continuation_cursor' },
        required: false,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: [recordsPath],
      nonEmptyPaths: [recordsPath],
      minItems: { [recordsPath]: 1 },
    },
    completeness: {
      kind: 'finite_exhaustive',
      exhaustedPath: `${pageField}.${exhaustedField}`,
      evidencePaths: [recordsPath],
    },
    continuation: {
      kind: 'cursor',
      cursorArgument: 'cursor',
      nextCursorPath: `${pageField}.${nextField}`,
      exhaustedPath: `${pageField}.${exhaustedField}`,
      maxPages: 2,
    },
    resultProjection,
  });

  const workspace = spaces.spaceStore.save({
    id: workspaceId,
    title: `Generated ingestion ${token}`,
    contract: {
      objective: 'Project exact canonical records from one closed workflow result.',
      successCriteria: ['All four exact observations are visible.'],
      invariants: ['Workspace remains a read-only projection.'],
    },
  });
  const workspaceApproval = workspaceBindings.createCanonicalEntityWorkspaceBindingApproval({
    selection: {
      version: 1,
      workspaceId,
      expectedWorkspaceRevision: workspace.version,
      expectedWorkspaceDigest: workspaceBindings.canonicalEntityWorkspaceSelectionDigest(workspace),
      bindingId,
      role: 'primary',
    },
    workflowId,
    at: new Date(Date.now() - 2_000).toISOString(),
  });
  const binding = surfaceBindings.putSoleActiveWorkflowSurfaceBinding({
    binding: workspaceApproval.binding,
  });
  if (!binding.ok || binding.digest !== workspaceApproval.bindingDigest) {
    throw new Error(`generated Workspace binding failed: ${JSON.stringify(binding)}`);
  }

  const session = eventlog.createSession({ id: `session.ingestion.${token}`, kind: 'workflow' });
  const workflowDigest = digest(`workflow:${fixtureLabel}`);
  const bindingSnapshotDigest = digest(`binding-snapshot:${fixtureLabel}`);
  const controlDigest = digest(`control:${fixtureLabel}`);
  const runOccurrenceId = `occurrence.ingestion.${token}`;
  const nodeId = `node.ingestion.${token}`;
  const armed = pagination.armWorkflowPaginatedReadAuthority({
    sessionId: session.id,
    workflowId,
    workflowRevision: 1,
    workflowDigest,
    runId,
    runOccurrenceId,
    nodeId,
    nodeAttempt: 1,
    invocationPlan: plan,
    bindingSnapshotDigest,
    controlDigest,
  });
  if (armed.status !== 'armed') throw new Error(`generated pagination authority failed: ${JSON.stringify(armed)}`);
  const root: ResultRoot = {
    version: 1,
    executionKind: 'paginated_read',
    activationId: armed.ref.activationId,
    lineage: {
      workflowId,
      workflowRevision: 1,
      workflowDigest,
      runId,
      runOccurrenceId,
      nodeId,
      nodeAttempt: 1,
      invocationPlanDigest: plan.bindingDigest,
      bindingSnapshotDigest,
      controlDigest,
    },
    workspaceBinding: workspaceApproval,
  };
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  mkdirSync(shared.WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(shared.WORKFLOW_RUNS_DIR, `${runId}.json`);
  runRecords.withWorkflowRunRecordLock(runFile, () => {
    runRecords.writeWorkflowRunRecordDurablyUnlocked(runFile, {
      id: runId,
      workflow: workflowId,
      workflowSlug: workflowId,
      source: 'manual',
      status: 'running',
      startedAt,
      canonicalEntityWorkflowResultRoot: root,
    } satisfies QueuedRunRecord);
  });
  const completed = await readKernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    baseArgs: { scope: `scope-${token}` },
  });
  if (completed.status !== 'completed') {
    throw new Error(`generated paginated read did not complete: ${JSON.stringify(completed)}`);
  }
  const finishedAt = new Date(Date.now() + 1_000).toISOString();
  const expectedDatasetId = `canonical-dataset:${entityResolution.canonicalEntitySha256({
    version: 1,
    workflowId,
    runId,
    activationDigest: armed.ref.activationDigest,
    projectionDigest: resultProjection.projectionDigest,
  })}`;
  const context: FixtureContext = {
    version: 1,
    label: fixtureLabel,
    workflowId,
    runId,
    workspaceId,
    bindingId,
    runFile,
    startedAt,
    finishedAt,
    expectedDatasetId,
    expectedRecordCount: 4,
    expectedPageCount: 2,
    plan,
    root,
  };
  writeContext(context);
  emit({
    contextFile: fixtureContextFile,
    readStatus: completed.status,
    aggregateDigest: completed.aggregate.aggregateReceiptDigest,
    state: inspect(context),
  });
}

if (mode === 'prepare') {
  await prepare();
} else if (mode === 'inspect') {
  const context = readContext();
  emit({ state: inspect(context) });
} else if (mode === 'crash_ingest') {
  const context = readContext();
  const point = process.env.CLEM_TYPED_INGEST_CRASH_POINT as CrashPoint | undefined;
  if (!point) throw new Error('crash_ingest requires a crash point');
  const result = produce(context, point);
  emit({ result, state: inspect(context) });
} else if (mode === 'ingest_only') {
  const context = readContext();
  const result = produce(context);
  emit({ result, state: inspect(context) });
} else if (mode === 'publish_terminal') {
  const context = readContext();
  const result = produce(context);
  if (result.status !== 'ready' && result.status !== 'replayed') {
    throw new Error(`lineage unavailable before terminal publication: ${JSON.stringify(result)}`);
  }
  const terminal = publishTerminal(context, result.claim);
  emit({ result, terminal, state: inspect(context) });
} else if (mode === 'recover') {
  const context = readContext();
  const result = produce(context);
  if (result.status !== 'ready' && result.status !== 'replayed') {
    throw new Error(`lineage recovery failed: ${JSON.stringify(result)}`);
  }
  const terminal = publishTerminal(context, result.claim);
  const reconciliation = runner.reconcileCanonicalEntityWorkspaceProjectionClaims({
    runsDirectory: shared.WORKFLOW_RUNS_DIR,
  });
  emit({ result, terminal, reconciliation, state: inspect(context) });
} else {
  throw new Error(`unknown typed ingestion fixture mode: ${mode}`);
}
