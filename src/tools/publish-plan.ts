import { retainPlanPreparationDraft, loadRetainedPlanDraft } from '../runtime/harness/plan-preparation-draft.js';
import { reviewPlanForPublication } from '../runtime/harness/plan-publication-review.js';
/** Full plan publication is a host-owned artifact write, never execution admission. */
import { FreshActionPlanDraftSchema } from './plan-tools.js';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { acceptedTaskModeIdentity } from '../runtime/harness/accepted-task-mode.js';
import { parsePlanRevisionRef } from '../runtime/harness/task-mode.js';
import { getPlanRevision, getPlanRevisionForSource, publishPlanRevision, type PlanStructuredOutline, type PlanArtifactV1 } from '../runtime/harness/plan-artifacts.js';
import { currentReviewedProviderIdentity, reviewedProviderIdentityMismatch } from '../runtime/harness/reviewed-provider-identity.js';
import { loadDurableAuthorizedLocalPlanningDefinition, resolveConfiguredLocalPlanningTool } from '../runtime/harness/local-planning-capability.js';
import { currentPrimaryModelPlanningDescriptor, restoreSelectedPlanningCallable, snapshotPrimaryModelPlanningContext, snapshotPrimaryModelSelectedStagedPlanningDescriptors, type HostFreshPlanningContextV1 } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { digestSchema } from './tool-contract-store.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../shared/closed-canonical-json.js';
import { validateProofProviderArguments } from '../runtime/harness/proof-provider-args.js';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { validatePlanArgumentPreparation } from './plan-argument-preparation.js';
import type { HostCapabilityDescriptorV1 } from '../runtime/semantic-boundary/turn-semantic-proposal.js';
import { PlanCollectionSchema, reviewedCollectionMembers, bindReviewedCollectionItem, planCollectionUniverseId, reviewedCollectionRoot, type PlanCollection } from '../runtime/harness/reviewed-plan-collection.js';
import { nextEdge, renderNextEdge, type HostNextEdgeV1 } from '../runtime/harness/next-edge.js';
import { currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import { assertDispatchLeaseCurrent } from '../runtime/harness/dispatch-lease.js';

const bindingSchema = z.object({ producerStepId: z.string().min(1), outputPath: z.string().default('').describe('Path into the settled result, or empty for the whole result. Use whole results for synthesis when the provider output shape is not known yet.'), targetPath: z.string().startsWith('/'), expectedType: z.enum(['string', 'number', 'boolean', 'object', 'array', 'json']).optional() }).strict();
const stepSchema = z.object({
  id: z.string().min(1).max(160), action: z.string().min(1),
  effect: z.enum(['none', 'compute', 'read', 'local_write', 'external_write', 'admin']).default('compute').describe('For tool steps the host derives the effect from capabilityRef. For reasoning use none, or compute when recording an output.'),
  capabilityRef: z.string().nullable().default(null), staticArguments: z.record(z.string(), z.unknown()).default({}),
  dynamicBindings: z.array(bindingSchema).default([]), dependsOn: z.array(z.string()).default([]).describe('Required successful producers, not attempted lookups. A compute step can investigate conditional sources through contextual reads before recording its synthesis; describe that method in action. Do not make an optional lookup and its fallback mandatory dependencies.'),
  subagentRole: z.string().nullable().default(null), verification: z.string().min(1),
  forEach: PlanCollectionSchema.optional().describe('Repeat this one operation over an exact collection, with durable progress per member. Do not duplicate the step for every record.'),
}).strict();
export const PlanPreparationSchema = z.object({
  executionDraft: FreshActionPlanDraftSchema.nullish(),
  steps: z.array(stepSchema).min(1), successCriteria: z.array(z.string().min(1)).min(1),
  subagents: z.array(z.object({ role: z.string().min(1), instructions: z.string().min(1), stepIds: z.array(z.string()).default([]) }).strict()).default([]),
}).strict();

/** Provider-neutral, non-strict wire schema. The host validates the outline
 * itself; adapters need not force arbitrary provider data into JSON strings. */
export const PlanPublicationOutlineSchema = PlanPreparationSchema.omit({ executionDraft: true }).extend({
  steps: z.array(stepSchema.omit({ staticArguments: true, id: true }).extend({
    id: z.string().min(1).max(160).optional().describe('Step identity, referenced by dependsOn and bindings. When omitted the host assigns step_<position>.'),
    staticArguments: z.record(z.string(), z.unknown()).optional().describe('The selected tool input object, directly. Keep JSON arrays and objects as data; the host serializes the transport.'),
    staticArgumentsJson: z.string().min(2).max(1_000_000).optional().describe('Legacy encoded input object. Prefer staticArguments. Supply only one representation.'),
  }).strict()).min(1),
}).strict();

/** Steps the outline left without an id, with the id the host assigns from
 *  the step's position. A missing identity on an otherwise executable step is
 *  a shape the host can complete from what it already holds; a refusal that
 *  only names the missing field costs a full model round per step. Ids that
 *  other steps reference are always authored, so a completed id never breaks
 *  a reference. */
export function completedPlanStepIds(outline: { steps: ReadonlyArray<{ id?: string }> }): Array<{ index: number; id: string }> {
  const taken = new Set(outline.steps.map((step) => step.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
  const completed: Array<{ index: number; id: string }> = [];
  outline.steps.forEach((step, index) => {
    if (typeof step.id === 'string' && step.id.length > 0) return;
    let candidate = `step_${index + 1}`;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `step_${index + 1}_${n}`;
    taken.add(candidate);
    completed.push({ index, id: candidate });
  });
  return completed;
}

export function decodePublishedPlanOutline(outline: z.infer<typeof PlanPublicationOutlineSchema>, executionDraft?: z.infer<typeof FreshActionPlanDraftSchema> | null): unknown {
  const assigned = new Map(completedPlanStepIds(outline).map((entry) => [entry.index, entry.id]));
  return {
    ...outline, executionDraft: executionDraft ?? null,
    steps: outline.steps.map(({ staticArgumentsJson, staticArguments: direct, ...rest }, index) => {
      const step = { ...rest, id: rest.id ?? assigned.get(index)! };
      if (staticArgumentsJson !== undefined && direct !== undefined) throw new Error(`Step ${step.id}: supply staticArguments or staticArgumentsJson, not both.`);
      let staticArguments: unknown = direct ?? {};
      try { if (staticArgumentsJson !== undefined) staticArguments = JSON.parse(staticArgumentsJson); }
      catch { throw new Error(`Step ${step.id}: staticArgumentsJson must be valid JSON containing only the selected tool's input fields.`); }
      if (!staticArguments || typeof staticArguments !== 'object' || Array.isArray(staticArguments)) {
        throw new Error(`Step ${step.id}: staticArgumentsJson must encode a JSON object.`);
      }
      return { ...step, staticArguments };
    }),
  };
}

const stepPatchSchema = z.object({
  step_id: z.string().min(1),
  // A patch has no defaults: an omitted field must preserve the retained value.
  // Zod defaults inside partial() would otherwise reset capabilityRef to null.
  changes: z.object({
    action: stepSchema.shape.action.optional(),
    effect: stepSchema.shape.effect.removeDefault().optional(),
    capabilityRef: stepSchema.shape.capabilityRef.removeDefault().optional(),
    staticArguments: stepSchema.shape.staticArguments.removeDefault().optional(),
    staticArgumentsJson: PlanPublicationOutlineSchema.shape.steps.element.shape.staticArgumentsJson,
    dynamicBindings: stepSchema.shape.dynamicBindings.removeDefault().optional(),
    dependsOn: stepSchema.shape.dependsOn.removeDefault().optional(),
    subagentRole: stepSchema.shape.subagentRole.removeDefault().optional(),
    verification: stepSchema.shape.verification.optional(),
    forEach: stepSchema.shape.forEach.nullable().describe('Set null to remove repetition when repairing a step to use a single batch input.'),
  }).strict(),
}).strict();
export const PlanPublicationInputSchema = z.object({
  execution_draft: z.null().optional(),
  full_text: z.string().min(1).max(1_000_000).optional().describe('The COMPLETE user-facing plan, including its source findings, method, assumptions and relevant remembered preferences. During a draft repair, omit to retain the existing full text. Supplying this field replaces it entirely; a change note is not a full replacement.'),
  structured_plan: PlanPublicationOutlineSchema.optional(),
  readiness: z.enum(['ready', 'needs_input']).default('ready'),
  missing_prerequisites: z.array(z.string().min(1)).default([]),
  base_ref_json: z.string().nullable().default(null),
  draft_digest: z.string().length(64).optional().describe('Repair only: copy the exact digest returned by a failed preparation. Omit this field entirely for a new full plan; never invent a digest. Requires step_patches.'),
  step_patches: z.array(stepPatchSchema).min(1).optional().describe('Repair only: [{step_id, changes}] for existing steps, paired with the returned draft_digest. Put every changed step field inside changes. Omitted steps and full_text are retained. To add, remove or reorder steps, submit the complete structured_plan and full_text without draft_digest or step_patches.'),
}).strict();

class RetainedPlanPreparationError extends Error {
  constructor(message: string, readonly draftDigest: string) { super(message); }
}

function publicationReceipt(artifact: PlanArtifactV1, recovered = false): string {
  return JSON.stringify({ ok: true,
    planArtifactRef: { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest },
    readiness: artifact.readiness,
    ...(recovered ? { status: 'already_published' } : {}),
    message: recovered
      ? 'This source already saved the plan referenced here. Return that exact saved plan; no replacement was published. Changes belong in a new Plan turn.'
      : artifact.readiness === 'needs_input'
        ? 'The partial plan and question are saved. The answer continues planning; prepare a ready revision before the user selects Execute. No business execution has started.'
        : 'The full plan is saved for review. The user can Execute this exact revision. No business execution has started.' });
}

export function applyPlanDraftPatches(draft: { fullText: string; structuredPlan: PlanStructuredOutline; base: unknown }, args: z.infer<typeof PlanPublicationInputSchema>) {
  if (args.structured_plan || args.base_ref_json) throw new Error('A retained draft repair cannot also replace the whole outline or its revision reference.');
  const outline = draft.structuredPlan;
  const steps = structuredClone(outline.steps) as Array<Record<string, unknown>>;
  const patched = new Set<string>();
  for (const patch of args.step_patches ?? []) {
    const step = steps.find(step => step.id === patch.step_id);
    if (!step) throw new Error(`Unknown step_id in draft repair: ${patch.step_id}. step_patches only edits existing steps. To add, remove or reorder steps, submit full_text and the complete structured_plan without draft_digest and step_patches; preserve the revision reference when present.`);
    if (patched.has(patch.step_id)) throw new Error(`Duplicate patch for step_id ${patch.step_id}. Combine its changes into one patch; omit unchanged steps.`);
    patched.add(patch.step_id);
    const { staticArgumentsJson, ...changes } = patch.changes;
    if (staticArgumentsJson !== undefined && changes.staticArguments !== undefined) throw new Error('Supply one argument representation in a draft repair.');
    Object.assign(step, changes);
    if (changes.forEach === null) delete step.forEach;
    if (staticArgumentsJson !== undefined) step.staticArguments = JSON.parse(staticArgumentsJson);
  }
  return { fullText: args.full_text ?? draft.fullText, baseRefJson: draft.base ? JSON.stringify(draft.base) : null,
    raw: { steps, successCriteria: outline.successCriteria, subagents: outline.subagents } };
}

function issueDetails(error: z.ZodError) {
  return error.issues.map(issue => ({
    path: '/' + issue.path.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/'),
    code: issue.code, message: issue.message,
  }));
}

/** SDK parser errors wrap the useful Zod paths in originalError. Return only
 * validation details, never the SDK's invocation input or run context. */
/**
 * THE EDGE OUT OF A VALIDATION REFUSAL.
 *
 * Live 2026-09-12 04:53:53: a steered Plan turn tried to publish and was
 * refused with `bindings must cover every canonical topology operation exactly
 * once` plus "Repair the listed fields in publish_plan". Both true. Neither
 * mentioned that publish_plan ALREADY accepts the honest partial —
 * `execution_draft: null` with `readiness: "needs_input"` and the gaps in
 * `missing_prerequisites`. So she went back to gathering bindings she could not
 * complete, which is the exact loop the steer had just ended.
 *
 * The escape hatch was never missing. Only the signpost was.
 */
function planRefusalEdge(issues: ReadonlyArray<{ path: string; message: string }>): HostNextEdgeV1 {
  // An incomplete execution draft is the one refusal with a better move than
  // "repair it": publish what is actually known and name what is not.
  const draftIncomplete = issues.some((issue) => issue.path.startsWith('/execution_draft'));
  if (draftIncomplete) {
    return nextEdge({
      tool: 'publish_plan',
      change: 'publish_partial',
      fields: [
        { path: '/execution_draft', set: 'null' },
        { path: '/readiness', set: '"needs_input"' },
        { path: '/missing_prerequisites', set: 'the exact facts still unresolved' },
      ],
      say: 'Every topology operation needs its own binding, so an execution draft cannot be partially bound. If the remaining steps are genuinely unresolved, publish the honest partial instead of gathering more.',
    });
  }
  return nextEdge({ tool: 'publish_plan', change: 'repair_arguments' });
}

function publicationError(error: unknown): string {
  if (error instanceof RetainedPlanPreparationError) return JSON.stringify({ ok: false, published: false,
    error: 'plan_preparation_failed', code: 'plan_preparation_failed', message: error.message,
    draft_digest: error.draftDigest,
    repair: 'The complete draft is retained. Call publish_plan with this draft_digest and step_patches [{step_id, changes}]. Only include changed fields inside changes; omit full_text to preserve the complete plan. If replacing full_text, supply the entire revised plan, not a change note. Adding, removing or reordering steps requires the complete structured_plan and full_text without draft_digest and step_patches. The host will prepare the whole resulting plan again.' });
  // InvalidToolInputError is not a public SDK export. Inspect only its stable
  // error identity and wrapped validator, not the private invocation object.
  const invalidInput = error instanceof Error && error.name === 'InvalidToolInputError';
  const original = invalidInput && 'originalError' in error ? error.originalError : error;
  if (original instanceof z.ZodError) {
    const issues = issueDetails(original);
    const edge = planRefusalEdge(issues);
    return JSON.stringify({ ok: false, published: false,
      error: 'invalid_plan_input',
      message: `Repair the listed fields in publish_plan; no plan was published. ${renderNextEdge(edge)}`,
      issues,
      nextEdge: edge });
  }
  if (invalidInput) return JSON.stringify({ ok: false, published: false,
    error: 'invalid_plan_input', message: 'publish_plan requires a valid JSON object matching its typed parameters; no plan was published.' });
  return JSON.stringify({ ok: false, published: false, error: 'plan_preparation_failed', code: 'plan_preparation_failed',
    message: error instanceof Error ? error.message : 'Plan preparation failed; no plan was published.' });
}

/** A repeated tool step needs a member set the host can seal at review time:
 *  the records the plan already holds (listed inline), or a complete read in
 *  this plan. A step that only records an output cannot seal a member set, so
 *  the repair names the two shapes that execute, without changing the plan's
 *  intent: per-member content the bindings do not cover is authored at
 *  execute time, judged against the approved goal and plan. */
function collectionProducerRepair(stepId: string, producerId: string, collection: PlanCollection): string {
  const bound = collection.bindings.map(binding => `${binding.itemPath || '/'} → ${binding.targetPath}`).join(', ');
  return `Step ${stepId}: ${producerId} records an output; it cannot supply a reviewed member set. Repair one of two ways, keeping the bindings (${bound || 'none'}): `
    + `(1) you already hold the members from planning — patch forEach to {items: [one object per member carrying every field those bindings read, including the authored per-member content such as subject and body], memberIdPath: the pointer to each object's stable id (for example /id), bindings} and drop producerStepId; `
    + `(2) make a tool step in this plan the producerStepId (a complete read supplies its records; a repeated tool step supplies {memberId, result} records) and bind each argument from the record; `
    + `or (3) unroll into one single-call step per member, each with dynamicBindings from ${producerId} (outputPath /drafts/0, /drafts/1, …), which stays a compute step whose result is recorded during Execute. `
    + `A reviewed write carries its exact arguments: every required field is static, bound, or carried by the member record — never left to be written at execute time.`;
}

/** For each `type_mismatch` whose expected shape is `array<scalar>` at a
 *  path a collection binding targets, and whose member value is exactly one
 *  scalar of that kind, rewrite the member record's value to a one-element
 *  list. Returns true when at least one value was completed. */
function completeScalarListMembers(input: { item: unknown; collection: PlanCollection; failures: ReadonlyArray<{ path: string; code: string; expected?: string }> }): boolean {
  if (!input.item || typeof input.item !== 'object' || Array.isArray(input.item)) return false;
  let completed = false;
  for (const failure of input.failures) {
    if (failure.code !== 'type_mismatch') continue;
    const inner = /^array<(string|number|boolean)>$/.exec(failure.expected ?? '')?.[1];
    if (!inner) continue;
    const binding = input.collection.bindings.find(candidate => candidate.targetPath === failure.path);
    if (!binding) continue;
    const parts = (binding.itemPath || '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) continue;
    let parent: Record<string, unknown> = input.item as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      const next = parent[part];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { parent = null as never; break; }
      parent = next as Record<string, unknown>;
    }
    if (!parent) continue;
    const key = parts.at(-1)!;
    const value = parent[key];
    if (typeof value !== inner) continue;
    parent[key] = [value];
    completed = true;
  }
  return completed;
}

/** Reviewer send-backs a single Plan source may absorb before its next
 *  structurally sound candidate publishes regardless. */
const PLAN_REVIEW_SEND_BACK_BUDGET = 2;

export async function preparePlanOutline(input: { planning?: HostFreshPlanningContextV1; sessionId: string; sourceUserSeq: number; raw: unknown; ready: boolean }): Promise<PlanStructuredOutline> {
  const outline = PlanPreparationSchema.parse(input.raw);
  // A typed data binding already declares its dependency. Do not make the
  // model repeat that edge in a second field. Cycle/producer validation below
  // still applies to the combined graph before anything can be published.
  for (const step of outline.steps) step.dependsOn = [...new Set([
    ...step.dependsOn, ...step.dynamicBindings.map(binding => binding.producerStepId),
    ...(step.forEach?.producerStepId ? [step.forEach.producerStepId] : []),
  ])];
  const steps = new Map(outline.steps.map(step => [step.id, step]));
  // Every structural problem is reported in ONE response. A plan with three
  // repeated steps used to learn about them one rejection at a time, and each
  // round trip was a full model call re-authoring the plan.
  const structuralIssues: string[] = [];
  if (steps.size !== outline.steps.length) structuralIssues.push('Plan step IDs must be unique.');
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
    try { visit(step.id); } catch (error) { structuralIssues.push(error instanceof Error ? error.message : String(error)); continue; }
    try {
      if (step.forEach) {
        const collection = step.forEach;
        if (!step.capabilityRef || Boolean(collection.items) === Boolean(collection.producerStepId)) throw new Error(`Step ${step.id}: forEach needs a tool and exactly one of items or producerStepId.`);
        if (collection.items) reviewedCollectionMembers(collection, collection.items);
        if (collection.producerStepId) {
          const producer = steps.get(collection.producerStepId)!;
          if (!producer.capabilityRef) throw new Error(collectionProducerRepair(step.id, producer.id, collection));
          if (producer.forEach) {
            if (!collection.memberIdPath) collection.memberIdPath = '/memberId';
            if (collection.memberIdPath !== '/memberId') throw new Error(`Step ${step.id}: repeated producer ${producer.id} returns {memberId, result}; use /memberId for identity and /result/... for data. Preserve the discovered-result dependency.`);
          }
        }
      }
      for (const binding of step.dynamicBindings) {
        const producer = steps.get(binding.producerStepId)!;
        if (!producer.capabilityRef && producer.effect !== 'compute') throw new Error(`Step ${step.id}: producer ${producer.id} must be a tool step or a compute step whose result is recorded during Execute.`);
      }
    } catch (error) {
      structuralIssues.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const role of outline.subagents) {
    if (!role.stepIds.length) role.stepIds = outline.steps.filter(step => step.subagentRole === role.role).map(step => step.id);
    for (const id of role.stepIds) {
      const assigned = steps.get(id);
      if (assigned && assigned.subagentRole === null) assigned.subagentRole = role.role;
      if (steps.get(id)?.subagentRole !== role.role) structuralIssues.push(`Subagent ${role.role} assignment does not match step ${id}.`);
    }
  }
  for (const step of outline.steps) if (step.subagentRole && !outline.subagents.some(role => role.role === step.subagentRole && role.stepIds.includes(step.id))) structuralIssues.push(`Step ${step.id} has an undefined subagent assignment.`);
  if (structuralIssues.length) throw new Error(structuralIssues.join('\n'));
  // The host derives the execution draft from the reviewed steps below. A
  // model-supplied draft is never compared against the outline: the outline
  // is the contract, and a retained draft on an older submission is ignored.
  const toolSteps = outline.steps.filter(step => step.capabilityRef !== null);
  const refs = new Set(outline.steps.map(step => step.capabilityRef).filter((ref): ref is string => Boolean(ref)));
  const snapshot = input.planning && snapshotPrimaryModelPlanningContext(input.planning.authority);
  const descriptors = [...(snapshot?.capabilities ?? []), ...(input.planning ? snapshotPrimaryModelSelectedStagedPlanningDescriptors({ authority: input.planning.authority, identity: input, selectedRefs: refs }) : [])];
  const preparedDescriptors = new Map<string, HostCapabilityDescriptorV1>();
  const preparedBindings: Record<string, unknown>[] = [];
  const preparationIssues: string[] = [];
  for (const step of outline.steps) {
    try {
    if (!step.capabilityRef && (step.effect === 'none' || step.effect === 'compute')) {
      continue;
    }
    if (input.planning && step.capabilityRef) await restoreSelectedPlanningCallable({
      authority: input.planning.authority, identity: input, capabilityRef: step.capabilityRef,
      publicationGuard: () => {
        if (currentToolAbortSignal()?.aborted) return false;
        const lease = harnessRunContextStorage.getStore()?.dispatchLease;
        try { if (lease) assertDispatchLeaseCurrent(lease); } catch { return false; }
        return true;
      },
    });
    const descriptor = (input.planning && step.capabilityRef
      ? currentPrimaryModelPlanningDescriptor({ authority: input.planning.authority, identity: input, capabilityRef: step.capabilityRef })
      : null) ?? descriptors.find(entry => entry.id === step.capabilityRef);
    const local = step.capabilityRef ? await loadDurableAuthorizedLocalPlanningDefinition({ ...input, capabilityRef: step.capabilityRef }) : null;
    const localDefinition = local?.ok ? local.definition : null;
    const selectedDescriptor = descriptor ?? localDefinition?.descriptor;
    if (!step.capabilityRef || !selectedDescriptor) {
      throw new Error(`Step ${step.id}: discover and cite its exact operation before publishing a ready plan.`);
    }
    if (selectedDescriptor.effect === 'unknown' || selectedDescriptor.effect === 'host_only') throw new Error(`Step ${step.id}: this capability has no executable business effect.`);
    step.effect = selectedDescriptor.effect;
    const argumentBindings = [...step.dynamicBindings, ...(step.forEach?.bindings.map(binding => ({
      producerStepId: step.forEach!.producerStepId ?? step.id, outputPath: binding.itemPath, targetPath: binding.targetPath,
    })) ?? [])];
    let schema: Record<string, unknown>;
    let identity: unknown;
    let description: string | undefined;
    if (localDefinition) {
      const configured = await resolveConfiguredLocalPlanningTool(localDefinition.name, localDefinition.carrier);
      if (!configured?.parameters) throw new Error(`Step ${step.id}: local operation schema is unavailable.`);
      description = configured.description;
      // Zod attaches a non-enumerable ~standard adapter to its JSON Schema.
      // Freeze the documented JSON representation, not that runtime adapter.
      schema = JSON.parse(JSON.stringify(configured.parameters)) as Record<string, unknown>;
      identity = { kind: 'local_registry', definition: localDefinition, inputSchemaDigest: digestSchema(schema) };
      const parsedArguments = configured.argumentSchema?.safeParse(step.staticArguments);
      if (argumentBindings.length) validatePlanArgumentPreparation({ schema, staticArguments: step.staticArguments, dynamicBindings: argumentBindings,
        ...(parsedArguments ? { localIssues: parsedArguments.success ? [] : parsedArguments.error.issues } : {}) });
      else {
        const validation = parsedArguments ? { ok: true as const } : validateProofProviderArguments({ schema, payload: step.staticArguments });
        if (parsedArguments?.success === false || !validation.ok) throw new Error(`Step ${step.id}: static arguments do not match the exact local schema: ${JSON.stringify(parsedArguments?.success === false ? issueDetails(parsedArguments.error) : !validation.ok ? validation.failures : [])}. Repair those fields in this step; its selected local tool is already known.`);
      }
    } else {
      // ONE identity comparison, shared with Execute revalidation and call
      // admission. The catalog seals the provider schema digest for every
      // callable entry; publication records that identity and never fills it.
      const current = currentReviewedProviderIdentity(step.capabilityRef);
      const canonical = current.ok ? current.canonical : null;
      const mismatches = [
        !current.ok ? (current.reason === 'entry_missing' ? 'callable catalog entry is missing'
          : current.reason === 'entry_not_callable' ? 'catalog entry has no current callable attestation'
            : 'provider input schema is missing') : null,
        canonical && canonical.manifestDigest !== selectedDescriptor.manifestDigest ? 'manifest contract differs from the disclosed definition' : null,
        canonical && canonical.account !== selectedDescriptor.accountScope ? 'account differs from the disclosed account' : null,
      ].filter(Boolean);
      if (mismatches.length) throw new Error(`Step ${step.id}: ${mismatches.join('; ')}. This is a host capability identity mismatch, not an argument-formatting error.`);
      if (!current.ok || !canonical) throw new Error(`Step ${step.id}: provider identity unavailable.`);
      if (reviewedProviderIdentityMismatch(current, canonical as unknown as Record<string, unknown>) === 'schema_digest_mismatch') {
        throw new Error(`Step ${step.id}: provider schema changed after discovery.`);
      }
      schema = JSON.parse(closedCanonicalJson(current.schema, { ...SEALED_CALL_CANONICAL_LIMITS, omitUndefinedObjectMembers: true }));
      identity = canonical;
      if (argumentBindings.length) validatePlanArgumentPreparation({ schema, staticArguments: step.staticArguments, dynamicBindings: argumentBindings });
      const validation = !argumentBindings.length && validateProofProviderArguments({ schema, payload: step.staticArguments });
      if (validation && !validation.ok) throw new Error(`Step ${step.id}: ${canonical.operationId} input does not match the discovered schema: ${JSON.stringify(validation.failures)}. Repair those fields in this step. The selected tool and account are already known.`);
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    const dynamicallyBound = new Set(argumentBindings.map(binding => binding.targetPath.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~')));
    if (required.some(key => !Object.hasOwn(step.staticArguments, key) && !dynamicallyBound.has(key))) throw new Error(`Step ${step.id}: a required argument has neither a static value nor a producer binding.`);
    if (step.forEach?.items && !step.dynamicBindings.length) for (const item of step.forEach.items) {
      let args = bindReviewedCollectionItem(step.staticArguments, step.forEach, item);
      let validation = validateProofProviderArguments({ schema, payload: args });
      if (!validation.ok) {
        // A scalar bound where the schema wants a list of that scalar is a
        // shape the host already knows how to complete: wrap it in the
        // retained member record itself, so review, admission and execute
        // all read the same bytes. Anything else still refuses.
        const wrapped = completeScalarListMembers({ item, collection: step.forEach, failures: validation.failures });
        if (wrapped) {
          args = bindReviewedCollectionItem(step.staticArguments, step.forEach, item);
          validation = validateProofProviderArguments({ schema, payload: args });
        }
      }
      if (!validation.ok) throw new Error(`Step ${step.id}: collection member arguments fail ${JSON.stringify(validation.failures)}.`);
    }
    preparedDescriptors.set(step.id, selectedDescriptor);
    preparedBindings.push({ stepId: step.id, capabilityRef: step.capabilityRef, identity, inputSchema: schema,
      ...(description ? { description } : {}),
      argumentValidation: argumentBindings.length ? 'validate_after_bound_results' : 'static_schema_checked',
      source: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'preparation unavailable.';
      preparationIssues.push(message.startsWith(`Step ${step.id}:`) ? message : `Step ${step.id}: ${message}`);
    }
  }
  // Producer effects are derived inside the loop above, so the collection
  // check runs after it; it joins the same single preparation response.
  for (const step of outline.steps) if (step.forEach?.producerStepId) {
    const producer = steps.get(step.forEach.producerStepId)!;
    if (!producer.forEach && producer.effect !== 'read') preparationIssues.push(`Step ${step.id}: a new collection requires a complete read. Repeated producers keep their existing reviewed member IDs; they do not infer new members from a write. ${collectionProducerRepair(step.id, producer.id, step.forEach)}`);
  }
  if (input.ready && preparationIssues.length) throw new Error(preparationIssues.join('\n'));
  const executionDraft = (preparationIssues.length === 0 && toolSteps.some(step => step.forEach || ['local_write', 'external_write', 'admin'].includes(step.effect))
    ? deriveExecutionDraft(outline, preparedDescriptors) : null);
  return JSON.parse(closedCanonicalJson({ ...outline, executionDraft, preparedBindings, preparationIssues }, SEALED_CALL_CANONICAL_LIMITS)) as PlanStructuredOutline;
}

/** Compile the duplicate tracking representation from reviewed steps and host
 * contracts. No task prose, guessed capability, new effect, or account enters
 * this projection. The full outline remains the immutable Execute contract. */
function deriveExecutionDraft(
  outline: z.infer<typeof PlanPreparationSchema>,
  descriptors: ReadonlyMap<string, HostCapabilityDescriptorV1>,
): z.infer<typeof FreshActionPlanDraftSchema> {
  const toolSteps = outline.steps.filter(step => step.capabilityRef !== null);
  const steps = new Map(outline.steps.map(step => [step.id, step]));
  const toolDependencies = (ids: readonly string[]): string[] => [...new Set(ids.flatMap(id => {
    const step = steps.get(id)!;
    return step.capabilityRef ? [id] : toolDependencies(step.dependsOn);
  }))];
  const writes = toolSteps.filter(step => ['local_write', 'external_write', 'admin'].includes(step.effect));
  const destination = writes.map(step => descriptors.get(step.id)!).find(row => row.destinationPosture);
  return FreshActionPlanDraftSchema.parse({
    criteria: outline.successCriteria,
    cardinality: null,
    destination: destination ? { posture: destination.destinationPosture,
      family: destination.deliverableKind, handleRequired: destination.handleRequired } : null,
    topology: { version: 1, universes: toolSteps.filter(step => step.forEach && reviewedCollectionRoot(step.id, steps) === step.id).map(step => {
      const collection = step.forEach!;
      return collection.items ? { id: planCollectionUniverseId(step.id), seal: 'accepted_input', members: reviewedCollectionMembers(collection, collection.items).map(member => member.id) }
        : { id: planCollectionUniverseId(step.id), seal: 'complete_source_receipt', producedBy: collection.producerStepId, memberIdPointer: collection.memberIdPath };
    }), operations: toolSteps.map(step => ({
      id: step.id, effect: step.effect, coverage: step.effect === 'read' ? (!step.forEach && toolSteps.some(consumer => consumer.forEach?.producerStepId === step.id) ? 'complete_set' : 'single') : null,
      dependsOn: toolDependencies(step.dependsOn),
      // dataFrom promises exact tool-result lineage. Synthesis is authored
      // content with its own durable reviewed result, not a copy of the raw
      // research ancestor. Keep ordering above; enforce its fields at the
      // reviewed call boundary instead of claiming tool-byte provenance.
      dataFrom: [...new Set([...step.dynamicBindings.map(binding => binding.producerStepId)
        .filter(id => steps.get(id)!.capabilityRef !== null), ...(step.forEach?.producerStepId ? [step.forEach.producerStepId] : [])])],
      cardinality: step.forEach ? { kind: 'each', universeId: planCollectionUniverseId(reviewedCollectionRoot(step.id, steps)) } : { kind: 'once' },
    })) },
    bindings: toolSteps.map(step => ({ operationId: step.id, role: step.id,
      capabilityRef: step.capabilityRef, evidence: [...descriptors.get(step.id)!.evidenceKinds] })),
    deliverables: writes.map(step => ({ id: step.id, kind: descriptors.get(step.id)!.deliverableKind })),
    evidenceRequirements: [...new Set(toolSteps.flatMap(step => [...descriptors.get(step.id)!.evidenceKinds]))],
  });
}

export function buildPublishPlanTool(planning?: HostFreshPlanningContextV1) {
  return tool({
    name: 'publish_plan',
    description: 'Publish the investigated plan for user review without executing it. For a ready plan supply full_text and structured_plan. If a user decision is missing, publish the partial plan and specific question in full_text with readiness needs_input; structured_plan may be omitted until the answer makes preparation useful. Do not invent bindings or a full graph merely to ask a question. Each executable step needs id, action, verification and, for a tool, its discovered capabilityRef plus staticArguments as an ordinary JSON object. The host derives tool effects, accounts, schemas, the execution graph and evidence contract. Omit unused lists and nulls. Assign subagents in either the steps or the role stepIds; do not repeat both. Use compute for synthesis and describe any conditional read-only investigation in its action; Execute can follow those sources before plan_step_result records the actual output. Graph dependencies require successful results, so a lookup allowed to fail or be absent belongs in that investigation method, not in mandatory dependencies. Indispensable reads remain required graph steps. Dynamic bindings use settled producer values; an empty outputPath passes the whole retained inner tool value, without a carrier wrapper. For text this is the string itself, not an object with output or content fields. For repeated work use forEach with known items or a reviewed read producerStepId, a memberIdPath and item-to-argument bindings. A repeated producer returns records {memberId,result}; a repeated consumer preserves /memberId and binds values under /result. For interpretation or reshaping, use a compute step and bind its output into the next tool input or batch array. Execute each member with the step requirement_id and that member’s universe_item_id; universe_selector can be omitted. Unresolved owner decisions use readiness needs_input. After a preparation failure, use the returned draft_digest and step_patches to correct only affected steps. base_ref_json selects an exact prior {planId,revision,digest} only for an explicit revision. Execute selects the complete saved artifact.',
    parameters: z.toJSONSchema(PlanPublicationInputSchema, { unrepresentable: 'any', io: 'input' }) as any,
    strict: false,
    errorFunction: (_context, error) => publicationError(error),
    execute: async input => {
      const args = PlanPublicationInputSchema.parse(input);
      const context = harnessRunContextStorage.getStore();
      if (!context?.sessionId || !context.sourceUserSeq || context.workerScope) throw new Error('Only the exact foreground Plan turn can publish a reviewed plan.');
      const source = acceptedTaskModeIdentity(context.sessionId, context.sourceUserSeq);
      if (source.mode?.kind !== 'plan') throw new Error('publish_plan requires explicit Plan mode.');
      const assertActive = (): void => {
        currentToolAbortSignal()?.throwIfAborted();
        if (context.dispatchLease) assertDispatchLeaseCurrent(context.dispatchLease);
      };
      assertActive();
      const retained = getPlanRevisionForSource({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
        principalId: source.principalId });
      if (retained) return publicationReceipt(retained, true);
      let draft: { fullText: string; baseRefJson: string | null; raw: unknown };
      // A complete outline is authoritative whenever it is supplied. A model
      // that pairs a full plan with the retained digest is handing the host
      // the bytes it wants published; refusing that as a malformed repair only
      // cost a round trip (live 2026-09-15 22:52).
      const fullSubmission = Boolean(args.full_text && args.structured_plan);
      if (!fullSubmission && (args.draft_digest || args.step_patches)) {
        if (!args.draft_digest) throw new Error('Draft repair requires the exact draft_digest returned with the retained draft.');
        draft = applyPlanDraftPatches(loadRetainedPlanDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: args.draft_digest }),
          { ...args, structured_plan: undefined, step_patches: args.step_patches ?? [] });
      } else {
        if (!args.full_text || (!args.structured_plan && args.readiness !== 'needs_input')) throw new Error('A ready plan requires full_text and structured_plan. For an unresolved user question, publish full_text with readiness needs_input; the executable outline can wait.');
        const completedIds = args.structured_plan ? completedPlanStepIds(args.structured_plan) : [];
        if (completedIds.length > 0) {
          try {
            appendEvent({ sessionId: context.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: {
              kind: 'plan_step_id_completed', sourceUserSeq: context.sourceUserSeq, steps: completedIds,
            } });
          } catch { /* advisory */ }
        }
        draft = { fullText: args.full_text, baseRefJson: args.base_ref_json,
          raw: args.structured_plan ? decodePublishedPlanOutline(args.structured_plan) : null };
      }
      // An honest question does not need a guessed executable graph. This
      // empty preparation has no effects or bindings and cannot be executed;
      // the existing ready-revision contract still owns that transition.
      let structuredPlan: PlanStructuredOutline;
      if (draft.raw === null) {
        structuredPlan = { steps: [], successCriteria: [], subagents: [], executionDraft: null, preparedBindings: [], preparationIssues: [] };
      } else {
        const decoded = PlanPreparationSchema.parse(draft.raw);
        try {
          structuredPlan = await preparePlanOutline({ planning, sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, raw: decoded, ready: false });
        } catch (error) {
          assertActive();
          const message = error instanceof Error ? error.message : 'Plan preparation failed.';
          const digest = retainPlanPreparationDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
            fullText: draft.fullText, baseRefJson: draft.baseRefJson,
            structuredPlan: JSON.parse(closedCanonicalJson({ ...decoded, executionDraft: decoded.executionDraft ?? null,
              preparedBindings: [], preparationIssues: [message] }, SEALED_CALL_CANONICAL_LIMITS)) as PlanStructuredOutline });
          throw new RetainedPlanPreparationError(message, digest);
        }
      }
      assertActive();
      // Metadata preparation awaits. A concurrently repaired draft must still
      // be the exact one this patch selected before any synchronous commit.
      if (args.draft_digest && !fullSubmission) loadRetainedPlanDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: args.draft_digest });
      if (args.readiness === 'ready' && (structuredPlan.preparationIssues as string[]).length) {
        const digest = retainPlanPreparationDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
          fullText: draft.fullText, structuredPlan, baseRefJson: draft.baseRefJson });
        throw new RetainedPlanPreparationError((structuredPlan.preparationIssues as string[]).join('\n'), digest);
      }
      // Review this candidate, not a pending advisory about an earlier draft.
      const candidate = { fullText: draft.fullText, structuredPlan, readiness: args.readiness,
        missingPrerequisites: [...new Set([...args.missing_prerequisites, ...(structuredPlan.preparationIssues as string[])])] };
      // PLAN IS BEST EFFORT. The completion reviewer catches a plan that
      // cannot execute; it must not hold a structurally sound plan hostage to
      // wording. Two send-backs on one source are the budget: the third
      // candidate publishes, and the reviewer's last note rides along as
      // advisory (the Execute judge still measures the output).
      const priorReviewRounds = listEvents(context.sessionId, { types: ['goal_alignment_judged'] })
        .filter(event => event.data.sourceUserSeq === context.sourceUserSeq && event.data.fulfills === false).length;
      const review = priorReviewRounds >= PLAN_REVIEW_SEND_BACK_BUDGET ? 'done' : await reviewPlanForPublication(candidate);
      assertActive();
      if (priorReviewRounds >= PLAN_REVIEW_SEND_BACK_BUDGET) {
        try {
          appendEvent({ sessionId: context.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: {
            kind: 'plan_review_budget_spent', sourceUserSeq: context.sourceUserSeq, rounds: priorReviewRounds,
          } });
        } catch { /* advisory */ }
      }
      if (review === 'continue') {
        const digest = retainPlanPreparationDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
          fullText: draft.fullText, structuredPlan, baseRefJson: draft.baseRefJson });
        return JSON.stringify({ ok: true, published: false, status: 'review_feedback', draft_digest: digest,
          message: 'The selected completion reviewer found a gap in this complete plan. The complete draft is retained. For existing steps, use draft_digest and step_patches [{step_id, changes}]; omit full_text to preserve it. If supplying full_text, include the entire revised plan, not a change note. To add, remove or reorder steps, submit full_text and the complete structured_plan without draft_digest and step_patches. Apply the review without changing the objective or replacing discovered dependencies with guesses. Nothing has executed.' });
      }
      if (args.draft_digest && !fullSubmission) loadRetainedPlanDraft({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: args.draft_digest });
      const routed = listEvents(context.sessionId, { types: ['turn_model_routed'] }).filter(event => event.data.sourceUserSeq === context.sourceUserSeq).at(-1);
      // A base revision this conversation cannot see (a plan recalled from an
      // unrelated earlier conversation) is not a revision to append to: the
      // model is describing new work in this conversation. Publish it as a new
      // plan instead of refusing the whole publication (live 2026-09-15 23:11).
      let baseRefJson = draft.baseRefJson;
      if (baseRefJson) {
        try {
          getPlanRevision({ sessionId: context.sessionId, principalId: source.principalId, ref: parsePlanRevisionRef(JSON.parse(baseRefJson)) });
        } catch {
          try {
            appendEvent({ sessionId: context.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: {
              kind: 'plan_base_ref_dropped', sourceUserSeq: context.sourceUserSeq, baseRefJson: baseRefJson.slice(0, 400),
            } });
          } catch { /* advisory */ }
          baseRefJson = null;
        }
      }
      const artifact = publishPlanRevision({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, principalId: source.principalId,
        ...candidate,
        ...(typeof routed?.data.model === 'string' ? { authorModelId: routed.data.model } : {}),
        ...(baseRefJson ? { base: parsePlanRevisionRef(JSON.parse(baseRefJson)) } : {}) });
      return publicationReceipt(artifact);
    },
  });
}
