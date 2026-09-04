import { createHash } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import {
  exactOrderedLiteralListSchema,
  type HostCapabilityDescriptorV1,
  type TurnSemanticProposalV1,
  boundedSemanticObjective,
} from '../runtime/semantic-boundary/turn-semantic-proposal.js';
import type { TurnGraphIR } from '../runtime/graph/turn-graph-ir.js';
import {
  admitAndCompilePrimaryModelProposal,
  snapshotPrimaryModelSelectedStagedPlanningDescriptors,
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
  openEventLog,
} from '../runtime/harness/eventlog.js';
import { PLAN_TASK_BINDING_SEAL_INTENTS_TABLE } from '../runtime/harness/host-planned-resolution-coexistence.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { currentLogicalCall } from '../runtime/harness/attempt-identity.js';
import {
  claimPendingPlanTaskBindingSealRecoveryCandidates,
  exactPlanTaskBindingSealIntent,
  planTaskBindingSealRecoveryOwner,
  recoverSettledPlanTaskActivation,
  recordPlanTaskBindingSealIntentInTransaction,
  recordPlanTaskPreambleDelivery,
  recordPlanTaskPreparationCheckpoint,
} from '../runtime/harness/plan-task-post-settlement.js';
import { bindAdmittedNodeCapability } from '../runtime/harness/graph-node-capability.js';
import {
  freezeCatalogSnapshotForSource,
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  persistedCatalogSnapshotManifestIdsForSource,
  persistSealedNodeBinding,
  sealBoundCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import { refreshTypedExecutionReadiness } from '../runtime/semantic-boundary/configure-typed-execution-runtime.js';
import { registerProofProvisionedCapabilities } from '../runtime/harness/proof-provisioned-catalog.js';
import {
  deriveMutationVerificationRecipe,
  parseOperationVerificationContract,
} from '../runtime/harness/mutation-verification-contract.js';
import {
  deriveAsyncReadContinuationRecipe,
} from '../runtime/harness/async-read-continuation-contract.js';
import {
  firecrawlBatchScrapeSchemasMatchV20260826,
} from '../runtime/harness/firecrawl-batch-scrape-schema-contract.js';
import {
  getCachedToolSchema,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
  liveComposioOutputSchemaDigest,
} from './composio-schema-cache.js';
import { digestSchema } from './tool-contract-store.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
} from '../runtime/harness/local-planning-capability.js';
import { requestedCapabilityEffectScope } from '../memory/capability-effect-scope.js';
import { uniqueWorkflowRunRequest } from './named-workflow-match.js';
import { acceptedSourceIsWorkflowInternal } from '../runtime/harness/named-workflow-host-dispatch.js';
import {
  accountSelectionForCitedWrite,
  citedLegsUnblockedByAccount,
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

/** Admission's own pre-persist refusal for a graph that compiled to a non-act
 * route (admit-and-compile-accepted-source.ts). plan_task maps it to the same
 * typed `plan_not_required` the model already knows how to walk, so the
 * compiler owns the route and the model contract does not change. */
const NON_ACTION_GRAPH_ADMISSION_REASON = 'plan_task may persist only an admitted action graph';

/** One graph-neutral read needs no graph: call_tool once. Both the shape
 * short-circuit and the compiler-route refusal return these exact bytes. */
const GRAPH_NEUTRAL_READ_REFUSAL = Object.freeze({
  ok: false,
  code: 'plan_not_required',
  detail: 'plan_task is only for action work or an exact reviewed Clementine-local read; use a graph-neutral read otherwise.',
  repair: 'Call call_tool exactly once with the exact graph-neutral read operation and schema already disclosed for this request. Do not call plan_task for this read.',
  recoveryTool: 'call_tool',
});

type PlanTaskPreparationTestHooks = {
  afterGraphIntentPersisted?: (identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
  }) => void;
  recoveryBindingSealFailure?: (identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
  }) => string | null;
  /** Clock for the pre-seal recovery age budget (tests only). */
  sealRecoveryNow?: () => number;
};

let planTaskPreparationTestHooks: PlanTaskPreparationTestHooks | null = null;

/** Test-only fault seam for the exact graph+intent -> seal crash window. */
export function installPlanTaskPreparationTestHooks(
  hooks: PlanTaskPreparationTestHooks | null,
): void {
  planTaskPreparationTestHooks = hooks;
}

/**
 * Age budget for host-owned pre-seal recovery of an exact current intent.
 *
 * Sealing is metadata/port reproof only — seconds, never a model call — so an
 * intent that is still failing to seal this long after it was recorded is not
 * going to seal without something outside this loop changing (a frozen catalog
 * whose identity no longer matches, a provider identity that cannot be
 * reproved). Without a budget the fresh-turn path answered "host preparation
 * is still pending. Please retry" and the daemon sweep re-sealed forever: safe
 * but unavailable, which is a failure. Past the budget a failing attempt
 * becomes `expired`, a factual non-resumable stop that names the last reason.
 * The budget is measured from the immutable intent's own `recorded_at`, so it
 * needs no counter and no schema; it is only ever applied to an attempt that
 * has just failed, so a machine that slept past the budget still gets one real
 * attempt before it is told the truth.
 */
export const PLAN_TASK_SEAL_RECOVERY_MAX_AGE_MS = 15 * 60_000;

type PlanTaskSealRecoveryHold =
  | { status: 'held'; reason: string }
  | { status: 'expired'; reason: string; heldSince: string; ageMs: number };

function planTaskSealRecoveryAgeBudget(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { heldSince: string; ageMs: number; exhausted: boolean } {
  const row = openEventLog().prepare(`
    SELECT recorded_at AS recordedAt
      FROM ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as { recordedAt: string } | undefined;
  const heldSince = typeof row?.recordedAt === 'string' ? row.recordedAt : '';
  const recordedAtMs = heldSince ? Date.parse(heldSince) : Number.NaN;
  const now = planTaskPreparationTestHooks?.sealRecoveryNow?.() ?? Date.now();
  const ageMs = Number.isFinite(recordedAtMs) ? Math.max(0, now - recordedAtMs) : 0;
  return {
    heldSince,
    ageMs,
    // An unreadable timestamp never expires anything: fail toward the
    // existing held behavior, never toward a terminal the row cannot justify.
    exhausted: Number.isFinite(recordedAtMs) && ageMs > PLAN_TASK_SEAL_RECOVERY_MAX_AGE_MS,
  };
}

const PlanId = WorkTopologyIdSchema;

const PlanOperationBindingSchema = z.object({
  operationId: PlanId,
  /** Capability role and proof annotations bind an operation id; structural
   * effect, dependency, coverage, and cardinality live only in topology. */
  role: PlanId,
  capabilityRef: PlanId,
  /** Evidence KINDS this operation will produce — a CLOSED host vocabulary, not
   * free description. The legal values are exactly: 'payload' (a read's bytes),
   * 'tool_result', 'receipt' and 'readback' (an external write), and
   * 'local_commit_receipt' (a local write). They are copied verbatim from the
   * capability descriptor's evidenceKinds.
   *
   * The set was never disclosed anywhere, so a model with no prior turn to copy
   * from could only guess — and every guess is prose, which fails the PlanId
   * pattern. Live 2026-09-03/04: this was the single most repeated plan_task
   * rejection of the day, including on a clean blank-state home. Naming the
   * vocabulary here is disclosure, not a new constraint. */
  evidence: z.array(PlanId).max(32)
    .describe("Evidence kinds from the closed set: payload | tool_result | receipt | readback | local_commit_receipt. Copy from the capability's evidenceKinds; never prose."),
}).strict();

/** Compact model-authored delta. Accepted-source identity, relation, goal
 * target, candidate list, open slots, proposal version, and rationale are all
 * host-derived, so paying to retransmit them on every plan was pure ceremony. */
export const FreshActionPlanDraftSchema = z.object({
  criteria: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  cardinality: z.object({
    count: z.number().int().min(1).max(10_000),
    fields: z.array(PlanId).max(32),
    locator: z.object({
      contract: z.literal('workspace_social_posts_v1'),
      collectionPointer: z.literal('/posts'),
      visibleMirrorPointer: z.literal('/_mobile/records/items'),
      calendarPointer: z.literal('/calendar'),
      calendarRequiredFields: exactOrderedLiteralListSchema(['date', 'channel', 'theme']),
      sourceEvidence: z.object({
        operationId: PlanId,
        recordsPointer: z.enum(['/news', '/web', '/results', '/items', '/records']),
        minDistinctRecords: z.literal(3),
        titlePointer: z.enum(['/title', '/name', '/headline']),
        urlPointer: z.enum(['/url', '/link', '/href']),
        publishedDatePointer: z.enum([
          '/date', '/publishedAt', '/published_at', '/publishedDate', '/published_date',
        ]),
        findingPointers: exactOrderedLiteralListSchema([
          '/snippet', '/description', '/content', '/markdown',
        ]),
        publisherPointer: z.enum(['/publisher', '/source', '/siteName', '/site_name']),
        maxAgeDays: z.number().int().min(1).max(30),
      }).strict(),
    }).strict().nullish().describe(
      'Host-recognized structured output locator. For a counted social-post Workspace, use workspace_social_posts_v1 with exact /posts, /calendar, and /_mobile/records/items pointers plus one bounded source-record field vocabulary; otherwise use JSON null.',
    ),
  }).strict().nullable(),
  destination: z.object({
    posture: z.enum(['create_new', 'named_existing']),
    family: PlanId,
    handleRequired: z.boolean(),
  }).strict().nullable(),
  topology: ActionWorkTopologySchema,
  bindings: z.array(PlanOperationBindingSchema).min(1).max(32),
  deliverables: z.array(z.object({ id: PlanId, kind: PlanId }).strict()).max(32),
  /** Same closed vocabulary as a binding's `evidence` — see above. */
  evidenceRequirements: z.array(PlanId).max(32)
    .describe("Evidence kinds from the closed set: payload | tool_result | receipt | readback | local_commit_receipt. Never prose or human criteria."),
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
  if (
    draft.cardinality
    && draft.destination?.family === 'workspace'
    && draft.cardinality.fields.includes('body')
    && draft.cardinality.fields.includes('citations')
    && !draft.cardinality.locator
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cardinality', 'locator'],
      message: 'a counted social-post Workspace requires one exact host-recognized collection and visible-mirror locator',
    });
  }
  const sourceEvidence = draft.cardinality?.locator?.sourceEvidence;
  if (sourceEvidence) {
    const source = draft.topology.operations.find((operation) => operation.id === sourceEvidence.operationId);
    const consumers = draft.topology.operations.filter((operation) => (
      operation.effect === 'local_write' && operation.dataFrom.includes(sourceEvidence.operationId)
    ));
    if (
      !source
      || source.effect !== 'read'
      || source.dataFrom.length !== 0
      || source.cardinality.kind !== 'once'
      || consumers.length !== 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardinality', 'locator', 'sourceEvidence', 'operationId'],
        message: 'structured source evidence must name one exact root read consumed by one local write',
      });
    }
  }
});

export const PlanTaskInputSchema = z.object({
  preamble: z.string().min(1).max(MAX_PREAMBLE_CHARS).refine(
    (value) => !value.includes('?'),
    'preamble must be settled and must not ask a question',
  ).describe(
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
    const batchScrapeOwner = bound.binding.manifest?.providerKind === 'composio'
      && bound.binding.manifest.operationId === 'FIRECRAWL_BATCH_SCRAPE'
      && bound.binding.manifest.operationVersion === '20260826_00'
      && bound.binding.manifest.effect === 'read'
      && Boolean(bound.binding.manifest.externalDefinition?.providerInputSchemaDigest)
      && bound.binding.manifest.externalDefinition?.providerOutputSchemaObserved === true
      && Boolean(bound.binding.manifest.externalDefinition.providerOutputSchemaDigest)
      ? bound.binding.manifest
      : null;
    const topologyOperation = input.graph.workTopology?.topology.operations.find(
      (operation) => operation.id === node.id,
    );
    const batchSourceEvidence = input.graph.classification.goalConstraints?.collection?.locator
      ?.sourceEvidence;
    const batchRecentArticleLocatorMatches = Boolean(
      batchSourceEvidence
      && batchSourceEvidence.operationId === node.id
      && batchSourceEvidence.recordsPointer === '/records'
      && batchSourceEvidence.minDistinctRecords === 3
      && batchSourceEvidence.titlePointer === '/title'
      && batchSourceEvidence.urlPointer === '/url'
      && batchSourceEvidence.publishedDatePointer === '/publishedAt'
      && JSON.stringify(batchSourceEvidence.findingPointers)
        === JSON.stringify(['/snippet', '/description', '/content', '/markdown'])
      && batchSourceEvidence.publisherPointer === '/publisher'
      && Number.isSafeInteger(batchSourceEvidence.maxAgeDays)
      && batchSourceEvidence.maxAgeDays >= 1
      && batchSourceEvidence.maxAgeDays <= 30
    );
    const batchRecentArticlesTopology = Boolean(
      batchScrapeOwner
      && topologyOperation?.effect === 'read'
      // R owns the exact fixed URL batch and may discharge only after the
      // host-owned getter returns terminal `completed` evidence for that whole
      // selected set. It is therefore complete_set, not another best-effort
      // resolved root lookup.
      && topologyOperation.coverage === 'complete_set'
      && topologyOperation.cardinality.kind === 'once'
      && topologyOperation.dataFrom.length === 0
      && topologyOperation.dependsOn.length === 1
      && input.graph.workTopology?.topology.operations.some((operation) => (
        operation.id === topologyOperation.dependsOn[0]
        && operation.effect === 'read'
        && operation.dataFrom.length === 0
      ))
      && input.graph.workTopology?.topology.operations.filter((operation) => (
        operation.effect === 'local_write'
        && operation.dependsOn.includes(node.id)
        && operation.dataFrom.includes(node.id)
      )).length === 1
      && batchRecentArticleLocatorMatches
    );
    // Starting provider-owned async work without its exact, host-verifiable
    // terminal vocabulary would create a durable job that no admitted consumer
    // can ever redeem. Refuse the plan before any provider call instead of
    // silently sealing the start as an ordinary read.
    if (batchScrapeOwner && !batchRecentArticlesTopology) return null;
    const getterCandidates = !batchRecentArticlesTopology || !batchScrapeOwner
      ? []
      : frozen.entries.filter((entry) => (
          isCurrentCallableCatalogEntry(entry)
          && entry.manifest.operationId === 'FIRECRAWL_BATCH_SCRAPE_GET'
          && entry.manifest.operationVersion === '20260826_00'
          && entry.manifest.providerKind === 'composio'
          && entry.manifest.providerIdentity === batchScrapeOwner.providerIdentity
          && entry.manifest.accountId === batchScrapeOwner.accountId
          && entry.manifest.effect === 'read'
          && entry.manifest.externalDefinition?.providerInputSchemaDigest
          && entry.manifest.externalDefinition.providerOutputSchemaObserved === true
          && entry.manifest.externalDefinition.providerOutputSchemaDigest
        ));
    const batchSchemaPairMatches = (() => {
      if (!batchRecentArticlesTopology || !batchScrapeOwner || getterCandidates.length !== 1) return false;
      const getter = getterCandidates[0]!;
      const startInput = getCachedToolSchema('FIRECRAWL_BATCH_SCRAPE');
      const startOutput = liveComposioOutputSchema('FIRECRAWL_BATCH_SCRAPE');
      const getterInput = getCachedToolSchema('FIRECRAWL_BATCH_SCRAPE_GET');
      const getterOutput = liveComposioOutputSchema('FIRECRAWL_BATCH_SCRAPE_GET');
      return Boolean(
        startInput
        && startOutput
        && getterInput
        && getterOutput
        && liveComposioOperationVersion('FIRECRAWL_BATCH_SCRAPE') === '20260826_00'
        && liveComposioOperationVersion('FIRECRAWL_BATCH_SCRAPE_GET') === '20260826_00'
        && digestSchema(startInput) === batchScrapeOwner.externalDefinition!.providerInputSchemaDigest
        && liveComposioOutputSchemaDigest('FIRECRAWL_BATCH_SCRAPE')
          === batchScrapeOwner.externalDefinition!.providerOutputSchemaDigest
        && digestSchema(getterInput) === getter.manifest!.externalDefinition!.providerInputSchemaDigest
        && liveComposioOutputSchemaDigest('FIRECRAWL_BATCH_SCRAPE_GET')
          === getter.manifest!.externalDefinition!.providerOutputSchemaDigest
        && firecrawlBatchScrapeSchemasMatchV20260826({
          startInput,
          startOutput,
          getterInput,
          getterOutput,
        })
      );
    })();
    const exactAsyncGetter = getterCandidates.length === 1
      ? (() => {
          const entry = getterCandidates[0]!;
          const identity = canonicalCatalogIdentityOf(entry);
          const outputDigest = entry.manifest?.externalDefinition?.providerOutputSchemaDigest;
          return identity && outputDigest ? { identity, outputDigest } : null;
        })()
      : null;
    if (batchRecentArticlesTopology && (!exactAsyncGetter || !batchSchemaPairMatches)) return null;
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
      ...(batchRecentArticlesTopology && exactAsyncGetter && batchScrapeOwner
        ? {
            asyncRead: (baseBindingDigest: string) => deriveAsyncReadContinuationRecipe({
              acceptedTaskId: input.acceptedTaskId,
              workContractId: input.workContractId,
              ownerRequirementId: node.id,
              ownerBindingDigest: baseBindingDigest,
              owner: {
                providerIdentity: batchScrapeOwner.providerIdentity,
                operationId: 'FIRECRAWL_BATCH_SCRAPE',
                schemaVersion: '20260826_00',
                providerInputSchemaDigest:
                  batchScrapeOwner.externalDefinition!.providerInputSchemaDigest,
                providerOutputSchemaDigest:
                  batchScrapeOwner.externalDefinition!.providerOutputSchemaDigest!,
                account: batchScrapeOwner.accountId,
              },
              getter: exactAsyncGetter.identity,
              getterProviderIdentity: getterCandidates[0]!.manifest!.providerIdentity,
              getterProviderOutputSchemaDigest: exactAsyncGetter.outputDigest,
            }),
          }
        : {}),
    });
    if (batchRecentArticlesTopology && !sealedBinding.asyncRead) return null;
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

/** Restart-only continuation for a graph atomically paired with its immutable
 * pre-seal owner. This path replays no model and owns no business invocation:
 * it can only freeze the same contract/preamble, seal the same selected
 * bindings, and advance to the pre-delivery checkpoint. */
export async function recoverPlanTaskBindingSealPreparation(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Promise<
  | { status: 'not_pending' | 'prepared' | 'replayed' }
  | PlanTaskSealRecoveryHold
> {
  const owner = planTaskBindingSealRecoveryOwner(input);
  if (owner.status === 'held') {
    // A legacy/corrupt owner is deliberately visible and held, never expired:
    // it has no exact recorded intent to measure a budget from.
    return { status: 'held', reason: 'plan graph has no exact current pre-seal recovery owner' };
  }
  // Every hold below is a failed attempt on an exact current intent. Inside
  // the age budget it stays `held` (retry is honest); past it the same failure
  // is reported as `expired` so the fresh-turn owner can stop factually.
  const budget = owner.status === 'ready' ? planTaskSealRecoveryAgeBudget(input) : null;
  const hold = (reason: string): PlanTaskSealRecoveryHold => (
    budget?.exhausted
      ? { status: 'expired', reason, heldSince: budget.heldSince, ageMs: budget.ageMs }
      : { status: 'held', reason }
  );
  // A completed plan has no remaining pre-seal owner, but a later host-only
  // checkpoint (for example an asynchronous read refinement) still resumes in
  // a fresh process with an empty capability factory.  Reconstruct the exact
  // frozen catalog before returning `not_pending`; otherwise the recovered
  // frame reaches hostRunRunner and is immediately held by
  // `catalog_snapshot_identity_mismatch`.  This remains metadata/port reproof
  // only: ids come from the immutable accepted-source snapshot and the ordinary
  // byte-exact snapshot reader is the final authority.
  const persistedCatalog = persistedCatalogSnapshotManifestIdsForSource(input);
  if (!persistedCatalog.ok) {
    if (owner.status === 'missing' && persistedCatalog.reason === 'missing_snapshot') {
      return { status: 'not_pending' };
    }
    return hold(`persisted frozen catalog is ${persistedCatalog.reason}`);
  }
  const source = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  if (!source) return hold('accepted source is unavailable for exact plan recovery');
  // A fresh process intentionally starts with no process-local tool_search
  // disclosures. Re-materialize only the manifest ids already named by this
  // source's immutable snapshot, then require the ordinary snapshot reader to
  // reproduce every canonical identity byte. This is metadata/port reproof;
  // it cannot call a model, rediscover a capability, or invoke business I/O.
  let rehydratedCatalog = freezeCatalogSnapshotForSource(input);
  if (!rehydratedCatalog.ok) {
    try {
      refreshTypedExecutionReadiness([...persistedCatalog.manifestIds]);
      const providerExpected = persistedCatalog.identities.filter((identity) => (
        identity.providerKind === 'composio'
      ));
      const missingProviderSchemaIdentity = providerExpected.find((identity) => (
        typeof identity.providerInputSchemaDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(identity.providerInputSchemaDigest)
        || typeof identity.operationId !== 'string'
        || !identity.operationId.trim()
      ));
      if (missingProviderSchemaIdentity) {
        return hold(`frozen provider identity is incomplete: ${missingProviderSchemaIdentity.capabilityId}`);
      }
      if (providerExpected.length > 0) {
        const reproved = await registerProofProvisionedCapabilities(input, {
          allowedIdentifiers: providerExpected.map((identity) => identity.operationId),
          expectedSchemaDigests: providerExpected.map((identity) => ({
            identifier: identity.operationId,
            schemaDigest: identity.providerInputSchemaDigest!,
          })),
          recoveryExpectedIdentities: persistedCatalog.identities,
        });
        if (reproved.refusal) {
          return hold(`frozen proof-provisioned catalog reproof refused: ${reproved.refusal.code}:${reproved.refusal.identifier}`);
        }
      }
    } catch (error) {
      return hold(`frozen catalog materialization failed: ${String(error instanceof Error ? error.message : error)}`);
    }
    rehydratedCatalog = freezeCatalogSnapshotForSource(input);
    if (!rehydratedCatalog.ok) {
      return hold(`frozen catalog ${rehydratedCatalog.reason}`);
    }
  }
  if (owner.status === 'missing') return { status: 'not_pending' };
  const intent = owner.intent;
  const frozen = freezePrimaryModelExpectedWorkContract(input);
  if (
    (frozen.status !== 'fixed' && frozen.status !== 'replayed')
    || frozen.contract.contractId !== intent.contractId
  ) {
    return hold(frozen.status === 'fixed' || frozen.status === 'replayed'
      ? 'recovered contract conflicts with immutable pre-seal intent'
      : `expected-work freeze is ${frozen.status}`);
  }
  const sealInput = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: intent.identity.acceptedTaskId,
    acceptedText: intent.objective,
    graph: intent.graph,
    operationIds: intent.operationIds,
    workContractId: intent.contractId,
  };
  const injectedSealFailure = planTaskPreparationTestHooks
    ?.recoveryBindingSealFailure?.(intent.identity) ?? null;
  if (injectedSealFailure) {
    return hold(injectedSealFailure);
  }
  let sealed = await sealFreshPlanCapabilityBindings(sealInput);
  if (!sealed.ok) sealed = await sealFreshPlanCapabilityBindings(sealInput);
  if (!sealed.ok) return hold(sealed.reason);
  // The intent owns the exact future acknowledgement, but it is not public
  // conversation state until every selected binding is executable. Publishing
  // first can visibly promise work while the immutable graph is still held.
  let preamble: ReturnType<typeof appendConversationPreambleOnce>;
  try {
    preamble = appendConversationPreambleOnce({ source, text: intent.preamble });
  } catch (error) {
    return hold(`exact preamble recovery failed: ${String(error instanceof Error ? error.message : error)}`);
  }
  try {
    const checkpoint = recordPlanTaskPreparationCheckpoint({
      identity: intent.identity,
      preamble: preamble.event,
      deliveryOwner: intent.deliveryOwner,
    });
    return { status: checkpoint.inserted ? 'prepared' : 'replayed' };
  } catch (error) {
    return hold(`exact checkpoint recovery failed: ${String(error instanceof Error ? error.message : error)}`);
  }
}

/** Daemon-owned bounded recovery pass. It advances only the immutable
 * graph/intent through host seal, preamble, checkpoint, exact durable delivery
 * (where that surface owns delivery), and activation. It never invokes a
 * model, provider, or business tool. Carrier-owned delivery remains explicitly
 * held for the ordinary channel resumer that can reconstruct its exact target. */
export async function recoverPendingPlanTaskBindingSealPreparations(input: {
  limit?: number;
} = {}): Promise<{
  scanned: number;
  prepared: number;
  replayed: number;
  activated: number;
  deliveryRequired: number;
  held: number;
  /** Exact intents whose failing seal is past the age budget. They are not
   * retried into activation; the fresh-turn owner reports them factually. */
  expired: number;
  records: Array<{
    sessionId: string;
    sourceUserSeq: number;
    preparation: string;
    activation: string;
    reason?: string;
  }>;
}> {
  const candidates = claimPendingPlanTaskBindingSealRecoveryCandidates(input);
  const summary = {
    scanned: candidates.length,
    prepared: 0,
    replayed: 0,
    activated: 0,
    deliveryRequired: 0,
    held: 0,
    expired: 0,
    records: [] as Array<{
      sessionId: string;
      sourceUserSeq: number;
      preparation: string;
      activation: string;
      reason?: string;
    }>,
  };
  for (const candidate of candidates) {
    const preparation = await recoverPlanTaskBindingSealPreparation(candidate);
    if (preparation.status === 'held' || preparation.status === 'expired') {
      if (preparation.status === 'held') summary.held += 1;
      else summary.expired += 1;
      summary.records.push({
        ...candidate,
        preparation: preparation.status,
        activation: 'not_attempted',
        reason: preparation.reason,
      });
      continue;
    }
    if (preparation.status === 'prepared') summary.prepared += 1;
    if (preparation.status === 'replayed') summary.replayed += 1;
    const activation = await recoverSettledPlanTaskActivation(candidate);
    if (activation.status === 'activated' || activation.status === 'replayed') {
      summary.activated += 1;
    } else if (activation.status === 'delivery_required') {
      summary.deliveryRequired += 1;
    }
    summary.records.push({
      ...candidate,
      preparation: preparation.status,
      activation: activation.status,
    });
  }
  return summary;
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
      // Host-composed from the accepted source; bounded to the proposal
      // schema so a long source cannot make every draft inadmissible.
      objective: boundedSemanticObjective(input.objective),
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

/**
 * The undisclosed-ref repair. Admission names the exact refs that fell outside
 * the bounded set (see admit-and-compile-accepted-source); this turns them into
 * an instruction that matches `recoveryTool`.
 *
 * Before: this refusal fell through to the generic
 * "correct the proposal using admissibleCapabilities" text while `recoveryTool`
 * said `tool_search`. Those are two different actions, so the model was told to
 * repair and to rediscover in the same breath — and a plan with four legs got
 * no signal at all about WHICH leg was undisclosed. The refusal already carried
 * that fact; it just never reached the model.
 */
function undisclosedRefRepairInstruction(
  reason: string,
  admissibleCount: number,
): string | null {
  if (!reason.includes('capability that was not disclosed')) return null;
  const named = reason.split('to this source:')[1]?.trim();
  const subject = named ? `The cited capabilityRef(s) ${named} were` : 'A cited capabilityRef was';
  return `${subject} not disclosed to this source, so the plan cannot cite them. `
    + (admissibleCount > 0
      ? 'Either cite a capabilityRef from admissibleCapabilities that fills the same role, or run '
        + 'tool_search once for that role and call plan_task with only the exact id it returns. '
        + 'Every other binding in this plan was fine — keep them.'
      : 'Run tool_search once for that role, then call plan_task with only the exact capabilityRef it returns.');
}

function verifierRecoveryTool(reason: string): 'plan_task' | 'tool_search' | null {
  if (!reason.startsWith('verification_successor_required:')) return null;
  return reason.includes(':ambiguous_compatible_verifier:') ? 'plan_task' : 'tool_search';
}

function boundedPlanAdmissionReasonCode(reason: string): string {
  if (reason.startsWith('verification_successor_required:')) return 'verification_successor_required';
  if (reason.includes('capability that was not disclosed')) return 'capability_not_disclosed';
  if (reason.startsWith('write_not_in_policy')) return 'write_not_in_policy';
  if (reason.startsWith('effect_exceeds_policy')) return 'effect_exceeds_policy';
  if (reason.startsWith('primary model planning catalog authority')) return 'host_planning_catalog_unavailable';
  if (reason.startsWith('audience hash mismatch')) return 'audience_mismatch';
  if (reason.startsWith('admitted graph persist refused')) return 'admitted_graph_persist_refused';
  if (reason.startsWith('admitted graph replay failed')) return 'admitted_graph_replay_failed';
  const token = reason.split(':', 1)[0]!.trim().replace(/[^A-Za-z0-9._/-]+/g, '_');
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(token) ? token : 'other';
}

function planAdmissionRecoveryTool(
  reason: string,
  admissibleCapabilities: readonly unknown[],
): 'plan_task' | 'tool_search' | 'retry_host' | 'stop_factual' {
  if (
    reason.startsWith('write_not_in_policy')
    || reason.startsWith('effect_exceeds_policy')
  ) return 'stop_factual';
  if (
    reason.startsWith('host_destination_')
    || reason.startsWith('primary model planning catalog authority')
    || reason.startsWith('selected_definition_revalidation_refused:')
    || reason.startsWith('selected_definition_exact_refresh_unavailable:')
    || reason.startsWith('selected_definition_operation_version_unavailable:')
    || reason.startsWith('audience hash mismatch')
    || reason.startsWith('policy_revision_mismatch')
    || reason.startsWith('audience_mismatch')
    || reason.startsWith('admitted graph persist refused')
    || reason.startsWith('admitted graph replay failed')
  ) return 'retry_host';
  return verifierRecoveryTool(reason)
    ?? (reason.includes('capability that was not disclosed')
      ? 'tool_search'
      : admissibleCapabilities.length > 0 ? 'plan_task' : 'tool_search');
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
  const consumingObjective = display || eventText;
  const continuation = context.taskContinuation;
  const objective = continuation
    && continuation.consumingSourceUserSeq === sourceUserSeq
    && continuation.parentSourceUserSeq < sourceUserSeq
    && continuation.parentInput.trim()
      ? continuation.parentInput.trim()
      : consumingObjective;
  if (!objective) throw new Error('plan_task accepted source text is missing');
  // A workflow step's own accepted text names its workflow and says "run";
  // the step surface denies workflow_run, so the class guard decides first
  // (lane parity with tryHostDispatchNamedWorkflow).
  const uniqueWorkflow = acceptedSourceIsWorkflowInternal(sessionId, sourceUserSeq) ? null : uniqueWorkflowRunRequest(
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
      recoveryTool: 'workflow_run',
    });
  }
  // Change 2: a check may refuse only if the missing fact is outside the
  // host. Two connected Outlook mailboxes is that fact. tool_search already
  // returned the matching write with account_selection_required; admitting
  // against the index card then called it undisclosed and offered
  // greenhouse/airtable (live 2026-08-29 seq 98118). Ask. Do not substitute.
  const citedCapabilityRefs = input.draft.bindings.map((binding) => binding.capabilityRef);
  const accountBlockers = thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq });
  const accountSelection = accountSelectionForCitedWrite({
    citedRefs: citedCapabilityRefs,
    blockers: accountBlockers,
  });
  // ...but the question belongs to the LEG that needs the account, not to the
  // whole plan. Live 2026-09-03 run 21: a five-step chain whose only ambiguous
  // leg was the final Outlook write was refused here, so a pure Salesforce READ
  // could not start until the user said where emails go three steps later. That
  // inverts read -> work -> write. When other legs are clear, freeze the plan
  // and let the account question arrive at the write, where it is answerable
  // with the work in hand.
  const unblockedLegs = citedLegsUnblockedByAccount({
    citedRefs: citedCapabilityRefs,
    blockers: accountBlockers,
  });
  if (accountSelection && unblockedLegs.length === 0) {
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
      recoveryTool: 'ask_user_question',
    });
  }
  const requestedEffectScope = requestedCapabilityEffectScope(objective);
  const selectedRefs = new Set(input.draft.bindings.map((binding) => binding.capabilityRef));
  const selectedStagedCapabilities = snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: planning.authority,
    identity: planning.identity,
    selectedRefs,
  });
  const completenessCapabilities = [
    ...planning.capabilities,
    ...selectedStagedCapabilities.filter((descriptor) => (
      !planning.capabilities.some((bounded) => bounded.id === descriptor.id)
    )),
  ];
  // A plan whose operations are ALL reads is a legitimate GATHERING STAGE, not
  // an incomplete write — reads never need a write bound (owner directive
  // 2026-08-29 "she validates against the ask before a write"; live 2026-09-02
  // the model planned exactly this "read the sheet + the CRM, show the user,
  // then write after validation" and the old gate refused the validate-first
  // shape it was asked for). The write is a SEPARATE accepted action the model
  // plans after the user validates. The irreversible-send floor is unchanged:
  // that write still passes admission, the execution gate, and its approval.
  const draftHasWriteOperation = input.draft.topology.operations.some(
    (operation) => PLAN_WRITE_EFFECTS.has(operation.effect),
  );
  const writeDeferredForValidation =
    (requestedEffectScope === 'write' || requestedEffectScope === 'mixed')
    && !draftHasWriteOperation;
  // A write blocked purely on WHICH connected account to use is not a
  // discovery problem: no amount of tool_search resolves it, because the
  // ambiguity is a question for the user at the write boundary.
  // `accountSelection` is non-null exactly when a CITED write is waiting on a
  // connected-account choice — computed above, reused here.
  const accountBlockedWriteInDraft = accountSelection !== null;
  if (
    (requestedEffectScope === 'write' || requestedEffectScope === 'mixed')
    && draftHasWriteOperation
    && !planDraftHasHostAttestedWrite({
      draft: input.draft,
      capabilities: completenessCapabilities,
    })
  ) {
    // The draft DOES bind a write operation, but to a capability the host has
    // not attested — a broken write binding, not a deferred one. That is a
    // discovery question about the EXACT write, never a pick-from-list: handing
    // the card's other writes back as candidates is the same substitution
    // class as offering greenhouse/airtable for an Outlook ask (live
    // 2026-08-29 seq 98118). One tool_search for the named write, then plan.
    return JSON.stringify({
      ok: false,
      code: 'plan_incomplete_missing_write',
      detail: 'This draft binds a write operation to a capability the host has not attested. Bind the exact disclosed write, or drop the write to gather and validate first.',
      requestedEffectScope,
      // The detail names TWO doors; the repair used to name only the first,
      // and when the write is unbindable that is the impossible one. Live
      // 2026-09-03 run 24: the cited mail-draft write could not be bound because
      // two connected mailboxes make it account_selection_required, so "search
      // for the write" could never succeed — while the gathering-stage door the
      // comment above describes was open the whole time. Name the achievable
      // door first when the blocked write is waiting on an account choice
      // rather than on discovery.
      repair: accountBlockedWriteInDraft
        ? 'The write you bound is waiting on an account choice, so it cannot be bound yet. Plan the READ operations only and call plan_task again — an all-read draft is a legitimate gathering stage. Do the gathering, then plan the write as a separate accepted action once the account is settled.'
        : 'Use tool_search for the exact missing write capability, then call plan_task again with that exact capabilityRef bound to a local_write, external_write, or admin topology operation.',
      recoveryTool: accountBlockedWriteInDraft ? 'plan_task' : 'tool_search',
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
      recoveryTool: 'plan_task',
    });
  }
  const proposal = proposalFromDraft({ objective, draft: input.draft });
  const readBindingCounts = new Map<string, number>();
  for (const binding of input.draft.bindings) {
    readBindingCounts.set(
      binding.operationId,
      (readBindingCounts.get(binding.operationId) ?? 0) + 1,
    );
  }
  // Only the shape that needs no graph is refused before admission: one
  // once-cardinality read of a single record (coverage 'single' or none) with
  // no destination and no counted/structured collection contract. Every other
  // read-only draft — a complete_set, accepted_set, or resolved_operation
  // read, a counted set — is graph work whose route the compiler owns; a
  // lexical guess here refused a complete_set calendar read, its sibling
  // work_call was refused with it, nothing dispatched, and the turn still
  // published "done" (11788). Admission refuses non-act graphs before any
  // persist, and that refusal maps to the same typed answer below.
  const soleOperation = input.draft.topology.operations.length === 1
    ? input.draft.topology.operations[0]!
    : null;
  const graphNeutralReadDraft = input.draft.destination === null
    && (input.draft.cardinality === null
      || (input.draft.cardinality.count === 1 && !input.draft.cardinality.locator))
    && input.draft.bindings.length === 1
    && soleOperation !== null
    && soleOperation.effect === 'read'
    && (soleOperation.coverage === 'single' || soleOperation.coverage === null)
    && soleOperation.cardinality.kind === 'once';
  const reviewedLocalReadPlan = graphNeutralReadDraft
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
  if (graphNeutralReadDraft && !reviewedLocalReadPlan) {
    return JSON.stringify(GRAPH_NEUTRAL_READ_REFUSAL);
  }
  // The exact logical-call identity is needed only once a graph is about to
  // persist (the immutable seal intent commits in that same transaction) and
  // again after admission. Requiring it BEFORE admission turned every typed
  // pre-admission refusal — namespace conflict, plan_not_required, account
  // selection, missing write — into a thrown Error that the SDK laundered
  // into "An error occurred while running the tool" (12041). The frame is an
  // AsyncLocalStorage store, so it is visible inside the synchronous persist
  // callback of this same async chain.
  const requirePlanIdentity = (stage: string) => {
    const logical = currentLogicalCall();
    if (!logical || logical.logicalToolCallId !== logical.logicalToolCallId.trim()) {
      throw new Error(`plan_task lost its exact logical-call identity before ${stage}`);
    }
    return {
      sessionId,
      sourceUserSeq,
      acceptedTaskId: logical.acceptedTaskId,
      logicalToolCallId: logical.logicalToolCallId,
    };
  };
  const deliveryOwner = context.onConversationPreamble
    ? 'carrier_owned' as const
    : 'durable_conversation' as const;
  const operationIds = input.draft.topology.operations.map((operation) => operation.id);
  const planned = await admitAndCompilePrimaryModelProposal({
    identity: { sessionId, sourceUserSeq, turn },
    surface: 'direct',
    proposal,
    planningCatalogAuthority: planning.authority,
    ...(continuation ? { verifiedTaskContinuation: continuation } : {}),
    onFirstPersistInTransaction: (db, graphEvent) => {
      recordPlanTaskBindingSealIntentInTransaction({
        db,
        identity: requirePlanIdentity('graph persistence'),
        graphEvent,
        objective,
        operationIds,
        preamble,
        deliveryOwner,
      });
    },
  });
  if (!planned.ok) {
    // The compiler routed this proposal as non-action work and admission
    // refused it before any persist: the same graph-neutral answer, from the
    // route owner rather than from a lexical guess.
    if (planned.reason === NON_ACTION_GRAPH_ADMISSION_REASON) {
      return JSON.stringify(GRAPH_NEUTRAL_READ_REFUSAL);
    }
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
    const withheld = (repairPlanning.withheld ?? []).slice(0, PLAN_REFUSAL_REPAIR_CAP);
    const withheldWrite = withheld.find((entry) => (
      entry.effect === 'external_write' || entry.effect === 'local_write' || entry.effect === 'admin'
    ));
    const withheldRepair = withheldWrite
      ? ` The host proved ${withheldWrite.id} (${withheldWrite.effect}) this turn but withheld it from the planning card (${withheldWrite.reason}). It is not missing and the connector is not down.`
      : withheld.length > 0
        ? ` The host withheld ${withheld.length} ceiling-matching capabilities from this card: ${withheld.map((entry) => `${entry.id}:${entry.effect}:${entry.reason}`).join(', ')}.`
        : '';
    const recoveryTool = planAdmissionRecoveryTool(planned.reason, admissibleCapabilities);
    const repair = recoveryTool === 'retry_host'
      ? 'The host refused its own internal step, not your proposal. retry_host is a host action, not a tool: call plan_task once more with the IDENTICAL arguments. Do not call call_tool, rediscover, substitute capabilities, or change the plan.'
      : recoveryTool === 'stop_factual'
        ? 'State factually that the current policy does not admit the requested effect. Do not retry planning or discovery.'
        : (verifierRepairInstruction(planned.reason)
          ?? undisclosedRefRepairInstruction(planned.reason, admissibleCapabilities.length)
          ?? (admissibleCapabilities.length > 0
            ? 'Correct the semantic proposal using only a capabilityRef from admissibleCapabilities with the matching effect, then call plan_task again. It may stand alone or be followed in the same frame by exactly one proposal-free dependency-root read/compute work_call.'
            : 'No citable capability is currently available. Use tool_search once for the missing role, then call plan_task with only the exact capabilityRef it returns.'))
          + withheldRepair;
    return JSON.stringify({
      ok: false,
      code: 'plan_not_admitted',
      detail: planned.reason,
      reasonCode: boundedPlanAdmissionReasonCode(planned.reason),
      admissibleCapabilities,
      ceiling: repairPlanning.effectCeiling,
      withheld,
      // A verifier refusal is not a "pick a different capability" problem — the
      // cited write is correct and simply needs a readback partner. Handing the
      // generic advice here sent the model round the admissible list looking
      // for a substitute that does not exist.
      repair,
      recoveryTool,
    });
  }
  const planIdentity = requirePlanIdentity('binding seal');
  const sealIntent = exactPlanTaskBindingSealIntent({ sessionId, sourceUserSeq });
  if (
    !sealIntent
    || sealIntent.identity.acceptedTaskId !== planIdentity.acceptedTaskId
    || sealIntent.identity.logicalToolCallId !== planIdentity.logicalToolCallId
    || sealIntent.graphEvent.id !== planned.event.id
    || sealIntent.graph.compiler.graphHash !== planned.compiled.graph.compiler.graphHash
  ) {
    throw new Error('plan_task admitted graph has no exact immutable binding-seal owner');
  }
  planTaskPreparationTestHooks?.afterGraphIntentPersisted?.(planIdentity);
  const authority = requireAcceptedTaskAuthority({ sessionId, sourceUserSeq });
  const preparedExpectedWork = prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq,
    proposal: planned.compiled.graph.workTopology?.topology,
  });
  if (preparedExpectedWork.status !== 'prepared') {
    throw new Error(`plan_task could not prepare its exact expected-work contract: ${preparedExpectedWork.reason}`);
  }
  const bindingSealInput = {
    sessionId,
    sourceUserSeq,
    acceptedTaskId: authority.acceptedTaskId,
    acceptedText: objective,
    graph: planned.compiled.graph,
    operationIds,
    workContractId: preparedExpectedWork.contract.contractId,
  };
  const expectedWork = freezePrimaryModelExpectedWorkContract({ sessionId, sourceUserSeq });
  if (expectedWork.status !== 'fixed' && expectedWork.status !== 'replayed') {
    throw new Error('plan_task admitted a graph whose expected-work topology is not deterministically projectable');
  }
  if (
    expectedWork.contract.contractId !== preparedExpectedWork.contract.contractId
    || expectedWork.contract.contractId !== sealIntent.contractId
  ) {
    throw new Error('plan_task expected-work contract changed between durable intent and freeze');
  }

  let bindingSeal = await sealFreshPlanCapabilityBindings(bindingSealInput);
  // Every seal failure here is host-owned and occurs after the graph is
  // write-once. Semantically invalid verifier topology was refused before the
  // graph/intent transaction, so the identical seal is always the only safe
  // retry at this point.
  if (!bindingSeal.ok) {
    bindingSeal = await sealFreshPlanCapabilityBindings(bindingSealInput);
  }
  if (!bindingSeal.ok) {
    // The immutable intent owns this host-only continuation. Throw so the
    // control call settles non-successfully and restart reconciliation retries
    // only this exact seal; the model must never re-plan an immutable graph.
    throw new Error(`plan_task binding seal recovery pending: ${bindingSeal.reason}`);
  }
  if (planIdentity.acceptedTaskId !== authority.acceptedTaskId) {
    throw new Error('plan_task logical-call owner disagrees with accepted task authority');
  }
  // `conversation_preamble` is a user-visible durable lane. Append it only
  // after the graph, contract, and every exact capability binding are sealed;
  // the immutable intent retains the same text across a crash before append.
  const persisted = appendConversationPreambleOnce({ source, text: preamble });
  recordPlanTaskPreparationCheckpoint({
    identity: planIdentity,
    preamble: persisted.event,
    deliveryOwner,
  });
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
    identity: planIdentity,
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
    next: writeDeferredForValidation
      ? 'This is a read/gather stage for a request that will also write. Invoke each plan-selected read through work_call with proposal:null and its exact requirement_id, then present what you found and ask the user to validate before the write. The write is a SEPARATE step you plan after they say go — do NOT claim the task is done.'
      : bindingSeal.unverifiedMutations.length > 0
      ? 'Invoke each plan-selected operation through work_call with proposal:null and its exact requirement_id. After a write, if the host could not read it back, tell the user you wrote and could not confirm — never claim done.'
      : 'Use tool_search as needed, then invoke each plan-selected local read or business operation through work_call with proposal:null and its exact requirement_id.',
    ...(writeDeferredForValidation ? { writeDeferred: true } : {}),
    ...(bindingSeal.unverifiedMutations.length > 0
      ? { unverifiedMutations: bindingSeal.unverifiedMutations }
      : {}),
  });
}

export function buildPlanTaskTool(input: {
  planning: HostFreshPlanningContextV1;
}): Tool<RuntimeContextValue> {
  // The description below re-renders the planning card, which grows with
  // same-source disclosures across re-primes (including a crash-resume). It
  // is turn state the model reads, not the callable contract, so the shipped
  // schema fingerprint covers name + parameters only (capability-envelope.ts).
  return Object.assign(tool({
    name: 'plan_task',
    description: [
      'Admit and freeze one action plan or exact reviewed Clementine-local read plan for the current accepted request inside this foreground model loop.',
      'Reads never need a plan: run any disclosed read through work_call first and look at the data. Call this tool for the write, or for a multi-operation action, once the data is in hand. Resolve any missing exact capability refs with tool_search first. Then call this tool first in its tool-call frame. It may stand alone, or it may be followed by exactly one proposal-free work_call for a dependency-root read/compute operation declared in this draft. No write, admin, unknown, dependent, or additional sibling is allowed. Include the brief user-facing preamble in this call.',
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
  }), { descriptionCarriesTurnState: true as const });
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
  // Host-authored repair key over the violated PATHS and their messages (no
  // argument values): the no-progress projection keys the stage on it, so a
  // draft that fixes one complaint and receives a different one registers
  // as progress instead of "the same schema failure again" (live 2026-09-01:
  // four distinct plan_task complaints in a row terminalized a converging
  // authoring turn). Same paths → same key → the loop floor still holds.
  const repairKey = issues.length > 0
    ? createHash('sha256').update(JSON.stringify([...new Set(issues)].sort())).digest('hex').slice(0, 32)
    : undefined;
  return JSON.stringify({
    ok: false,
    code: 'plan_invalid_input',
    detail: detail.slice(0, 4_000),
    repair: 'Fix exactly the named paths and call plan_task again; do not resend the identical arguments.',
    recoveryTool: 'plan_task',
    ...(repairKey ? { repairKey } : {}),
  });
}

/** plan_task is a first-class host control only. It is deliberately absent
 * from local MCP/call_tool so wrappers cannot race the sole-call barrier. */
export function registerPlanTools(_server: McpServer): void {
  // no-op by design
}
