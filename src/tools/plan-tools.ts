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
import { freezePrimaryModelExpectedWorkContract } from '../runtime/harness/expected-work-contract.js';
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
  persistSealedNodeBinding,
  sealBoundCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
} from '../runtime/harness/local-planning-capability.js';
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
}): Promise<boolean> {
  const frozen = freezeCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (!frozen.ok) return false;
  const operationIds = new Set(input.operationIds);
  const nodes = input.graph.nodes.filter((node) => operationIds.has(node.id));
  if (
    nodes.length !== operationIds.size
    || [...operationIds].some((operationId) => !nodes.some((node) => node.id === operationId))
  ) return false;
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
    return sealBoundCapability({
      nodeId: node.id,
      binding: bound.binding,
      // This is a capability-selection seal, not invocation identity. The
      // same host-owned projection is used by the admitted graph executor.
      argumentDigest: createHash('sha256').update(JSON.stringify({
        nodeId: node.id,
        capabilityId: bound.binding.capabilityId,
      }), 'utf8').digest('hex'),
    });
  }));
  if (sealed.some((binding) => binding === null)) return false;
  return sealed.every((binding) => persistSealedNodeBinding({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    binding: binding!,
  }));
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
    return operation.dependsOn.some((dependency) => reachesRead(dependency, seen));
  };
  if (topology.operations.some((operation) => (
    (operation.effect === 'local_write'
      || operation.effect === 'external_write'
      || operation.effect === 'admin')
    && operation.cardinality.kind === 'once'
    && operation.dependsOn.some((dependency) => reachesRead(dependency))
  ))) return 'collect_then_construct';
  return 'single_act';
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
  const turn = context.turn as number;
  const preamble = settledPreamble(input.preamble);

  const source = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === sourceUserSeq);
  if (!source) throw new Error('plan_task accepted source disappeared before admission');
  const display = typeof source.data.displayText === 'string' ? source.data.displayText.trim() : '';
  const eventText = typeof source.data.text === 'string' ? source.data.text.trim() : '';
  const objective = display || eventText;
  if (!objective) throw new Error('plan_task accepted source text is missing');
  const proposal = proposalFromDraft({ objective, draft: input.draft });

  const planned = await admitAndCompilePrimaryModelProposal({
    identity: { sessionId, sourceUserSeq, turn },
    surface: 'direct',
    proposal,
    planningCatalogAuthority: planning.authority,
  });
  if (!planned.ok) {
    return JSON.stringify({
      ok: false,
      code: 'plan_not_admitted',
      detail: planned.reason,
      repair: 'Correct the semantic proposal against the exact host planning catalog, then call plan_task again. It may stand alone or be followed in the same frame by exactly one proposal-free dependency-root read/compute work_call.',
    });
  }
  if (planned.compiled.graph.classification.route !== 'act') {
    return JSON.stringify({
      ok: false,
      code: 'plan_not_required',
      detail: 'plan_task is only for action work; answer or use a direct read without freezing an action graph.',
    });
  }
  const authority = requireAcceptedTaskAuthority({ sessionId, sourceUserSeq });
  if (!await sealFreshPlanCapabilityBindings({
    sessionId,
    sourceUserSeq,
    acceptedTaskId: authority.acceptedTaskId,
    acceptedText: objective,
    graph: planned.compiled.graph,
    operationIds: input.draft.topology.operations.map((operation) => operation.id),
  })) {
    throw new Error('plan_task could not seal every exact selected graph capability');
  }
  const expectedWork = freezePrimaryModelExpectedWorkContract({ sessionId, sourceUserSeq });
  if (expectedWork.status !== 'fixed' && expectedWork.status !== 'replayed') {
    throw new Error('plan_task admitted a graph whose expected-work topology is not deterministically projectable');
  }

  const persisted = appendConversationPreambleOnce({ source, text: preamble });
  const logical = currentLogicalCall();
  if (
    !logical
    || logical.acceptedTaskId !== authority.acceptedTaskId
    || logical.logicalToolCallId !== logical.logicalToolCallId.trim()
  ) throw new Error('plan_task lost its exact logical-call identity before preamble delivery');
  if (!context.onConversationPreamble) {
    throw new Error('plan_task requires an awaited conversational preamble delivery port');
  }
  const deliveryRequest = conversationPreambleDeliveryRequest(persisted.event);
  const delivered = await context.onConversationPreamble(deliveryRequest);
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
    next: 'Use tool_search as needed, then invoke each business operation through work_call with proposal:null and its exact requirement_id.',
  });
}

export function buildPlanTaskTool(input: {
  planning: HostFreshPlanningContextV1;
}): Tool<RuntimeContextValue> {
  return tool({
    name: 'plan_task',
    description: [
      'Admit and freeze one action plan for the exact current accepted request inside this foreground model loop.',
      'Resolve any missing exact capability refs with tool_search first. Then call this tool first in its tool-call frame. It may stand alone, or it may be followed by exactly one proposal-free work_call for a dependency-root read/compute operation declared in this draft. No write, admin, unknown, dependent, or additional sibling is allowed. Include the brief user-facing preamble in this call.',
      'This is a host-only control: it performs no provider/business I/O and grants no approval. After success, every work_call must pass proposal:null.',
      'Use topology as the sole operation DAG. Put capabilityRef/role/evidence annotations in bindings; do not copy effects or dependencies into bindings. coverage is required for reads and null for non-reads. Use cardinality each only for genuine per-member work; a counted collection written once stays once.',
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
