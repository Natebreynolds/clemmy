import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ActionWorkTopologySchema,
  ActionWorkTopologyBaseSchema,
  validateWorkTopology,
  workTopologyDigest,
} from '../graph/work-topology.js';

/**
 * Transient model-owned interpretation for one accepted turn.
 *
 * This is deliberately NOT a task store, graph, work contract, approval, or
 * execution authority. The model may propose meaning; the host supplies source
 * identity and checks every durable reference. A later adapter may project a
 * checked proposal into the existing graph/work types, but this value must
 * never be persisted as a competing source of truth.
 */
export const TURN_SEMANTIC_PROPOSAL_VERSION = 1 as const;
const CONTEXT_CHECKED_SEMANTICS_SCOPE = 'semantics_only_no_execution_authority' as const;
const CHECKED_TURN_SEMANTICS: unique symbol = Symbol('checked-turn-semantics');
const checkedSemanticEnvelopes = new WeakSet<object>();

const MAX_OBJECTIVE_CHARS = 8_000;
const MAX_CRITERIA = 64;
const MAX_CRITERION_CHARS = 2_000;
const MAX_OPEN_SLOTS = 8;
const MAX_OPTIONS_PER_SLOT = 8;
const MAX_LABEL_CHARS = 1_000;
const MAX_CANDIDATES = 128;
const MAX_SLOT_ANSWERS = 1;
const MAX_SLOT_VALUE_CHARS = 4_000;
const MAX_RATIONALE_CHARS = 2_000;

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/_-]{0,127}$/;

const opaqueIdSchema = z.string().min(1).max(128).regex(OPAQUE_ID_RE);
const nonBlankString = (max: number) => z.string().min(1).max(max).regex(/\S/);

const goalRefSchema = z.object({
  goalId: opaqueIdSchema,
  baseRevision: z.number().int().nonnegative(),
}).strict();

const goalCriterionSchema = z.object({
  id: opaqueIdSchema,
  /** Diagnostic semantic statement. Host authority code must not parse it. */
  statement: nonBlankString(MAX_CRITERION_CHARS),
}).strict();

const openSlotSchema = z.object({
  slotKey: opaqueIdSchema,
  /** User-facing wording only. It grants no authority. */
  question: nonBlankString(MAX_LABEL_CHARS),
  options: z.array(z.object({
    optionId: opaqueIdSchema,
    label: nonBlankString(MAX_LABEL_CHARS),
  }).strict()).max(MAX_OPTIONS_PER_SLOT),
  allowFreeText: z.boolean(),
}).strict();

const candidateRefSchema = z.object({
  kind: z.enum(['capability', 'workflow']),
  /** Opaque host catalog identity. It is advisory until separately admitted. */
  id: opaqueIdSchema,
}).strict();

const semanticGoalDraftSchema = z.object({
  objective: nonBlankString(MAX_OBJECTIVE_CHARS),
  /** Opaque diagnostic ids. Host code must not attach executable meaning. */
  criteria: z.array(goalCriterionSchema).min(1).max(MAX_CRITERIA),
  openSlots: z.array(openSlotSchema).max(MAX_OPEN_SLOTS),
  candidates: z.array(candidateRefSchema).max(MAX_CANDIDATES),
}).strict();

const requestedEffectSchema = z.enum([
  'none',
  'read',
  'compute',
  'host_only',
  'unknown',
  'local_write',
  'external_write',
  'admin',
]);

const proposedOperationSchema = z.object({
  id: opaqueIdSchema,
  /** Capability role, never a tool/provider slug. */
  role: opaqueIdSchema,
  requestedEffect: requestedEffectSchema,
  /**
   * Required. Every operation, including host_only, names an exact host-issued
   * capability identity. Human-language roles never authorize.
   */
  capabilityRef: opaqueIdSchema,
  dependsOn: z.array(opaqueIdSchema).max(32),
  evidence: z.array(opaqueIdSchema).max(32),
}).strict();

const proposedDeliverableSchema = z.object({
  id: opaqueIdSchema,
  kind: opaqueIdSchema,
}).strict();

const proposedDestinationSchema = z.object({
  posture: z.enum(['create_new', 'named_existing']),
  family: opaqueIdSchema,
  handleRequired: z.boolean(),
}).strict();

/** Independent source/effect judge. Assesses the proposed effect/posture. */
export const SourceEffectJudgeV1Schema = z.object({
  verdict: z.enum(['entailed', 'conflict', 'uncertain']),
  effect: requestedEffectSchema,
  destinationPosture: z.enum(['create_new', 'named_existing']).nullable(),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  rationale: z.string().max(MAX_RATIONALE_CHARS),
}).strict();

export type SourceEffectJudgeV1 = z.infer<typeof SourceEffectJudgeV1Schema>;

/** Independent grounding judge. Assesses one exact named capability. */
export const CapabilityGroundingJudgeV1Schema = z.object({
  verdict: z.enum(['entailed', 'conflict', 'uncertain']),
  capabilityRef: opaqueIdSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  rationale: z.string().max(MAX_RATIONALE_CHARS),
}).strict();

export type CapabilityGroundingJudgeV1 = z.infer<typeof CapabilityGroundingJudgeV1Schema>;

/** One whole-plan grounding judgment. The model does not copy authority hashes. */
export const PlanGroundingOperationVerdictV1Schema = z.object({
  operationId: opaqueIdSchema,
  verdict: z.enum(['entailed', 'conflict', 'uncertain']),
  rationale: z.string().max(MAX_RATIONALE_CHARS),
}).strict();

export const PlanGroundingJudgeV1Schema = z.object({
  verdict: z.enum(['entailed', 'conflict', 'uncertain']),
  operations: z.array(PlanGroundingOperationVerdictV1Schema).max(32),
}).strict();

export type PlanGroundingOperationVerdictV1 = z.infer<typeof PlanGroundingOperationVerdictV1Schema>;
export type PlanGroundingJudgeV1 = z.infer<typeof PlanGroundingJudgeV1Schema>;

/** Structured work the model proposes. IDs are opaque; meaning is in kinds. */
const proposedSemanticWorkV1BaseSchema = z.object({
  construct: z.enum(['none', 'collect_then_construct', 'fanout', 'single_act']),
  cardinality: z.object({
    count: z.number().int().min(1).max(10_000),
    fields: z.array(opaqueIdSchema).max(32),
  }).strict().nullable(),
  /**
   * Canonical sink list. Empty/omitted/null means no destination.
   *
   * `.nullish()`, never bare `.optional()`: the OpenAI strict structured-output
   * transform rejects an optional field that is not also nullable, so a bare
   * `.optional()` here makes the whole proposal schema unusable at runtime
   * (`semantic-schema-strictness` pins exactly this — the same trap recorded
   * after the last occurrence).
   */
  destinations: z.array(proposedDestinationSchema).max(8).nullish(),
  /** Projection of destinations[0] for existing proposal authors. */
  destination: proposedDestinationSchema.nullable(),
  requestedEffect: requestedEffectSchema,
  /** The one provider-neutral operation topology. Capability bindings below
   * annotate these ids; they do not restate cardinality, coverage, or lineage. */
  // The BASE (wire) shape carries the topology's structural schema only; its
  // cross-field refinements fire at admission via validateWorkTopology in the
  // refined schema's superRefine. Carrying the refined topology here re-threw
  // the exact class at the transport (live 2026-08-25: weekly-review
  // assess_goals, "coverage and cardinality describe different read sets"
  // still labelled model_failed AFTER the first wire split — the refinement
  // lived one level deeper than the work schema).
  topology: ActionWorkTopologyBaseSchema.nullish(),
  /** Content digest when topology is present. Admission recomputes it; the
   * model cannot grant authority by supplying a matching string. */
  topologyHash: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  operations: z.array(proposedOperationSchema).max(32),
  deliverables: z.array(proposedDeliverableSchema).max(32),
  evidenceRequirements: z.array(opaqueIdSchema).max(32),
}).strict();

export const ProposedSemanticWorkV1Schema = proposedSemanticWorkV1BaseSchema.superRefine((work, ctx) => {
  const listed = work.destinations ?? [];
  if (listed.length > 0 && work.destination) {
    const first = listed[0]!;
    if (
      first.posture !== work.destination.posture
      || first.family !== work.destination.family
      || first.handleRequired !== work.destination.handleRequired
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinations', 0],
        message: 'destinations[0] must match destination',
      });
    }
  }
  if (work.topology) {
    // ADMISSION owns the topology's full contract. The base field above is the
    // structural wire shape only, so every ActionWorkTopologySchema refinement
    // (DAG/cross-field checks AND the inline-members cap — and anything added
    // to it later) must be enforced here, by parsing against the refined
    // schema itself rather than re-listing its checks. Re-listing is how the
    // inline-members cap would have silently dropped out of admission when the
    // wire split moved the field to the base shape.
    const refinedTopology = ActionWorkTopologySchema.safeParse(work.topology);
    if (!refinedTopology.success) {
      for (const issue of refinedTopology.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['topology', ...issue.path],
          message: issue.message,
        });
      }
      return;
    }
    // The digest is HOST-computed and grants no authority (see the field's own
    // doc comment). Demanding it from the model gated every topology-bearing
    // proposal on a sha256 the model cannot produce: live 2026-08-24 the
    // scorpion-facebook-trends workflow step failed admission with
    // `model_failed` at "work.topologyHash", and the run ended blocked telling
    // a scheduled step to "restate it". The host derives the digest from the
    // normalized topology at admission; a digest the model DOES supply is still
    // checked below, so a wrong one can never pass.
    const validatedTopology = validateWorkTopology(work.topology);
    if (!validatedTopology.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topology'],
        message: validatedTopology.errors.join('; '),
      });
      return;
    }
    if (
      work.topologyHash
      && workTopologyDigest(validatedTopology.topology) !== work.topologyHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topologyHash'],
        message: 'topologyHash does not match the normalized topology',
      });
    }
    const bindings = new Map(work.operations.map((operation) => [operation.id, operation]));
    if (bindings.size !== work.operations.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'topology capability bindings must have unique operation ids',
      });
    }
    const topologyIds = new Set(validatedTopology.topology.operations.map((operation) => operation.id));
    if (topologyIds.size !== bindings.size || [...topologyIds].some((id) => !bindings.has(id))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'topology and capability bindings must cover the same operation ids',
      });
    }
    // The topology is CANONICAL and this schema says so: "Capability bindings
    // below annotate these ids; they do not restate cardinality, coverage, or
    // lineage." Requiring the binding to ALSO restate `effect` and `dependsOn`
    // -- byte-for-byte and in order -- contradicted that, and made a whole
    // workflow die on a duplication mistake. Live 2026-08-24, three scheduled
    // workflows blocked in one batch:
    //   daily-standup-email -> "capability binding effect must match the canonical topology"
    //   morning-briefing    -> "capability binding dependencies must match the canonical topology"
    // Admission RECONCILES against the canonical topology instead (see
    // reconcileOperationToTopology): lineage is taken from the topology, and
    // effect takes the MORE RESTRICTIVE of the two, so reconciliation can never
    // escalate authority. Coverage is still enforced above -- every topology id
    // must still have a binding and vice versa.
  } else if (work.topologyHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['topologyHash'],
      message: 'topologyHash is invalid without a topology',
    });
  }
});

const slotAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('option'),
    questionId: opaqueIdSchema,
    slotKey: opaqueIdSchema,
    optionId: opaqueIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('value'),
    questionId: opaqueIdSchema,
    slotKey: opaqueIdSchema,
    value: nonBlankString(MAX_SLOT_VALUE_CHARS),
  }).strict(),
]);

export const TurnSemanticProposalV1Schema = z.object({
  version: z.literal(TURN_SEMANTIC_PROPOSAL_VERSION),
  relation: z.enum([
    'conversation',
    'new_goal',
    'continue_goal',
    'answer_open_slot',
    'amend_goal',
    'abandon_goal',
    'ambiguous',
  ]),
  targetGoal: goalRefSchema.nullable(),
  goal: semanticGoalDraftSchema.nullable(),
  work: ProposedSemanticWorkV1Schema.nullable(),
  slotAnswers: z.array(slotAnswerSchema).max(MAX_SLOT_ANSWERS),
  /** Bounded telemetry only. Validators must never derive authority from it. */
  rationale: z.string().max(MAX_RATIONALE_CHARS),
}).strict();

/**
 * The WIRE variant: identical shape, no semantic refinements.
 *
 * The full schema serves two masters. As the SDK `outputType` it made every
 * semantic refinement failure THROW inside runner.run — labelled
 * `model_failed`, bypassing the bounded one-repair gate entirely — while the
 * identical check at admission produces a typed issue that IS repairable. All
 * six `model_failed` records since 2026-08-24 were this: our own topology /
 * dependsOn / requestedEffect refinements firing at the transport layer, one
 * layer before the repair they were entitled to. Zero were provider errors.
 *
 * So the wire accepts anything structurally parseable, and admission — which
 * has ALWAYS re-validated the raw with the full schema, refinements included —
 * stays the sole judge. Nothing is weakened: a proposal that fails a
 * refinement still never compiles; it now fails where the repair loop can see
 * it. (Deliberately NOT the forbidden variant: the refinements were not
 * removed from the admission schema, which would have left topology unchecked.)
 */
export const TurnSemanticProposalV1WireSchema = z.object({
  version: z.literal(TURN_SEMANTIC_PROPOSAL_VERSION),
  relation: z.enum([
    'conversation',
    'new_goal',
    'continue_goal',
    'answer_open_slot',
    'amend_goal',
    'abandon_goal',
    'ambiguous',
  ]),
  targetGoal: goalRefSchema.nullable(),
  goal: semanticGoalDraftSchema.nullable(),
  work: proposedSemanticWorkV1BaseSchema.nullable(),
  slotAnswers: z.array(slotAnswerSchema).max(MAX_SLOT_ANSWERS),
  rationale: z.string().max(MAX_RATIONALE_CHARS),
}).strict();

export type TurnSemanticProposalV1 = z.infer<typeof TurnSemanticProposalV1Schema>;
export type TurnRelationV1 = TurnSemanticProposalV1['relation'];
export type GoalRefV1 = NonNullable<TurnSemanticProposalV1['targetGoal']>;
export type SemanticGoalDraftV1 = NonNullable<TurnSemanticProposalV1['goal']>;
export type ProposedSemanticWorkV1 = NonNullable<TurnSemanticProposalV1['work']>;
export type SlotAnswerV1 = TurnSemanticProposalV1['slotAnswers'][number];
export type RequestedSemanticEffectV1 = ProposedSemanticWorkV1['requestedEffect'];
export type ProposedDestinationV1 = NonNullable<ProposedSemanticWorkV1['destination']>;

export function workDestinationsOf(
  work: Pick<ProposedSemanticWorkV1, 'destination' | 'destinations'>,
): ProposedDestinationV1[] {
  if (work.destinations && work.destinations.length > 0) return [...work.destinations];
  return work.destination ? [work.destination] : [];
}

export interface ResumableGoalViewV1 {
  goalId: string;
  baseRevision: number;
  objective?: string;
  constraints?: ReadonlyArray<{ id: string; kind: string }>;
  openSlots?: ReadonlyArray<{ slotKey: string; question: string }>;
  checkpointRef?: string;
  settledEvidenceRefs?: readonly string[];
}

export interface OpenQuestionViewV1 {
  questionId: string;
  goalId: string;
  goalRevision: number;
  slotKey: string;
  /** Exact delivered wording. */
  question: string;
  options: ReadonlyArray<{ optionId: string; label: string }>;
  allowFreeText: boolean;
}

export interface TurnSemanticHostViewV1 {
  /** Accepted-source identity is host-owned and absent from model output. */
  source: {
    sessionId: string;
    sourceUserSeq: number;
    inputHash: string;
    audienceHash: string;
  };
  /** SHA-256 of the independently loaded host policy snapshot. */
  policyRevision: string;
  /** Bounded host-selected candidates; the model chooses which one it means. */
  resumableGoals: readonly ResumableGoalViewV1[];
  openQuestions: readonly OpenQuestionViewV1[];
  catalog: {
    capabilityIds: ReadonlySet<string>;
    workflowIds: ReadonlySet<string>;
    /** Provider-neutral descriptors. Role labels may rank; they never authorize. */
    capabilities?: readonly HostCapabilityDescriptorV1[];
  };
}

export const GroundingDescriptorViewV1Schema = z.object({
  id: opaqueIdSchema,
  effect: requestedEffectSchema,
  purpose: z.string().min(1).max(256),
  acceptedInputKinds: z.array(opaqueIdSchema).min(1).max(8),
  producedOutputKinds: z.array(opaqueIdSchema).min(1).max(8),
  applicableDeliverableKinds: z.array(opaqueIdSchema).min(1).max(8),
  destinationPosture: z.enum(['create_new', 'named_existing']).nullable(),
  evidenceKinds: z.array(opaqueIdSchema).max(16),
  handleRequired: z.boolean(),
  readbackRequired: z.boolean(),
  accountScope: z.string().min(1).max(256),
}).strict();

export type GroundingDescriptorViewV1 = z.infer<typeof GroundingDescriptorViewV1Schema>;

export function groundingDescriptorViewFromHost(
  descriptor: HostCapabilityDescriptorV1,
): GroundingDescriptorViewV1 {
  return {
    id: descriptor.id,
    effect: descriptor.effect,
    purpose: descriptor.purpose,
    acceptedInputKinds: [...descriptor.acceptedInputKinds],
    producedOutputKinds: [...descriptor.producedOutputKinds],
    applicableDeliverableKinds: [...descriptor.applicableDeliverableKinds],
    destinationPosture: descriptor.destinationPosture,
    evidenceKinds: [...descriptor.evidenceKinds],
    handleRequired: descriptor.handleRequired,
    readbackRequired: descriptor.readbackRequired,
    accountScope: descriptor.accountScope,
  };
}

export function groundingDescriptorViewDigest(views: readonly GroundingDescriptorViewV1[]): string {
  return createHash('sha256').update(canonicalJson(views), 'utf8').digest('hex');
}

export interface HostCapabilityDescriptorV1 {
  id: string;
  effect: 'none' | 'read' | 'compute' | 'host_only' | 'unknown' | 'local_write' | 'external_write' | 'admin';
  /** Provider-neutral operation purpose. Not a tool slug. */
  purpose: string;
  acceptedInputKinds: readonly string[];
  producedOutputKinds: readonly string[];
  applicableDeliverableKinds: readonly string[];
  inputShape: string;
  outputShape: string;
  outputKind: string;
  deliverableKind: string;
  destinationPosture: 'create_new' | 'named_existing' | null;
  evidenceKinds: readonly string[];
  handleRequired: boolean;
  readbackRequired: boolean;
  accountScope: string;
  manifestDigest: string;
  advisoryRoles?: readonly string[];
}

export const MAX_HOST_CAPABILITY_DESCRIPTORS = 32;
export const MAX_HOST_DESCRIPTOR_SERIALIZED_BYTES = 16_384;

export function boundHostCapabilityDescriptors(
  descriptors: readonly HostCapabilityDescriptorV1[],
): HostCapabilityDescriptorV1[] {
  const bounded: HostCapabilityDescriptorV1[] = [];
  let bytes = 2;
  for (const descriptor of descriptors.slice(0, MAX_HOST_CAPABILITY_DESCRIPTORS)) {
    const encoded = JSON.stringify(descriptor);
    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    const next = bytes + encodedBytes + (bounded.length > 0 ? 1 : 0);
    if (next > MAX_HOST_DESCRIPTOR_SERIALIZED_BYTES) break;
    bounded.push(descriptor);
    bytes = next;
  }
  return bounded;
}

function resolveDescriptorSuccessorId(
  id: string,
  byId: Map<string, HostCapabilityDescriptorV1>,
): string | undefined {
  if (byId.has(id)) return id;
  return [...byId.keys()].find((key) => key.startsWith(`${id}:v`) || key.startsWith(`${id}:`));
}

export function shownGroundingDescriptors(input: {
  descriptors: readonly HostCapabilityDescriptorV1[];
  referencedIds: readonly (string | null | undefined)[];
}): { ok: true; shown: GroundingDescriptorViewV1[]; digest: string } | { ok: false; code: string; message: string; capabilityRef?: string } {
  const uniqueRefs: string[] = [];
  for (const id of input.referencedIds) {
    if (typeof id !== 'string' || !id.trim()) continue;
    if (!uniqueRefs.includes(id)) uniqueRefs.push(id);
  }
  const byId = new Map(input.descriptors.map((entry) => [entry.id, entry]));
  const selected: HostCapabilityDescriptorV1[] = [];
  const boundRefs: string[] = [];
  for (const id of uniqueRefs) {
    const successorId = resolveDescriptorSuccessorId(id, byId);
    const descriptor = byId.get(id) ?? (successorId ? byId.get(successorId) : undefined);
    if (!descriptor) {
      return {
        ok: false,
        code: 'unknown_capability_ref',
        message: 'capability reference is not present in the frozen host catalog',
        capabilityRef: id,
      };
    }
    selected.push(descriptor);
    if (!boundRefs.includes(descriptor.id)) boundRefs.push(descriptor.id);
  }
  const bounded = boundHostCapabilityDescriptors(selected);
  const shown = bounded.map((entry) => groundingDescriptorViewFromHost(entry));
  const shownIds = shown.map((entry) => entry.id);
  for (const id of boundRefs) {
    const count = shownIds.filter((shownId) => shownId === id).length;
    if (count !== 1) {
      return {
        ok: false,
        code: 'grounding_descriptor_omitted',
        message: 'referenced capability descriptor omitted from the grounding judge request',
        capabilityRef: id,
      };
    }
  }
  return {
    ok: true,
    shown,
    digest: groundingDescriptorViewDigest(shown),
  };
}

export interface TurnSemanticValidationIssue {
  code: string;
  path: string;
  message: string;
  operationId?: string;
  capabilityRef?: string;
}

export interface ContextCheckedTurnSemanticProposalV1 {
  readonly scope: typeof CONTEXT_CHECKED_SEMANTICS_SCOPE;
  readonly source: Readonly<TurnSemanticHostViewV1['source']>;
  /** Proposal-only telemetry. It is never a replay or authority identity. */
  readonly payloadHash: string;
  /**
   * Digest of the semantic payload (excluding rationale) plus the exact host
   * source, audience, resumable goals, and visible question snapshot. It still
   * cannot replace the durable event/CAS identity at a later boundary.
   */
  readonly contextHash: string;
  readonly proposal: TurnSemanticProposalV1;
  readonly [CHECKED_TURN_SEMANTICS]: true;
}

export type TurnSemanticValidationResult =
  | { ok: true; checked: ContextCheckedTurnSemanticProposalV1 }
  | { ok: false; issues: TurnSemanticValidationIssue[] };

function issue(
  issues: TurnSemanticValidationIssue[],
  code: string,
  path: string,
  message: string,
  extra: { operationId?: string; capabilityRef?: string } = {},
): void {
  issues.push({ code, path, message, ...extra });
}

function exactGoalRef(a: GoalRefV1 | null, b: GoalRefV1 | null): boolean {
  return a !== null
    && b !== null
    && a.goalId === b.goalId
    && a.baseRevision === b.baseRevision;
}

function hostOffersGoal(host: TurnSemanticHostViewV1, target: GoalRefV1 | null): boolean {
  return target !== null && host.resumableGoals.some((candidate) => exactGoalRef(candidate, target));
}

function requireExactActiveGoal(
  proposal: TurnSemanticProposalV1,
  host: TurnSemanticHostViewV1,
  issues: TurnSemanticValidationIssue[],
): void {
  if (!hostOffersGoal(host, proposal.targetGoal)) {
    issue(
      issues,
      'target_goal_mismatch',
      'targetGoal',
      'target goal and base revision must exactly match one host-offered resumable goal',
    );
  }
}

/**
 * Does this work object ask for anything to happen?
 *
 * `work === null` is one way a proposal says "no work", and it was treated as
 * the ONLY way. A model that fills the schema's shape instead — every list
 * empty, construct `none`, effect `none` — was read as carrying work, so a
 * plain greeting failed the conversation branch and the whole turn terminated
 * `blocked` with "I could not finish planning that". Live 2026-08-22: a canary
 * that asked only for a fixed sentence back; and 2026-08-21, the same shape
 * inside a workflow synthesis.
 *
 * Emptiness is the honest test, because the invariant this protects is that a
 * conversation must not smuggle executable intent — and nothing can execute
 * without an operation or a deliverable to bind. The effect enum is still
 * checked so a proposal that CLAIMS a write is never quietly read as inert.
 */
function workRequestsNothing(work: TurnSemanticProposalV1['work']): boolean {
  if (work === null) return true;
  return work.construct === 'none'
    && work.operations.length === 0
    && work.deliverables.length === 0
    && work.evidenceRequirements.length === 0
    && work.cardinality === null
    && work.destination === null
    && (work.destinations ?? []).length === 0
    && (work.requestedEffect === 'none'
      || work.requestedEffect === 'compute'
      || work.requestedEffect === 'host_only');
}

function validateRelationMatrix(
  proposal: TurnSemanticProposalV1,
  host: TurnSemanticHostViewV1,
  issues: TurnSemanticValidationIssue[],
): void {
  const noAnswers = proposal.slotAnswers.length === 0;
  // Two different questions were being asked of one flag, and conflating them
  // is what turned a greeting into a blocked turn.
  //
  //  - "does this relation illegally CARRY work?" — asked by conversation,
  //    continue_goal and answer_open_slot. A work object that asks for nothing
  //    carries nothing, whatever its shape.
  //  - "did the proposal SUPPLY structured work?" — asked by new_goal and
  //    amend_goal, which need a plan to exist. That one still means a work
  //    object was provided at all, deliberately left as it was: making it
  //    inert-aware would newly reject a new_goal whose work is present but
  //    empty, which is a real question (an admitted graph with zero operations
  //    is the pathology behind the near-zero bind rate) but a separate change
  //    with its own blast radius. It does not belong in this fix.
  const carriesNoWork = workRequestsNothing(proposal.work);
  const suppliedNoWork = proposal.work === null;
  switch (proposal.relation) {
    case 'conversation':
      if (proposal.targetGoal !== null || proposal.goal !== null || !carriesNoWork || !noAnswers) {
        issue(issues, 'illegal_relation_payload', '', 'conversation cannot carry goal, work, or slot answers');
      }
      return;
    case 'new_goal': {
      // Clarifying open-slots with no work are conversation, not illegal work.
      // Structured work remains required only when the proposal claims an
      // executable plan.
      // A goal WITHOUT structured work is the act-directly shape: "here is
      // what I am doing; I will do it with tools now." It admits and routes
      // as model-driven execution — no operations means nothing typed to
      // bind, so the turn proceeds through the ordinary tool loop under the
      // same effect gates as any other turn. Refusing it forced every brain
      // to fabricate a work topology for host-native tasks; the first Claude
      // proposal on the unified lane (live 2026-08-25, morning-briefing)
      // declared an honest goal with work:null and was blocked twice for the
      // shape alone. Structured work stays fully validated WHEN CLAIMED.
      if (
        proposal.targetGoal !== null
        || proposal.goal === null
        || !noAnswers
      ) {
        issue(issues, 'illegal_relation_payload', '', 'new_goal requires one goal and carries no target or slot answers');
      }
      return;
    }
    case 'continue_goal':
      requireExactActiveGoal(proposal, host, issues);
      if (proposal.goal !== null || !carriesNoWork || !noAnswers) {
        issue(issues, 'illegal_relation_payload', '', 'continue_goal cannot replace the goal, work, or answer slots');
      }
      return;
    case 'answer_open_slot':
      requireExactActiveGoal(proposal, host, issues);
      if (proposal.goal !== null || !carriesNoWork || noAnswers) {
        issue(issues, 'illegal_relation_payload', '', 'answer_open_slot requires slot answers and no replacement goal or work');
      }
      return;
    case 'amend_goal':
      requireExactActiveGoal(proposal, host, issues);
      if (proposal.goal === null || suppliedNoWork || !noAnswers) {
        issue(
          issues,
          'illegal_relation_payload',
          '',
          'amend_goal requires a full semantic goal and work replacement and cannot also settle a slot',
        );
      }
      return;
    case 'abandon_goal':
      requireExactActiveGoal(proposal, host, issues);
      if (proposal.goal !== null || !carriesNoWork || !noAnswers) {
        issue(issues, 'illegal_relation_payload', '', 'abandon_goal cannot replace the goal, work, or answer slots');
      }
      return;
    case 'ambiguous':
      if (proposal.goal !== null || !carriesNoWork || !noAnswers) {
        issue(issues, 'illegal_relation_payload', '', 'ambiguous cannot replace the goal, work, or settle slots');
      }
      if (proposal.targetGoal !== null) requireExactActiveGoal(proposal, host, issues);
  }
}

function repeated(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function validateGoalDraft(
  proposal: TurnSemanticProposalV1,
  host: TurnSemanticHostViewV1,
  issues: TurnSemanticValidationIssue[],
): void {
  const goal = proposal.goal;
  if (!goal) return;
  for (const id of repeated(goal.criteria.map((criterion) => criterion.id))) {
    issue(issues, 'duplicate_criterion_id', 'goal.criteria', `duplicate criterion id: ${id}`);
  }
  for (const slotKey of repeated(goal.openSlots.map((slot) => slot.slotKey))) {
    issue(issues, 'duplicate_slot_key', 'goal.openSlots', `duplicate slot key: ${slotKey}`);
  }
  for (const [index, slot] of goal.openSlots.entries()) {
    if (!slot.allowFreeText && slot.options.length === 0) {
      issue(
        issues,
        'unanswerable_open_slot',
        `goal.openSlots.${index}`,
        'an open slot must allow free text or expose at least one option',
      );
    }
    for (const optionId of repeated(slot.options.map((option) => option.optionId))) {
      issue(
        issues,
        'duplicate_option_id',
        `goal.openSlots.${index}.options`,
        `duplicate option id: ${optionId}`,
      );
    }
  }
  const candidateKeys = goal.candidates.map((candidate) => `${candidate.kind}:${candidate.id}`);
  for (const key of repeated(candidateKeys)) {
    issue(issues, 'duplicate_candidate', 'goal.candidates', `duplicate candidate: ${key}`);
  }
  // Candidates are ADVISORY hints recorded on the graph (candidateRefs) —
  // no dispatch, binding, or authority path reads them. They were still
  // validated against the disclosed catalogs as if they authorized work, and
  // that refusal killed real work: a workflow step truthfully naming ITS OWN
  // workflow as a goal candidate blocked twice (live 2026-08-25, morning-
  // briefing on the unified lane — the step catalog never discloses the
  // step's own workflow id). Authority stays where it is enforced: every
  // operation's capabilityRef keeps full citation/effect/grounding checks.
}

function validateProposedWork(
  proposal: TurnSemanticProposalV1,
  host: TurnSemanticHostViewV1,
  issues: TurnSemanticValidationIssue[],
): void {
  const work = proposal.work;
  if (!work) return;
  for (const id of repeated(work.operations.map((operation) => operation.id))) {
    issue(issues, 'duplicate_operation_id', 'work.operations', `duplicate operation id: ${id}`);
  }
  for (const id of repeated(work.deliverables.map((deliverable) => deliverable.id))) {
    issue(issues, 'duplicate_deliverable_id', 'work.deliverables', `duplicate deliverable id: ${id}`);
  }
  const knownOps = new Set(work.operations.map((operation) => operation.id));
  const catalogOpen = host.catalog.capabilityIds.size > 0;
  const descriptors = host.catalog.capabilities ?? [];
  // Host-native work (host_only/none/compute) is expressed WITHOUT a foreign
  // capability citation. Every citation requirement below must exempt the same
  // set, so the predicate is shared: when the two blocks diverged, an open
  // catalog left no admissible way to state host-native work and the only
  // path through admission was citing an irrelevant foreign capability.
  const hostNativeOperation = (operation: { requestedEffect: string }): boolean =>
    operation.requestedEffect === 'host_only'
    || operation.requestedEffect === 'none'
    || operation.requestedEffect === 'compute';
  for (const [index, operation] of work.operations.entries()) {
    for (const dep of operation.dependsOn) {
      if (!knownOps.has(dep)) {
        issue(issues, 'unknown_operation_dependency', `work.operations.${index}.dependsOn`, `unknown dependency: ${dep}`);
      }
    }
    if (!catalogOpen) continue;
    if (hostNativeOperation(operation)) continue;
    const descriptorById = new Map(descriptors.map((entry) => [entry.id, entry]));
    const boundId = host.catalog.capabilityIds.has(operation.capabilityRef)
      ? operation.capabilityRef
      : resolveDescriptorSuccessorId(operation.capabilityRef, descriptorById);
    if (!boundId || !host.catalog.capabilityIds.has(boundId)) {
      issue(
        issues,
        'unknown_capability_ref',
        `work.operations.${index}.capabilityRef`,
        'capability reference is not present in the host catalog',
      );
      continue;
    }
    const descriptor = descriptorById.get(boundId) ?? descriptors.find((entry) => entry.id === boundId);
    if (!descriptor) {
      issue(
        issues,
        'capability_descriptor_missing',
        `work.operations.${index}.capabilityRef`,
        'referenced capability has no descriptor in the shown catalog',
      );
      continue;
    }
    if (descriptor.effect !== operation.requestedEffect) {
      issue(
        issues,
        'capability_ref_effect_mismatch',
        `work.operations.${index}.capabilityRef`,
        'capability reference effect does not match the proposed operation',
      );
    }
  }
  if (catalogOpen && descriptors.length > 0) {
    const byOp = new Map(work.operations.map((operation) => [operation.id, operation]));
    const descriptorById = new Map(descriptors.map((entry) => [entry.id, entry]));
    const descriptorForRef = (capabilityRef: string) => (
      descriptorById.get(capabilityRef)
      ?? (() => {
        const bound = resolveDescriptorSuccessorId(capabilityRef, descriptorById);
        return bound ? descriptorById.get(bound) : undefined;
      })()
    );
    for (const operation of work.operations) {
      if (hostNativeOperation(operation)) continue;
      const successor = descriptorForRef(operation.capabilityRef);
      if (!successor) {
        issue(
          issues,
          'dag_kind_metadata_missing',
          `work.operations.${operation.id}`,
          'executable edge is missing a successor capability descriptor',
        );
        continue;
      }
      for (const dep of operation.dependsOn) {
        const predecessorOp = byOp.get(dep);
        // An edge with a host-native endpoint has no descriptor pair to
        // compare; kind flow is only checkable between two cited operations.
        if (predecessorOp && hostNativeOperation(predecessorOp)) continue;
        const predecessor = predecessorOp
          ? descriptorForRef(predecessorOp.capabilityRef)
          : undefined;
        if (!predecessor) {
          issue(
            issues,
            'dag_kind_metadata_missing',
            `work.operations.${operation.id}.dependsOn`,
            'executable edge is missing a predecessor capability descriptor',
          );
          continue;
        }
        const produced = predecessor.producedOutputKinds ?? [];
        const accepted = successor.acceptedInputKinds ?? [];
        if (!produced.some((kind) => accepted.includes(kind))) {
          issue(
            issues,
            'dag_kind_mismatch',
            `work.operations.${operation.id}.dependsOn`,
            'predecessor produced kinds do not satisfy successor accepted kinds',
            { operationId: predecessorOp?.id ?? operation.id, capabilityRef: predecessorOp?.capabilityRef },
          );
        }
      }
    }
  }
}

function validateSlotAnswers(
  proposal: TurnSemanticProposalV1,
  host: TurnSemanticHostViewV1,
  issues: TurnSemanticValidationIssue[],
): void {
  const answerKeys = proposal.slotAnswers.map((answer) => `${answer.questionId}:${answer.slotKey}`);
  for (const key of repeated(answerKeys)) {
    issue(issues, 'duplicate_slot_answer', 'slotAnswers', `duplicate slot answer: ${key}`);
  }
  for (const [index, answer] of proposal.slotAnswers.entries()) {
    const question = host.openQuestions.find((candidate) => (
      candidate.questionId === answer.questionId
      && candidate.slotKey === answer.slotKey
      && proposal.targetGoal !== null
      && candidate.goalId === proposal.targetGoal.goalId
      && candidate.goalRevision === proposal.targetGoal.baseRevision
    ));
    if (!question) {
      issue(
        issues,
        'question_slot_mismatch',
        `slotAnswers.${index}`,
        'slot answer does not match an open question on the exact target goal revision',
      );
      continue;
    }
    if (answer.kind === 'option' && !question.options.some((option) => option.optionId === answer.optionId)) {
      issue(
        issues,
        'hidden_option',
        `slotAnswers.${index}.optionId`,
        'selected option was not visible on the matched question',
      );
    }
    if (answer.kind === 'value' && !question.allowFreeText) {
      issue(
        issues,
        'free_text_not_allowed',
        `slotAnswers.${index}.value`,
        'matched question does not allow a free-text value',
      );
    }
  }
}

function validOpaqueHostId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_RE.test(value);
}

function validateHostView(host: TurnSemanticHostViewV1): TurnSemanticValidationIssue[] {
  const issues: TurnSemanticValidationIssue[] = [];
  if (!validOpaqueHostId(host.source.sessionId)) {
    issue(issues, 'host_invalid_session_id', 'host.source.sessionId', 'host session id is invalid');
  }
  if (!Number.isSafeInteger(host.source.sourceUserSeq) || host.source.sourceUserSeq <= 0) {
    issue(issues, 'host_invalid_source_seq', 'host.source.sourceUserSeq', 'host source sequence must be positive');
  }
  if (!/^[a-f0-9]{64}$/i.test(host.source.inputHash)) {
    issue(issues, 'host_invalid_input_hash', 'host.source.inputHash', 'host input hash must be SHA-256');
  }
  if (!/^[a-f0-9]{64}$/i.test(host.source.audienceHash)) {
    issue(issues, 'host_invalid_audience_hash', 'host.source.audienceHash', 'host audience hash must be SHA-256');
  }
  if (!/^[a-f0-9]{64}$/i.test(host.policyRevision)) {
    issue(issues, 'host_invalid_policy_revision', 'host.policyRevision', 'host policy revision must be SHA-256');
  }
  if (host.resumableGoals.length > 32) {
    issue(issues, 'host_too_many_goals', 'host.resumableGoals', 'host may expose at most 32 resumable goals');
  }
  for (const [index, goal] of host.resumableGoals.entries()) {
    if (!validOpaqueHostId(goal.goalId) || !Number.isSafeInteger(goal.baseRevision) || goal.baseRevision < 0) {
      issue(issues, 'host_invalid_goal', `host.resumableGoals.${index}`, 'host goal reference is invalid');
    }
  }
  for (const goalId of repeated(host.resumableGoals.map((goal) => goal.goalId))) {
    issue(issues, 'host_duplicate_goal', 'host.resumableGoals', `host exposes goal more than once: ${goalId}`);
  }
  if (host.openQuestions.length > MAX_OPEN_SLOTS) {
    issue(issues, 'host_too_many_questions', 'host.openQuestions', `host may expose at most ${MAX_OPEN_SLOTS} questions`);
  }
  for (const [index, question] of host.openQuestions.entries()) {
    if (!validOpaqueHostId(question.questionId) || !validOpaqueHostId(question.slotKey)) {
      issue(issues, 'host_invalid_question', `host.openQuestions.${index}`, 'host question identity is invalid');
    }
    if (typeof question.question !== 'string' || !/\S/.test(question.question) || question.question.length > MAX_LABEL_CHARS) {
      issue(issues, 'host_invalid_question_text', `host.openQuestions.${index}.question`, 'host question text is invalid');
    }
    if (!hostOffersGoal(host, {
      goalId: question.goalId,
      baseRevision: question.goalRevision,
    })) {
      issue(
        issues,
        'host_question_goal_mismatch',
        `host.openQuestions.${index}`,
        'host question does not belong to an offered goal revision',
      );
    }
    if (question.options.length > MAX_OPTIONS_PER_SLOT) {
      issue(
        issues,
        'host_too_many_options',
        `host.openQuestions.${index}.options`,
        `host question may expose at most ${MAX_OPTIONS_PER_SLOT} options`,
      );
    }
    for (const option of question.options) {
      if (!validOpaqueHostId(option.optionId) || typeof option.label !== 'string' || !/\S/.test(option.label)) {
        issue(issues, 'host_invalid_option', `host.openQuestions.${index}.options`, 'host option is invalid');
      }
    }
    for (const optionId of repeated(question.options.map((option) => option.optionId))) {
      issue(
        issues,
        'host_duplicate_option',
        `host.openQuestions.${index}.options`,
        `host option appears more than once: ${optionId}`,
      );
    }
  }
  for (const questionId of repeated(host.openQuestions.map((question) => question.questionId))) {
    issue(issues, 'host_duplicate_question', 'host.openQuestions', `host question appears more than once: ${questionId}`);
  }
  for (const [kind, ids] of [
    ['capability', host.catalog.capabilityIds],
    ['workflow', host.catalog.workflowIds],
  ] as const) {
    for (const id of ids) {
      if (!validOpaqueHostId(id)) {
        issue(issues, 'host_invalid_catalog_id', `host.catalog.${kind}Ids`, `host ${kind} id is invalid`);
      }
    }
  }
  return issues;
}

/** The exact payloadHash admitTurnSemantics computes — exported so the host
 *  deterministic-compile recompute reproduces byte-identical digests. */
export function canonicalProposalPayloadHash(proposal: unknown): string {
  return createHash('sha256').update(canonicalJson(proposal), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function canonicalHostContext(host: TurnSemanticHostViewV1): unknown {
  return {
    source: host.source,
    policyRevision: host.policyRevision,
    resumableGoals: [...host.resumableGoals].map((goal) => ({
      goalId: goal.goalId,
      baseRevision: goal.baseRevision,
      objective: goal.objective ?? null,
      constraints: [...(goal.constraints ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      openSlots: [...(goal.openSlots ?? [])].sort((a, b) => a.slotKey.localeCompare(b.slotKey)),
      checkpointRef: goal.checkpointRef ?? null,
      settledEvidenceRefs: [...(goal.settledEvidenceRefs ?? [])].sort(),
    })).sort((a, b) => (
      a.goalId.localeCompare(b.goalId) || a.baseRevision - b.baseRevision
    )),
    openQuestions: host.openQuestions.map((question) => ({
      questionId: question.questionId,
      goalId: question.goalId,
      goalRevision: question.goalRevision,
      slotKey: question.slotKey,
      question: question.question,
      allowFreeText: question.allowFreeText,
      options: [...question.options].sort((a, b) => a.optionId.localeCompare(b.optionId)),
    })).sort((a, b) => (
      a.questionId.localeCompare(b.questionId) || a.slotKey.localeCompare(b.slotKey)
    )),
  };
}

function semanticPayload(proposal: TurnSemanticProposalV1): unknown {
  const { rationale: _rationale, ...semantic } = proposal;
  return semantic;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function isContextCheckedTurnSemanticProposalV1(
  value: unknown,
): value is ContextCheckedTurnSemanticProposalV1 {
  return Boolean(value && typeof value === 'object' && checkedSemanticEnvelopes.has(value));
}

export function semanticProposalDigest(proposal: TurnSemanticProposalV1): string {
  return createHash('sha256').update(canonicalJson(proposal), 'utf8').digest('hex');
}

/**
 * Validate model-owned semantics against a trusted host snapshot.
 *
 * This function is pure: it reads no database, clock, model, provider, or
 * environment state. A successful result still carries no execution authority.
 */
export function validateTurnSemanticProposalV1(
  raw: unknown,
  host: TurnSemanticHostViewV1,
): TurnSemanticValidationResult {
  const hostIssues = validateHostView(host);
  if (hostIssues.length > 0) return { ok: false, issues: hostIssues };
  const parsed = TurnSemanticProposalV1Schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((entry) => ({
        code: `schema_${entry.code}`,
        path: entry.path.join('.'),
        message: entry.message,
      })),
    };
  }
  const proposal = deepFreeze(parsed.data);
  const issues: TurnSemanticValidationIssue[] = [];
  validateRelationMatrix(proposal, host, issues);
  validateGoalDraft(proposal, host, issues);
  validateProposedWork(proposal, host, issues);
  validateSlotAnswers(proposal, host, issues);
  if (issues.length > 0) return { ok: false, issues };

  const checked = deepFreeze({
    scope: CONTEXT_CHECKED_SEMANTICS_SCOPE,
    source: { ...host.source },
    payloadHash: createHash('sha256').update(canonicalJson(proposal), 'utf8').digest('hex'),
    contextHash: createHash('sha256').update(canonicalJson({
      host: canonicalHostContext(host),
      proposal: semanticPayload(proposal),
    }), 'utf8').digest('hex'),
    proposal,
    [CHECKED_TURN_SEMANTICS]: true as const,
  });
  checkedSemanticEnvelopes.add(checked);
  return { ok: true, checked };
}
