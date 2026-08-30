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

const mode = process.env.CLEM_CANONICAL_TRUTH_MODE;
const scenario = process.env.CLEM_CANONICAL_TRUTH_SCENARIO as Scenario | undefined;
const label = process.env.CLEM_CANONICAL_TRUTH_LABEL;
const counterFile = process.env.CLEM_CANONICAL_TRUTH_COUNTER;
const contextFile = process.env.CLEM_CANONICAL_TRUTH_CONTEXT;
const reverseProviderOrder = process.env.CLEM_CANONICAL_TRUTH_ORDER === 'reverse';
if (!mode || !scenario || !label || !counterFile || !contextFile) {
  throw new Error('canonical truth fixture requires mode, scenario, label, counter, and context');
}

const eventlog = await import('../runtime/harness/eventlog.js');
const pagination = await import('../runtime/harness/workflow-paginated-read-authority.js');
const readKernel = await import('../runtime/harness/workflow-paginated-read-kernel.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
const spaces = await import('../spaces/store.js');
const workspaceBindings = await import('../spaces/canonical-entity-workspace-binding-contract.js');
const surfaceBindings = await import('../spaces/workflow-surface-binding-store.js');
const workspaceProjection = await import('../spaces/canonical-entity-workspace-store-projection.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const opportunities = await import('../execution/automation-opportunity.js');
const workflowBridge = await import('../execution/automation-workflow-bridge.js');
const producer = await import('../execution/canonical-entity-workflow-lineage-producer.js');
const canonicalStore = await import('../execution/canonical-entity-store.js');
const entityResolution = await import('../execution/canonical-entity-resolution.js');
const runRecords = await import('../execution/workflow-run-record.js');
const runner = await import('../execution/workflow-runner.js');
const shared = await import('../tools/shared.js');

type Scenario = 'complete' | 'unknown_denominator' | 'failed_partition' | 'missing_page' | 'repeated_cursor' | 'bounded_budget';
type ResultRoot = import('../execution/canonical-entity-workflow-lineage-producer.js')
  .CanonicalEntityWorkflowResultRootV1;
type ProjectionClaim = import('../spaces/canonical-entity-workflow-finalizer.js')
  .CanonicalEntityWorkflowProjectionClaim;
type QueuedRunRecord = import('../execution/workflow-runner.js').QueuedRunRecord;
type InvocationPlan = import('../memory/workflow-node-invocation-plan.js').WorkflowNodeInvocationPlanV1;

interface FixtureContext {
  version: 1;
  scenario: Scenario;
  label: string;
  workflowId: string;
  runId: string;
  workspaceId: string;
  bindingId: string;
  runFile: string;
  startedAt: string;
  finishedAt: string;
  expectedDatasetId: string;
  plan: InvocationPlan;
  root: ResultRoot;
  roles: Record<string, string>;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenOf(value: string): string {
  return digest(value).slice(0, 12);
}

function writeContext(context: FixtureContext): void {
  writeFileSync(contextFile!, JSON.stringify(context), { encoding: 'utf8', mode: 0o600 });
}

function readContext(): FixtureContext {
  return JSON.parse(readFileSync(contextFile!, 'utf8')) as FixtureContext;
}

function sqliteCount(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function lineageReceiptCount(): number {
  const directory = path.join(
    process.env.CLEMENTINE_HOME!,
    'state',
    'canonical-entities',
    'workflow-lineage',
  );
  return existsSync(directory)
    ? readdirSync(directory).filter((entry) => entry.endsWith('.json')).length
    : 0;
}

function inspect(context: FixtureContext) {
  const harness = eventlog.openEventLog();
  const entities = canonicalStore.openCanonicalEntityStoreDb();
  const workspaces = workspaceDb.openWorkspaceDb();
  const dataset = canonicalStore.getCanonicalDataset(context.expectedDatasetId, entities);
  const coverage = dataset
    ? canonicalStore.summarizeStoredDatasetCoverage(context.expectedDatasetId, entities)
    : null;
  const head = workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(
    context.bindingId,
    workspaces,
  );
  const surface = surfaceBindings.getWorkspaceRunProjection(context.bindingId, workspaces);
  const terminal = runRecords.readWorkflowRunRecord<QueuedRunRecord>(context.runFile);
  const decisions = dataset
    ? (entities.prepare(`
        SELECT observation_id FROM canonical_decisions
         WHERE dataset_id = ? ORDER BY observation_id
      `).all(context.expectedDatasetId) as Array<{ observation_id: string }>).map((row) => {
        const observation = canonicalStore.getCanonicalObservation(
          context.expectedDatasetId,
          row.observation_id,
          entities,
        );
        const decision = canonicalStore.getCanonicalDecision(
          context.expectedDatasetId,
          row.observation_id,
          entities,
        );
        return {
          recordId: observation?.origin.recordId,
          exactIdentifiers: observation?.exactIdentifiers.length ?? 0,
          compoundSignals: observation?.compoundSignals.map((signal) => signal.name) ?? [],
          decision: decision?.decision,
          reason: decision?.decision === 'quarantine' ? decision.reason : null,
          score: decision?.decision === 'quarantine' ? null : decision?.score,
          candidateCount: decision?.candidates.length ?? 0,
          matchedExact: decision?.candidates[0]?.matchedExactIdentifiers.length ?? 0,
          matchedCompound: decision?.candidates[0]?.matchedCompoundSignals.length ?? 0,
          canonicalId: decision?.decision === 'quarantine' ? null : decision?.canonicalId,
        };
      })
    : [];
  const recordIds = dataset
    ? canonicalStore.listCanonicalRecordIds({ datasetId: context.expectedDatasetId, limit: 100, db: entities }).items
    : [];
  const records = recordIds.map((canonicalId) => {
    const record = canonicalStore.getCanonicalRecord(context.expectedDatasetId, canonicalId, entities)!;
    return {
      canonicalId,
      originRecordIds: record.observationIds.map((observationId) => (
        canonicalStore.getCanonicalObservation(context.expectedDatasetId, observationId, entities)?.origin.recordId
      )).filter((value): value is string => Boolean(value)).sort(),
      auditActions: record.audit.map((entry) => entry.action),
      conflictingFields: Object.values(record.fields)
        .filter((field) => field.conflicting)
        .map((field) => field.name)
        .sort(),
      labelEvidence: record.fields.label?.evidence.map((evidence) => ({
        value: evidence.value,
        sourceId: evidence.provenance.sourceId,
        recordId: evidence.provenance.recordId,
        path: evidence.provenance.path,
        observedAt: evidence.observedAt,
      })) ?? [],
    };
  });
  const pageRows = harness.prepare(`
    SELECT page_ordinal, state, continuation_state, provider_exhausted_truth,
           result_handle_id, page_receipt_digest, item_count
      FROM workflow_paginated_read_pages
     WHERE activation_id = ? ORDER BY page_ordinal
  `).all(context.root.activationId);
  const aggregate = harness.prepare(`
    SELECT outcome, reason, coverage_state, final_exhausted_truth,
           page_count, total_item_count
      FROM workflow_paginated_aggregate_receipts
     WHERE activation_id = ? LIMIT 1
  `).get(context.root.activationId) ?? null;
  return {
    pid: process.pid,
    roles: context.roles,
    provider: {
      physicalCrossings: sqliteCount(harness, `
        SELECT COUNT(*) AS count FROM physical_dispatches
         WHERE state = 'returned' AND io_claimed_at IS NOT NULL
      `),
      resultHandles: sqliteCount(harness, 'SELECT COUNT(*) AS count FROM durable_result_handles'),
      pages: pageRows,
      aggregate,
    },
    canonical: {
      datasets: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_datasets'),
      observations: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_observations'),
      decisions: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_decisions'),
      records: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_records'),
      batches: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_resolution_batches'),
      quarantines: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_quarantine'),
      coveragePages: sqliteCount(entities, 'SELECT COUNT(*) AS count FROM canonical_coverage_pages'),
      dataset,
      coverage,
      decisionsByOrigin: decisions.sort((left, right) => String(left.recordId).localeCompare(String(right.recordId))),
      recordsByOrigin: records.sort((left, right) => left.originRecordIds.join().localeCompare(right.originRecordIds.join())),
      quarantine: dataset
        ? canonicalStore.listCanonicalQuarantine({ datasetId: context.expectedDatasetId, limit: 100, db: entities }).items
        : [],
      audit: dataset
        ? canonicalStore.auditCanonicalDatasetIntegrity(context.expectedDatasetId, entities)
        : null,
    },
    lineageReceipts: lineageReceiptCount(),
    terminal: terminal ? {
      status: terminal.status ?? null,
      terminalOutcome: terminal.terminalOutcome ?? null,
      hasClaim: Object.hasOwn(terminal, 'canonicalEntityWorkspaceProjectionClaim'),
      reportBack: terminal.reportBack ?? null,
    } : null,
    space: {
      heads: sqliteCount(workspaces, 'SELECT COUNT(*) AS count FROM workspace_canonical_entity_projection_heads'),
      projections: sqliteCount(workspaces, 'SELECT COUNT(*) AS count FROM workspace_run_projections'),
      head,
      surface,
    },
  };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`CANONICAL_TRUTH_FIXTURE:${JSON.stringify({ pid: process.pid, ...payload })}\n`);
}

function richRecords(token: string): { pages: Array<Array<Record<string, string>>>; roles: Record<string, string> } {
  const roles = {
    exactSeed: `source-${token}-exact-seed`,
    exactMerge: `source-${token}-exact-merge`,
    compoundSeed: `source-${token}-compound-seed`,
    compoundMerge: `source-${token}-compound-merge`,
    ambiguityLeft: `source-${token}-ambiguity-left`,
    ambiguityRight: `source-${token}-ambiguity-right`,
    ambiguityProbe: `source-${token}-ambiguity-probe`,
    distinct: `source-${token}-distinct`,
    conflict: `source-${token}-conflict`,
  };
  return {
    roles,
    pages: [[
      {
        source_record_id: roles.exactSeed,
        exact_key: `exact-${token}-one`,
        label: `earlier-${token}`,
        conflict_a: `conflict-${token}`,
        conflict_b: `anchor-${token}`,
      },
      {
        source_record_id: roles.compoundSeed,
        label: `compound-earlier-${token}`,
        strong_a: ` Blue ${token} `,
        strong_b: `NORTH ${token}`,
      },
      {
        source_record_id: roles.ambiguityLeft,
        label: `left-${token}`,
        common_a: ` Shared ${token} `,
        common_b: `PAIR ${token}`,
        left_a: `left-${token}`,
        left_b: `branch-${token}`,
      },
      {
        source_record_id: roles.ambiguityRight,
        label: `right-${token}`,
        common_a: `shared ${token}`,
        common_b: ` pair ${token} `,
        right_a: `right-${token}`,
        right_b: `branch-${token}`,
      },
    ], [
      {
        source_record_id: roles.exactMerge,
        exact_key: `exact-${token}-one`,
        label: `later-${token}`,
      },
      {
        source_record_id: roles.compoundMerge,
        label: `compound-later-${token}`,
        strong_a: `blue ${token}`,
        strong_b: ` north ${token} `,
      },
      {
        source_record_id: roles.ambiguityProbe,
        label: `ambiguous-${token}`,
        common_a: `shared ${token}`,
        common_b: `pair ${token}`,
        left_a: `LEFT-${token}`,
        left_b: `BRANCH-${token}`,
        right_a: `RIGHT-${token}`,
        right_b: `BRANCH-${token}`,
      },
      {
        source_record_id: roles.distinct,
        label: `distinct-${token}`,
        strong_a: `unique-${token}`,
        strong_b: `separate-${token}`,
      },
      {
        source_record_id: roles.conflict,
        exact_key: `exact-${token}-two`,
        label: `conflict-${token}`,
        conflict_a: `conflict-${token}`,
        conflict_b: `anchor-${token}`,
      },
    ]],
  };
}

function opportunity(input: {
  token: string;
  fields: ReturnType<typeof projections.createWorkflowCanonicalEntityResultProjectionV2>['fields'];
  maxPages: number;
  acceptedTerminalStates: ['completed'] | ['completed', 'failed'];
}) {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Canonical truth ${input.token}`,
    objective: 'Resolve reviewed exact and compound identities with retained provenance.',
    rationale: 'Durable canonical truth and a rebuildable review surface are operationally useful.',
    lifetime: { kind: 'single_run' },
    recurrence: { mode: 'none' },
    trigger: { kind: 'manual' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['The exact page chain is terminal.'] },
      outcomeAuthority: {
        version: 1,
        kind: 'workflow_read_aggregate',
        acceptedTerminalStates: input.acceptedTerminalStates,
      },
    },
    capabilityRequirements: [{
      id: `read_${input.token}`,
      description: 'Read the exact reviewed bounded record collection.',
      minimumEffect: 'read',
      constraints: ['Retain settled result handles and page exhaustion.'],
    }],
    phases: [{
      id: `phase_${input.token}`,
      objective: 'Read and retain the bounded record collection.',
      dependsOn: [],
      capabilityRequirementIds: [`read_${input.token}`],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: input.maxPages },
      partitioned: false,
      outputEvidence: ['Ordered result handles and exhaustion are retained.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: input.maxPages },
    dataset: {
      schema: {
        fields: input.fields.map((field) => ({
          name: field.field,
          type: field.type,
          required: field.required,
          sensitivity: field.sensitivity,
        })),
        additionalFields: 'reject',
      },
      identity: {
        rules: [
          { id: `exact_${input.token}`, fields: ['exact_key'], match: 'exact', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
          { id: `strong_${input.token}`, fields: ['strong_a', 'strong_b'], match: 'compound', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
          { id: `common_${input.token}`, fields: ['common_a', 'common_b'], match: 'compound', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
          { id: `left_${input.token}`, fields: ['left_a', 'left_b'], match: 'compound', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
          { id: `right_${input.token}`, fields: ['right_a', 'right_b'], match: 'compound', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
          { id: `conflict_${input.token}`, fields: ['conflict_a', 'conflict_b'], match: 'compound', normalizers: ['trim', 'unicode_nfkc', 'case_fold'] },
        ],
        ambiguousMatch: 'review_required',
      },
      merge: {
        mode: 'review_required',
        defaultConflict: 'review_required',
        fieldPolicies: [],
        preserveSourceRecords: true,
      },
      provenance: {
        required: true,
        retainSourceSnapshots: true,
        requiredReferences: ['source_ref', 'run_ref', 'observed_at'],
      },
    },
    deliverables: [{
      id: `dataset_${input.token}`,
      description: 'Canonical records, provenance, coverage, and review queue.',
      kind: 'dataset_snapshot',
      required: true,
      successCriterionIds: [`truth_${input.token}`],
      evidence: ['The canonical store and Workspace head share exact authority roots.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: `truth_${input.token}`,
      description: 'Canonical decisions and coverage remain receipt-supported.',
      evidence: ['Every projected count traces to a durable batch or coverage receipt.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 32,
      effectCeiling: { class: 'read', maxOperationsPerRun: input.maxPages },
      successCriterionIds: [`truth_${input.token}`],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 2,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 32,
      maxOperationsPerRun: input.maxPages,
      reserveOperations: 0,
    },
  });
}

function publishTerminal(context: FixtureContext, claim: ProjectionClaim): QueuedRunRecord {
  const failed = context.scenario === 'failed_partition';
  const complete = context.scenario === 'complete';
  const detail = failed
    ? 'One exact workflow-read partition failed after a provenance-preserving settled prefix; coverage is non-universal.'
    : complete
      ? 'Canonical entity truth completed with exact exhausted coverage.'
      : 'Read execution completed; the population denominator is unknown, so no universal claim is supported.';
  return runner.publishWorkflowRunTerminalForTest(
    context.runFile,
    {
      id: context.runId,
      workflow: context.workflowId,
      workflowSlug: context.workflowId,
      status: failed ? 'failed' : 'completed',
      finishedAt: context.finishedAt,
      needsAttention: failed,
      canonicalEntityWorkflowResultRoot: context.root,
      canonicalEntityWorkspaceProjectionClaim: claim,
      output: detail,
    },
    { workflowName: context.workflowId, outcome: failed ? 'failed' : 'done', detail },
  );
}

async function prepare(): Promise<void> {
  const token = tokenOf(label!);
  const maxPages = scenario === 'bounded_budget' ? 1 : scenario === 'missing_page' ? 3 : 2;
  const recordsPath = `records_${token}`;
  const pagePath = `page_${token}`;
  const exhaustedPath = `done_${token}`;
  const nextPath = `next_${token}`;
  const rich = richRecords(token);
  const definitionFingerprint = digest(`canonical-truth-schema:${label}`);
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.truth.${token}`,
    providerKind: 'local_registry',
    operationId: `read_truth_${token}`,
    providerIdentity: `generated.carrier.${token}`,
    providerVersion: 'generated.1',
    operationVersion: '1',
    definitionFingerprint,
    effect: 'read',
    accountId: `account.truth.${token}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: `host.generated.${token}`, issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  const cursor = `cursor-${token}`;
  const registered = ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async ({ payload }) => {
        const args = payload as Record<string, unknown>;
        const page = args.cursor === undefined ? 0 : args.cursor === cursor ? 1 : -1;
        appendFileSync(counterFile!, `${JSON.stringify({ pid: process.pid, scenario, page, args })}\n`, 'utf8');
        if (page < 0) throw new Error('host-owned continuation cursor drifted');
        const sourcePage = rich.pages[Math.min(page, rich.pages.length - 1)]!;
        const selected = reverseProviderOrder ? [...sourcePage].reverse() : sourcePage;
        if (scenario === 'failed_partition' && page === 1) {
          throw new Error('generated second page failed after the settled prefix');
        }
        if (scenario === 'missing_page') {
          return { [recordsPath]: selected.slice(0, 1), [pagePath]: { [exhaustedPath]: false } };
        }
        if (scenario === 'repeated_cursor') {
          return {
            [recordsPath]: selected.slice(0, 1),
            [pagePath]: { [exhaustedPath]: false, [nextPath]: cursor },
          };
        }
        if (scenario === 'bounded_budget') {
          return {
            [recordsPath]: selected.slice(0, 1),
            [pagePath]: { [exhaustedPath]: false, [nextPath]: cursor },
          };
        }
        return {
          [recordsPath]: selected,
          [pagePath]: { [exhaustedPath]: page === 1, [nextPath]: page === 0 ? cursor : null },
        };
      },
    },
  );
  if (!registered.ok) throw new Error(`fixture port failed: ${registered.reason}`);
  const entry: import('../runtime/harness/host-capability-catalog-factory.js').RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('catalog callback cannot own physical I/O'); },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  const observed = observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  });
  if (!observed.ok) throw new Error(`capability observation failed: ${observed.reason}`);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  if (!identity) throw new Error('catalog identity is absent');

  const fieldNames = [
    'source_record_id', 'exact_key', 'label', 'strong_a', 'strong_b',
    'common_a', 'common_b', 'left_a', 'left_b', 'right_a', 'right_b',
    'conflict_a', 'conflict_b',
  ];
  const resultProjection = projections.createWorkflowCanonicalEntityResultProjectionV2({
    recordsPath,
    fields: fieldNames.map((field) => ({
      field,
      recordPath: field,
      type: 'string' as const,
      required: field === 'source_record_id' || field === 'label',
      sensitivity: field === 'label' ? 'internal' as const : 'public' as const,
      confidence: field === 'label' ? 0.8 : 1,
    })),
    sourceRecord: { idPath: 'source_record_id', observedAt: { kind: 'page_settled_at' } },
    entityKind: `entity_${token}`,
    identityRules: [
      { kind: 'exact_identifier', ruleId: `exact_${token}`, fields: ['exact_key'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], namespace: `stable_${token}` },
      { kind: 'compound_signal', ruleId: `strong_${token}`, fields: ['strong_a', 'strong_b'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], signalName: `strong_${token}` },
      { kind: 'compound_signal', ruleId: `common_${token}`, fields: ['common_a', 'common_b'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], signalName: `common_${token}` },
      { kind: 'compound_signal', ruleId: `left_${token}`, fields: ['left_a', 'left_b'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], signalName: `left_${token}` },
      { kind: 'compound_signal', ruleId: `right_${token}`, fields: ['right_a', 'right_b'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], signalName: `right_${token}` },
      { kind: 'compound_signal', ruleId: `conflict_${token}`, fields: ['conflict_a', 'conflict_b'], normalizers: ['trim', 'unicode_nfkc', 'case_fold'], signalName: `conflict_${token}` },
    ],
    resolutionPolicy: {
      policyId: `policy_${token}`,
      mergeThreshold: 6,
      distinctThreshold: 2,
      ambiguityMargin: 0,
      weights: {
        defaultExactIdentifierMatch: 10,
        defaultCompoundSignalMatch: 0,
        compoundSignalMatches: {
          [`strong_${token}`]: 6,
          [`common_${token}`]: 2,
          [`left_${token}`]: 4,
          [`right_${token}`]: 4,
          [`conflict_${token}`]: 6,
        },
      },
      exclusiveIdentifierNamespaces: [`stable_${token}`],
    },
    fieldResolution: { kind: 'retain_all_evidence', selection: 'highest_confidence_then_newest', conflict: 'mark_conflicting_for_review' },
    provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
    partition: {
      kind: 'workflow_run',
      coverageItems: 'source_record_occurrences',
      denominator: scenario === 'unknown_denominator' || scenario === 'failed_partition'
        ? 'unknown'
        : 'settled_record_count',
      completion: 'closed_authority_exhaustion',
      outcomeAuthority: {
        version: 1,
        kind: 'workflow_read_aggregate',
        acceptedTerminalStates: scenario === 'failed_partition'
          ? ['completed', 'failed']
          : ['completed'],
      },
    },
    bounds: {
      maxPages,
      maxRecordsPerPage: 16,
      maxRecords: 32,
      maxPageBytes: 200_000,
      maxRecordBytes: 20_000,
      maxTotalBytes: 400_000,
    },
  });
  const workspaceId = `truth-${token}`;
  const bindingId = `binding.truth.${token}`;
  const workspace = spaces.spaceStore.save({
    id: workspaceId,
    title: `Canonical truth ${token}`,
    contract: {
      objective: 'Project canonical records and review truth without execution authority.',
      successCriteria: ['Progress, records, provenance, coverage, and review remain rebuildable.'],
      invariants: ['Space performs no provider I/O and owns no schedule.'],
    },
  });
  const selection = {
    version: 1 as const,
    workspaceId,
    expectedWorkspaceRevision: workspace.version,
    expectedWorkspaceDigest: workspaceBindings.canonicalEntityWorkspaceSelectionDigest(workspace),
    bindingId,
    role: 'primary' as const,
  };
  const reviewedOpportunity = opportunity({
    token,
    fields: resultProjection.fields,
    maxPages,
    acceptedTerminalStates: resultProjection.partition.outcomeAuthority.acceptedTerminalStates,
  });
  const proposalDigest = opportunities.automationOpportunityDigest(reviewedOpportunity);
  const proposal: import('../execution/automation-opportunity-store.js').AutomationOpportunityProposalRecordV1 = {
    version: 1,
    proposalId: `proposal_${token}`,
    status: 'approved',
    revision: 2,
    digest: proposalDigest,
    opportunity: reviewedOpportunity,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:02:00.000Z',
    reviewedAt: '2026-08-27T00:01:00.000Z',
    decidedAt: '2026-08-27T00:02:00.000Z',
  };
  const requirement = reviewedOpportunity.capabilityRequirements[0]!;
  const liveCapability: import('../execution/automation-workflow-bridge.js').AutomationLiveCapabilityContractV1 = {
    lifecycle: 'current',
    logicalToolName: `surface_${token}`,
    identity,
    matches: [{
      requirementId: requirement.id,
      requirementDigest: workflowBridge.automationCapabilityRequirementDigest(requirement),
    }],
  };
  const liveSnapshot = {
    digest: workflowBridge.automationLiveCapabilitySnapshotDigest([liveCapability]),
    capabilities: [liveCapability],
  };
  const bridge = workflowBridge.designApprovedAutomationWorkflowBridge({
    proposal,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    activation: { kind: 'preview', target: 'pilot' },
    liveSnapshot,
    readPilotContract: {
      phaseId: reviewedOpportunity.phases[0]!.id,
      requirementId: requirement.id,
      workflowInputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: { source: { kind: 'workflow_input', key: 'scope' }, required: true, type: 'string' },
        cursor: { source: { kind: 'continuation_cursor' }, required: false, type: 'string' },
      },
      evidence: { requiredPaths: [recordsPath], nonEmptyPaths: [recordsPath], minItems: { [recordsPath]: 1 } },
      completeness: { kind: 'finite_exhaustive', exhaustedPath: `${pagePath}.${exhaustedPath}`, evidencePaths: [recordsPath] },
      continuation: { kind: 'cursor', cursorArgument: 'cursor', nextCursorPath: `${pagePath}.${nextPath}`, exhaustedPath: `${pagePath}.${exhaustedPath}`, maxPages },
      resultProjection,
      workspaceBindingSelection: selection,
    },
  });
  if (!bridge.ok || !bridge.preview || bridge.issues.length > 0) {
    throw new Error(`reviewed workflow bridge refused v2 canonical truth: ${JSON.stringify(bridge.issues)}`);
  }
  const plan = bridge.preview.workflow.steps[0]?.invocationPlan;
  if (!plan || plan.resultProjection?.version !== 2) {
    throw new Error('reviewed workflow bridge did not seal a version-2 invocation plan');
  }
  const workflowId = bridge.preview.workflow.name;
  const workspaceApproval = workspaceBindings.createCanonicalEntityWorkspaceBindingApproval({
    selection,
    workflowId,
    at: '2026-08-27T00:03:00.000Z',
  });
  const binding = surfaceBindings.putSoleActiveWorkflowSurfaceBinding({ binding: workspaceApproval.binding });
  if (!binding.ok) throw new Error(`Workspace binding failed: ${JSON.stringify(binding)}`);

  const runId = `run.truth.${token}`;
  const session = eventlog.createSession({ id: `session.truth.${token}`, kind: 'workflow' });
  const lineage = {
    workflowId,
    workflowRevision: 1,
    workflowDigest: digest(`workflow:${label}`),
    runId,
    runOccurrenceId: `occurrence.truth.${token}`,
    nodeId: `node.truth.${token}`,
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(`binding:${label}`),
    controlDigest: digest(`control:${label}`),
  };
  const armed = pagination.armWorkflowPaginatedReadAuthority({
    sessionId: session.id,
    ...lineage,
    invocationPlan: plan,
  });
  if (armed.status !== 'armed') throw new Error(`pagination authority failed: ${JSON.stringify(armed)}`);
  const root: ResultRoot = {
    version: 1,
    executionKind: 'paginated_read',
    activationId: armed.ref.activationId,
    lineage,
    workspaceBinding: workspaceApproval,
  };
  const startedAt = '2026-08-27T00:04:00.000Z';
  const finishedAt = '2026-08-27T00:05:00.000Z';
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
  const read = await readKernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    baseArgs: { scope: `scope-${token}` },
  });
  const expectedDatasetId = `canonical-dataset:${entityResolution.canonicalEntitySha256({
    version: 1,
    workflowId,
    runId,
    activationDigest: armed.ref.activationDigest,
    projectionDigest: resultProjection.projectionDigest,
  })}`;
  const context: FixtureContext = {
    version: 1,
    scenario: scenario!,
    label: label!,
    workflowId,
    runId,
    workspaceId,
    bindingId,
    runFile,
    startedAt,
    finishedAt,
    expectedDatasetId,
    plan,
    root,
    roles: rich.roles,
  };
  writeContext(context);
  const result = producer.produceCanonicalEntityWorkflowLineage({
    version: 1,
    root,
    invocationPlan: plan,
    startedAt,
    proposedFinishedAt: finishedAt,
  });
  emit({
    bridge: { ok: bridge.ok, projectionVersion: plan.resultProjection?.version },
    read,
    result,
    state: inspect(context),
  });
}

if (mode === 'prepare') {
  await prepare();
} else if (mode === 'recover') {
  const context = readContext();
  const result = producer.produceCanonicalEntityWorkflowLineage({
    version: 1,
    root: context.root,
    invocationPlan: context.plan,
    startedAt: context.startedAt,
    proposedFinishedAt: context.finishedAt,
  });
  if (result.status !== 'ready' && result.status !== 'replayed') {
    throw new Error(`canonical lineage did not replay: ${JSON.stringify(result)}`);
  }
  publishTerminal(context, result.claim);
  const reconciliation = runner.reconcileCanonicalEntityWorkspaceProjectionClaims({
    runsDirectory: shared.WORKFLOW_RUNS_DIR,
  });
  emit({ result, reconciliation, state: inspect(context) });
} else if (mode === 'publish_terminal') {
  const context = readContext();
  const result = producer.produceCanonicalEntityWorkflowLineage({
    version: 1,
    root: context.root,
    invocationPlan: context.plan,
    startedAt: context.startedAt,
    proposedFinishedAt: context.finishedAt,
  });
  if (result.status !== 'ready' && result.status !== 'replayed') {
    throw new Error(`canonical lineage unavailable before terminal publication: ${JSON.stringify(result)}`);
  }
  const terminal = publishTerminal(context, result.claim);
  emit({ result, terminal, state: inspect(context) });
} else if (mode === 'inspect') {
  const context = readContext();
  emit({ state: inspect(context) });
} else {
  throw new Error(`unknown canonical truth fixture mode: ${mode}`);
}
