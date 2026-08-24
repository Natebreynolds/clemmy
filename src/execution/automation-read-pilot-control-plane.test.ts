/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-read-pilot-control-plane.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-pilot-control-plane-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const control = await import('./automation-read-pilot-control-plane.js');
const workspaceControl = await import('./automation-read-pilot-workspace-control-plane.js');
const opportunities = await import('./automation-opportunity.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const bridge = await import('./automation-workflow-bridge.js');
const runner = await import('./workflow-runner.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const shared = await import('../tools/shared.js');
const pilotTools = await import('../tools/automation-read-pilot-tools.js');
const resultProjections = await import('../memory/workflow-result-projection-contract.js');
const bindingStore = await import('../spaces/workflow-surface-binding-store.js');
const spaces = await import('../spaces/store.js');
const entityStore = await import('./canonical-entity-store.js');
const workspaceProjection = await import('../spaces/canonical-entity-workspace-store-projection.js');
import type { ClementineAssistant } from '../assistant/core.js';
import type { AutomationOpportunityV1 } from './automation-opportunity.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import type { RegisterAutomationReadPilotProjectionInputV1 } from './automation-read-pilot-control-plane.js';
import type { CanonicalEntityWorkspaceCreationContractV1 } from '../spaces/canonical-entity-workspace-binding-contract.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

test.afterEach(() => {
  control.automationReadPilotControlPlaneInternalsForTest.setAfterQueueAcceptedHook();
  workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest.setAfterWorkspaceSaveHook();
  workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest.setBeforeWorkspaceCreateHook();
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

test.after(() => {
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}_${sequence}`;
}

function opportunity(
  label: string,
  effect: 'read' | 'local_write' | 'external_write' = 'read',
  recurring = false,
  dataset = false,
  maxOperations = 1,
): AutomationOpportunityV1 {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} pilot`,
    objective: `Retrieve one bounded ${label} result with exact evidence.`,
    rationale: 'A disabled pilot verifies one exact live capability binding.',
    lifetime: recurring ? { kind: 'ongoing' } : { kind: 'single_run' },
    recurrence: recurring
      ? {
          mode: 'proposed',
          cadence: { kind: 'interval', every: 2, unit: 'hour' },
          overlapPolicy: 'skip',
          catchUpPolicy: 'run_once',
          activation: 'requires_pilot_success_and_recurrence_consent',
        }
      : { mode: 'none' },
    trigger: recurring ? { kind: 'recurrence' } : { kind: 'manual' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['A bounded result is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: `retrieve bounded ${label} values`,
      minimumEffect: effect,
      constraints: ['Return one bounded result.'],
    }],
    phases: [{
      id: 'read-result',
      objective: `Retrieve one bounded ${label} result.`,
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: {
        class: effect,
        approval: effect === 'read' ? 'not_required' : 'required',
        maxOperationsPerRun: maxOperations,
      },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: effect, maxOperationsPerRun: maxOperations },
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: dataset ? 'dataset_snapshot' : 'artifact',
      required: true,
      successCriterionIds: ['complete'],
      evidence: ['The records collection is present.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'complete',
      description: 'The bounded result is complete.',
      evidence: ['The records collection is non-empty.'],
    }],
    ...(dataset ? {
      dataset: {
        schema: {
          fields: [
            { name: 'key', type: 'string', required: true, sensitivity: 'public' },
            { name: 'scope', type: 'string', required: true, sensitivity: 'internal' },
          ],
          additionalFields: 'reject',
        },
        identity: {
          rules: [{ id: 'by-key', fields: ['key'], match: 'exact', normalizers: ['trim'] }],
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
    } : {}),
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: effect, maxOperationsPerRun: maxOperations },
      successCriterionIds: ['complete'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 1,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: maxOperations,
      reserveOperations: 0,
    },
  });
}

function approvedProposal(
  label: string,
  effect: 'read' | 'local_write' | 'external_write' = 'read',
  recurring = false,
  dataset = false,
  maxOperations = 1,
): AutomationOpportunityProposalRecordV1 {
  const proposalId = unique(`proposal_${label}`);
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId,
    opportunity: opportunity(label, effect, recurring, dataset, maxOperations),
    actorRef: `accepted-source:chat.${label}#1`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error(created.message);
  const reviewed = opportunityStore.transitionAutomationOpportunityProposal({
    proposalId,
    to: 'reviewed',
    expectedRevision: created.record.revision,
    expectedDigest: created.record.digest,
    actorRef: `human-review:${label}`,
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  if (!reviewed.ok) throw new Error(reviewed.message);
  const approved = opportunityStore.transitionAutomationOpportunityProposal({
    proposalId,
    to: 'approved',
    expectedRevision: reviewed.record.revision,
    expectedDigest: reviewed.record.digest,
    actorRef: `human-decision:${label}`,
  });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  if (!approved.ok) throw new Error(approved.message);
  return approved.record;
}

interface BlankStateFixture {
  label: string;
  proposal: AutomationOpportunityProposalRecordV1;
  chatId: string;
  input: Omit<RegisterAutomationReadPilotProjectionInputV1, 'selections'>;
  acquisition: control.AutomationReadPilotCapabilityAcquisitionPortV1;
  workspaceCreation?: CanonicalEntityWorkspaceCreationContractV1;
  bodies(): number;
  materializations(): number;
  payloads(): unknown[];
}

function blankStateFixture(label: string, options: {
  recurring?: boolean;
  dataset?: boolean;
  pages?: number;
  paginationMode?: 'complete' | 'cycle' | 'budget';
} = {}): BlankStateFixture {
  const pageCount = options.pages ?? 1;
  const paginationMode = options.paginationMode ?? 'complete';
  const proposal = approvedProposal(
    label,
    'read',
    options.recurring === true,
    options.dataset === true,
    pageCount,
  );
  const chatId = unique(`chat.${label}`);
  eventlog.createSession({ id: chatId, kind: 'chat' });
  const operationId = unique(`operation.${label}`);
  const accountId = unique(`account.${label}`);
  const providerIdentity = unique(`runtime.${label}`);
  const portId = unique(`port.${label}`);
  const compilerId = unique(`compiler.${label}`);
  let bodies = 0;
  let materializations = 0;
  const payloads: unknown[] = [];
  const carrier: materializer.LiveCapabilityCarrier = {
    identity: { kind: 'host', name: unique(`carrier.${label}`) },
    async enumerate() {
      return [{
        identifier: operationId,
        carrierKind: 'host' as const,
        carrier: carrier.identity.name,
        displayName: `Bounded ${label} values`,
        description: proposal.opportunity.capabilityRequirements[0]!.description,
        effectClass: 'read' as const,
        effectProvenance: 'declared' as const,
        accountIdentity: accountId,
      }];
    },
    async refresh() {},
    observe(reference) {
      if (reference.identifier !== operationId || reference.accountId !== accountId) return 'missing';
      return {
        operationId,
        providerKind: 'local_registry',
        providerIdentity,
        providerVersion: '1',
        operationVersion: '1',
        accountId,
        effect: 'read',
        effectAttestation: 'carrier_declared',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string' },
            ...(pageCount > 1 ? { cursor: { type: 'string' } } : {}),
          },
          required: ['scope'],
        },
        observedAt: Date.now(),
        invoke: {
          portId,
          argumentCompiler: { id: compilerId, version: '1' },
        },
      };
    },
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = manifestStores.createCapabilityManifestStore();
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(store);
  const acquisition: control.AutomationReadPilotCapabilityAcquisitionPortV1 = {
    async acquire(request) {
      materializations += 1;
      return materializer.materializeLiveReadCapability({
        objective: request.objective,
        carrier,
        factory,
        store,
        registerPort: ({ manifest, attestation }) => {
          if (ports.resolveProductionPortsForManifest(manifest)) return { ok: true as const };
          shipped.loadShippedImplementations().registerIsolatedObservation({
            operationId: attestation.reference.identifier,
            accountId: attestation.accountId,
            definitionFingerprint: attestation.definitionFingerprint,
            providerVersion: attestation.providerVersion,
            operationVersion: attestation.operationVersion,
            observedAt: Date.now(),
          });
          return ports.registerFixtureCapabilityPort(
            ports.productionPortIdentityFromManifest(manifest),
            {
              invoke: async ({ payload }) => {
                bodies += 1;
                payloads.push(structuredClone(payload));
                const inputPayload = payload as { scope?: unknown; cursor?: unknown };
                if (pageCount === 1) {
                  return { records: [{ key: `record.${label}`, scope: inputPayload.scope }] };
                }
                const index = inputPayload.cursor === undefined || inputPayload.cursor === null
                  ? 0
                  : Number(String(inputPayload.cursor).split('-').at(-1));
                if (!Number.isSafeInteger(index) || index < 0 || index >= pageCount) {
                  throw new Error('unexpected exact continuation cursor');
                }
                const final = index === pageCount - 1;
                const cycle = paginationMode === 'cycle' && index === 1;
                const budget = paginationMode === 'budget';
                return {
                  records: [{
                    key: index < 2 ? `record.${label}.shared` : `record.${label}.${index}`,
                    scope: inputPayload.scope,
                  }],
                  ...(cycle
                    ? { nextCursor: `cursor-${index}` }
                    : final && !budget
                      ? {}
                      : { nextCursor: `cursor-${index + 1}` }),
                  exhausted: final && !budget,
                };
              },
            },
          );
        },
      });
    },
  };
  let workspaceCreation: CanonicalEntityWorkspaceCreationContractV1 | undefined;
  const input: Omit<RegisterAutomationReadPilotProjectionInputV1, 'selections'> = {
    proposalId: proposal.proposalId,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    approvalSessionId: chatId,
    originSessionId: chatId,
    contract: {
      phaseId: 'read-result',
      requirementId: 'bounded-read',
      workflowInputs: {
        scope: { type: 'string', required: true },
      },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
        ...(pageCount > 1 ? {
          cursor: {
            source: { kind: 'continuation_cursor' as const },
            required: false as const,
            type: 'string' as const,
          },
        } : {}),
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: pageCount > 1
        ? {
            kind: 'finite_exhaustive',
            exhaustedPath: 'exhausted',
            evidencePaths: ['records'],
          }
        : { kind: 'terminal_result', evidencePaths: ['records'] },
      ...(pageCount > 1 ? {
        continuation: {
          kind: 'cursor' as const,
          cursorArgument: 'cursor',
          nextCursorPath: 'nextCursor',
          exhaustedPath: 'exhausted',
          maxPages: pageCount,
        },
      } : {}),
      ...(options.dataset === true ? (() => {
        const workspaceId = `workspace-${unique('dataset').replaceAll('_', '-').toLowerCase()}`;
        workspaceCreation = {
          version: 1,
          workspaceId,
          title: 'Reviewed dataset workspace',
          objective: 'Present exact canonical entity coverage from the approved pilot.',
          successCriteria: ['Only digest-bound canonical truth is visible.'],
          invariants: ['This Workspace grants no execution or schedule authority.'],
          originSessionId: chatId,
        };
        return {
          resultProjection: resultProjections.createWorkflowCanonicalEntityResultProjection({
            recordsPath: 'records',
            fields: [
              { field: 'key', recordPath: 'key', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
              { field: 'scope', recordPath: 'scope', type: 'string', required: true, sensitivity: 'internal', confidence: 1 },
            ],
            sourceRecord: { idPath: 'key', observedAt: { kind: 'page_settled_at' } },
            entityKind: 'generic-record',
            identityRules: [{
              ruleId: 'by-key',
              fields: ['key'],
              normalizers: ['trim'],
              exactIdentifierNamespace: 'generic-key',
            }],
            resolutionPolicy: {
              policyId: 'exact-generic-key',
              mergeThreshold: 10,
              distinctThreshold: 2,
              ambiguityMargin: 1,
              weights: {
                defaultExactIdentifierMatch: 10,
                defaultCompoundSignalMatch: 0,
              },
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
              maxPages: pageCount,
              maxRecordsPerPage: 10,
              maxRecords: 10,
              maxPageBytes: 100_000,
              maxRecordBytes: 10_000,
              maxTotalBytes: 100_000,
            },
          }),
        };
      })() : {}),
    },
    workflowInputs: { scope: `scope.${label}` },
  };
  return {
    label,
    proposal,
    chatId,
    input,
    acquisition,
    ...(workspaceCreation ? { workspaceCreation } : {}),
    bodies: () => bodies,
    materializations: () => materializations,
    payloads: () => structuredClone(payloads),
  };
}

function runFiles(): string[] {
  if (!existsSync(shared.WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(shared.WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function kernelCounts(): {
  activations: number;
  logical: number;
  physical: number;
  settlements: number;
} {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_node_invocation_activations) AS activations,
      (SELECT COUNT(*) FROM logical_tool_calls) AS logical,
      (SELECT COUNT(*) FROM physical_dispatches WHERE io_claimed_at IS NOT NULL) AS physical,
      (SELECT COUNT(*) FROM logical_call_settlements) AS settlements
  `).get() as {
    activations: number;
    logical: number;
    physical: number;
    settlements: number;
  };
}

type PilotToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function chatPilotSurface(fixture: BlankStateFixture): {
  acquisitionRef: string;
  handlers: Map<string, (input: Record<string, unknown>) => Promise<PilotToolResult>>;
} {
  const acquisitionRef = `pilot-acquisition:host:${digest(fixture.label)}`;
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<PilotToolResult>>();
  const server = {
    tool(
      name: string,
      _description: string,
      _parameters: unknown,
      handler: (input: Record<string, unknown>) => Promise<PilotToolResult>,
    ): void {
      handlers.set(name, handler);
    },
  };
  pilotTools.registerAutomationReadPilotTools(server as never, {
    acceptedSource: () => ({ sessionId: fixture.chatId, sourceUserSeq: 1 }),
    listAcquisitions: () => [{
      acquisitionRef,
      carrierKind: 'host',
      label: 'Configured live carrier',
      description: 'One exact provider-neutral fixture carrier.',
    }],
    resolveAcquisition: (candidate) => candidate === acquisitionRef
      ? { ok: true, acquisition: fixture.acquisition }
      : { ok: false, code: 'acquisition_ref_stale', reason: 'Reference is not current.' },
  });
  return { acquisitionRef, handlers };
}

function chatPilotRequest(
  fixture: BlankStateFixture,
  acquisitionRef: string,
): Record<string, unknown> {
  const projection = fixture.input.contract.resultProjection;
  const workspaceBinding = fixture.input.contract.workspaceBindingSelection;
  return {
    proposal_id: fixture.input.proposalId,
    expected_proposal_revision: fixture.input.expectedProposalRevision,
    expected_proposal_digest: fixture.input.expectedProposalDigest,
    acquisition_ref: acquisitionRef,
    contract: {
      phase_id: fixture.input.contract.phaseId,
      requirement_id: fixture.input.contract.requirementId,
      workflow_inputs: fixture.input.contract.workflowInputs,
      arguments: fixture.input.contract.arguments,
      evidence: {
        required_paths: fixture.input.contract.evidence.requiredPaths,
        non_empty_paths: fixture.input.contract.evidence.nonEmptyPaths,
        min_items: fixture.input.contract.evidence.minItems,
      },
      completeness: fixture.input.contract.completeness.kind === 'terminal_result'
        ? {
            kind: 'terminal_result',
            evidence_paths: fixture.input.contract.completeness.evidencePaths,
          }
        : {
            kind: 'finite_exhaustive',
            exhausted_path: fixture.input.contract.completeness.exhaustedPath,
            evidence_paths: fixture.input.contract.completeness.evidencePaths,
          },
      ...(fixture.input.contract.continuation
        ? {
            continuation: fixture.input.contract.continuation.kind === 'none'
              ? { kind: 'none' }
              : {
                  kind: 'cursor',
                  cursor_argument: fixture.input.contract.continuation.cursorArgument,
                  next_cursor_path: fixture.input.contract.continuation.nextCursorPath,
                  exhausted_path: fixture.input.contract.continuation.exhaustedPath,
                  max_pages: fixture.input.contract.continuation.maxPages,
                },
          }
        : {}),
      ...(projection ? {
        result_projection: {
          version: 1,
          records_path: projection.recordsPath,
          fields: projection.fields.map((field) => ({
            field: field.field,
            record_path: field.recordPath,
            type: field.type,
            required: field.required,
            sensitivity: field.sensitivity,
            confidence: field.confidence,
          })),
          source_record: {
            id_path: projection.sourceRecord.idPath,
            ...(projection.sourceRecord.revisionPath
              ? { revision_path: projection.sourceRecord.revisionPath }
              : {}),
            observed_at: projection.sourceRecord.observedAt.kind === 'record_path'
              ? { kind: 'record_path', path: projection.sourceRecord.observedAt.path }
              : { kind: 'page_settled_at' },
          },
          entity_kind: projection.entityKind,
          identity_rules: projection.identityRules.map((rule) => ({
            rule_id: rule.ruleId,
            fields: rule.fields,
            normalizers: rule.normalizers,
            exact_identifier_namespace: rule.exactIdentifierNamespace,
          })),
          resolution_policy: {
            policy_id: projection.resolutionPolicy.policyId,
            merge_threshold: projection.resolutionPolicy.mergeThreshold,
            distinct_threshold: projection.resolutionPolicy.distinctThreshold,
            ambiguity_margin: projection.resolutionPolicy.ambiguityMargin,
            weights: {
              default_exact_identifier_match: projection.resolutionPolicy.weights.defaultExactIdentifierMatch,
              ...(projection.resolutionPolicy.weights.exactIdentifierMatches
                ? { exact_identifier_matches: projection.resolutionPolicy.weights.exactIdentifierMatches }
                : {}),
              default_compound_signal_match: projection.resolutionPolicy.weights.defaultCompoundSignalMatch,
              ...(projection.resolutionPolicy.weights.compoundSignalMatches
                ? { compound_signal_matches: projection.resolutionPolicy.weights.compoundSignalMatches }
                : {}),
            },
            ...(projection.resolutionPolicy.exclusiveIdentifierNamespaces
              ? { exclusive_identifier_namespaces: projection.resolutionPolicy.exclusiveIdentifierNamespaces }
              : {}),
          },
          field_resolution: {
            kind: projection.fieldResolution.kind,
            selection: projection.fieldResolution.selection,
            conflict: projection.fieldResolution.conflict,
          },
          provenance: {
            kind: projection.provenance.kind,
            retain_source_snapshots: projection.provenance.retainSourceSnapshots,
          },
          partition: {
            kind: projection.partition.kind,
            coverage_items: projection.partition.coverageItems,
            denominator: projection.partition.denominator,
            completion: projection.partition.completion,
          },
          bounds: {
            max_pages: projection.bounds.maxPages,
            max_records_per_page: projection.bounds.maxRecordsPerPage,
            max_records: projection.bounds.maxRecords,
            max_page_bytes: projection.bounds.maxPageBytes,
            max_record_bytes: projection.bounds.maxRecordBytes,
            max_total_bytes: projection.bounds.maxTotalBytes,
          },
        },
      } : {}),
      ...(workspaceBinding ? {
        workspace_binding_selection: {
          version: 1,
          workspace_id: workspaceBinding.workspaceId,
          expected_workspace_revision: workspaceBinding.expectedWorkspaceRevision,
          expected_workspace_digest: workspaceBinding.expectedWorkspaceDigest,
          binding_id: workspaceBinding.bindingId,
          role: workspaceBinding.role,
        },
      } : {}),
    },
    workflow_inputs: fixture.input.workflowInputs,
  };
}

function chatPilotAcquisitionListRequest(
  fixture: BlankStateFixture,
): Record<string, unknown> {
  return {
    proposal_id: fixture.input.proposalId,
    expected_proposal_revision: fixture.input.expectedProposalRevision,
    expected_proposal_digest: fixture.input.expectedProposalDigest,
    phase_id: fixture.input.contract.phaseId,
    requirement_id: fixture.input.contract.requirementId,
  };
}

function chatWorkspaceCreationRequest(fixture: BlankStateFixture): Record<string, unknown> {
  const creation = fixture.workspaceCreation;
  assert.ok(creation);
  return {
    ...chatPilotAcquisitionListRequest(fixture),
    workspace: {
      workspace_id: creation.workspaceId,
      title: creation.title,
      objective: creation.objective,
      success_criteria: creation.successCriteria,
      invariants: creation.invariants,
    },
  };
}

function pilotToolJson(result: PilotToolResult): Record<string, any> {
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

test('blank-state chat projection acquires live authority, shows one exact card, queues once, and runner crosses once', async () => {
  const fixture = blankStateFixture('alpha');
  const surface = chatPilotSurface(fixture);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(manifestStores.peekCapabilityManifestStore()?.list().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);

  const list = pilotToolJson(await surface.handlers.get('automation_read_pilot_acquisition_list')!(
    chatPilotAcquisitionListRequest(fixture),
  ));
  assert.deepEqual(list.acquisitions.map((entry: { acquisitionRef: string }) => entry.acquisitionRef), [
    surface.acquisitionRef,
  ]);
  assert.equal(list.executionAuthority, 'none');

  const requested = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(
    chatPilotRequest(fixture, surface.acquisitionRef),
  ));
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.projection.status, 'approval_pending');
  assert.equal(requested.approval.status, 'pending');
  assert.equal(requested.approvalCreated, true);
  assert.equal(requested.cardCreated, true);
  assert.equal(requested.executionAuthority, 'pending_exact_approval');
  assert.equal(requested.recurrenceAuthority, 'none');
  const registeredApproval = approvals.get(requested.approval.approvalId);
  assert.equal(registeredApproval?.tool, 'workflow_node_read');
  assert.equal(fixture.materializations(), 1);
  assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, 1);
  assert.equal(runFiles().length, 0);

  // Lost chat response / exact retry: acquisition can re-observe live state,
  // but the projection, formal row, and card identities stay first-winner.
  const retried = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(
    chatPilotRequest(fixture, surface.acquisitionRef),
  ));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.projection.projectionId, requested.projection.projectionId);
  assert.equal(retried.approval.approvalId, requested.approval.approvalId);
  assert.equal(retried.approvalCreated, false);
  assert.equal(retried.cardCreated, false);
  assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, 1);

  const approved = approvals.resolve(requested.approval.approvalId, 'approved', `human.${fixture.label}`);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const before = kernelCounts();
  const reconciled = control.reconcileAutomationReadPilotProjection(requested.projection.projectionId);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  if (!reconciled.ok) return;
  assert.equal(reconciled.state, 'queued');
  assert.equal(reconciled.projection.status, 'queued');
  assert.ok(reconciled.projection.runId);
  assert.ok(reconciled.projection.triggerReceiptId);
  assert.equal(runFiles().length, 1);
  assert.equal(fixture.bodies(), 0, 'queue reconciliation performs no provider body');

  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1);
  const after = kernelCounts();
  assert.deepEqual({
    activations: after.activations - before.activations,
    logical: after.logical - before.logical,
    physical: after.physical - before.physical,
    settlements: after.settlements - before.settlements,
  }, { activations: 1, logical: 1, physical: 1, settlements: 1 });

  const replay = control.reconcileAutomationReadPilotProjection(requested.projection.projectionId);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  if (replay.ok) assert.equal(replay.state, 'already_queued');
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1);
  assert.deepEqual(kernelCounts(), after);

  const terminalReplay = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(
    chatPilotRequest(fixture, surface.acquisitionRef),
  ));
  assert.equal(terminalReplay.ok, true);
  assert.equal(terminalReplay.projection.status, 'queued');
  assert.equal(terminalReplay.executionAuthority, 'queued_one_shot_pilot');
  assert.equal(terminalReplay.cardCreated, false);
  assert.equal(fixture.bodies(), 1, 'terminal request replay cannot cross the provider body');
});

test('Workspace creation approval converges across crash, rejection, expiry, cancellation, drift, and cross-session misuse', async (t) => {
  await t.test('crash after exact manifest write replays without a duplicate Workspace or card', async () => {
    const fixture = blankStateFixture('workspace_crash', { dataset: true });
    const surface = chatPilotSurface(fixture);
    const requested = pilotToolJson(await surface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(fixture)));
    assert.equal(requested.ok, true, JSON.stringify(requested));
    assert.equal(approvals.resolve(
      requested.approval.approvalId,
      'approved',
      'human.workspace-crash',
    ).ok, true);
    workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest
      .setAfterWorkspaceSaveHook(() => {
        throw new Error('simulated hard stop after exact Workspace manifest write');
      });
    assert.throws(
      () => workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
        requested.projection.projectionId,
      ),
      /simulated hard stop/,
    );
    assert.equal(
      workspaceControl.loadAutomationReadPilotWorkspaceCreation(requested.projection.projectionId)?.status,
      'creating',
    );
    const interrupted = spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId);
    assert.equal(interrupted?.version, 1);

    eventlog.closeEventLog();
    workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest.setAfterWorkspaceSaveHook();
    const recovered = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      requested.projection.projectionId,
    );
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (!recovered.ok) return;
    assert.equal(recovered.state, 'created');
    assert.equal(recovered.projection.selection?.workspaceId, fixture.workspaceCreation!.workspaceId);
    assert.equal(spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId)?.version, 1);
    const replay = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      requested.projection.projectionId,
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    if (replay.ok) assert.equal(replay.state, 'already_created');
    const toolReplay = pilotToolJson(await surface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(fixture)));
    assert.equal(toolReplay.projection.status, 'created');
    assert.equal(toolReplay.approval.approvalId, requested.approval.approvalId);
    assert.equal(toolReplay.approvalCreated, false);
    assert.equal(toolReplay.cardCreated, false);
  });

  await t.test('non-approval decisions and stale or foreign sources create nothing', async () => {
    for (const resolution of ['rejected', 'expired', 'cancelled_by_user'] as const) {
      const fixture = blankStateFixture(unique(`workspace_${resolution}`), { dataset: true });
      const surface = chatPilotSurface(fixture);
      const requested = pilotToolJson(await surface.handlers.get(
        'automation_read_pilot_workspace_create_request',
      )!(chatWorkspaceCreationRequest(fixture)));
      assert.equal(requested.ok, true, JSON.stringify(requested));
      assert.equal(approvals.resolve(
        requested.approval.approvalId,
        resolution,
        `human.${resolution}`,
      ).ok, true);
      const reconciled = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
        requested.projection.projectionId,
      );
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
      if (reconciled.ok) assert.equal(reconciled.state, 'refused');
      assert.equal(spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId), undefined);
    }

    const lateFixture = blankStateFixture(unique('workspace_late_approval'), { dataset: true });
    const lateSurface = chatPilotSurface(lateFixture);
    const lateRequest = pilotToolJson(await lateSurface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(lateFixture)));
    assert.equal(lateRequest.ok, true, JSON.stringify(lateRequest));
    eventlog.openEventLog().prepare(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
    ).run(new Date(Date.now() - 1_000).toISOString(), lateRequest.approval.approvalId);
    const lateWorkspaceDecision = approvals.resolve(
      lateRequest.approval.approvalId,
      'approved',
      'human.workspace-too-late',
    );
    assert.equal(lateWorkspaceDecision.ok, false);
    assert.equal(lateWorkspaceDecision.reason, 'expired');
    const lateReconciled = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      lateRequest.projection.projectionId,
    );
    assert.equal(lateReconciled.ok, true, JSON.stringify(lateReconciled));
    if (lateReconciled.ok) {
      assert.equal(lateReconciled.state, 'refused');
      assert.equal(lateReconciled.projection.refusalCode, 'workspace_creation_approval_expired');
    }
    assert.equal(spaces.spaceStore.get(lateFixture.workspaceCreation!.workspaceId), undefined);

    const foreign = blankStateFixture('workspace_foreign', { dataset: true });
    const beforeCards = eventlog.listEvents(foreign.chatId, { types: ['approval_requested'] }).length;
    const crossSession = workspaceControl.requestAutomationReadPilotWorkspaceCreation({
      proposalId: foreign.proposal.proposalId,
      expectedProposalRevision: foreign.proposal.revision,
      expectedProposalDigest: foreign.proposal.digest,
      approvalSessionId: foreign.chatId,
      sourceUserSeq: 1,
      contract: { ...foreign.workspaceCreation!, originSessionId: 'chat.foreign-session' },
    });
    assert.equal(crossSession.ok, false);
    assert.equal(eventlog.listEvents(foreign.chatId, { types: ['approval_requested'] }).length, beforeCards);
    assert.equal(spaces.spaceStore.get(foreign.workspaceCreation!.workspaceId), undefined);

    const staleSurface = chatPilotSurface(foreign);
    const stale = pilotToolJson(await staleSurface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!({
      ...chatWorkspaceCreationRequest(foreign),
      expected_proposal_digest: digest('stale-workspace-proposal'),
    }));
    assert.equal(stale.ok, false);
    assert.equal(spaces.spaceStore.get(foreign.workspaceCreation!.workspaceId), undefined);
  });

  await t.test('a conflicting manifest after approval refuses without binding, queue, or run', async () => {
    const baselineRuns = runFiles().length;
    const fixture = blankStateFixture('workspace_drift', { dataset: true });
    const surface = chatPilotSurface(fixture);
    const requested = pilotToolJson(await surface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(fixture)));
    assert.equal(approvals.resolve(
      requested.approval.approvalId,
      'approved',
      'human.workspace-drift',
    ).ok, true);
    spaces.spaceStore.save({
      id: fixture.workspaceCreation!.workspaceId,
      title: 'Contradictory manifest',
      originSessionId: fixture.chatId,
    });
    const reconciled = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      requested.projection.projectionId,
    );
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    if (reconciled.ok) assert.equal(reconciled.state, 'refused');
    assert.equal(bindingStore.listWorkflowSurfaceBindingsForWorkspace(
      fixture.workspaceCreation!.workspaceId,
    ).length, 0);
    assert.equal(runFiles().length, baselineRuns);
    assert.equal(fixture.bodies(), 0);
  });

  await t.test('a concurrent manifest appearing after the absence read is never overwritten', async () => {
    const baselineRuns = runFiles().length;
    const fixture = blankStateFixture('workspace_create_race', { dataset: true });
    const surface = chatPilotSurface(fixture);
    const requested = pilotToolJson(await surface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(fixture)));
    assert.equal(requested.ok, true, JSON.stringify(requested));
    assert.equal(approvals.resolve(
      requested.approval.approvalId,
      'approved',
      'human.workspace-race',
    ).ok, true);
    workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest
      .setBeforeWorkspaceCreateHook(() => {
        spaces.spaceStore.save({
          id: fixture.workspaceCreation!.workspaceId,
          title: 'User-owned concurrent Workspace',
          contract: {
            objective: 'Keep these exact user-owned bytes.',
            successCriteria: ['Do not overwrite this Workspace.'],
            invariants: ['The approved create-only path remains non-destructive.'],
          },
          dataSources: [{ id: 'user-owned-source' }],
          actions: [{ id: 'user-owned-action', label: 'User-owned action' }],
          originSessionId: fixture.chatId,
        });
        workspaceControl.automationReadPilotWorkspaceControlPlaneInternalsForTest
          .setBeforeWorkspaceCreateHook();
      });
    const reconciled = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      requested.projection.projectionId,
    );
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    if (reconciled.ok) assert.equal(reconciled.state, 'refused');
    const surviving = spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId);
    assert.equal(surviving?.title, 'User-owned concurrent Workspace');
    assert.equal(surviving?.contract?.objective, 'Keep these exact user-owned bytes.');
    assert.deepEqual(surviving?.dataSources.map((source) => source.id), ['user-owned-source']);
    assert.deepEqual(surviving?.actions.map((action) => action.id), ['user-owned-action']);
    assert.equal(bindingStore.listWorkflowSurfaceBindingsForWorkspace(
      fixture.workspaceCreation!.workspaceId,
    ).length, 0);
    assert.equal(runFiles().length, baselineRuns);
    assert.equal(fixture.bodies(), 0);
  });
});

test('blank-home reviewed dataset chat pilot crosses three pages and publishes canonical truth before success', async () => {
  const baselineRunFiles = runFiles().length;
  const fixture = blankStateFixture('dataset', { dataset: true, pages: 3 });
  const surface = chatPilotSurface(fixture);
  assert.ok(fixture.workspaceCreation);
  assert.equal(spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId), undefined);
  const creationRequested = pilotToolJson(await surface.handlers.get(
    'automation_read_pilot_workspace_create_request',
  )!(chatWorkspaceCreationRequest(fixture)));
  assert.equal(creationRequested.ok, true, JSON.stringify(creationRequested));
  assert.equal(creationRequested.projection.status, 'approval_pending');
  assert.equal(creationRequested.executionAuthority, 'none');
  assert.equal(creationRequested.workflowBindingAuthority, 'none');
  assert.equal(spaces.spaceStore.get(fixture.workspaceCreation!.workspaceId), undefined);
  const creationApproval = approvals.get(creationRequested.approval.approvalId);
  assert.equal(creationApproval?.args.authority.execution, 'none');
  assert.equal(creationApproval?.args.authority.schedule, 'none');
  assert.equal(
    (creationApproval?.args.creation as { workspaceId?: string } | undefined)?.workspaceId,
    fixture.workspaceCreation!.workspaceId,
  );
  const creationRetry = pilotToolJson(await surface.handlers.get(
    'automation_read_pilot_workspace_create_request',
  )!(chatWorkspaceCreationRequest(fixture)));
  assert.equal(creationRetry.approval.approvalId, creationRequested.approval.approvalId);
  assert.equal(creationRetry.approvalCreated, false);
  assert.equal(creationRetry.cardCreated, false);
  assert.equal(approvals.resolve(
    creationRequested.approval.approvalId,
    'approved',
    'human.workspace',
  ).ok, true);
  const created = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
    creationRequested.projection.projectionId,
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok || !created.projection.selection) return;
  assert.equal(created.state, 'created');
  const workspaceSelection = created.projection.selection;
  fixture.input.contract.workspaceBindingSelection = workspaceSelection;
  assert.ok(spaces.spaceStore.get(workspaceSelection.workspaceId));
  const inventory = pilotToolJson(await surface.handlers.get('automation_read_pilot_workspace_list')!(
    chatPilotAcquisitionListRequest(fixture),
  ));
  assert.equal(inventory.ok, true);
  const selectedInventory = inventory.workspaces.filter((candidate: { workspaceId?: string }) => (
    candidate.workspaceId === workspaceSelection.workspaceId
  ));
  assert.deepEqual(selectedInventory, [{
    workspaceId: workspaceSelection.workspaceId,
    expectedWorkspaceRevision: workspaceSelection.expectedWorkspaceRevision,
    expectedWorkspaceDigest: workspaceSelection.expectedWorkspaceDigest,
  }]);
  assert.equal(inventory.selectionAuthority, 'none');

  const requested = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(
    chatPilotRequest(fixture, surface.acquisitionRef),
  ));
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const approval = approvals.get(requested.approval.approvalId);
  assert.ok(approval?.args.resultProjection);
  assert.equal(
    (approval?.args.resultProjection as { bounds?: { maxPages?: number } } | undefined)?.bounds?.maxPages,
    3,
  );
  assert.equal(
    (approval?.args.workspaceBinding as { selection?: { workspaceId?: string } } | undefined)
      ?.selection?.workspaceId,
    workspaceSelection.workspaceId,
  );
  assert.equal(runFiles().length, baselineRunFiles);
  assert.equal(bindingStore.listWorkflowSurfaceBindingsForWorkspace(workspaceSelection.workspaceId).length, 0);

  assert.equal(approvals.resolve(
    requested.approval.approvalId,
    'approved',
    'human.dataset',
  ).ok, true);
  const queued = control.reconcileAutomationReadPilotProjection(requested.projection.projectionId);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (!queued.ok || !queued.projection.runId) return;
  const binding = bindingStore.getWorkflowSurfaceBinding(workspaceSelection.bindingId);
  assert.ok(binding);
  assert.equal(binding?.workflowId, `automation-${fixture.proposal.digest.slice(0, 16)}`);
  assert.equal(binding?.workspaceId, workspaceSelection.workspaceId);
  assert.equal(fixture.bodies(), 0);

  await runner.processWorkflowRuns({} as ClementineAssistant);
  const runPath = path.join(shared.WORKFLOW_RUNS_DIR, `${queued.projection.runId}.json`);
  const runBytes = (await import('node:fs')).readFileSync(runPath, 'utf8');
  const paginationDebug = {
    payloads: fixture.payloads(),
    activations: eventlog.openEventLog().prepare(`
      SELECT activation_id, aggregate_state, next_page_ordinal, close_reason
        FROM workflow_paginated_read_activations WHERE run_id = ?
    `).all(queued.projection.runId),
    pages: eventlog.openEventLog().prepare(`
      SELECT page_ordinal, state, continuation_state, provider_exhausted_truth
        FROM workflow_paginated_read_pages
       WHERE activation_id IN (
         SELECT activation_id FROM workflow_paginated_read_activations WHERE run_id = ?
       ) ORDER BY page_ordinal
    `).all(queued.projection.runId),
    calls: eventlog.openEventLog().prepare(`
      SELECT l.logical_tool_call_id, l.state AS logical_state, l.outcome_kind,
             p.state AS physical_state, s.outcome_kind AS settlement_outcome,
             s.outcome_detail
        FROM logical_tool_calls l
        LEFT JOIN physical_dispatches p
          ON p.session_id = l.session_id AND p.source_user_seq = l.source_user_seq
         AND p.logical_tool_call_id = l.logical_tool_call_id
        LEFT JOIN logical_call_settlements s
          ON s.session_id = l.session_id AND s.source_user_seq = l.source_user_seq
         AND s.logical_tool_call_id = l.logical_tool_call_id
       WHERE l.accepted_task_id LIKE 'workflow-paginated-authority:%'
       ORDER BY l.opened_at
    `).all(),
  };
  assert.equal(fixture.bodies(), 3, `${runBytes}\n${JSON.stringify(paginationDebug, null, 2)}`);
  const terminal = JSON.parse(runBytes) as {
    status?: string;
    terminalOutcome?: string;
    canonicalEntityWorkspaceProjectionClaim?: {
      identity?: { datasetId?: string };
    };
  };
  assert.equal(terminal.status, 'completed', runBytes);
  assert.equal(terminal.terminalOutcome, 'succeeded', runBytes);
  assert.ok(terminal.canonicalEntityWorkspaceProjectionClaim?.identity?.datasetId);
  assert.equal(runBytes.includes('record.dataset'), false, 'provider entity bodies stay out of the run/event projection');
  const datasetId = terminal.canonicalEntityWorkspaceProjectionClaim!.identity!.datasetId!;
  const dataset = entityStore.getCanonicalDataset(datasetId);
  const coverage = entityStore.summarizeStoredDatasetCoverage(datasetId);
  assert.ok(dataset);
  assert.equal(coverage?.status, 'complete');
  assert.equal(coverage?.exhaustion, 'exhausted');
  assert.equal(coverage?.observed, 3);
  const head = workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(workspaceSelection.bindingId);
  assert.equal(head?.identity.datasetId, datasetId);
  assert.equal(head?.coverage.status, 'complete');
  assert.equal(head?.records.canonicalRecordsCreated, 2);
  assert.equal(head?.records.mergedObservations, 1);
  assert.equal(head?.quarantine.observationCount, 0);
  const firstHeadDigest = head?.headDigest;

  assert.deepEqual(
    runner.reconcileCanonicalEntityWorkspaceProjectionClaims(),
    { eligible: 1, projected: 0, replayed: 1, blocked: 0, failed: 0 },
  );
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 3, 'boot/retry cannot redispatch the retained read pages');
  assert.equal(
    workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(workspaceSelection.bindingId)?.headDigest,
    firstHeadDigest,
  );
});

test('partial budget and cursor-cycle runs never publish canonical completeness or a Workspace head', async () => {
  for (const scenario of [
    { mode: 'cycle' as const, expectedBodies: 2 },
    { mode: 'budget' as const, expectedBodies: 3 },
  ]) {
    const fixture = blankStateFixture(`dataset_${scenario.mode}`, {
      dataset: true,
      pages: 3,
      paginationMode: scenario.mode,
    });
    const surface = chatPilotSurface(fixture);
    const create = pilotToolJson(await surface.handlers.get(
      'automation_read_pilot_workspace_create_request',
    )!(chatWorkspaceCreationRequest(fixture)));
    assert.equal(create.ok, true, JSON.stringify(create));
    assert.equal(approvals.resolve(
      create.approval.approvalId,
      'approved',
      `human.workspace-${scenario.mode}`,
    ).ok, true);
    const created = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(
      create.projection.projectionId,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok || !created.projection.selection) continue;
    fixture.input.contract.workspaceBindingSelection = created.projection.selection;
    const pilot = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(
      chatPilotRequest(fixture, surface.acquisitionRef),
    ));
    assert.equal(pilot.ok, true, JSON.stringify(pilot));
    assert.equal(approvals.resolve(
      pilot.approval.approvalId,
      'approved',
      `human.pilot-${scenario.mode}`,
    ).ok, true);
    const queued = control.reconcileAutomationReadPilotProjection(pilot.projection.projectionId);
    assert.equal(queued.ok, true, JSON.stringify(queued));
    if (!queued.ok || !queued.projection.runId) continue;
    await runner.processWorkflowRuns({} as ClementineAssistant);
    assert.equal(fixture.bodies(), scenario.expectedBodies);
    const runBytes = (await import('node:fs')).readFileSync(
      path.join(shared.WORKFLOW_RUNS_DIR, `${queued.projection.runId}.json`),
      'utf8',
    );
    const terminal = JSON.parse(runBytes) as {
      terminalOutcome?: string;
      canonicalEntityWorkspaceProjectionClaim?: unknown;
    };
    assert.equal(terminal.terminalOutcome, 'blocked', runBytes);
    assert.equal(terminal.canonicalEntityWorkspaceProjectionClaim, undefined);
    assert.equal(
      workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(
        created.projection.selection.bindingId,
      ),
      null,
    );
    await runner.processWorkflowRuns({} as ClementineAssistant);
    assert.equal(fixture.bodies(), scenario.expectedBodies, 'terminal partial/cycle replay cannot redispatch');
  }
});

test('crash after queue acceptance recovers from the immutable receipt without a sibling run', async () => {
  const fixture = blankStateFixture('beta');
  const baselineRunFiles = runFiles().length;
  const registered = await control.acquireAndRegisterAutomationReadPilotProjection({
    ...fixture.input,
    acquisition: fixture.acquisition,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  assert.equal(
    approvals.resolve(registered.approval.approvalId, 'approved', `human.${fixture.label}`).ok,
    true,
  );

  control.automationReadPilotControlPlaneInternalsForTest.setAfterQueueAcceptedHook(() => {
    throw new Error('simulated process death after queue acceptance');
  });
  assert.throws(
    () => control.reconcileAutomationReadPilotProjection(registered.projection.projectionId),
    /simulated process death/,
  );
  const interrupted = control.loadAutomationReadPilotProjection(registered.projection.projectionId);
  assert.equal(interrupted?.status, 'queueing');
  assert.ok(interrupted?.triggerReceiptId);
  assert.equal(runFiles().length, baselineRunFiles + 1);
  assert.equal(fixture.bodies(), 0);

  // Reopen the authority DB as a process restart would. The catalog/manifest
  // stay current, but recovery must use the receipt before consulting either.
  eventlog.closeEventLog();
  control.automationReadPilotControlPlaneInternalsForTest.setAfterQueueAcceptedHook();
  const recovered = control.reconcileAutomationReadPilotProjection(registered.projection.projectionId);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  if (!recovered.ok) return;
  assert.equal(recovered.state, 'queued');
  assert.ok(recovered.projection.runId);
  assert.equal(runFiles().length, baselineRunFiles + 1, 'receipt recovery cannot create a sibling run');

  const duplicate = control.reconcileAutomationReadPilotProjection(registered.projection.projectionId);
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  if (duplicate.ok) assert.equal(duplicate.state, 'already_queued');
  assert.equal(runFiles().length, baselineRunFiles + 1);
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1);
});

test('declined, expired, drifted, missing, ambiguous, paginated, compute, and write shapes queue nothing', async (t) => {
  await t.test('declined and expired exact rows become terminal refusals', async () => {
    for (const resolution of ['rejected', 'expired'] as const) {
      const fixture = blankStateFixture(unique(resolution));
      const registered = await control.acquireAndRegisterAutomationReadPilotProjection({
        ...fixture.input,
        acquisition: fixture.acquisition,
      });
      assert.equal(registered.ok, true, JSON.stringify(registered));
      if (!registered.ok) continue;
      assert.equal(approvals.resolve(
        registered.approval.approvalId,
        resolution,
        `human.${resolution}`,
      ).ok, true);
      const reconciled = control.reconcileAutomationReadPilotProjection(registered.projection.projectionId);
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
      if (reconciled.ok) assert.equal(reconciled.state, 'refused');
      assert.equal(fixture.bodies(), 0);
    }

    const lateFixture = blankStateFixture(unique('late-approved'));
    const baselineRunFiles = runFiles().length;
    const lateRegistered = await control.acquireAndRegisterAutomationReadPilotProjection({
      ...lateFixture.input,
      acquisition: lateFixture.acquisition,
    });
    assert.equal(lateRegistered.ok, true, JSON.stringify(lateRegistered));
    if (!lateRegistered.ok) return;
    eventlog.openEventLog().prepare(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
    ).run(new Date(Date.now() - 1_000).toISOString(), lateRegistered.approval.approvalId);
    const latePilotDecision = approvals.resolve(
      lateRegistered.approval.approvalId,
      'approved',
      'human.pilot-too-late',
    );
    assert.equal(latePilotDecision.ok, false);
    assert.equal(latePilotDecision.reason, 'expired');
    const lateReconciled = control.reconcileAutomationReadPilotProjection(
      lateRegistered.projection.projectionId,
    );
    assert.equal(lateReconciled.ok, true, JSON.stringify(lateReconciled));
    if (lateReconciled.ok) {
      assert.equal(lateReconciled.state, 'refused');
      assert.equal(lateReconciled.projection.refusalCode, 'approval_expired');
    }
    assert.equal(runFiles().length, baselineRunFiles);
    assert.equal(lateFixture.bodies(), 0);
  });

  await t.test('live binding drift after approval creates no run', async () => {
    const fixture = blankStateFixture('drift');
    const registered = await control.acquireAndRegisterAutomationReadPilotProjection({
      ...fixture.input,
      acquisition: fixture.acquisition,
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    if (!registered.ok) return;
    assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'human.drift').ok, true);
    const manifestId = registered.projection.capabilityId;
    manifestStores.peekCapabilityManifestStore()?.revoke(manifestId);
    catalogs.peekHostCapabilityCatalogFactory()?.forget(manifestId);
    const reconciled = control.reconcileAutomationReadPilotProjection(registered.projection.projectionId);
    assert.equal(reconciled.ok, false, JSON.stringify(reconciled));
    if (!reconciled.ok) assert.equal(reconciled.code, 'capability_unavailable');
    assert.equal(fixture.bodies(), 0);
  });

  await t.test('missing acquisition port and missing/ambiguous acquisition results create no card', async () => {
    for (const reason of ['unconfigured', 'missing', 'ambiguous'] as const) {
      const fixture = blankStateFixture(`acquire_${reason}`);
      const beforeCards = eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length;
      const result = reason === 'unconfigured'
        ? await control.acquireAndRegisterAutomationReadPilotProjection({ ...fixture.input })
        : await control.acquireAndRegisterAutomationReadPilotProjection({
            ...fixture.input,
            acquisition: {
              async acquire() {
                return {
                  status: 'blocked' as const,
                  reason,
                  detail: `generated ${reason} acquisition`,
                  retired: [],
                };
              },
            },
          });
      assert.equal(result.ok, false);
      assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, beforeCards);
      assert.equal(fixture.bodies(), 0);
    }
  });

  await t.test('stale proposal CAS, paginated completeness, compute binding, and write proposal stop before approval', async () => {
    const cases: Array<{
      label: string;
      mutate(fixture: BlankStateFixture): Promise<RegisterAutomationReadPilotProjectionInputV1> | RegisterAutomationReadPilotProjectionInputV1;
    }> = [
      {
        label: 'stale',
        mutate(fixture) {
          return {
            ...fixture.input,
            expectedProposalDigest: digest('stale'),
            selections: [],
          };
        },
      },
      {
        label: 'paginated',
        mutate(fixture) {
          return {
            ...fixture.input,
            contract: {
              ...fixture.input.contract,
              completeness: {
                kind: 'finite_exhaustive',
                exhaustedPath: 'exhausted',
                evidencePaths: ['records'],
              },
            },
            selections: [],
          };
        },
      },
      {
        label: 'compute',
        async mutate(fixture) {
          const acquired = await fixture.acquisition.acquire({
            proposalId: fixture.proposal.proposalId,
            proposalRevision: fixture.proposal.revision,
            proposalDigest: fixture.proposal.digest,
            phaseId: 'read-result',
            requirementId: 'bounded-read',
            requirementDigest: bridge.automationCapabilityRequirementDigest(
              fixture.proposal.opportunity.capabilityRequirements[0]!,
            ),
            objective: fixture.proposal.opportunity.capabilityRequirements[0]!.description,
            effect: 'read',
          });
          assert.equal(acquired.status, 'installed');
          if (acquired.status !== 'installed') throw new Error(acquired.detail);
          const factory = catalogs.peekHostCapabilityCatalogFactory()!;
          const entry = factory.get(acquired.manifest.manifestId)!;
          factory.register({ ...entry, effect: 'compute' });
          const identity = catalogs.canonicalCatalogIdentityOf(factory.get(entry.capabilityId)!);
          assert.ok(identity);
          return {
            ...fixture.input,
            selections: [{
              capabilityId: identity.capabilityId,
              expectedIdentityDigest: control.automationReadPilotCatalogIdentityDigest(identity),
            }],
          };
        },
      },
      {
        label: 'write',
        mutate(fixture) {
          const writeProposal = approvedProposal(unique('write'), 'external_write');
          return {
            ...fixture.input,
            proposalId: writeProposal.proposalId,
            expectedProposalRevision: writeProposal.revision,
            expectedProposalDigest: writeProposal.digest,
            contract: {
              ...fixture.input.contract,
              requirementId: writeProposal.opportunity.capabilityRequirements[0]!.id,
              phaseId: writeProposal.opportunity.phases[0]!.id,
            },
            selections: [],
          };
        },
      },
    ];
    for (const candidate of cases) {
      const fixture = blankStateFixture(`blocked_${candidate.label}`);
      const beforeCards = eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length;
      const input = await candidate.mutate(fixture);
      const result = control.registerAutomationReadPilotProjection(input);
      assert.equal(result.ok, false, `${candidate.label}: ${JSON.stringify(result)}`);
      assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, beforeCards);
      assert.equal(fixture.bodies(), 0);
    }
  });
});

test('projection storage is versioned, idempotent, and contains no prose-derived schedule authority', async () => {
  const fixture = blankStateFixture('schema', { recurring: true });
  const registered = await control.acquireAndRegisterAutomationReadPilotProjection({
    ...fixture.input,
    acquisition: fixture.acquisition,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  const db = eventlog.openEventLog();
  const versions = db.prepare(
    'SELECT version FROM automation_read_pilot_control_plane_migrations ORDER BY version',
  ).all() as Array<{ version: number }>;
  assert.deepEqual(versions, [{ version: 1 }]);
  const row = db.prepare(`
    SELECT compilation_json, workflow_inputs_json, trigger_receipt_id, run_id
      FROM automation_read_pilot_projections WHERE projection_id = ?
  `).get(registered.projection.projectionId) as {
    compilation_json: string;
    workflow_inputs_json: string;
    trigger_receipt_id: string | null;
    run_id: string | null;
  };
  const compilation = JSON.parse(row.compilation_json) as {
    proposal: { opportunity: { recurrence: { mode: string } } };
  };
  assert.equal(compilation.proposal.opportunity.recurrence.mode, 'proposed');
  assert.equal(row.trigger_receipt_id, null);
  assert.equal(row.run_id, null);
  assert.equal(typeof JSON.parse(row.workflow_inputs_json).scope, 'string');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM automation_read_pilot_projections').get().n,
    control.listAutomationReadPilotProjections({ limit: 1000 }).length,
  );
  assert.equal(approvals.resolve(registered.approval.approvalId, 'approved', 'human.schema').ok, true);
  const queued = control.reconcileAutomationReadPilotProjection(registered.projection.projectionId);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (queued.ok && queued.projection.runId) {
    const workflowId = `automation-${fixture.proposal.digest.slice(0, 16)}`;
    const workflows = await import('../memory/workflow-store.js');
    assert.deepEqual(workflows.readWorkflow(workflowId)?.data.trigger, { manual: true });
    assert.equal(workflows.readWorkflow(workflowId)?.data.enabled, false);
  }
});
