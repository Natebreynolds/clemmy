/** Full plan publication is a host-owned artifact write, never execution admission. */
import { FreshActionPlanDraftSchema } from './plan-tools.js';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { acceptedTaskModeIdentity } from '../runtime/harness/accepted-task-mode.js';
import { parsePlanRevisionRef } from '../runtime/harness/task-mode.js';
import { publishPlanRevision, type PlanStructuredOutline } from '../runtime/harness/plan-artifacts.js';
import { canonicalCatalogIdentityOf, isCurrentCallableCatalogEntry, peekHostCapabilityCatalogFactory } from '../runtime/harness/host-capability-catalog-factory.js';
import { loadDurableAuthorizedLocalPlanningDefinition } from '../runtime/harness/local-planning-capability.js';
import { snapshotPrimaryModelPlanningContext, snapshotPrimaryModelSelectedStagedPlanningDescriptors, type HostFreshPlanningContextV1 } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { getLocalToolSchemas } from './local-runtime-tools.js';
import { getCachedToolSchema } from './composio-schema-cache.js';
import { digestSchema } from './tool-contract-store.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../shared/closed-canonical-json.js';
import { validateProofProviderArguments } from '../runtime/harness/proof-provider-args.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import { validatePlanArgumentPreparation } from './plan-argument-preparation.js';

const bindingSchema = z.object({ producerStepId: z.string().min(1), outputPath: z.string().startsWith('/'), targetPath: z.string().startsWith('/'), expectedType: z.enum(['string', 'number', 'boolean', 'object', 'array']) }).strict();
const stepSchema = z.object({
  id: z.string().min(1).max(160), action: z.string().min(1),
  effect: z.enum(['none', 'compute', 'read', 'local_write', 'external_write', 'admin']).describe('Copy the exact effect disclosed for the selected capability. An external service draft is still external_write. The matching execution_draft operation must declare the same effect.'),
  capabilityRef: z.string().nullable(), staticArguments: z.record(z.string(), z.unknown()),
  dynamicBindings: z.array(bindingSchema).max(100), dependsOn: z.array(z.string()).max(100),
  subagentRole: z.string().nullable(), verification: z.string().min(1),
}).strict();
export const PlanPreparationSchema = z.object({
  executionDraft: FreshActionPlanDraftSchema.nullable(),
  steps: z.array(stepSchema).min(1).max(32), successCriteria: z.array(z.string().min(1)).min(1).max(100),
  subagents: z.array(z.object({ role: z.string().min(1), instructions: z.string().min(1), stepIds: z.array(z.string()).min(1) }).strict()).max(32),
}).strict();

/** Keep the plan structure visible in the model tool schema. Only arbitrary
 * provider/local input objects need JSON encoding; the host owns account and
 * schema identities, so there is no model-authored account field to guess. */
export const PlanPublicationOutlineSchema = PlanPreparationSchema.omit({ executionDraft: true }).extend({
  steps: z.array(stepSchema.omit({ staticArguments: true }).extend({
    staticArgumentsJson: z.string().min(2).max(1_000_000).describe('JSON object containing the exact selected tool input fields only. For a provider tool, use its input_schema fields directly: do not wrap them in tool_slug, arguments, name, or args_json. The host derives the account from the discovered capabilityRef. Preserve string values and line breaks exactly.'),
  }).strict()).min(1).max(32),
}).strict();

export function decodePublishedPlanOutline(outline: z.infer<typeof PlanPublicationOutlineSchema>, executionDraft: z.infer<typeof FreshActionPlanDraftSchema> | null): unknown {
  return {
    ...outline, executionDraft,
    steps: outline.steps.map(({ staticArgumentsJson, ...step }) => {
      let staticArguments: unknown;
      try { staticArguments = JSON.parse(staticArgumentsJson); }
      catch { throw new Error(`Step ${step.id}: staticArgumentsJson must be valid JSON containing only the selected tool's input fields.`); }
      if (!staticArguments || typeof staticArguments !== 'object' || Array.isArray(staticArguments)) {
        throw new Error(`Step ${step.id}: staticArgumentsJson must encode a JSON object.`);
      }
      return { ...step, staticArguments };
    }),
  };
}

function issueDetails(error: z.ZodError) {
  return error.issues.map(issue => ({
    path: '/' + issue.path.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/'),
    code: issue.code, message: issue.message,
  }));
}

/** SDK parser errors wrap the useful Zod paths in originalError. Return only
 * validation details, never the SDK's invocation input or run context. */
function publicationError(error: unknown): string {
  // InvalidToolInputError is not a public SDK export. Inspect only its stable
  // error identity and wrapped validator, not the private invocation object.
  const invalidInput = error instanceof Error && error.name === 'InvalidToolInputError';
  const original = invalidInput && 'originalError' in error ? error.originalError : error;
  if (original instanceof z.ZodError) return JSON.stringify({ ok: false, published: false,
    error: 'invalid_plan_input', message: 'Repair the listed fields in publish_plan; no plan was published.', issues: issueDetails(original) });
  if (invalidInput) return JSON.stringify({ ok: false, published: false,
    error: 'invalid_plan_input', message: 'publish_plan requires a valid JSON object matching its typed parameters; no plan was published.' });
  return JSON.stringify({ ok: false, published: false, error: 'plan_preparation_failed',
    message: error instanceof Error ? error.message : 'Plan preparation failed; no plan was published.' });
}

export async function preparePlanOutline(input: { planning?: HostFreshPlanningContextV1; sessionId: string; sourceUserSeq: number; raw: unknown; ready: boolean }): Promise<PlanStructuredOutline> {
  const outline = PlanPreparationSchema.parse(input.raw);
  const steps = new Map(outline.steps.map(step => [step.id, step]));
  if (steps.size !== outline.steps.length) throw new Error('Plan step IDs must be unique.');
  const visited = new Set<string>();
  const visit = (id: string, chain = new Set<string>()): void => {
    if (visited.has(id)) return;
    if (chain.has(id)) throw new Error('Plan dependencies must not contain a cycle.');
    const step = steps.get(id);
    if (!step) throw new Error(`Plan dependency ${id} does not exist.`);
    for (const dependency of step.dependsOn) visit(dependency, new Set([...chain, id]));
    visited.add(id);
  };
  for (const step of outline.steps) {
    visit(step.id);
    for (const binding of step.dynamicBindings) {
      if (!steps.get(binding.producerStepId)?.capabilityRef || !step.dependsOn.includes(binding.producerStepId)) throw new Error(`Step ${step.id} needs its settled tool producer in dependsOn.`);
    }
  }
  for (const role of outline.subagents) for (const id of role.stepIds) {
    if (steps.get(id)?.subagentRole !== role.role) throw new Error(`Subagent ${role.role} assignment does not match step ${id}.`);
  }
  for (const step of outline.steps) if (step.subagentRole && !outline.subagents.some(role => role.role === step.subagentRole && role.stepIds.includes(step.id))) throw new Error(`Step ${step.id} has an undefined subagent assignment.`);
  const toolSteps = outline.steps.filter(step => step.capabilityRef !== null);
  const mutates = toolSteps.some(step => ['local_write', 'external_write', 'admin'].includes(step.effect));
  if (input.ready && mutates && !outline.executionDraft) throw new Error('A ready executable plan requires its complete executionDraft for durable tracking.');
  if (outline.executionDraft) {
    const draft = outline.executionDraft;
    if (draft.topology.operations.length !== toolSteps.length) throw new Error('Execution draft must cover each reviewed tool step exactly once.');
    for (const step of toolSteps) {
      const op = draft.topology.operations.find(op => op.id === step.id);
      const binding = draft.bindings.find(binding => binding.operationId === step.id);
      const equalSet = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
      if (!op || !binding || binding.capabilityRef !== step.capabilityRef || op.effect !== step.effect
        || op.cardinality.kind !== 'once' || !equalSet(op.dependsOn, step.dependsOn)
        || !equalSet(op.dataFrom, step.dynamicBindings.map(binding => binding.producerStepId))) {
        throw new Error(`Step ${step.id}: execution draft disagrees with the reviewed capability, effect, dependencies, or result bindings. Keep step.effect and its matching execution_draft topology operation.effect identical.`);
      }
    }
  }
  const refs = new Set(outline.steps.map(step => step.capabilityRef).filter((ref): ref is string => Boolean(ref)));
  const snapshot = input.planning && snapshotPrimaryModelPlanningContext(input.planning.authority);
  const descriptors = [...(snapshot?.capabilities ?? []), ...(input.planning ? snapshotPrimaryModelSelectedStagedPlanningDescriptors({ authority: input.planning.authority, identity: input, selectedRefs: refs }) : [])];
  const preparedBindings: Record<string, unknown>[] = [];
  const preparationIssues: string[] = [];
  for (const step of outline.steps) {
    try {
    if (!step.capabilityRef && (step.effect === 'none' || step.effect === 'compute')) {
      continue;
    }
    const descriptor = descriptors.find(entry => entry.id === step.capabilityRef);
    const local = step.capabilityRef ? await loadDurableAuthorizedLocalPlanningDefinition({ ...input, capabilityRef: step.capabilityRef }) : null;
    const localDefinition = local?.ok ? local.definition : null;
    const selectedDescriptor = descriptor ?? localDefinition?.descriptor;
    if (!step.capabilityRef || !selectedDescriptor) {
      throw new Error(`Step ${step.id}: discover and cite its exact operation before publishing a ready plan.`);
    }
    if (selectedDescriptor.effect !== step.effect) {
      throw new Error(`Step ${step.id}: the discovered capability ${step.capabilityRef} has effect ${selectedDescriptor.effect}, not ${step.effect}. Set both this step.effect and its matching execution_draft topology operation.effect to ${selectedDescriptor.effect}. The capability is already discovered; this error does not require another tool search.`);
    }
    let schema: Record<string, unknown>;
    let identity: unknown;
    if (localDefinition) {
      const localSchema = getLocalToolSchemas().get(localDefinition.name);
      if (!localSchema) throw new Error(`Step ${step.id}: local operation schema is unavailable.`);
      // Zod attaches a non-enumerable ~standard adapter to its JSON Schema.
      // Freeze the documented JSON representation, not that runtime adapter.
      schema = JSON.parse(JSON.stringify(z.toJSONSchema(localSchema))) as Record<string, unknown>;
      identity = { kind: 'local_registry', definition: localDefinition, inputSchemaDigest: digestSchema(schema) };
      const parsedArguments = localSchema.safeParse(step.staticArguments);
      if (step.dynamicBindings.length) validatePlanArgumentPreparation({ schema, staticArguments: step.staticArguments, dynamicBindings: step.dynamicBindings, localIssues: parsedArguments.success ? [] : parsedArguments.error.issues });
      else if (!parsedArguments.success) throw new Error(`Step ${step.id}: static arguments do not match the exact local schema: ${JSON.stringify(issueDetails(parsedArguments.error))}. staticArgumentsJson must contain the selected tool's input fields directly, without a call_tool or work_call wrapper.`);
    } else {
      const entry = peekHostCapabilityCatalogFactory()?.get(step.capabilityRef);
      const canonical = entry && isCurrentCallableCatalogEntry(entry) ? canonicalCatalogIdentityOf(entry) : null;
      const cached = canonical && getCachedToolSchema(canonical.operationId);
      if (!entry || !canonical || !cached || canonical.manifestDigest !== selectedDescriptor.manifestDigest || canonical.account !== selectedDescriptor.accountScope) throw new Error(`Step ${step.id}: current provider schema/account identity does not match discovery.`);
      schema = JSON.parse(closedCanonicalJson(cached, { ...SEALED_CALL_CANONICAL_LIMITS, omitUndefinedObjectMembers: true }));
      if (digestSchema(schema) !== canonical.providerInputSchemaDigest) throw new Error(`Step ${step.id}: provider schema changed after discovery.`);
      identity = canonical;
      if (step.dynamicBindings.length) validatePlanArgumentPreparation({ schema, staticArguments: step.staticArguments, dynamicBindings: step.dynamicBindings });
      const validation = !step.dynamicBindings.length && validateProofProviderArguments({ schema, payload: step.staticArguments });
      if (validation && !validation.ok) throw new Error(`Step ${step.id}: static arguments do not match the exact provider schema (${validation.failingPaths.join(', ')}). staticArgumentsJson must contain ${canonical.operationId}'s input_schema fields directly; do not wrap them in tool_slug, arguments, name, or args_json. Required input fields: ${JSON.stringify(schema.required ?? [])}.`);
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    const dynamicallyBound = new Set(step.dynamicBindings.map(binding => binding.targetPath.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~')));
    if (required.some(key => !Object.hasOwn(step.staticArguments, key) && !dynamicallyBound.has(key))) throw new Error(`Step ${step.id}: a required argument has neither a static value nor a producer binding.`);
    preparedBindings.push({ stepId: step.id, capabilityRef: step.capabilityRef, identity, inputSchema: schema,
      argumentValidation: step.dynamicBindings.length ? 'validate_after_bound_results' : 'static_schema_checked',
      source: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq } });
    } catch (error) {
      if (input.ready) throw error;
      preparationIssues.push(error instanceof Error ? error.message : `Step ${step.id}: preparation unavailable.`);
    }
  }
  return JSON.parse(closedCanonicalJson({ ...outline, preparedBindings, preparationIssues }, SEALED_CALL_CANONICAL_LIMITS)) as PlanStructuredOutline;
}

export function buildPublishPlanTool(planning?: HostFreshPlanningContextV1) {
  return tool({
    name: 'publish_plan',
    description: 'Publish the complete investigated plan for user review without executing it. Put the typed outline in structured_plan and the matching action draft in execution_draft (null only for read-only or incomplete work). Each step.id must exactly match its execution_draft operation and binding operationId. Cite discovered exact capability refs; the host attaches verified account/schema identities. Account metadata is not part of the outline. Encode only the selected tool input object in each staticArgumentsJson. Use none/compute with capabilityRef:null only for tool-free reasoning. Missing required facts make readiness needs_input. Dynamic values reference prior result paths, never invented IDs. base_ref_json is null for a new plan or exact {planId,revision,digest} for an explicit revision. The full saved artifact is what Execute selects.',
    parameters: z.object({ execution_draft: FreshActionPlanDraftSchema.nullable().describe('Complete existing action topology and evidence contract, prepared once here and re-used unchanged at Execute. Null for read-only or unresolved work.'), full_text: z.string().min(1).max(1_000_000).describe('Complete readable Markdown for the user. Use real paragraph and line breaks, not literal escaped newline text.'), structured_plan: PlanPublicationOutlineSchema, readiness: z.enum(['ready', 'needs_input']), missing_prerequisites: z.array(z.string().min(1)).max(100), base_ref_json: z.string().nullable() }).strict(),
    errorFunction: (_context, error) => publicationError(error),
    execute: async args => {
      const context = harnessRunContextStorage.getStore();
      if (!context?.sessionId || !context.sourceUserSeq || context.workerScope) throw new Error('Only the exact foreground Plan turn can publish a reviewed plan.');
      const source = acceptedTaskModeIdentity(context.sessionId, context.sourceUserSeq);
      if (source.mode?.kind !== 'plan') throw new Error('publish_plan requires explicit Plan mode.');
      const structuredPlan = await preparePlanOutline({ planning, sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, raw: decodePublishedPlanOutline(args.structured_plan, args.execution_draft), ready: args.readiness === 'ready' });
      const routed = listEvents(context.sessionId, { types: ['turn_model_routed'] }).filter(event => event.data.sourceUserSeq === context.sourceUserSeq).at(-1);
      const artifact = publishPlanRevision({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, principalId: source.principalId,
        fullText: args.full_text, structuredPlan, readiness: args.readiness, missingPrerequisites: [...new Set([...args.missing_prerequisites, ...(structuredPlan.preparationIssues as string[])])],
        ...(typeof routed?.data.model === 'string' ? { authorModelId: routed.data.model } : {}),
        ...(args.base_ref_json ? { base: parsePlanRevisionRef(JSON.parse(args.base_ref_json)) } : {}) });
      return JSON.stringify({ ok: true, planArtifactRef: { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest }, readiness: artifact.readiness, message: 'The full plan is saved for review. The user can Execute this exact revision. No business execution has started.' });
    },
  });
}
