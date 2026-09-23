/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-read-pilot-control-plane.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  localOutput = false,
  opportunityOverride?: AutomationOpportunityV1,
): AutomationOpportunityProposalRecordV1 {
  const authored = opportunityOverride ? structuredClone(opportunityOverride) : opportunity(label, effect, recurring, dataset, maxOperations);
  if (localOutput) {
    authored.capabilityRequirements.push({ id: 'workspace-output', description: 'Persist the reviewed dataset in the chosen Workspace.', minimumEffect: 'local_write', constraints: ['Only the exact consented Workspace projection.'] });
    authored.phases.push({ id: 'persist-result', objective: 'Persist the dataset with its provenance.', dependsOn: ['read-result'], capabilityRequirementIds: ['workspace-output'], effect: { class: 'local_write', approval: 'not_required', maxOperationsPerRun: 1 }, partitioned: false, outputEvidence: ['Exact Workspace projection head.'] });
    authored.effectCeiling = { class: 'local_write', maxOperationsPerRun: maxOperations + 1 };
    authored.pilot.effectCeiling = { class: 'local_write', maxOperationsPerRun: maxOperations + 1 };
    authored.budgets.maxOperationsPerRun = maxOperations + 1;
    authored.dataset!.schema.fields.push(
      { name: 'run_ref', type: 'string', required: true, sensitivity: 'internal' },
      { name: 'observed_at', type: 'timestamp', required: true, sensitivity: 'public' },
      { name: 'source_ref', type: 'string', required: true, sensitivity: 'public' },
    );
    authored.dataset!.merge.mode = 'field_policy_after_exact_identity';
    authored.dataset!.merge.fieldPolicies = [{ field: 'scope', onConflict: 'prefer_newer' }];
  }
  const proposalId = unique(`proposal_${label}`);
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId,
    opportunity: authored,
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
  localOutput?: boolean;
  opportunityOverride?: AutomationOpportunityV1;
  resultOverride?: unknown;
  inputSchemaOverride?: Record<string, unknown>;
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
    options.localOutput === true,
    options.opportunityOverride,
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
        inputSchema: options.inputSchemaOverride ?? {
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
                if (options.resultOverride !== undefined) return structuredClone(options.resultOverride);
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
      phaseId: options.opportunityOverride?.phases.find(phase => phase.effect.class === 'read')?.id ?? 'read-result',
      requirementId: options.opportunityOverride?.capabilityRequirements.find(requirement => requirement.minimumEffect === 'read')?.id ?? 'bounded-read',
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
              ...(options.localOutput ? [
                { field: 'run_ref', hostSource: 'workflow_run_id' as const, type: 'string' as const, required: true, sensitivity: 'internal' as const, confidence: 1 },
                { field: 'observed_at', hostSource: 'page_settled_at' as const, type: 'timestamp' as const, required: true, sensitivity: 'public' as const, confidence: 1 },
                { field: 'source_ref', hostSource: 'page_receipt_id' as const, type: 'string' as const, required: true, sensitivity: 'public' as const, confidence: 1 },
              ] : []),
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
              ...(options.localOutput ? { preferNewerAfterExactIdentity: ['scope'] } : {}),
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
      ...(fixture.input.contract.workspaceOutputPhaseId ? { workspace_output_phase_id: fixture.input.contract.workspaceOutputPhaseId } : {}),
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
          ...(projection.textInterpretation ? { text_interpretation: {
            version: projection.textInterpretation.version, kind: projection.textInterpretation.kind,
            field: projection.textInterpretation.field, prefix: projection.textInterpretation.prefix,
            whitespace: projection.textInterpretation.whitespace, blank_lines: projection.textInterpretation.blankLines,
            max_source_bytes: projection.textInterpretation.maxSourceBytes, max_source_records: projection.textInterpretation.maxSourceRecords,
            selection: { kind: projection.textInterpretation.selection.kind, max_records: projection.textInterpretation.selection.maxRecords },
          } } : {}),
          fields: projection.fields.map((field) => ({
            field: field.field,
            ...(field.hostSource ? { host_source: field.hostSource } : { record_path: field.recordPath }),
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
            ...(projection.resolutionPolicy.preferNewerAfterExactIdentity ? { prefer_newer_after_exact_identity: projection.resolutionPolicy.preferNewerAfterExactIdentity } : {}),
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

test('reviewed read plus local output crosses three pages and publishes canonical truth before success', async () => {
  const baselineRunFiles = runFiles().length;
  const fixture = blankStateFixture('dataset', { dataset: true, pages: 3, localOutput: true });
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
  fixture.input.contract.workspaceOutputPhaseId = 'persist-result';
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

  for (const fields of [[], ['key']]) {
    const invalid = chatPilotRequest(fixture, surface.acquisitionRef);
    ((invalid.contract as any).result_projection.resolution_policy).prefer_newer_after_exact_identity = fields;
    const denied = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(invalid));
    assert.equal(denied.ok, false, 'omitted or substituted merge policies cannot be compiled');
    assert.equal(fixture.bodies(), 0);
  }
  for (const phaseBinding of [undefined, 'read-result', 'unrelated-output']) {
    const invalid = chatPilotRequest(fixture, surface.acquisitionRef);
    (invalid.contract as Record<string, unknown>).workspace_output_phase_id = phaseBinding;
    const denied = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(invalid));
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(fixture.bodies(), 0);
  }
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
  const retainedPages = eventlog.openEventLog().prepare(`
    SELECT page_receipt_id, settled_at FROM workflow_paginated_read_pages
    WHERE activation_id IN (SELECT activation_id FROM workflow_paginated_read_activations WHERE run_id = ?)
  `).all(queued.projection.runId) as Array<{ page_receipt_id: string; settled_at: string }>;
  assert.equal(retainedPages.length, 3);
  const recordIds = entityStore.listCanonicalRecordIds({ datasetId }).items;
  assert.equal(recordIds.length, 2);
  for (const id of recordIds) {
    const canonical = entityStore.getCanonicalRecord(datasetId, id)!;
    for (const evidence of canonical.fields.run_ref!.evidence) {
      assert.equal(evidence.value, queued.projection.runId);
      assert.equal(evidence.provenance.path, 'host:workflow_run_id');
    }
    for (const evidence of canonical.fields.observed_at!.evidence) {
      assert.equal(evidence.value, evidence.observedAt);
      assert.equal(evidence.provenance.path, 'host:page_settled_at');
      assert.ok(retainedPages.some(page => page.settled_at === evidence.value));
    }
    assert.ok(canonical.fields.source_ref!.evidence.every(e => retainedPages.some(page => page.page_receipt_id === e.value && page.settled_at === e.observedAt) && e.provenance.path === 'host:page_receipt_id'));
  }
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


test('explicit text selection survives the chat tool into the exact separate pilot review without dispatch', async () => {
  const fixture = blankStateFixture('text_review', { dataset: true });
  const surface = chatPilotSurface(fixture);
  const previous = fixture.input.contract.resultProjection!;
  const { projectionDigest: _digest, ...base } = previous;
  fixture.input.contract.resultProjection = resultProjections.createWorkflowCanonicalEntityResultProjection({
    ...base,
    textInterpretation: { version: 1, kind: 'text_lines', field: 'key', prefix: '- ', whitespace: 'trim', blankLines: 'reject', maxSourceBytes: 10_000, maxSourceRecords: 100, selection: { kind: 'first', maxRecords: 5 } },
    fields: [base.fields[0]!, { field: 'scope', hostSource: 'workflow_run_id', type: 'string', required: true, sensitivity: 'internal', confidence: 1 }],
    bounds: { ...base.bounds, maxRecords: 5, maxRecordsPerPage: 5 },
  });
  const create = pilotToolJson(await surface.handlers.get('automation_read_pilot_workspace_create_request')!(chatWorkspaceCreationRequest(fixture)));
  assert.equal(create.ok, true, JSON.stringify(create));
  assert.equal(approvals.resolve(create.approval.approvalId, 'approved', 'operator.text-workspace').ok, true);
  const created = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(create.projection.projectionId);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok || !created.projection.selection) return;
  fixture.input.contract.workspaceBindingSelection = created.projection.selection;
  const invalid = chatPilotRequest(fixture, surface.acquisitionRef);
  (invalid.contract as any).result_projection.text_interpretation.selection.max_records = 6;
  const invalidResult = await surface.handlers.get('automation_read_pilot_request')!(invalid);
  assert.equal(shared.isInvalidArgumentsTextResult(invalidResult), true, 'invalid contract remains repairable by the caller');
  const denied = pilotToolJson(invalidResult);
  assert.equal(denied.ok, false, 'selection drift is refused before review');
  const requested = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(chatPilotRequest(fixture, surface.acquisitionRef)));
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const approval = approvals.get(requested.approval.approvalId);
  assert.deepEqual(approval?.args.resultProjection, fixture.input.contract.resultProjection);
  assert.equal(fixture.bodies(), 0, 'authoring and requesting review cannot execute a text source');
});


test('original approved inventory contract executes 13 text records into five scoped records and replays once', async () => {
  const recoveryBefore = runner.reconcileCanonicalEntityWorkspaceProjectionClaims();
  const original = JSON.parse(readFileSync(new URL('./fixtures/read-local-dataset-opportunity.json', import.meta.url), 'utf8')) as AutomationOpportunityV1;
  const raw = JSON.parse(readFileSync(new URL('./fixtures/documentation-inventory-mcp-result.json', import.meta.url), 'utf8'));
  const fixture = blankStateFixture('original_text_inventory', { dataset: true, opportunityOverride: original, resultOverride: raw,
    inputSchemaOverride: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' },
  });
  fixture.input.contract.arguments = {};
  fixture.input.contract.workflowInputs = {};
  fixture.input.workflowInputs = {};
  assert.deepEqual(fixture.proposal.opportunity, opportunities.parseAutomationOpportunity(original));
  const surface = chatPilotSurface(fixture);
  const { projectionDigest: _digest, ...base } = fixture.input.contract.resultProjection!;
  fixture.input.contract.workspaceOutputPhaseId = 'write-space';
  fixture.input.contract.resultProjection = resultProjections.createWorkflowCanonicalEntityResultProjection({
    ...base,
    textInterpretation: { version: 1, kind: 'text_lines', field: 'section_name', prefix: '- ', whitespace: 'trim', blankLines: 'reject', maxSourceBytes: 10_000, maxSourceRecords: 100, selection: { kind: 'first', maxRecords: 5 } },
    fields: [
      { field: 'section_name', recordPath: 'section_name', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
      { field: 'observed_at', hostSource: 'page_settled_at', type: 'timestamp', required: true, sensitivity: 'public', confidence: 1 },
      { field: 'run_ref', hostSource: 'workflow_run_id', type: 'string', required: true, sensitivity: 'internal', confidence: 1 },
      { field: 'source_ref', hostSource: 'page_receipt_id', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
    ],
    sourceRecord: { idPath: 'section_name', observedAt: { kind: 'page_settled_at' } },
    identityRules: [{ ruleId: 'section-name', fields: ['section_name'], normalizers: ['case_fold', 'trim'], exactIdentifierNamespace: 'section-name' }],
    resolutionPolicy: { ...base.resolutionPolicy, preferNewerAfterExactIdentity: ['observed_at', 'run_ref', 'source_ref'] },
    bounds: { ...base.bounds, maxRecords: 5, maxRecordsPerPage: 5 },
  });
  const create = pilotToolJson(await surface.handlers.get('automation_read_pilot_workspace_create_request')!({ ...chatWorkspaceCreationRequest(fixture), phase_id: 'write-space', requirement_id: 'acceptance-space-write' }));
  assert.equal(create.ok, true, JSON.stringify(create));
  assert.equal(approvals.resolve(create.approval.approvalId, 'approved', 'operator.original-text-workspace').ok, true);
  const created = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(create.projection.projectionId);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok || !created.projection.selection) return;
  fixture.input.contract.workspaceBindingSelection = created.projection.selection;
  // A live model supplied raw MCP evidence paths and omitted the approved
  // prefer-newer fields. Return both repairs in one refusal, before dispatch.
  const invalidContract = chatPilotRequest(fixture, surface.acquisitionRef);
  const invalidWire = invalidContract.contract as any;
  invalidWire.evidence.required_paths = ['/content'];
  invalidWire.completeness.evidence_paths = ['/content'];
  delete invalidWire.result_projection.resolution_policy.prefer_newer_after_exact_identity;
  const invalidPreviewResult = await surface.handlers.get('automation_read_pilot_request')!(invalidContract);
  assert.equal(shared.isInvalidArgumentsTextResult(invalidPreviewResult), true, 'contract repair must remain admissible through host recovery');
  const invalidPreview = pilotToolJson(invalidPreviewResult);
  assert.equal(invalidPreview.ok, false);
  assert.equal(invalidPreview.code, 'preview_blocked');
  assert.match(invalidPreview.reason, /evidence.required_paths must include/);
  assert.match(invalidPreview.reason, /completeness.evidence_paths must include/);
  assert.match(invalidPreview.reason, /prefer_newer_after_exact_identity must match/);
  assert.equal(fixture.bodies(), 0, 'invalid authoring never dispatches');
  const requested = pilotToolJson(await surface.handlers.get('automation_read_pilot_request')!(chatPilotRequest(fixture, surface.acquisitionRef)));
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(approvals.resolve(requested.approval.approvalId, 'approved', 'operator.original-text-pilot').ok, true);
  const queued = control.reconcileAutomationReadPilotProjection(requested.projection.projectionId);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (!queued.ok || !queued.projection.runId) return;
  await runner.processWorkflowRuns({} as ClementineAssistant);
  const run = JSON.parse(readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, `${queued.projection.runId}.json`), 'utf8'));
  assert.equal(run.terminalOutcome, 'succeeded', JSON.stringify(run));
  assert.equal(fixture.bodies(), 1);
  const head = workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(created.projection.selection.bindingId);
  assert.ok(head);
  assert.equal(head.records.canonicalRecordsCreated, 5);
  assert.equal(head.coverage.observed, 5);
  assert.deepEqual(head.selection && {
    sourceRecords: head.selection.sourceRecords, selectedRecords: head.selection.selectedRecords,
    omittedRecords: head.selection.omittedRecords, scope: head.selection.scope,
  }, { sourceRecords: 13, selectedRecords: 5, omittedRecords: 8, scope: 'reviewed_selection' });
  assert.equal(head.selection?.projectionDigest, fixture.input.contract.resultProjection.projectionDigest);
  const retained = eventlog.openEventLog().prepare(`
    SELECT h.raw_payload_json, h.raw_payload_sha256 FROM logical_call_settlements s
    JOIN durable_result_handles h ON h.handle_id = s.result_handle_id
    WHERE s.settlement_event_id = ?
  `).get(head.selection!.sourceReceiptId) as { raw_payload_json: string; raw_payload_sha256: string };
  assert.ok(retained);
  assert.equal(head.selection!.sourceResultDigest, retained.raw_payload_sha256);
  const retainedView = (await import('../runtime/harness/result-facts.js')).projectProviderResultEvidenceView(
    JSON.parse(retained.raw_payload_json), fixture.input.contract.resultProjection.textInterpretation,
  );
  assert.equal(retainedView.kind, 'provider_payload');
  if (retainedView.kind !== 'provider_payload') return;
  assert.equal((retainedView.payload as { selection: { sourceRecords: number } }).selection.sourceRecords, 13);

  const recordIds = entityStore.listCanonicalRecordIds({ datasetId: head.identity.datasetId }).items;
  assert.equal(recordIds.length, 5);
  for (const id of recordIds) {
    const record = entityStore.getCanonicalRecord(head.identity.datasetId, id)!;
    assert.deepEqual(Object.keys(record.fields).sort(), ['observed_at', 'run_ref', 'section_name', 'source_ref']);
    assert.equal(record.fields.run_ref!.evidence[0]!.value, queued.projection.runId);
    assert.equal(record.fields.source_ref!.evidence[0]!.value, head.selection!.sourceReceiptId);
  }
  assert.deepEqual(runner.reconcileCanonicalEntityWorkspaceProjectionClaims(), { eligible: recoveryBefore.eligible + 1, projected: 0, replayed: recoveryBefore.replayed + 1, blocked: 0, failed: 0 });
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1);
  assert.deepEqual(workspaceProjection.getCanonicalEntityWorkspaceProjectionHead(created.projection.selection.bindingId), head);
});


test('Workspace review accepts the exact output phase without granting read acquisition or execution', async () => {
  const original = JSON.parse(readFileSync(new URL('./fixtures/read-local-dataset-opportunity.json', import.meta.url), 'utf8')) as AutomationOpportunityV1;
  const fixture = blankStateFixture('output_phase_review', { dataset: true, opportunityOverride: original });
  const surface = chatPilotSurface(fixture);
  const handler = surface.handlers.get('automation_read_pilot_workspace_create_request')!;
  const request = { ...chatWorkspaceCreationRequest(fixture), phase_id: 'write-space', requirement_id: 'acceptance-space-write' };
  const before = eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length;
  const stale = await handler({ ...request, expected_proposal_revision: fixture.proposal.revision + 1 });
  assert.equal(pilotToolJson(stale).code, 'proposal_stale');
  assert.equal(shared.isInvalidArgumentsTextResult(stale), false, 'state drift is not mislabeled as an argument mismatch');
  for (const mismatch of [
    { phase_id: 'write-space', requirement_id: 'doc-section-inventory-read' },
    { phase_id: 'read-inventory', requirement_id: 'acceptance-space-write' },
    { phase_id: 'unrelated', requirement_id: 'acceptance-space-write' },
  ]) {
    const rejected = await handler({ ...request, ...mismatch });
    assert.equal(pilotToolJson(rejected).ok, false);
    assert.equal(shared.isInvalidArgumentsTextResult(rejected), true, 'a scope mismatch before dispatch remains repairable');
  }
  assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, before);
  const readInventory = await surface.handlers.get('automation_read_pilot_acquisition_list')!({ ...chatPilotAcquisitionListRequest(fixture), phase_id: request.phase_id, requirement_id: request.requirement_id });
  assert.equal(pilotToolJson(readInventory).ok, false, 'output scope cannot select read acquisitions');
  const staged = pilotToolJson(await handler(request));
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(staged.workspaceAuthority, 'pending_exact_human_approval');
  assert.equal(staged.executionAuthority, 'none');
  assert.equal(staged.scheduleAuthority, 'none');
  assert.equal(fixture.bodies(), 0);
  assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, before + 1);
});

test('version-two authoring identifies missing outcome authority before closed-JSON serialization', async () => {
  const fixture = blankStateFixture('missing_outcome_authority', { dataset: true });
  const surface = chatPilotSurface(fixture);
  const request = chatPilotRequest(fixture, surface.acquisitionRef);
  const projection = (request.contract as any).result_projection;
  projection.version = 2;
  projection.identity_rules = projection.identity_rules.map((rule: any) => ({
    kind: 'exact_identifier', rule_id: rule.rule_id, fields: rule.fields,
    normalizers: rule.normalizers, namespace: rule.exact_identifier_namespace,
  }));
  const response = await surface.handlers.get('automation_read_pilot_request')!(request);
  assert.equal(shared.isInvalidArgumentsTextResult(response), true);
  const failure = pilotToolJson(response);
  assert.equal(failure.code, 'pilot_contract_invalid');
  assert.match(failure.reason, /result_projection.partition.outcome_authority is required for version 2/);
  assert.doesNotMatch(failure.reason, /closed JSON domain/);
  assert.equal(fixture.bodies(), 0);
  assert.equal(eventlog.listEvents(fixture.chatId, { types: ['approval_requested'] }).length, 0);
});

test('Workspace inventory accepts the declared output scope and an exact destination filter', async () => {
  const original = JSON.parse(readFileSync(new URL('./fixtures/read-local-dataset-opportunity.json', import.meta.url), 'utf8')) as AutomationOpportunityV1;
  const fixture = blankStateFixture('exact_workspace_inventory', { dataset: true, opportunityOverride: original });
  const surface = chatPilotSurface(fixture);
  const createdRequest = pilotToolJson(await surface.handlers.get('automation_read_pilot_workspace_create_request')!(chatWorkspaceCreationRequest(fixture)));
  assert.equal(createdRequest.ok, true);
  assert.equal(approvals.resolve(createdRequest.approval.approvalId, 'approved', 'operator.inventory').ok, true);
  const created = workspaceControl.reconcileAutomationReadPilotWorkspaceCreation(createdRequest.projection.projectionId);
  assert.equal(created.ok, true);
  if (!created.ok || !created.projection.selection) return;
  const id = created.projection.selection.workspaceId;
  const handler = surface.handlers.get('automation_read_pilot_workspace_list')!;
  for (const scope of [
    { phase_id: 'read-inventory', requirement_id: 'doc-section-inventory-read' },
    { phase_id: 'write-space', requirement_id: 'acceptance-space-write' },
  ]) {
    const input = { ...chatPilotAcquisitionListRequest(fixture), ...scope, workspace_id: id };
    const found = pilotToolJson(await handler(input));
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.deepEqual(found.workspaces, [{ workspaceId: id, expectedWorkspaceRevision: created.projection.selection.expectedWorkspaceRevision, expectedWorkspaceDigest: created.projection.selection.expectedWorkspaceDigest }]);
    assert.equal(found.selectionAuthority, 'none');
    assert.deepEqual(pilotToolJson(await handler({ ...input, workspace_id: 'missing-exact-workspace' })).workspaces, []);
  }
  assert.equal(fixture.bodies(), 0);
});
