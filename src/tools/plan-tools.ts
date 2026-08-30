import { createHash } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import type {
  HostCapabilityDescriptorV1,
  TurnSemanticProposalV1,
} from '../runtime/semantic-boundary/turn-semantic-proposal.js';
import type { TurnGraphIR } from '../runtime/graph/turn-graph-ir.js';
import {
  admitAndCompilePrimaryModelProposal,
  snapshotPrimaryModelPlanningContext,
  type HostFreshPlanningContextV1,
} from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { requireAcceptedTaskAuthority } from '../runtime/harness/accepted-task-authority.js';
import {
  freezePrimaryModelExpectedWorkContract,
  prepareActionExpectedWorkContract,
} from '../runtime/harness/expected-work-contract.js';
import { hostDurableConversationPreambleDelivery } from '../runtime/harness/durable-conversation-preamble.js';
import { actionExpectedWorkRequired } from '../runtime/harness/expected-work-admission.js';
import {
  appendConversationPreambleOnce,
  conversationPreambleDeliveryRequest,
  listEvents,
} from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { currentLogicalCall } from '../runtime/harness/attempt-identity.js';
import { recordPlanTaskPreambleDelivery } from '../runtime/harness/plan-task-post-settlement.js';
import { bindAdmittedNodeCapability } from '../runtime/harness/graph-node-capability.js';
import {
  freezeCatalogSnapshotForSource,
  canonicalCatalogIdentityOf,
  persistSealedNodeBinding,
  sealBoundCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  deriveMutationVerificationRecipe,
  parseOperationVerificationContract,
} from '../runtime/harness/mutation-verification-contract.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
} from '../runtime/harness/local-planning-capability.js';
import { requestedCapabilityEffectScope } from '../memory/capability-effect-scope.js';
import { uniqueWorkflowRunRequest } from './named-workflow-match.js';
import {
  accountSelectionForCitedWrite,
  thisTurnSearchAccountSelectionBlockers,
} from './tool-search-provider-sources.js';
import {
  ActionWorkTopologySchema,
  WorkTopologyIdSchema,
  validateWorkTopology,
  workTopologyDigest,
  type WorkTopologyEffectV1,
  type WorkTopologyV1,
} from '../runtime/graph/work-topology.js';

const MAX_PREAMBLE_CHARS = 1_000;

const PlanId = WorkTopologyIdSchema;

const PlanOperationBindingSchema = z.object({
  operationId: PlanId,
  /** Capability role and proof annotations bind an operation id; structural
   * effect, dependency, coverage, and cardinality live only in topology. */
  role: PlanId,
  capabilityRef: PlanId,
  evidence: z.array(PlanId).max(32),
}).strict();

/** Compact model-authored delta. Accepted-source identity, relation, goal
 * target, candidate list, open slots, proposal version, and rationale are all
 * host-derived, so paying to retransmit them on every plan was pure ceremony. */
export const FreshActionPlanDraftSchema = z.object({
  criteria: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  cardinality: z.object({
    count: z.number().int().min(1).max(10_000),
    fields: z.array(PlanId).max(32),
  }).strict().nullable(),
  destination: z.object({
    posture: z.enum(['create_new', 'named_existing']),
    family: PlanId,
    handleRequired: z.boolean(),
  }).strict().nullable(),
  topology: ActionWorkTopologySchema,
  bindings: z.array(PlanOperationBindingSchema).min(1).max(32),
  deliverables: z.array(z.object({ id: PlanId, kind: PlanId }).strict()).max(32),
  evidenceRequirements: z.array(PlanId).max(32),
}).strict().superRefine((draft, ctx) => {
  const bindingIds = draft.bindings.map((binding) => binding.operationId);
  if (new Set(bindingIds).size !== bindingIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindings'],
      message: 'operation bindings must be unique',
    });
  }
  const operationIds = draft.topology.operations.map((operation) => operation.id);
  const bindingSet = new Set(bindingIds);
  if (
    operationIds.length !== bindingIds.length
    || operationIds.some((id) => !bindingSet.has(id))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindings'],
      message: 'bindings must cover every canonical topology operation exactly once',
    });
  }
});

export const PlanTaskInputSchema = z.object({
  preamble: z.string().min(1).max(MAX_PREAMBLE_CHARS).describe(
    'One brief conversational acknowledgement shown immediately before work. It must state the concrete reading, make no completion claim, and ask no question.',
  ),
  draft: FreshActionPlanDraftSchema.describe(
    'Provider-neutral action topology. Cite only exact capabilityRef ids from the planning card or a tool_search result.',
  ),
}).strict();

export type PlanTaskInput = z.infer<typeof PlanTaskInputSchema>;

/** Deterministic host projection for the sole-action Auto lane. It carries no
 * authority of its own: the returned bytes are invoked through the configured
 * plan_task tool, whose ordinary source/catalog/admission/seal path remains
 * the only graph/work-contract compiler. Compound work is intentionally not
 * representable here. */
export function hostSingleActionPlanTaskInput(input: {
  capabilityRef: string;
  operationId: string;
  effect: 'local_write' | 'external_write';
  descriptor: HostCapabilityDescriptorV1;
}): PlanTaskInput | null {
  if (
    input.capabilityRef !== input.descriptor.id
    || input.effect !== input.descriptor.effect
    || input.capabilityRef !== input.capabilityRef.trim()
    || input.operationId !== input.operationId.trim()
  ) return null;
  const deliverableId = `auto_deliverable_${createHash('sha256')
    .update(`${input.capabilityRef}\0${input.operationId}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
  const candidate = {
    preamble: 'I’ll carry out that exact requested action now.',
    draft: {
      criteria: ['Complete the accepted request with one exact action and retain its durable result.'],
      cardinality: null,
      destination: input.descriptor.destinationPosture
        ? {
            posture: input.descriptor.destinationPosture,
            family: input.descriptor.deliverableKind,
            handleRequired: input.descriptor.handleRequired,
          }
        : null,
      topology: {
        version: 1 as const,
        operations: [{
          id: input.capabilityRef,
          effect: input.effect,
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' as const },
        }],
        universes: [],
      },
      bindings: [{
        operationId: input.capabilityRef,
        role: input.descriptor.destinationPosture ? 'destination' : 'action',
        capabilityRef: input.capabilityRef,
        evidence: [...input.descriptor.evidenceKinds],
      }],
      deliverables: [{
        id: deliverableId,
        kind: input.descriptor.deliverableKind,
      }],
      evidenceRequirements: [...input.descriptor.evidenceKinds],
    },
  };
  const parsed = PlanTaskInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function settledPreamble(raw: string): string {
  const text = raw.trim();
  if (!text || text.length > MAX_PREAMBLE_CHARS) {
    throw new Error('plan_task requires one bounded conversational preamble');
  }
  if (text.includes('?')) {
    throw new Error('plan_task preamble must be settled and must not ask a question');
  }
  return text;
}

function planningCatalogText(capabilities: readonly HostCapabilityDescriptorV1[]): string {
  if (capabilities.length === 0) {
    return '(The initial planning card had no exact capability descriptors. Use foreground tool_search; cite only exact capabilityRef values it returns.)';
  }
  return JSON.stringify(capabilities.map((capability) => ({
    capabilityRef: capability.id,
    effect: capability.effect,
    purpose: capability.purpose,
    acceptedInputKinds: capability.acceptedInputKinds,
    producedOutputKinds: capability.producedOutputKinds,
    applicableDeliverableKinds: capability.applicableDeliverableKinds,
    destinationPosture: capability.destinationPosture,
    deliverableKind: capability.deliverableKind,
  })));
}

const PLAN_REFUSAL_REPAIR_CAP = 8;

const PLAN_WRITE_EFFECTS = new Set<WorkTopologyEffectV1>([
  'local_write',
  'external_write',
  'admin',
]);

/**
 * A model-authored effect label is not authority. A draft contains a write
 * only when the operation is bound to an exact currently disclosed capability
 * whose host-attested effect matches that operation's write effect.
 */
export function planDraftHasHostAttestedWrite(input: {
  draft: Pick<PlanTaskInput['draft'], 'topology' | 'bindings'>;
  capabilities: readonly HostCapabilityDescriptorV1[];
}): boolean {
  const capabilityEffects = new Map(
    input.capabilities.map((capability) => [capability.id, capability.effect] as const),
  );
  const boundRefs = new Map(
    input.draft.bindings.map((binding) => [binding.operationId, binding.capabilityRef] as const),
  );
  return input.draft.topology.operations.some((operation) => (
    PLAN_WRITE_EFFECTS.has(operation.effect)
    && capabilityEffects.get(boundRefs.get(operation.id) ?? '') === operation.effect
  ));
}

/**
 * A refused proposal must not make the model rediscover authority the host
 * already disclosed.  These rows are a bounded projection of the exact live
 * planning catalog; they grant nothing and carry no schema/account bytes.
 */
function planningRefusalRepairCatalog(
  capabilities: readonly HostCapabilityDescriptorV1[],
  preferredRefs: ReadonlySet<string> = new Set(),
): Array<{
  capabilityRef: string;
  effect: HostCapabilityDescriptorV1['effect'];
  purpose: string;
}> {
  return [...capabilities]
    .sort((left, right) => (
      Number(preferredRefs.has(right.id)) - Number(preferredRefs.has(left.id))
    ))
    .slice(0, PLAN_REFUSAL_REPAIR_CAP)
    .map((capability) => ({
      capabilityRef: capability.id,
      effect: capability.effect,
      purpose: capability.purpose,
    }));
}

function requestedEffectOf(
  effects: readonly WorkTopologyEffectV1[],
): WorkTopologyEffectV1 {
  const order = ['read', 'compute', 'local_write', 'external_write', 'admin'] as const;
  return order.reduce((highest, effect) => (
    effects.includes(effect) && order.indexOf(effect) > order.indexOf(highest) ? effect : highest
  ), 'read');
}

async function sealFreshPlanCapabilityBindings(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  acceptedText: string;
  graph: TurnGraphIR;
  operationIds: readonly string[];
  workContractId: string;
}): Promise<{ ok: true; unverifiedMutations: string[] } | { ok: false; reason: string }> {
  const frozen = freezeCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (!frozen.ok) return { ok: false, reason: `frozen catalog ${frozen.reason}` };
  const operationIds = new Set(input.operationIds);
  const nodes = input.graph.nodes.filter((node) => operationIds.has(node.id));
  if (
    nodes.length !== operationIds.size
    || [...operationIds].some((operationId) => !nodes.some((node) => node.id === operationId))
  ) return { ok: false, reason: 'the accepted graph does not contain every business operation exactly once' };
  const unverifiedMutations: string[] = [];
  const sealed = await Promise.all(nodes.map(async (node) => {
    const refs = node.capabilities
      ?.filter((requirement) => requirement.kind === 'tool' && requirement.resolution === 'explicit')
      .flatMap((requirement) => requirement.names ?? [])
      ?? [];
    const localRef = refs.length === 1 && refs[0]!.startsWith('cap:local:')
      ? refs[0]!
      : null;
    let bound: ReturnType<typeof bindAdmittedNodeCapability>;
    if (localRef) {
      const local = await loadDurableAuthorizedLocalPlanningDefinition({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        capabilityRef: localRef,
      });
      if (!local.ok) return null;
      const definition = local.definition;
      const descriptor = definition.descriptor;
      bound = bindAdmittedNodeCapability({
        node,
        graph: input.graph,
        identity: {
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
        },
        acceptedText: input.acceptedText,
        // Local planning refs deliberately do not become provider-catalog
        // entries: their source-bound durable definition is the exact
        // authority, and this read revalidates its configured schema and
        // registry semantics again after graph persistence. Adapt only that
        // single revalidated ref into the common binder; every non-local ref
        // must still resolve through the immutable frozen host catalog above.
        catalog: {
          bind: (request) => {
            const requestedRefs = request.node.capabilities
              ?.filter((requirement) => requirement.kind === 'tool' && requirement.resolution === 'explicit')
              .flatMap((requirement) => requirement.names ?? [])
              ?? [];
            if (
              requestedRefs.length !== 1
              || requestedRefs[0] !== definition.capabilityRef
            ) return null;
            return {
              capabilityId: definition.capabilityRef,
              toolName: definition.name,
              schemaVersion: String(definition.version),
              schemaDigest: definition.envelopeFingerprint,
              args: { capabilityId: definition.capabilityRef },
              account: definition.accountIdentity,
              effect: descriptor.effect,
              ...(descriptor.destinationPosture
                ? {
                    destination: {
                      family: descriptor.deliverableKind,
                      posture: descriptor.destinationPosture,
                    },
                  }
                : {}),
              manifestDigest: descriptor.manifestDigest,
              providerKind: 'local_registry',
              liveFingerprint: definition.envelopeFingerprint,
              invoke: async () => {
                throw new Error('local planning selection seals identity only; work_call owns invocation');
              },
            };
          },
        },
      });
    } else {
      bound = bindAdmittedNodeCapability({
        node,
        graph: input.graph,
        identity: {
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
        },
        acceptedText: input.acceptedText,
        catalog: frozen.catalog,
      });
    }
    if (!bound.ok) return null;
    const operationVerification = parseOperationVerificationContract(
      bound.binding.manifest?.externalDefinition?.verification,
    );
    const sealedBinding = sealBoundCapability({
      nodeId: node.id,
      binding: bound.binding,
      // This is a capability-selection seal, not invocation identity. The
      // same host-owned projection is used by the admitted graph executor.
      argumentDigest: createHash('sha256').update(JSON.stringify({
        nodeId: node.id,
        capabilityId: bound.binding.capabilityId,
      }), 'utf8').digest('hex'),
      ...(operationVerification && 'mutation' in operationVerification
        ? {
            verification: (baseBindingDigest: string) => {
              if (!bound.ok || !bound.binding.manifest) return null;
              const derived = deriveMutationVerificationRecipe({
                acceptedTaskId: input.acceptedTaskId,
                workContractId: input.workContractId,
                ownerRequirementId: node.id,
                ownerBindingDigest: baseBindingDigest,
                mutation: bound.binding.manifest,
                catalog: frozen.entries,
                canonicalIdentityOf: canonicalCatalogIdentityOf,
              });
              if (!derived.ok) return null;
              return derived.recipe;
            },
          }
        : {}),
    });
    if (operationVerification && 'mutation' in operationVerification && !sealedBinding.verification) {
      // Slice 2: a missing host-derived recipe is an obligation, not a
      // plan refusal. The write seam reports "wrote, could not verify".
      unverifiedMutations.push(node.id);
    }
    return sealedBinding;
  }));
  if (sealed.some((binding) => binding === null)) {
    return { ok: false, reason: 'one or more selected graph capabilities could not be sealed' };
  }
  const persisted = sealed.every((binding) => persistSealedNodeBinding({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    binding: binding!,
  }));
  return persisted
    ? { ok: true, unverifiedMutations }
    : { ok: false, reason: 'one or more sealed graph capabilities conflicted with durable state' };
}

export function derivePlanConstructFromTopology(
  topology: WorkTopologyV1,
): 'collect_then_construct' | 'fanout' | 'single_act' {
  if (topology.operations.some((operation) => operation.cardinality.kind === 'each')) {
    return 'fanout';
  }
  const byId = new Map(topology.operations.map((operation) => [operation.id, operation]));
  const reachesRead = (operationId: string, seen = new Set<string>()): boolean => {
    if (seen.has(operationId)) return false;
    seen.add(operationId);
    const operation = byId.get(operationId);
    if (!operation) return false;
    if (operation.effect === 'read') return true;
    return operation.dataFrom.some((source) => reachesRead(source, seen));
  };
  if (topology.operations.some((operation) => (
    (operation.effect === 'local_write'
      || operation.effect === 'external_write'
      || operation.effect === 'admin')
    && operation.cardinality.kind === 'once'
    && operation.dataFrom.some((source) => reachesRead(source))
  ))) return 'collect_then_construct';
  return 'single_act';
}

export type CollectConstructLineageCompleteness =
  | { ok: true }
  | { ok: false; writeOperationIds: string[]; sourceOperationIds: string[] };

/** A non-null collection contract plus a concrete destination is the draft's
 * provider-neutral claim that collected records will be constructed into an
 * artifact. `dependsOn` remains ordering only. For each once-write ordered
 * after a read, the model must separately name a dataFrom chain that reaches a
 * read; the host validates that judgment but never guesses an edge. */
export function collectConstructLineageCompleteness(
  draft: Pick<z.infer<typeof FreshActionPlanDraftSchema>, 'cardinality' | 'destination' | 'topology'>,
): CollectConstructLineageCompleteness {
  if (draft.cardinality === null || draft.destination === null) return { ok: true };
  const topology = validateWorkTopology(draft.topology);
  if (!topology.ok) return { ok: true }; // the canonical schema/admission reports these errors
  const byId = new Map(topology.topology.operations.map((operation) => [operation.id, operation]));
  const reachesReadThrough = (
    operationId: string,
    edge: 'dependsOn' | 'dataFrom',
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(operationId)) return false;
    seen.add(operationId);
    const operation = byId.get(operationId);
    if (!operation) return false;
    if (operation.effect === 'read') return true;
    return operation[edge].some((next) => reachesReadThrough(next, edge, seen));
  };
  const writeOperations = topology.topology.operations.filter((operation) => (
    (operation.effect === 'local_write'
      || operation.effect === 'external_write'
      || operation.effect === 'admin')
    && operation.cardinality.kind === 'once'
    && operation.dependsOn.some((dependency) => reachesReadThrough(dependency, 'dependsOn'))
  ));
  const missing = writeOperations.filter((operation) => (
    !operation.dataFrom.some((source) => reachesReadThrough(source, 'dataFrom'))
  ));
  if (missing.length === 0) return { ok: true };
  const sourceOperationIds = topology.topology.operations
    .filter((operation) => operation.effect === 'read')
    .map((operation) => operation.id)
    .sort();
  return {
    ok: false,
    writeOperationIds: missing.map((operation) => operation.id).sort(),
    sourceOperationIds,
  };
}

function proposalFromDraft(input: {
  objective: string;
  draft: z.infer<typeof FreshActionPlanDraftSchema>;
}): TurnSemanticProposalV1 {
  const validatedTopology = validateWorkTopology(input.draft.topology);
  if (!validatedTopology.ok) {
    throw new Error(`plan_task topology is invalid: ${validatedTopology.errors.join('; ')}`);
  }
  const topology = validatedTopology.topology;
  const bindingById = new Map(input.draft.bindings.map((binding) => [binding.operationId, binding]));
  const capabilityRefs = [...new Set(input.draft.bindings.map((binding) => binding.capabilityRef))];
  const destination = input.draft.destination ? { ...input.draft.destination } : null;
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: input.objective,
      criteria: input.draft.criteria.map((statement, index) => ({
        id: `criterion_${index + 1}`,
        statement,
      })),
      openSlots: [],
      candidates: capabilityRefs.map((id) => ({ kind: 'capability' as const, id })),
    },
    work: {
      construct: derivePlanConstructFromTopology(topology),
      cardinality: input.draft.cardinality ? { ...input.draft.cardinality } : null,
      destinations: destination ? [{ ...destination }] : null,
      destination,
      requestedEffect: requestedEffectOf(topology.operations.map((operation) => operation.effect)),
      // Keep the strict model representation (coverage:null on non-reads) in
      // the hash-bound proposal. Admission normalizes it once before the graph.
      topology: input.draft.topology,
      topologyHash: workTopologyDigest(topology),
      operations: topology.operations.map((operation) => ({
        id: operation.id,
        role: bindingById.get(operation.id)!.role,
        requestedEffect: operation.effect,
        capabilityRef: bindingById.get(operation.id)!.capabilityRef,
        dependsOn: [...operation.dependsOn],
        evidence: [...bindingById.get(operation.id)!.evidence],
      })),
      deliverables: input.draft.deliverables.map((deliverable) => ({ ...deliverable })),
      evidenceRequirements: [...input.draft.evidenceRequirements],
    },
    slotAnswers: [],
    rationale: 'Foreground model action draft admitted against exact current-turn host disclosures.',
  };
}

/**
 * Turn a verifier refusal into something a model can act on in ONE step.
 *
 * Every external write must be provable, so a mutation needs a partner read
 * that reads it back. The partner is looked for only among capabilities staged
 * for THIS turn, so a model that discovered the write but not the readback is
 * refused — through no fault of its own, because nothing ever told it a
 * readback was required.
 *
 * The old repair ("select an exact current capability set whose host-declared
 * verifier recipe can be frozen") names nothing searchable, so the model has to
 * guess. The refusal now carries the resource family and handle kind, which are
 * exactly the two facts that decide a match, so the instruction can say what to
 * search for. That is what makes this recoverable on a small model: an ordinary
 * "put these in a sheet" should not require inferring the harness's proof rules.
 */
function verifierRepairInstruction(reason: string): string | null {
  if (!reason.startsWith('verification_successor_required:')) return null;
  const family = /:family=([^:]+)/.exec(reason)?.[1];
  const handle = /:handle=([^:]+)/.exec(reason)?.[1];
  const ambiguous = reason.includes(':ambiguous_compatible_verifier:');
  if (ambiguous) {
    return 'Several disclosed read operations could verify this write, so the host cannot choose. '
      + 'Cite exactly one of them alongside the write in the same plan.';
  }
  if (!family || !handle) {
    return 'This write must be paired with a read operation that reads it back. Run one tool_search '
      + 'for a read on the same provider and account that returns the written record, cite it in the '
      + 'same plan as the write, then call plan_task again.';
  }
  return `This write must be paired with a read that verifies it. Run one tool_search for a READ `
    + `operation on the same provider and account that reads back a "${family}" and accepts a `
    + `"${handle}" handle, then cite BOTH that read and the write in the same plan and call `
    + `plan_task again. The write cannot be admitted alone.`;
}

function priorAcceptedSourceTexts(sessionId: string, sourceUserSeq: number): string[] {
  try {
    return listEvents(sessionId, { types: ['user_input_received'] })
      .filter((event) => event.seq < sourceUserSeq)
      .map((event) => {
        const display = typeof event.data.displayText === 'string' ? event.data.displayText.trim() : '';
        const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
        return display || text;
      })
      .filter((text) => text.length > 0);
  } catch {
    return [];
  }
}

async function executePlanTask(
  input: PlanTaskInput,
  planning?: HostFreshPlanningContextV1,
): Promise<string> {
  const context = harnessRunContextStorage.getStore();
  if (
    !context
    || !context.sessionId
    || !Number.isSafeInteger(context.sourceUserSeq)
    || (context.sourceUserSeq ?? 0) <= 0
    || !Number.isSafeInteger(context.turn)
  ) {
    throw new Error('plan_task requires the exact active accepted-source context');
  }
  if (!planning) throw new Error('plan_task requires a host-minted current-turn planning catalog');
  const sessionId = context.sessionId;
  const sourceUserSeq = context.sourceUserSeq as number;
  const preamble = settledPreamble(input.preamble);

  const source = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === sourceUserSeq);
  if (!source) throw new Error('plan_task accepted source disappeared before admission');
  // The identity triple describes the ACCEPTED SOURCE, and the persist layer
  // validates it by comparing this turn against the source row's own turn
  // (turn-graph-shadow.ts: `source.turn !== input.identity.turn` =>
  // `source_missing`). The run context's `turn` is the turn being EXECUTED,
  // which only coincides on the first turn of a session — a follow-up runs as
  // turn N while its accepted source is still stamped with the turn that was
  // open when it arrived. Passing the executing turn therefore made every
  // multi-turn plan report its own source as missing, three lines after this
  // function successfully loaded that exact row. Measured on the live store:
  // all 20 admissions ever had source.turn === executing turn; 118 refusals
  // had them differ, and not one plan has ever admitted on a follow-up turn.
  const turn = source.turn;
  const display = typeof source.data.displayText === 'string' ? source.data.displayText.trim() : '';
  const eventText = typeof source.data.text === 'string' ? source.data.text.trim() : '';
  const objective = display || eventText;
  if (!objective) throw new Error('plan_task accepted source text is missing');
  const uniqueWorkflow = uniqueWorkflowRunRequest(
    objective,
    priorAcceptedSourceTexts(sessionId, sourceUserSeq),
  );
  if (uniqueWorkflow) {
    // OPEN-THE-GATES C2/C: a uniquely named workflow is invoked with
    // workflow_run. plan_task here sent GLM into admission, then she
    // workflow_get'd three times and invented a host-gate refusal
    // (sess-desktop-ca4779, zero workflow_run calls).
    return JSON.stringify({
      ok: false,
      code: 'plan_not_required',
      detail: 'this accepted request uniquely names an existing workflow; call workflow_run with that exact name',
      workflowName: uniqueWorkflow.name,
      repair: `Call workflow_run with name "${uniqueWorkflow.name}". Do not plan_task. Do not workflow_get unless the user asked to inspect the definition.`,
    });
  }
  // Change 2: a check may refuse only if the missing fact is outside the
  // host. Two connected Outlook mailboxes is that fact. tool_search already
  // returned the matching write with account_selection_required; admitting
  // against the index card then called it undisclosed and offered
  // greenhouse/airtable (live 2026-08-29 seq 98118). Ask. Do not substitute.
  const accountSelection = accountSelectionForCitedWrite({
    citedRefs: input.draft.bindings.map((binding) => binding.capabilityRef),
    blockers: thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq }),
  });
  if (accountSelection) {
    // The recovery projection deliberately admits at most five exact choices.
    // Keep the producer inside that same closed boundary so a large connected
    // account set still becomes one precise question instead of a factual stop.
    const accountChoices = accountSelection.choices.slice(0, 5);
    const choices = accountChoices.join(', ');
    return JSON.stringify({
      ok: false,
      code: 'account_selection_required',
      detail: `${accountSelection.name} is the matching write for this ask; it is not missing and the connector is not down. Ask the user which connected account to use.`,
      question: 'Which connected account should I use?',
      accountChoices,
      repair: `Ask the user which exact connected account to use (${choices}). Do not pick a substitute write. After they name one, repeat one tool_search that includes that account, then call plan_task with the capabilityRef that search returns.`,
    });
  }
  const requestedEffectScope = requestedCapabilityEffectScope(objective);
  if (
    (requestedEffectScope === 'write' || requestedEffectScope === 'mixed')
    && !planDraftHasHostAttestedWrite({ draft: input.draft, capabilities: planning.capabilities })
  ) {
    return JSON.stringify({
      ok: false,
      code: 'plan_incomplete_missing_write',
      detail: 'The accepted request requires a write, but this draft contains no exactly bound host-attested write operation.',
      requestedEffectScope,
      repair: 'Use tool_search for the exact missing write capability, then call plan_task again with that exact capabilityRef bound to a local_write, external_write, or admin topology operation. Do not freeze or execute a read-only subset.',
    });
  }
  const lineage = collectConstructLineageCompleteness(input.draft);
  if (!lineage.ok) {
    return JSON.stringify({
      ok: false,
      code: 'plan_incomplete_data_lineage',
      detail: `The collected record set is destined for an artifact, but write operation(s) ${lineage.writeOperationIds.join(', ')} name only ordering dependencies. dependsOn does not authorize or retain payload consumption.`,
      writeOperationIds: lineage.writeOperationIds,
      sourceOperationIds: lineage.sourceOperationIds,
      repair: 'Call plan_task again in this same turn. Keep dependsOn for ordering and set each affected write dataFrom to the exact immediate read/compute operation whose bytes construct the artifact; that dataFrom chain must reach one of sourceOperationIds. Do not ask the user about this internal topology repair.',
    });
  }
  const proposal = proposalFromDraft({ objective, draft: input.draft });

  const planned = await admitAndCompilePrimaryModelProposal({
    identity: { sessionId, sourceUserSeq, turn },
    surface: 'direct',
    proposal,
    planningCatalogAuthority: planning.authority,
  });
  if (!planned.ok) {
    // Admission may have promoted an exact same-source staged ref that the
    // initial eight-slot display card withheld. Re-read the opaque authority
    // so repair names the ref the model actually cited instead of sending it
    // back through another identical tool_search loop.
    const repairPlanning = snapshotPrimaryModelPlanningContext(planning.authority) ?? planning;
    const citedRefs = new Set(input.draft.bindings.map((binding) => binding.capabilityRef));
    const admissibleCapabilities = planningRefusalRepairCatalog(
      repairPlanning.capabilities,
      citedRefs,
    );
    const withheld = repairPlanning.withheld ?? [];
    const withheldWrite = withheld.find((entry) => (
      entry.effect === 'external_write' || entry.effect === 'local_write' || entry.effect === 'admin'
    ));
    const withheldRepair = withheldWrite
      ? ` The host proved ${withheldWrite.id} (${withheldWrite.effect}) this turn but withheld it from the planning card (${withheldWrite.reason}). It is not missing and the connector is not down.`
      : withheld.length > 0
        ? ` The host withheld ${withheld.length} ceiling-matching capabilities from this card: ${withheld.map((entry) => `${entry.id}:${entry.effect}:${entry.reason}`).join(', ')}.`
        : '';
    return JSON.stringify({
      ok: false,
      code: 'plan_not_admitted',
      detail: planned.reason,
      admissibleCapabilities,
      ceiling: repairPlanning.effectCeiling,
      withheld,
      // A verifier refusal is not a "pick a different capability" problem — the
      // cited write is correct and simply needs a readback partner. Handing the
      // generic advice here sent the model round the admissible list looking
      // for a substitute that does not exist.
      repair: (verifierRepairInstruction(planned.reason)
        ?? (admissibleCapabilities.length > 0
          ? 'Correct the semantic proposal using only a capabilityRef from admissibleCapabilities with the matching effect, then call plan_task again. It may stand alone or be followed in the same frame by exactly one proposal-free dependency-root read/compute work_call.'
          : 'No citable capability is currently available. Use tool_search once for the missing role, then call plan_task with only the exact capabilityRef it returns.'))
        + withheldRepair,
    });
  }
  const readBindingCounts = new Map<string, number>();
  for (const binding of input.draft.bindings) {
    readBindingCounts.set(
      binding.operationId,
      (readBindingCounts.get(binding.operationId) ?? 0) + 1,
    );
  }
  const reviewedLocalReadPlan = planned.compiled.graph.classification.route === 'retrieve'
    && planned.compiled.graph.effectCeiling === 'read'
    && input.draft.destination === null
    && input.draft.bindings.length > 0
    && input.draft.topology.operations.every((operation) => operation.effect === 'read')
    && input.draft.topology.operations.every((operation) => (
      readBindingCounts.get(operation.id) === 1
    ))
    && (await Promise.all(input.draft.bindings.map(async (binding) => {
      const local = await loadDurableAuthorizedLocalPlanningDefinition({
        sessionId,
        sourceUserSeq,
        capabilityRef: binding.capabilityRef,
      });
      return local.ok
        && local.definition.carrier === 'work_call'
        && local.definition.descriptor.effect === 'read'
        && local.definition.consequence === 'read'
        && local.definition.reversibility === 'read_only'
        && local.definition.descriptor.destinationPosture === null;
    }))).every(Boolean);
  if (planned.compiled.graph.classification.route !== 'act' && !reviewedLocalReadPlan) {
    return JSON.stringify({
      ok: false,
      code: 'plan_not_required',
      detail: 'plan_task is only for action work or an exact reviewed Clementine-local read; use a graph-neutral read otherwise.',
    });
  }
  const authority = requireAcceptedTaskAuthority({ sessionId, sourceUserSeq });
  const preparedExpectedWork = prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq,
    proposal: planned.compiled.graph.workTopology?.topology,
  });
  if (preparedExpectedWork.status !== 'prepared') {
    throw new Error(`plan_task could not prepare its exact expected-work contract: ${preparedExpectedWork.reason}`);
  }
  const bindingSeal = await sealFreshPlanCapabilityBindings({
    sessionId,
    sourceUserSeq,
    acceptedTaskId: authority.acceptedTaskId,
    acceptedText: objective,
    graph: planned.compiled.graph,
    operationIds: input.draft.topology.operations.map((operation) => operation.id),
    workContractId: preparedExpectedWork.contract.contractId,
  });
  if (!bindingSeal.ok) {
    return JSON.stringify({
      ok: false,
      code: bindingSeal.reason.startsWith('verification_successor_required:')
        ? 'verification_successor_required'
        : 'plan_binding_not_sealed',
      detail: bindingSeal.reason,
      repair: verifierRepairInstruction(bindingSeal.reason)
        ?? 'Select an exact current capability set whose host-declared verifier recipe can be frozen, then call plan_task again.',
    });
  }
  const expectedWork = freezePrimaryModelExpectedWorkContract({ sessionId, sourceUserSeq });
  if (expectedWork.status !== 'fixed' && expectedWork.status !== 'replayed') {
    throw new Error('plan_task admitted a graph whose expected-work topology is not deterministically projectable');
  }
  if (expectedWork.contract.contractId !== preparedExpectedWork.contract.contractId) {
    throw new Error('plan_task expected-work contract changed between recipe sealing and durable freeze');
  }

  const persisted = appendConversationPreambleOnce({ source, text: preamble });
  const logical = currentLogicalCall();
  if (
    !logical
    || logical.acceptedTaskId !== authority.acceptedTaskId
    || logical.logicalToolCallId !== logical.logicalToolCallId.trim()
  ) throw new Error('plan_task lost its exact logical-call identity before preamble delivery');
  // A carrier that paints its own live message supplies a port; one that
  // renders the conversation from the durable log has already been delivered
  // to by the append above. Both are deliveries — only one needs a transport.
  const deliverPreamble = context.onConversationPreamble
    ?? hostDurableConversationPreambleDelivery();
  const deliveryRequest = conversationPreambleDeliveryRequest(persisted.event);
  const delivered = await deliverPreamble(deliveryRequest);
  if (delivered.status === 'failed') {
    throw new Error(`conversation preamble ${delivered.reason}`);
  }
  recordPlanTaskPreambleDelivery({
    identity: {
      sessionId,
      sourceUserSeq,
      acceptedTaskId: logical.acceptedTaskId,
      logicalToolCallId: logical.logicalToolCallId,
    },
    preamble: persisted.event,
    delivery: delivered,
  });
  // The graph/contract may be replayed after a transport failure, but no
  // business call is admitted until the conversational preamble has actually
  // crossed the awaited delivery edge for this physical run. Activation is
  // intentionally deferred one boundary further: this graph-neutral control
  // call must settle before the new graph can govern later work calls.
  return JSON.stringify({
    ok: true,
    acceptedTaskId: authority.acceptedTaskId,
    graphId: planned.compiled.graph.graphId,
    graphHash: planned.compiled.graph.compiler.graphHash,
    contractId: expectedWork.contract.contractId,
    requirements: expectedWork.contract.operations.map((operation) => ({
      id: operation.id,
      effect: operation.effect,
      coverage: operation.coverage ?? null,
      dependsOn: operation.dependsOn,
      cardinality: operation.cardinality,
    })),
    next: bindingSeal.unverifiedMutations.length > 0
      ? 'Invoke each plan-selected operation through work_call with proposal:null and its exact requirement_id. After a write, if the host could not read it back, tell the user you wrote and could not verify — do not invent a connector outage.'
      : 'Use tool_search as needed, then invoke each plan-selected local read or business operation through work_call with proposal:null and its exact requirement_id.',
    ...(bindingSeal.unverifiedMutations.length > 0
      ? { unverifiedMutations: bindingSeal.unverifiedMutations }
      : {}),
  });
}

export function buildPlanTaskTool(input: {
  planning: HostFreshPlanningContextV1;
}): Tool<RuntimeContextValue> {
  return tool({
    name: 'plan_task',
    description: [
      'Admit and freeze one action plan or exact reviewed Clementine-local read plan for the current accepted request inside this foreground model loop.',
      'Resolve any missing exact capability refs with tool_search first. Then call this tool first in its tool-call frame. It may stand alone, or it may be followed by exactly one proposal-free work_call for a dependency-root read/compute operation declared in this draft. No write, admin, unknown, dependent, or additional sibling is allowed. Include the brief user-facing preamble in this call.',
      'This is a host-only control: it performs no provider/business I/O and grants no approval. After success, every work_call must pass proposal:null.',
      'Use topology as the sole operation DAG. Put capabilityRef/role/evidence annotations in bindings; do not copy effects or dependencies into bindings. coverage is required for reads and null for non-reads. dependsOn means ORDER only. When a later operation consumes prior result bytes, also name its exact immediate source in dataFrom; for example read_source once with dataFrom:[], then write_once with dependsOn:["read_source"] and dataFrom:["read_source"]. Use cardinality each only for genuine per-member work; a counted collection written once stays once.',
      `Exact host planning catalog: ${planningCatalogText(input.planning.capabilities)}`,
    ].join(' '),
    parameters: PlanTaskInputSchema,
    // A plan can only be admitted against a capability the host DISCLOSED, so
    // an actually empty live catalog keeps this door absent. Foreground
    // tool_search may disclose an exact ref later in the same agent run. The
    // SDK re-evaluates isEnabled before every model request, so re-read the
    // authority's immutable current snapshot here instead of pinning the empty
    // initial card forever. Invalid/unminted authorities remain disabled.
    isEnabled: async () => {
      const planning = snapshotPrimaryModelPlanningContext(input.planning.authority);
      return Boolean(
        planning
        && planning.capabilities.length > 0
        && !actionExpectedWorkRequired(planning.identity),
      );
    },
    execute: async (args) => {
      const planning = snapshotPrimaryModelPlanningContext(input.planning.authority);
      if (!planning) throw new Error('plan_task requires a live host-minted planning catalog');
      return executePlanTask(args as PlanTaskInput, planning);
    },
    // Input-shape rejections return the typed plan_invalid_input refusal with
    // the violated paths (see planTaskInvalidInputRefusal). Everything else
    // keeps the SDK's default text: settlement recognizes that prefix as a
    // laundered failure, and downstream failure detection keys on it.
    errorFunction: (_context, error) => {
      const refusal = planTaskInvalidInputRefusal(error);
      if (refusal) return refusal;
      const details = error instanceof Error ? error.toString() : String(error);
      return `An error occurred while running the tool. Please try again. Error: ${details}`;
    },
  });
}

/**
 * Typed refusal for a plan_task input-shape rejection, naming every violated
 * path. The SDK default errorFunction destroys the zod issues into "Invalid
 * JSON input for tool" — live 2026-08-26 (sess-desktop-8823/b3a7/f58f/e0e9):
 * six schema-layer rejections whose issues NAMED their own fix ("coverage and
 * cardinality describe different read sets", a PlanId pattern miss, one stray
 * strict key) were laundered into that detail-free string; the model retried
 * the identical arguments five times, the loop guardrail blocked, and the
 * conversation died. An error that names its own condition must reach the
 * model (self-healing law), and the result stays inside plan_task's closed
 * typed union so settlement records a typed failure, never success.
 */
function planTaskInvalidInputRefusal(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if ((error as { name?: unknown }).name !== 'InvalidToolInputError') return null;
  const original = (error as { originalError?: unknown }).originalError;
  const rawIssues = original && typeof original === 'object'
    ? (original as { issues?: unknown }).issues
    : undefined;
  const issues = Array.isArray(rawIssues)
    ? (rawIssues as Array<{ path?: unknown; message?: unknown }>).slice(0, 8).map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0
          ? issue.path.join('.')
          : '(root)';
        return `${path}: ${String(issue.message ?? 'invalid')}`;
      })
    : [];
  const detail = issues.length > 0
    ? `plan_task input did not match its schema — ${issues.join('; ')}`
    : 'plan_task input was not one parseable JSON object matching its schema';
  return JSON.stringify({
    ok: false,
    code: 'plan_invalid_input',
    detail: detail.slice(0, 4_000),
    repair: 'Fix exactly the named paths and call plan_task again; do not resend the identical arguments.',
  });
}

/** plan_task is a first-class host control only. It is deliberately absent
 * from local MCP/call_tool so wrappers cannot race the sole-call barrier. */
export function registerPlanTools(_server: McpServer): void {
  // no-op by design
}
