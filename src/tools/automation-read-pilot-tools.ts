import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  acquireAndRegisterAutomationReadPilotProjection,
  type AutomationReadPilotCapabilityAcquisitionPortV1,
  type AutomationReadPilotTypedContractV1,
} from '../execution/automation-read-pilot-control-plane.js';
import { automationCapabilityRequirementDigest } from '../execution/automation-workflow-bridge.js';
import { createWorkflowCanonicalEntityResultProjection } from '../memory/workflow-result-projection-contract.js';
import { canonicalEntityWorkspaceSelectionDigest } from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore } from '../spaces/store.js';
import { requestAutomationReadPilotWorkspaceCreation } from '../execution/automation-read-pilot-workspace-control-plane.js';
import { loadAutomationOpportunityProposal } from '../execution/automation-opportunity-store.js';
import {
  listConfiguredReadPilotAcquisitions,
  resolveConfiguredReadPilotAcquisition,
  type AutomationReadPilotAcquisitionScopeV1,
  type ResolveConfiguredReadPilotAcquisitionResult,
} from '../execution/automation-read-pilot-production-acquisition.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const EXACT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const EXACT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$/;
const MAX_RESULT_CHARS = 32_000;

type AcquisitionResolverResult =
  | { ok: true; acquisition: AutomationReadPilotCapabilityAcquisitionPortV1 }
  | { ok: false; code: string; reason: string };

export interface AutomationReadPilotAcquisitionChoiceV1 {
  acquisitionRef: string;
  carrierKind: string;
  label: string;
  description: string;
}

export interface AutomationReadPilotToolOptions {
  listAcquisitions?: (
    scope: AutomationReadPilotAcquisitionScopeV1,
  ) => readonly AutomationReadPilotAcquisitionChoiceV1[];
  resolveAcquisition?: (
    acquisitionRef: string,
    scope: AutomationReadPilotAcquisitionScopeV1,
  ) => AcquisitionResolverResult;
  acceptedSource?: () => { sessionId: string; sourceUserSeq: number } | undefined;
}

const stringWorkflowInputSchema = z.object({
  type: z.literal('string'),
  required: z.literal(true),
}).strict();

const stringArgumentBindingSchema = z.object({
  source: z.object({
    kind: z.literal('workflow_input'),
    key: z.string().regex(EXACT_KEY_RE),
  }).strict(),
  required: z.literal(true),
  type: z.literal('string'),
}).strict();

const continuationArgumentBindingSchema = z.object({
  source: z.object({ kind: z.literal('continuation_cursor') }).strict(),
  required: z.literal(false),
  type: z.literal('string'),
}).strict();

const resultProjectionSchema = z.object({
  version: z.literal(1),
  records_path: z.string().trim().min(1).max(512),
  fields: z.array(z.object({
    field: z.string().regex(EXACT_KEY_RE),
    record_path: z.string().trim().min(1).max(512),
    type: z.enum(['string', 'number', 'boolean', 'timestamp', 'object', 'array']),
    required: z.boolean(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
    confidence: z.number().min(0).max(1),
  }).strict()).min(1).max(512),
  source_record: z.object({
    id_path: z.string().trim().min(1).max(512),
    revision_path: z.string().trim().min(1).max(512).optional(),
    observed_at: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('record_path'), path: z.string().trim().min(1).max(512) }).strict(),
      z.object({ kind: z.literal('page_settled_at') }).strict(),
    ]),
  }).strict(),
  entity_kind: z.string().regex(EXACT_REF_RE),
  identity_rules: z.array(z.object({
    rule_id: z.string().regex(EXACT_REF_RE),
    fields: z.array(z.string().regex(EXACT_KEY_RE)).min(1).max(32),
    normalizers: z.array(z.enum(['trim', 'case_fold', 'unicode_nfkc', 'numeric'])).min(1).max(8),
    exact_identifier_namespace: z.string().regex(EXACT_REF_RE),
  }).strict()).min(1).max(64),
  resolution_policy: z.object({
    policy_id: z.string().regex(EXACT_REF_RE),
    merge_threshold: z.number().nonnegative(),
    distinct_threshold: z.number().nonnegative(),
    ambiguity_margin: z.number().nonnegative(),
    weights: z.object({
      default_exact_identifier_match: z.number().nonnegative(),
      exact_identifier_matches: z.record(z.string().regex(EXACT_REF_RE), z.number().nonnegative()).optional(),
      default_compound_signal_match: z.number().nonnegative(),
      compound_signal_matches: z.record(z.string().regex(EXACT_REF_RE), z.number().nonnegative()).optional(),
    }).strict(),
    exclusive_identifier_namespaces: z.array(z.string().regex(EXACT_REF_RE)).max(64).optional(),
  }).strict(),
  field_resolution: z.object({
    kind: z.literal('retain_all_evidence'),
    selection: z.literal('highest_confidence_then_newest'),
    conflict: z.literal('mark_conflicting_for_review'),
  }).strict(),
  provenance: z.object({
    kind: z.literal('workflow_page_record'),
    retain_source_snapshots: z.literal(true),
  }).strict(),
  partition: z.object({
    kind: z.literal('workflow_run'),
    coverage_items: z.literal('source_record_occurrences'),
    denominator: z.literal('settled_record_count'),
    completion: z.literal('closed_authority_exhaustion'),
  }).strict(),
  bounds: z.object({
    max_pages: z.number().int().min(1).max(10_000),
    max_records_per_page: z.number().int().min(1).max(1_000_000),
    max_records: z.number().int().min(1).max(10_000_000),
    max_page_bytes: z.number().int().min(1).max(8_000_000),
    max_record_bytes: z.number().int().min(1).max(8_000_000),
    max_total_bytes: z.number().int().min(1).max(64_000_000),
  }).strict(),
}).strict();

const typedContractSchema = z.object({
  phase_id: z.string().regex(EXACT_REF_RE),
  requirement_id: z.string().regex(EXACT_REF_RE),
  workflow_inputs: z.record(z.string().regex(EXACT_KEY_RE), stringWorkflowInputSchema),
  arguments: z.record(
    z.string().regex(EXACT_KEY_RE),
    z.union([stringArgumentBindingSchema, continuationArgumentBindingSchema]),
  ),
  evidence: z.object({
    required_paths: z.array(z.string().trim().min(1).max(512)).max(256),
    non_empty_paths: z.array(z.string().trim().min(1).max(512)).max(256),
    min_items: z.record(
      z.string().trim().min(1).max(512),
      z.number().int().nonnegative().max(1_000_000),
    ),
  }).strict(),
  completeness: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('terminal_result'),
      evidence_paths: z.array(z.string().trim().min(1).max(512)).max(256),
    }).strict(),
    z.object({
      kind: z.literal('finite_exhaustive'),
      exhausted_path: z.string().trim().min(1).max(512),
      evidence_paths: z.array(z.string().trim().min(1).max(512)).max(256),
    }).strict(),
  ]),
  continuation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
      kind: z.literal('cursor'),
      cursor_argument: z.string().regex(EXACT_KEY_RE),
      next_cursor_path: z.string().trim().min(1).max(512),
      exhausted_path: z.string().trim().min(1).max(512),
      max_pages: z.number().int().min(1).max(10_000),
    }).strict(),
  ]).optional(),
  result_projection: resultProjectionSchema.optional(),
  workspace_binding_selection: z.object({
    version: z.literal(1),
    workspace_id: z.string().regex(EXACT_REF_RE),
    expected_workspace_revision: z.number().int().positive(),
    expected_workspace_digest: z.string().regex(DIGEST_RE),
    binding_id: z.string().regex(EXACT_REF_RE),
    role: z.literal('primary'),
  }).strict().optional(),
}).strict();

const workspaceCreationSchema = z.object({
  workspace_id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  success_criteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
  invariants: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
}).strict();

function acceptedSource(
  override?: AutomationReadPilotToolOptions['acceptedSource'],
): { sessionId: string; sourceUserSeq: number } | undefined {
  const supplied = override?.();
  const context = supplied ?? harnessRunContextStorage.getStore();
  if (
    !context
    || !EXACT_REF_RE.test(context.sessionId)
    || !Number.isSafeInteger(context.sourceUserSeq)
    || (context.sourceUserSeq ?? 0) < 1
  ) return undefined;
  return { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq! };
}

function acquisitionScope(input: {
  source: { sessionId: string; sourceUserSeq: number };
  proposalId: string;
  expectedProposalRevision: number;
  expectedProposalDigest: string;
  phaseId: string;
  requirementId: string;
}): { ok: true; scope: AutomationReadPilotAcquisitionScopeV1 } | {
  ok: false;
  code: string;
  reason: string;
} {
  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal) return { ok: false, code: 'proposal_missing', reason: 'The exact automation proposal was not found.' };
  if (
    proposal.revision !== input.expectedProposalRevision
    || proposal.digest !== input.expectedProposalDigest
  ) return { ok: false, code: 'proposal_stale', reason: 'The proposal revision or digest is stale.' };
  if (proposal.status !== 'approved') {
    return { ok: false, code: 'proposal_not_approved', reason: 'The proposal has not completed its separate user-owned review decision.' };
  }
  const phase = proposal.opportunity.phases[0];
  const requirement = proposal.opportunity.capabilityRequirements[0];
  if (
    proposal.opportunity.phases.length !== 1
    || proposal.opportunity.capabilityRequirements.length !== 1
    || !phase
    || !requirement
    || phase.id !== input.phaseId
    || requirement.id !== input.requirementId
    || phase.capabilityRequirementIds.length !== 1
    || phase.capabilityRequirementIds[0] !== requirement.id
    || phase.effect.class !== 'read'
    || requirement.minimumEffect !== 'read'
    || proposal.opportunity.effectCeiling.class !== 'read'
  ) return {
    ok: false,
    code: 'pilot_requirement_unsupported',
    reason: 'Acquisition-reference issuance requires the exact single read phase and requirement.',
  };
  return {
    ok: true,
    scope: {
      ...input.source,
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      phaseId: phase.id,
      requirementId: requirement.id,
      requirementDigest: automationCapabilityRequirementDigest(requirement),
    },
  };
}

function internalContract(input: z.infer<typeof typedContractSchema>): AutomationReadPilotTypedContractV1 {
  const projection = input.result_projection;
  return {
    phaseId: input.phase_id,
    requirementId: input.requirement_id,
    workflowInputs: structuredClone(input.workflow_inputs),
    arguments: structuredClone(input.arguments),
    evidence: {
      requiredPaths: [...input.evidence.required_paths],
      nonEmptyPaths: [...input.evidence.non_empty_paths],
      minItems: structuredClone(input.evidence.min_items),
    },
    completeness: input.completeness.kind === 'terminal_result'
      ? {
          kind: 'terminal_result',
          evidencePaths: [...input.completeness.evidence_paths],
        }
      : {
          kind: 'finite_exhaustive',
          exhaustedPath: input.completeness.exhausted_path,
          evidencePaths: [...input.completeness.evidence_paths],
        },
    ...(input.continuation
      ? {
          continuation: input.continuation.kind === 'none'
            ? { kind: 'none' as const }
            : {
                kind: 'cursor' as const,
                cursorArgument: input.continuation.cursor_argument,
                nextCursorPath: input.continuation.next_cursor_path,
                exhaustedPath: input.continuation.exhausted_path,
                maxPages: input.continuation.max_pages,
              },
        }
      : {}),
    ...(projection
      ? {
          resultProjection: createWorkflowCanonicalEntityResultProjection({
            recordsPath: projection.records_path,
            fields: projection.fields.map((field) => ({
              field: field.field,
              recordPath: field.record_path,
              type: field.type,
              required: field.required,
              sensitivity: field.sensitivity,
              confidence: field.confidence,
            })),
            sourceRecord: {
              idPath: projection.source_record.id_path,
              ...(projection.source_record.revision_path
                ? { revisionPath: projection.source_record.revision_path }
                : {}),
              observedAt: projection.source_record.observed_at.kind === 'record_path'
                ? { kind: 'record_path' as const, path: projection.source_record.observed_at.path }
                : { kind: 'page_settled_at' as const },
            },
            entityKind: projection.entity_kind,
            identityRules: projection.identity_rules.map((rule) => ({
              ruleId: rule.rule_id,
              fields: [...rule.fields],
              normalizers: [...rule.normalizers],
              exactIdentifierNamespace: rule.exact_identifier_namespace,
            })),
            resolutionPolicy: {
              policyId: projection.resolution_policy.policy_id,
              mergeThreshold: projection.resolution_policy.merge_threshold,
              distinctThreshold: projection.resolution_policy.distinct_threshold,
              ambiguityMargin: projection.resolution_policy.ambiguity_margin,
              weights: {
                defaultExactIdentifierMatch: projection.resolution_policy.weights.default_exact_identifier_match,
                ...(projection.resolution_policy.weights.exact_identifier_matches
                  ? { exactIdentifierMatches: structuredClone(projection.resolution_policy.weights.exact_identifier_matches) }
                  : {}),
                defaultCompoundSignalMatch: projection.resolution_policy.weights.default_compound_signal_match,
                ...(projection.resolution_policy.weights.compound_signal_matches
                  ? { compoundSignalMatches: structuredClone(projection.resolution_policy.weights.compound_signal_matches) }
                  : {}),
              },
              ...(projection.resolution_policy.exclusive_identifier_namespaces
                ? { exclusiveIdentifierNamespaces: [...projection.resolution_policy.exclusive_identifier_namespaces] }
                : {}),
            },
            fieldResolution: {
              kind: projection.field_resolution.kind,
              selection: projection.field_resolution.selection,
              conflict: projection.field_resolution.conflict,
            },
            provenance: {
              kind: projection.provenance.kind,
              retainSourceSnapshots: true,
            },
            partition: {
              kind: projection.partition.kind,
              coverageItems: projection.partition.coverage_items,
              denominator: projection.partition.denominator,
              completion: projection.partition.completion,
            },
            bounds: {
              maxPages: projection.bounds.max_pages,
              maxRecordsPerPage: projection.bounds.max_records_per_page,
              maxRecords: projection.bounds.max_records,
              maxPageBytes: projection.bounds.max_page_bytes,
              maxRecordBytes: projection.bounds.max_record_bytes,
              maxTotalBytes: projection.bounds.max_total_bytes,
            },
          }),
        }
      : {}),
    ...(input.workspace_binding_selection
      ? {
          workspaceBindingSelection: {
            version: 1 as const,
            workspaceId: input.workspace_binding_selection.workspace_id,
            expectedWorkspaceRevision: input.workspace_binding_selection.expected_workspace_revision,
            expectedWorkspaceDigest: input.workspace_binding_selection.expected_workspace_digest,
            bindingId: input.workspace_binding_selection.binding_id,
            role: input.workspace_binding_selection.role,
          },
        }
      : {}),
  };
}

function errorResult(code: string, reason: string) {
  return textResult(JSON.stringify({ ok: false, code, reason }), {
    maxChars: MAX_RESULT_CHARS,
    isError: true,
  });
}

/**
 * Chat-facing control surface for the first one-read automation pilot.
 *
 * This tool creates only the durable projection and its formal approval card.
 * It cannot resolve that approval, queue the pilot, schedule recurrence, or
 * infer a carrier from prose. The opaque acquisition reference must have been
 * issued by the current host configuration and is re-resolved at the call.
 */
export function registerAutomationReadPilotTools(
  server: McpServer,
  options: AutomationReadPilotToolOptions = {},
): void {
  const listAcquisitions = options.listAcquisitions ?? listConfiguredReadPilotAcquisitions;
  const resolveAcquisition = options.resolveAcquisition
    ?? ((ref: string, scope: AutomationReadPilotAcquisitionScopeV1): ResolveConfiguredReadPilotAcquisitionResult => (
      resolveConfiguredReadPilotAcquisition(ref, scope)
    ));

  server.tool(
    'automation_read_pilot_workspace_create_request',
    'Stage one exact local Workspace manifest for a separately approved dataset proposal and show its own formal human creation card. This tool cannot create the Workspace, select a capability, bind or run a workflow, schedule, or infer recurrence.',
    {
      proposal_id: z.string().regex(EXACT_REF_RE),
      expected_proposal_revision: z.number().int().positive(),
      expected_proposal_digest: z.string().regex(DIGEST_RE),
      phase_id: z.string().regex(EXACT_REF_RE),
      requirement_id: z.string().regex(EXACT_REF_RE),
      workspace: workspaceCreationSchema,
    },
    async ({
      proposal_id,
      expected_proposal_revision,
      expected_proposal_digest,
      phase_id,
      requirement_id,
      workspace,
    }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) return errorResult('accepted_source_required', 'An exact accepted chat source must own Workspace creation review.');
      const scoped = acquisitionScope({
        source,
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        phaseId: phase_id,
        requirementId: requirement_id,
      });
      if (!scoped.ok) return errorResult(scoped.code, scoped.reason);
      const proposal = loadAutomationOpportunityProposal(proposal_id);
      if (!proposal?.opportunity.dataset) {
        return errorResult('workspace_creation_not_applicable', 'The exact approved proposal has no dataset contract.');
      }
      const requested = requestAutomationReadPilotWorkspaceCreation({
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        approvalSessionId: source.sessionId,
        sourceUserSeq: source.sourceUserSeq,
        contract: {
          version: 1,
          workspaceId: workspace.workspace_id,
          title: workspace.title,
          objective: workspace.objective,
          successCriteria: [...workspace.success_criteria],
          invariants: [...workspace.invariants],
          originSessionId: source.sessionId,
        },
      });
      if (!requested.ok) return errorResult(requested.code, requested.reason);
      return textResult(JSON.stringify({
        ok: true,
        projection: requested.projection,
        approval: {
          approvalId: requested.approval.approvalId,
          status: requested.approval.status,
          expiresAt: requested.approval.expiresAt,
        },
        approvalCreated: requested.approvalCreated,
        cardCreated: requested.cardCreated,
        workspaceAuthority: requested.projection.status === 'created'
          ? 'exact_manifest_created'
          : requested.projection.status === 'refused'
            ? 'none_refused'
            : 'pending_exact_human_approval',
        workflowBindingAuthority: 'none',
        executionAuthority: 'none',
        scheduleAuthority: 'none',
        nextBoundary: requested.projection.status === 'created'
          ? 'formal_pilot_approval_with_exact_workspace_selection'
          : 'formal_workspace_creation_resolution',
      }), { maxChars: MAX_RESULT_CHARS });
    },
  );

  server.tool(
    'automation_read_pilot_workspace_list',
    'List exact current Workspace revisions that a separately approved dataset pilot may name on its formal human approval card. Inventory grants no binding, workflow, schedule, or execution authority and never selects by name or list order.',
    {
      proposal_id: z.string().regex(EXACT_REF_RE),
      expected_proposal_revision: z.number().int().positive(),
      expected_proposal_digest: z.string().regex(DIGEST_RE),
      phase_id: z.string().regex(EXACT_REF_RE),
      requirement_id: z.string().regex(EXACT_REF_RE),
    },
    async ({
      proposal_id,
      expected_proposal_revision,
      expected_proposal_digest,
      phase_id,
      requirement_id,
    }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) return errorResult('accepted_source_required', 'An exact accepted chat source must own Workspace inventory.');
      const scoped = acquisitionScope({
        source,
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        phaseId: phase_id,
        requirementId: requirement_id,
      });
      if (!scoped.ok) return errorResult(scoped.code, scoped.reason);
      const proposal = loadAutomationOpportunityProposal(proposal_id);
      if (!proposal?.opportunity.dataset) {
        return errorResult('workspace_binding_not_applicable', 'The exact approved proposal has no dataset contract.');
      }
      const workspaces = spaceStore.list().map((workspace) => ({
        workspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.version,
        expectedWorkspaceDigest: canonicalEntityWorkspaceSelectionDigest(workspace),
      }));
      return textResult(JSON.stringify({
        ok: true,
        workspaces,
        selectionAuthority: 'none',
        nextBoundary: 'formal_pilot_approval_with_exact_workspace_selection',
      }), { maxChars: MAX_RESULT_CHARS });
    },
  );

  server.tool(
    'automation_read_pilot_acquisition_list',
    'List exact host-issued live read acquisition references. This is configuration inventory only and grants no proposal, approval, pilot, workflow, schedule, or execution authority.',
    {
      proposal_id: z.string().regex(EXACT_REF_RE),
      expected_proposal_revision: z.number().int().positive(),
      expected_proposal_digest: z.string().regex(DIGEST_RE),
      phase_id: z.string().regex(EXACT_REF_RE),
      requirement_id: z.string().regex(EXACT_REF_RE),
    },
    async ({
      proposal_id,
      expected_proposal_revision,
      expected_proposal_digest,
      phase_id,
      requirement_id,
    }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) {
        return errorResult(
          'accepted_source_required',
          'An exact accepted chat source must own acquisition-reference issuance.',
        );
      }
      const scoped = acquisitionScope({
        source,
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        phaseId: phase_id,
        requirementId: requirement_id,
      });
      if (!scoped.ok) return errorResult(scoped.code, scoped.reason);
      let acquisitions: readonly AutomationReadPilotAcquisitionChoiceV1[];
      try {
        acquisitions = listAcquisitions(scoped.scope);
      } catch (error) {
        return errorResult(
          'acquisition_inventory_unavailable',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (acquisitions.length > 1) {
        return errorResult(
          'acquisition_inventory_invalid',
          'The host must issue at most one registry-wide acquisition reference for an exact proposal requirement.',
        );
      }
      return textResult(JSON.stringify({
        ok: true,
        acquisitions,
        executionAuthority: 'none',
      }), { maxChars: MAX_RESULT_CHARS });
    },
  );

  server.tool(
    'automation_read_pilot_request',
    'Request a formal approval card for one exact, already-approved read-only automation proposal and one exact host-issued carrier reference. This previews and persists no more than a disabled one-run pilot; it never approves, queues, runs, schedules, or infers recurrence.',
    {
      proposal_id: z.string().regex(EXACT_REF_RE),
      expected_proposal_revision: z.number().int().positive(),
      expected_proposal_digest: z.string().regex(DIGEST_RE),
      acquisition_ref: z.string().regex(EXACT_REF_RE),
      contract: typedContractSchema,
      workflow_inputs: z.record(
        z.string().regex(EXACT_KEY_RE),
        z.string().min(1).max(65_536),
      ),
    },
    async ({
      proposal_id,
      expected_proposal_revision,
      expected_proposal_digest,
      acquisition_ref,
      contract,
      workflow_inputs,
    }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) {
        return errorResult(
          'accepted_source_required',
          'An exact accepted chat source must own an automation pilot request.',
        );
      }
      const scoped = acquisitionScope({
        source,
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        phaseId: contract.phase_id,
        requirementId: contract.requirement_id,
      });
      if (!scoped.ok) return errorResult(scoped.code, scoped.reason);
      let resolved: AcquisitionResolverResult;
      try {
        resolved = resolveAcquisition(acquisition_ref, scoped.scope);
      } catch (error) {
        return errorResult(
          'acquisition_resolution_failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!resolved.ok) return errorResult(resolved.code, resolved.reason);

      const requested = await acquireAndRegisterAutomationReadPilotProjection({
        proposalId: proposal_id,
        expectedProposalRevision: expected_proposal_revision,
        expectedProposalDigest: expected_proposal_digest,
        approvalSessionId: source.sessionId,
        originSessionId: source.sessionId,
        acquisition: resolved.acquisition,
        contract: internalContract(contract),
        workflowInputs: structuredClone(workflow_inputs),
      });
      if (!requested.ok) return errorResult(requested.code, requested.reason);
      const executionAuthority = requested.projection.status === 'queued'
        ? 'queued_one_shot_pilot'
        : requested.projection.status === 'queueing'
          ? 'queue_reconciliation_pending'
          : 'pending_exact_approval';
      return textResult(JSON.stringify({
        ok: true,
        projection: requested.projection,
        approval: {
          approvalId: requested.approval.approvalId,
          status: requested.approval.status,
          expiresAt: requested.approval.expiresAt,
        },
        approvalCreated: requested.approvalCreated,
        cardCreated: requested.cardCreated,
        executionAuthority,
        nextBoundary: requested.projection.status === 'approval_pending'
          ? 'formal_approval_resolution'
          : 'durable_projection_reconciliation',
        recurrenceAuthority: 'none',
      }), { maxChars: MAX_RESULT_CHARS });
    },
  );
}
