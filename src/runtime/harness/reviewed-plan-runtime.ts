/** Exact reviewed preparation at activation and each business call. No grants. */
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { canonicalCatalogIdentityOf, isCurrentCallableCatalogEntry, peekHostCapabilityCatalogFactory } from './host-capability-catalog-factory.js';
import { revalidateLocalPlanningDefinition, issueAuthorizedLocalPlanningDisclosureCandidate, resolveConfiguredLocalPlanningTool, type AuthorizedLocalPlanningDefinitionV1 } from './local-planning-capability.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { disclosePrimaryModelPlanningCapabilities, type HostFreshPlanningContextV1 } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { loadExpectedWorkCallBindingState } from './expected-work-admission.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { openEventLog } from './eventlog.js';
import { resolveWorkTopologyJsonPointer } from '../graph/work-topology.js';
import { unwrapRuntimeEffectiveToolIdentity, type RuntimeToolEffect } from './tool-effect.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import type { PlanArtifactV1 } from './plan-artifacts.js';

const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const equal = (a: unknown, b: unknown) => closedCanonicalJson(a, SEALED_CALL_CANONICAL_LIMITS) === closedCanonicalJson(b, SEALED_CALL_CANONICAL_LIMITS);
function prepared(artifact: PlanArtifactV1) {
  const outline = artifact.structuredPlan;
  if (!outline || !Array.isArray(outline.steps) || !Array.isArray(outline.preparedBindings)
    || !Array.isArray(outline.preparationIssues) || outline.preparationIssues.length) throw new Error('Reviewed plan lacks complete host-verified preparation.');
  return { steps: outline.steps.filter(object), bindings: outline.preparedBindings.filter(object) };
}

export async function revalidateReviewedPlanPreparation(planning: HostFreshPlanningContextV1): Promise<void> {
  const execution = acceptedPlanExecution(planning.identity.sessionId, planning.identity.sourceUserSeq);
  if (!execution) return;
  const outline = prepared(execution.artifact);
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
      await disclosePrimaryModelPlanningCapabilities({ authority: planning.authority, candidates: [candidate] });
    } else {
      const entry = peekHostCapabilityCatalogFactory()?.get(step.capabilityRef);
      const canonical = entry && isCurrentCallableCatalogEntry(entry) ? canonicalCatalogIdentityOf(entry) : null;
      const schema = canonical && getCachedToolSchema(canonical.operationId);
      if (!canonical || !schema || !equal(canonical, binding.identity)
        || digestSchema(JSON.parse(closedCanonicalJson(schema, { ...SEALED_CALL_CANONICAL_LIMITS, omitUndefinedObjectMembers: true }))) !== canonical.providerInputSchemaDigest) {
        throw new Error(`Reviewed provider capability ${step.capabilityRef} changed or is unavailable. Revise the plan before execution.`);
      }
    }
  }
}

/** The producer resolver must return durable raw settled bytes, never model prose. */
export function resolveReviewedStepArguments(step: Record<string, any>, resolveProducer: (id: string) => unknown): Record<string, unknown> {
  if (!object(step.staticArguments) || !Array.isArray(step.dynamicBindings)) throw new Error('Reviewed argument contract is malformed.');
  const args = JSON.parse(closedCanonicalJson(step.staticArguments, SEALED_CALL_CANONICAL_LIMITS));
  const targets = new Set<string>();
  for (const binding of step.dynamicBindings) {
    if (!object(binding) || typeof binding.targetPath !== 'string' || !Array.isArray(step.dependsOn)
      || !step.dependsOn.includes(binding.producerStepId) || targets.has(binding.targetPath)) throw new Error('Reviewed dynamic binding is malformed or ambiguous.');
    targets.add(binding.targetPath);
    const producer = resolveProducer(binding.producerStepId);
    if (typeof binding.outputPath !== 'string' || !binding.outputPath.startsWith('/')) throw new Error('Reviewed producer path is invalid.');
    let cursor: unknown = producer;
    for (const part of binding.outputPath.slice(1).split('/').map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if ((!object(cursor) && !Array.isArray(cursor)) || !Object.hasOwn(cursor, part)) throw new Error(`Producer ${binding.producerStepId} did not return ${binding.outputPath}.`);
      cursor = (cursor as Record<string, unknown>)[part];
    }
    const result = resolveWorkTopologyJsonPointer(producer, binding.outputPath);
    if (!result.ok) throw new Error(`Producer ${binding.producerStepId} did not return ${binding.outputPath}.`);
    const type = Array.isArray(result.value) ? 'array' : result.value === null ? 'null' : typeof result.value;
    if (type !== binding.expectedType) throw new Error('Reviewed dynamic argument type does not match its settled producer.');
    const parts = binding.targetPath.slice(1).split('/').map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!binding.targetPath.startsWith('/') || parts.some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Reviewed dynamic target is invalid.');
    let target: Record<string, unknown> = args;
    for (const part of parts.slice(0, -1)) {
      if (!object(target[part])) throw new Error('Reviewed dynamic target parent must be explicitly declared.');
      target = target[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (Object.hasOwn(target, key)) throw new Error('A reviewed argument cannot have both a static value and a dynamic binding.');
    target[key] = result.value;
  }
  return args;
}

export function reviewedPlanCallRefusal(input: { sessionId: string; sourceUserSeq: number; toolName: string; args: unknown; effect: RuntimeToolEffect; attestation?: HostCallAttestation; effectiveArgs?: unknown }): string | undefined {
  const execution = acceptedPlanExecution(input.sessionId, input.sourceUserSeq);
  if (!execution || ['read', 'compute', 'host_only'].includes(input.effect)) return undefined;
  const unwrapped = unwrapRuntimeEffectiveToolIdentity(input.toolName, input.args);
  const toolName = unwrapped.toolName ?? input.toolName;
  if (['run_worker', 'request_approval'].includes(toolName) && !unwrapped.composioCarrier) return undefined;
  try {
    const outline = prepared(execution.artifact);
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok') throw new Error('Activate the exact reviewed plan with plan_task before its business calls.');
    const requestedId = object(input.args) ? input.args.requirement_id : undefined;
    const candidates = outline.steps.filter(step => {
      if (typeof requestedId === 'string' && requestedId !== step.id) return false;
      const binding = outline.bindings.find(row => row.stepId === step.id);
      if (!binding || !object(binding.identity)) return false;
      return binding.identity.kind === 'local_registry' ? binding.identity.definition?.name === toolName
        : binding.identity.operationId === input.attestation?.operationId;
    });
    const matching = candidates.filter(step => {
      const expected = resolveReviewedStepArguments(step, producerId => {
        const rows = openEventLog().prepare('SELECT logical_tool_call_id FROM expected_work_call_bindings WHERE session_id = ? AND source_user_seq = ? AND requirement_id = ?')
          .all(input.sessionId, input.sourceUserSeq, producerId) as Array<{ logical_tool_call_id: string }>;
        const successful = rows.flatMap(row => {
          const binding = loadExpectedWorkCallBindingState({ ...input, logicalToolCallId: row.logical_tool_call_id });
          if (binding.status !== 'ok' || binding.binding.contractId !== loaded.contract.contractId || binding.binding.requirementId !== producerId) return [];
          const result = redeemSuccessfulSettlementResultForHost({ ...input, acceptedTaskId: loaded.contract.acceptedTaskId, logicalToolCallId: row.logical_tool_call_id });
          return result.status === 'ok' ? [result.value.rawPayload] : [];
        });
        if (successful.length !== 1) throw new Error(`Reviewed producer ${producerId} requires one exact settled result.`);
        return successful[0];
      });
      const actual = unwrapped.args ?? input.effectiveArgs ?? input.args;
      if (!equal(actual, expected)) return false;
      const binding = outline.bindings.find(row => row.stepId === step.id)!;
      if (binding.identity.kind !== 'local_registry') {
        const a = input.attestation;
        if (!a || a.capabilityId !== binding.capabilityRef || a.manifestDigest !== binding.identity.manifestDigest
          || a.accountId !== binding.identity.account || a.providerInputSchemaDigest !== binding.identity.providerInputSchemaDigest) return false;
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
