/** Exact reviewed preparation at activation and each business call. No grants. */
import { reviewedArgumentsWithLocalNulls } from './reviewed-local-null-arguments.js';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import type { RegisteredHostCapability, CanonicalCatalogIdentityV1 } from './host-capability-catalog-factory.js';
import { revalidateLocalPlanningDefinition, issueAuthorizedLocalPlanningDisclosureCandidate, resolveConfiguredLocalPlanningTool, type AuthorizedLocalPlanningDefinitionV1 } from './local-planning-capability.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { attestationMatchesReviewedIdentity, currentReviewedProviderIdentity, reviewedProviderIdentityMismatch } from './reviewed-provider-identity.js';
import { disclosePrimaryModelPlanningCapabilities, type HostFreshPlanningContextV1 } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { resolveReviewedPlanStepResult, resolveReviewedPlanCollectionRecords } from './reviewed-plan-results.js';
import { reviewedCollectionMembers, bindReviewedCollectionItem, planPointer } from './reviewed-plan-collection.js';
import { resolveReviewedStepArguments } from './reviewed-plan-bindings.js';
import { reviewedFileCorrection } from './reviewed-file-correction.js';
import { unwrapRuntimeEffectiveToolIdentity, type RuntimeToolEffect } from './tool-effect.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import type { PlanArtifactV1 } from './plan-artifacts.js';
import { isPlainOrClementineLocalTool, isTrustedComposioGateway } from './runtime-tool-identity.js';
import { getTurnGraphEventForSource, appendEvent } from './eventlog.js';
import { parseNamespacedTool } from '../mcp-namespace-shim.js';

const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const equal = (a: unknown, b: unknown) => closedCanonicalJson(a, SEALED_CALL_CANONICAL_LIMITS) === closedCanonicalJson(b, SEALED_CALL_CANONICAL_LIMITS);
async function prepareReviewedMcpServer(serverSlug: string): Promise<void> {
  const { prewarmMcpServers } = await import('../mcp-servers.js');
  const ready = await prewarmMcpServers({ allowedServerSlugs: [serverSlug], attempts: 1 });
  if (!ready.allConnected || ready.target === 'none') throw new Error(`Reviewed MCP server ${serverSlug} is not connected yet. Retry when it is available.`);
}
function prepared(artifact: PlanArtifactV1) {
  const outline = artifact.structuredPlan;
  if (!outline || !Array.isArray(outline.steps) || !Array.isArray(outline.preparedBindings)
    || !Array.isArray(outline.preparationIssues) || outline.preparationIssues.length) throw new Error('Reviewed plan lacks complete host-verified preparation.');
  return { steps: outline.steps.filter(object), bindings: outline.preparedBindings.filter(object) };
}

/** One reviewed tool step whose current capability passed the check. */
export type ReviewedPlanPreparationCheckV1 =
  | { stepId: string; capabilityRef: string; kind: 'local_registry'; candidate: AuthorizedLocalPlanningDisclosureCandidate }
  | { stepId: string; capabilityRef: string; kind: 'provider'; entry: RegisteredHostCapability; schema: Record<string, unknown> };

type AuthorizedLocalPlanningDisclosureCandidate = Parameters<typeof disclosePrimaryModelPlanningCapabilities>[0]['candidates'][number];

/**
 * The pure check half of Execute preparation: every reviewed tool step must
 * still resolve to the exact current capability and schema it was published
 * against. Nothing here attaches authority to a source or needs a claim, so a
 * fresh Execute can run it BEFORE its one-per-revision claim is minted; a
 * refusal then leaves the revision ready instead of burning it. The same
 * check runs again after the claim, from `revalidateReviewedPlanPreparation`.
 */
export async function checkReviewedPlanPreparation(
  artifact: PlanArtifactV1,
  trace?: { sessionId?: string; sourceUserSeq?: number },
): Promise<ReviewedPlanPreparationCheckV1[]> {
  const outline = prepared(artifact);
  const checked: ReviewedPlanPreparationCheckV1[] = [];
  for (const step of outline.steps) {
    if (!step.capabilityRef) continue;
    const binding = outline.bindings.find(row => row.stepId === step.id && row.capabilityRef === step.capabilityRef);
    if (!binding || !object(binding.identity)) throw new Error(`Reviewed step ${step.id} has no checked capability.`);
    if (binding.identity.kind === 'local_registry') {
      const prior = binding.identity.definition as AuthorizedLocalPlanningDefinitionV1;
      const current = await revalidateLocalPlanningDefinition(prior);
      const configured = await resolveConfiguredLocalPlanningTool(prior.name, prior.carrier);
      if (!current.ok || !configured?.parameters || digestSchema(JSON.parse(JSON.stringify(configured.parameters))) !== binding.identity.inputSchemaDigest) throw new Error(`Reviewed native tool ${prior.name} changed. Revise the plan before execution.`);
      const candidate = await issueAuthorizedLocalPlanningDisclosureCandidate({ name: prior.name, carrier: prior.carrier, configuredNames: new Set([configured.name]) });
      if (!candidate || 'refused' in candidate) throw new Error(`Reviewed native tool ${prior.name} is no longer available.`);
      checked.push({ stepId: step.id, capabilityRef: step.capabilityRef, kind: 'local_registry', candidate });
    } else {
      let current = currentReviewedProviderIdentity(step.capabilityRef);
      if (!current.ok && binding.identity.providerKind === 'composio'
        && typeof binding.identity.operationId === 'string') {
        // Reobserve metadata for the existing reviewed manifest after restart.
        // This supplies no new grant and the full identity comparison below
        // still rejects changed definitions, accounts, or implementations.
        const { registerProofProvisionedCapabilities } = await import('./proof-provisioned-catalog.js');
        const { getPlanRevision } = await import('./plan-artifacts.js');
        let proofSource = artifact;
        const seenRevisions = new Set<string>();
        while (!seenRevisions.has(proofSource.digest)) {
          seenRevisions.add(proofSource.digest);
          await registerProofProvisionedCapabilities({ sessionId: proofSource.sessionId, sourceUserSeq: proofSource.sourceUserSeq }, {
            allowedIdentifiers: [binding.identity.operationId],
            expectedSchemaDigests: [{ identifier: binding.identity.operationId, schemaDigest: binding.identity.providerInputSchemaDigest }],
            recoveryExpectedIdentities: [binding.identity as CanonicalCatalogIdentityV1],
          });
          current = currentReviewedProviderIdentity(step.capabilityRef);
          if (current.ok || !proofSource.base) break;
          // Reused revisions retain the original discovery proof in their
          // owned base lineage; they do not fabricate a fresh account choice.
          proofSource = getPlanRevision({ sessionId: artifact.sessionId,
            principalId: artifact.principalId, ref: proofSource.base });
        }
      }
      if (!current.ok && binding.identity.providerKind === 'native_mcp'
        && typeof binding.identity.operationId === 'string' && object(binding.inputSchema)) {
        const operation = parseNamespacedTool(binding.identity.operationId);
        if (operation) {
          await prepareReviewedMcpServer(operation.serverSlug);
          // Restart drops process-local MCP entries. Reobserve the configured
          // server's exact definition before comparing it to the reviewed
          // identity; the saved schema alone never grants a callable tool.
          const { createProductionMcpReadCarrier } = await import('./production-mcp-read-carrier.js');
          await createProductionMcpReadCarrier({ serverName: operation.serverSlug }).materializeExact({
            operationId: binding.identity.operationId, inputSchema: binding.inputSchema,
          });
          current = currentReviewedProviderIdentity(step.capabilityRef);
        }
      }
      const reason = current.ok ? reviewedProviderIdentityMismatch(current, binding.identity as Record<string, unknown>) : current.reason;
      if (reason) {
        try {
          appendEvent({ sessionId: trace?.sessionId ?? artifact.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: {
            kind: 'plan_execution_revalidation_refused', sourceUserSeq: trace?.sourceUserSeq, stepId: step.id,
            capabilityRef: step.capabilityRef, entryPresent: Boolean(current.entry), callable: current.ok, schemaCached: current.ok, reason,
          } });
        } catch { /* trace never blocks the refusal */ }
        throw new Error(`Reviewed provider capability ${step.capabilityRef} changed or is unavailable. Revise the plan before execution.`);
      }
      if (!current.ok) continue;
      checked.push({ stepId: step.id, capabilityRef: step.capabilityRef, kind: 'provider', entry: current.entry, schema: current.schema });
    }
  }
  return checked;
}

/** Check, then attach the exact approved selection to THIS accepted source. */
export async function revalidateReviewedPlanPreparation(planning: HostFreshPlanningContextV1): Promise<void> {
  const execution = acceptedPlanExecution(planning.identity.sessionId, planning.identity.sourceUserSeq);
  if (!execution) return;
  const checked = await checkReviewedPlanPreparation(execution.artifact, planning.identity);
  await attachReviewedPlanPreparation(planning, checked);
}

export async function attachReviewedPlanPreparation(
  planning: HostFreshPlanningContextV1,
  checked: readonly ReviewedPlanPreparationCheckV1[],
): Promise<void> {
  for (const row of checked) {
    if (row.kind === 'local_registry') {
      await disclosePrimaryModelPlanningCapabilities({ authority: planning.authority, candidates: [row.candidate] });
      continue;
    }
    // A live catalog row alone is not this source's planning card, and
    // unrelated remembered tools can occupy every display slot.
    const providerKind = row.entry.manifest?.providerKind;
    if (!getTurnGraphEventForSource(planning.identity.sessionId, planning.identity.sourceUserSeq)
      && (providerKind === 'composio' || providerKind === 'native_mcp')) {
      const disclosureName = row.capabilityRef;
      const refs = await disclosePrimaryModelPlanningCapabilities({ authority: planning.authority,
        candidates: [{ name: disclosureName, carrier: 'work_call', schema: row.schema,
          sourceKind: providerKind === 'composio' ? 'authorized_composio' : 'authorized_external_mcp' }] });
      if (refs[disclosureName] !== row.capabilityRef) throw new Error(`Reviewed provider capability ${row.capabilityRef} could not be attached to this execution source.`);
    }
  }
}

/** Prepare a NEW reviewed revision from retained steps. A retired MCP lease
 * may be replaced only by the same observed operation contract. Execute never
 * uses this path: the new revision still goes through publication review. */
export async function refreshRetainedPlanPreparation(artifact: PlanArtifactV1) {
  const next = structuredClone(artifact);
  const outline = prepared(next);
  for (const binding of outline.bindings) {
    if (binding.identity?.providerKind !== 'native_mcp') continue;
    const operation = parseNamespacedTool(binding.identity.operationId);
    if (!operation) throw new Error('Retained MCP operation is malformed.');
    await prepareReviewedMcpServer(operation.serverSlug);
    const { createProductionMcpReadCarrier } = await import('./production-mcp-read-carrier.js');
    const restored = await createProductionMcpReadCarrier({ serverName: operation.serverSlug }).materializeExact({
      operationId: binding.identity.operationId, inputSchema: binding.inputSchema,
    });
    if (restored.status !== 'installed') throw new Error(`Retained MCP preparation failed: ${restored.detail}`);
    const current = currentReviewedProviderIdentity(restored.manifest.manifestId);
    if (!current.ok) throw new Error('Refreshed MCP operation is unavailable.');
    const contract = (identity: object) => Object.fromEntries(Object.entries(identity)
      .filter(([key]) => !['capabilityId', 'manifestId', 'manifestDigest'].includes(key)));
    if (!equal(contract(current.canonical), contract(binding.identity))) {
      throw new Error('Retained MCP operation contract changed; revise the plan explicitly.');
    }
    const step = outline.steps.find(row => row.id === binding.stepId);
    if (step) step.capabilityRef = restored.manifest.manifestId;
    binding.capabilityRef = restored.manifest.manifestId;
    binding.identity = current.canonical;
  }
  const checked = await checkReviewedPlanPreparation(next);
  return { artifact: next, checked };
}

export { resolveReviewedStepArguments } from './reviewed-plan-bindings.js';

function resolvedCallArguments(input: { sessionId: string; sourceUserSeq: number; args: unknown }, step: Record<string, any>) {
  let expected = resolveReviewedStepArguments(step, id => resolveReviewedPlanStepResult(input, id));
  if (step.forEach) {
    const itemId = object(input.args) ? input.args.universe_item_id : undefined;
    const member = reviewedCollectionMembers(step.forEach, resolveReviewedPlanCollectionRecords(input, step.forEach))
      .find(member => member.id === itemId);
    if (!member) throw new Error('The call must name an exact member of the reviewed collection.');
    expected = bindReviewedCollectionItem(expected, step.forEach, member.record);
  }
  // The exact approved destination is already ours. A newly recorded content
  // revision uses the native replacement operation with a retained receipt and
  // an atomic current-byte precondition, not a replay of the create.
  if (reviewedFileCorrection(input, step.id)) expected.mode = 'overwrite';
  return expected;
}

/** The approved bindings own these values, not a second transcription by the
 * model. Materialize before call admission so dispatch, receipts and recovery
 * all use the same bytes. Static arguments, operation and account still pass
 * the ordinary exact reviewed-call checks. Never manufacture missing evidence. */
export function materializeReviewedPlanCallArguments(input: { sessionId: string; sourceUserSeq: number; toolName: string; argumentsJson: string }): { argumentsJson: string; targets: string[] } | undefined {
  if (!isPlainOrClementineLocalTool(input.toolName, 'work_call')) return undefined;
  try {
    const args: unknown = JSON.parse(input.argumentsJson);
    if (!object(args) || typeof args.requirement_id !== 'string' || typeof args.name !== 'string') return undefined;
    const execution = acceptedPlanExecution(input.sessionId, input.sourceUserSeq);
    if (!execution || loadExpectedWorkContract(input.sessionId, input.sourceUserSeq).status !== 'ok') return undefined;
    const outline = prepared(execution.artifact);
    const step = outline.steps.find(row => row.id === args.requirement_id);
    const binding = outline.bindings.find(row => row.stepId === step?.id);
    if (!step || !binding || !object(binding.identity)) return undefined;
    const targets: string[] = [...(step.dynamicBindings ?? []).map((row: any) => row.targetPath),
      ...(step.forEach?.bindings ?? []).map((row: any) => row.targetPath)];
    if (!targets.length) return undefined;
    const effective = unwrapRuntimeEffectiveToolIdentity(input.toolName, args);
    const name = binding.identity.kind === 'local_registry' ? binding.identity.definition.name : binding.identity.operationId;
    if (effective.toolName?.toLowerCase() !== name.toLowerCase() || !object(effective.args)) return undefined;
    const expected = resolvedCallArguments({ ...input, args }, step);
    if (reviewedFileCorrection(input, step.id)) targets.push('/mode');
    const actual = structuredClone(effective.args);
    for (const pointer of targets) {
      const parts = pointer.slice(1).split('/').map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!pointer.startsWith('/') || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) return undefined;
      let destination: Record<string, any> = actual, source: Record<string, any> = expected;
      for (const part of parts.slice(0, -1)) {
        // Omitted parent containers can carry approved static siblings. An
        // explicitly supplied incompatible container remains a call error.
        if (!Object.hasOwn(destination, part)) destination[part] = structuredClone(source[part]);
        if (!object(destination[part]) && !Array.isArray(destination[part])) return undefined;
        destination = destination[part]; source = source[part];
      }
      destination[parts.at(-1)!] = planPointer(expected, pointer);
    }
    if (equal(actual, effective.args)) return undefined;
    // Repack only the canonical selected carrier. Aliases and malformed
    // envelopes retain their existing validation/repair path.
    const inner = JSON.parse(args.args_json);
    if (isTrustedComposioGateway(args.name)) {
      if (!object(inner) || inner.tool_slug?.toLowerCase() !== name.toLowerCase()) return undefined;
      inner.arguments = JSON.stringify(actual);
      args.args_json = JSON.stringify(inner);
    } else {
      if (args.name.toLowerCase() !== name.toLowerCase()) return undefined;
      args.args_json = JSON.stringify(actual);
    }
    return { argumentsJson: JSON.stringify(args), targets };
  } catch { return undefined; } // The ordinary call check reports unresolved bindings.
}

/** A reviewed member's input mapping is stronger evidence than finding its
 * bookkeeping ID by coincidence inside provider arguments. No authority is
 * inferred for unreviewed reads. Current capability/account checks still run. */
export function reviewedPlanMemberReadArgumentsMatch(input: { sessionId: string; sourceUserSeq: number; stepId: string; memberId: string; toolName: string; args: unknown }): boolean {
  try {
    const execution = acceptedPlanExecution(input.sessionId, input.sourceUserSeq);
    if (!execution) return false;
    const outline = prepared(execution.artifact);
    const step = outline.steps.find(step => step.id === input.stepId && step.effect === 'read' && step.forEach);
    const binding = outline.bindings.find(row => row.stepId === input.stepId);
    if (!step || !binding) return false;
    const name = binding.identity.kind === 'local_registry' ? binding.identity.definition.name : binding.identity.operationId;
    if (name.toLowerCase() !== input.toolName.toLowerCase()) return false;
    const member = reviewedCollectionMembers(step.forEach, resolveReviewedPlanCollectionRecords(input, step.forEach)).find(member => member.id === input.memberId);
    if (!member) return false;
    const expected = bindReviewedCollectionItem(resolveReviewedStepArguments(step,
      id => resolveReviewedPlanStepResult(input, id)), step.forEach, member.record);
    return equal(input.args, reviewedArgumentsWithLocalNulls(expected, input.args, binding));
  } catch { return false; }
}

/**
 * A reviewed step bound to a local tool whose result can say "not done yet —
 * fix this" (a workflow creation test that found issues) is completed by the
 * tools that fix it, not by calling the same tool again. Those calls belong
 * to the same step: refusing them as substitutions stopped an Execute turn
 * at the first "left DISABLED" result with every later step unrun. The set is
 * closed and local: nothing here reaches a provider.
 */
const REVIEWED_REPAIR_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  workflow_create: [
    'workflow_update', 'workflow_edit_step', 'workflow_apply_contract_fixes', 'workflow_capability_resolve',
    'workflow_set_enabled', 'workflow_get', 'workflow_state',
  ],
  workflow_from_session: [
    'workflow_update', 'workflow_edit_step', 'workflow_apply_contract_fixes', 'workflow_capability_resolve',
    'workflow_set_enabled', 'workflow_get', 'workflow_state',
  ],
  // A Workspace is created and then made to work: its creation smoke can
  // park it paused, a data source can wait on a grant, the view can need an
  // edit. Reads, refreshes and view edits of the same Workspace are the step.
  space_save: [
    'space_refresh', 'space_set_data', 'space_edit_view', 'space_get_view', 'space_preview', 'space_get', 'space_list',
    'space_history', 'space_diff', 'space_get_runner', 'space_edit_runner', 'space_try_runner',
    'space_action_prepare', 'space_publish', 'pending_action_list', 'pending_action_get',
  ],
};

export function reviewedRepairCompanion(boundToolName: string | undefined, calledToolName: string | undefined): boolean {
  if (!boundToolName || !calledToolName) return false;
  return (REVIEWED_REPAIR_COMPANIONS[boundToolName] ?? []).includes(calledToolName);
}

export function reviewedPlanCallRefusal(input: { sessionId: string; sourceUserSeq: number; toolName: string; args: unknown; effect: RuntimeToolEffect; attestation?: HostCallAttestation; effectiveArgs?: unknown; authorityIssue?: string }): string | undefined {
  const execution = acceptedPlanExecution(input.sessionId, input.sourceUserSeq);
  if (!execution || ['compute', 'host_only'].includes(input.effect)) return undefined;
  // A capability reference on a contextual read is not a reviewed step ID.
  // Keep supplemental reads carrier-neutral; normal tool-edge discovery,
  // account, schema and effect checks still own their admission below us.
  // Calls claiming an actual reviewed step keep its exact prepared arguments.
  const requestedId = object(input.args) ? input.args.requirement_id : undefined;
  const reviewedSteps = execution.artifact.structuredPlan?.steps;
  if (input.effect === 'read' && Array.isArray(reviewedSteps) && !reviewedSteps.some(
    (step: unknown) => object(step) && step.id === requestedId,
  )) return undefined;
  const unwrapped = unwrapRuntimeEffectiveToolIdentity(input.toolName, input.args);
  const toolName = unwrapped.toolName ?? input.toolName;
  if (['run_worker', 'request_approval'].includes(toolName) && !unwrapped.composioCarrier) return undefined;
  try {
    const outline = prepared(execution.artifact);
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok') throw new Error('Activate the exact reviewed plan with plan_task before its business calls.');
    const requestedBinding = outline.bindings.find(row => row.stepId === requestedId);
    if (
      requestedBinding
      && requestedBinding.identity?.kind === 'local_registry'
      && reviewedRepairCompanion(requestedBinding.identity.definition?.name, toolName)
    ) return undefined;
    if (requestedBinding && requestedBinding.identity?.kind !== 'local_registry' && !input.attestation) {
      // Name the mismatch the model can act on. A reviewed step is bound to
      // one operation; a call that names a different one for that step is the
      // usual cause, and "binding failure" sent the model hunting elsewhere.
      const boundOperation = typeof requestedBinding.identity?.operationId === 'string' ? requestedBinding.identity.operationId : '';
      const substituted = boundOperation && toolName && boundOperation.toLowerCase() !== toolName.toLowerCase();
      throw new Error(substituted
        ? `Reviewed step ${requestedId} is bound to ${boundOperation}; this call names ${toolName}. Call ${boundOperation} for this step with corrected arguments, or ask for a plan revision. The reviewed binding is not rewritten by a different operation.`
        : `Reviewed step ${requestedId}: current provider authority could not be bound (${input.authorityIssue || 'attestation_missing'}). This is a host capability binding failure, not a request to rewrite the approved arguments.`);
    }
    const candidates = outline.steps.filter(step => {
      if (typeof requestedId === 'string' && requestedId !== step.id) return false;
      const binding = outline.bindings.find(row => row.stepId === step.id);
      if (!binding || !object(binding.identity)) return false;
      return binding.identity.kind === 'local_registry' ? binding.identity.definition?.name === toolName
        : binding.identity.operationId === input.attestation?.operationId;
    });
    const matching = candidates.filter(step => {
      const actual = unwrapped.args ?? input.effectiveArgs ?? input.args;
      const binding = outline.bindings.find(row => row.stepId === step.id)!;
      const expected = reviewedArgumentsWithLocalNulls(resolvedCallArguments(input, step), actual, binding);
      if (!equal(actual, expected)) {
        if (candidates.length === 1 && object(actual)) {
          const paths = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
            .filter(key => !Object.hasOwn(actual, key) || !Object.hasOwn(expected, key) || !equal(actual[key], expected[key]))
            .map(key => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
          const sources = (step.dynamicBindings ?? []).filter((binding: any) => paths.some(path => binding.targetPath === path || binding.targetPath.startsWith(`${path}/`)))
            .map((binding: any) => `${binding.targetPath} consumes ${binding.outputPath === '' ? 'the entire recorded value' : binding.outputPath} from ${binding.producerStepId}`);
          throw new Error(`Reviewed step ${step.id}: arguments differ at ${paths.join(', ')}. ${sources.join('; ')}${sources.length ? '. Reuse those exact recorded values; if the synthesis is wrong, correct it with plan_step_result before writing.' : ' Use the arguments from the approved step.'}`);
        }
        return false;
      }
      if (binding.identity.kind !== 'local_registry') {
        if (input.attestation?.capabilityId !== binding.capabilityRef) return false;
        if (!attestationMatchesReviewedIdentity(input.attestation, binding.identity)) return false;
      }
      return true;
    });
    if (matching.length !== 1) throw new Error('The call does not uniquely match the reviewed operation, exact arguments, account, and schema.');
    if (typeof requestedId === 'string' && requestedId !== matching[0]!.id) throw new Error('The call names a different reviewed step.');
    return undefined;
  } catch (error) {
    return `REVIEWED_PLAN_CALL_REFUSED: ${error instanceof Error ? error.message : 'Reviewed authority is unavailable.'} No business effect was started.`;
  }
}
