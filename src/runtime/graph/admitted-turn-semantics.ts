/**
 * Opaque admitted-semantics brand. The compiler accepts only values sealed
 * here. A lookalike structural object is rejected.
 */
import type { AcceptedGoalConstruct, AcceptedGoalV1 } from './accepted-goal.js';
import { createHash } from 'node:crypto';
import type {
  CompileTurnGraphResult,
  TurnGraphAwaitInput,
  TurnGraphRoute,
  TurnGraphSurface,
} from './turn-graph-ir.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import type { TaskContinuationContext } from '../../types.js';
import type { TurnSemanticProposalV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import type { PrimaryModelPlanningCatalogAuthorityV1 } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import type { WorkTopologyV1 } from './work-topology.js';

const ADMITTED_SCOPE = 'admitted_turn_semantics_v1' as const;
const ADMITTED_TURN_SEMANTICS: unique symbol = Symbol('admitted-turn-semantics');
const admittedEnvelopes = new WeakSet<object>();
const DURABLE_GRAPH_PERSISTENCE_SCOPE = 'durable_accepted_turn_graph_v1' as const;
const durableGraphPersistenceTickets = new WeakMap<object, {
  graph: CompileTurnGraphResult['graph'];
  semanticProvenanceDigest: string;
}>();

/**
 * Opaque proof that a graph came from the durable source -> model semantics ->
 * host admission compiler. The ticket intentionally binds the graph object,
 * not merely caller-copyable hashes. Presentation surfaces may compile a
 * different graph hash for the same admitted semantics; persistence uses the
 * semantic provenance digest to reuse the first frozen winner.
 */
export interface DurableAcceptedTurnGraphPersistenceTicket {
  readonly scope: typeof DURABLE_GRAPH_PERSISTENCE_SCOPE;
}

export function inspectDurableAcceptedTurnGraphPersistenceTicket(input: {
  ticket: DurableAcceptedTurnGraphPersistenceTicket;
  graph: CompileTurnGraphResult['graph'];
}): { semanticProvenanceDigest: string } | null {
  const bound = durableGraphPersistenceTickets.get(input.ticket as object);
  if (!bound || bound.graph !== input.graph) return null;
  if (input.ticket.scope !== DURABLE_GRAPH_PERSISTENCE_SCOPE) return null;
  return { semanticProvenanceDigest: bound.semanticProvenanceDigest };
}

function issueDurableAcceptedTurnGraphPersistenceTicket(input: {
  graph: CompileTurnGraphResult['graph'];
  semanticProvenanceDigest: string;
}): DurableAcceptedTurnGraphPersistenceTicket {
  const ticket = Object.freeze({ scope: DURABLE_GRAPH_PERSISTENCE_SCOPE });
  durableGraphPersistenceTickets.set(ticket, { ...input });
  return ticket;
}

export interface AdmittedClampedSemanticsV1 {
  kind:
    | 'conversation'
    | 'mint_goal'
    | 'continue_same_root'
    | 'settle_slot'
    | 'amend_revision'
    | 'abandon_root'
    | 'keep_slot_open';
  construct: AcceptedGoalConstruct;
  collection?: AcceptedGoalV1['collection'];
  destinations?: AcceptedGoalV1['destinations'];
  destination?: AcceptedGoalV1['destination'];
  effectCeiling: RuntimeToolEffect | 'none';
  requestedEffect: RuntimeToolEffect | 'none';
  route: TurnGraphRoute;
  goalId?: string;
  revision?: number;
  openSlot?: TurnGraphAwaitInput;
  slotAnswer?: {
    kind: 'option' | 'value' | 'meta';
    questionId: string;
    slotKey: string;
    optionId?: string;
    value?: string;
    action?: 'explain' | 'customize';
  };
  metaAction?: 'explain' | 'customize';
  operations?: ReadonlyArray<{
    id: string;
    role: string;
    requestedEffect: RuntimeToolEffect | 'none';
    capabilityRef: string | null;
    dependsOn: readonly string[];
    evidence: readonly string[];
  }>;
  /** Exact normalized topology accepted with the semantic payload. Capability
   * annotations above bind its ids but do not own a second DAG. */
  workTopology?: WorkTopologyV1;
  workTopologyHash?: string;
  evidenceRequirements?: readonly string[];
}

export interface AdmittedTurnSemanticsSource {
  sessionId: string;
  sourceUserSeq: number;
  inputHash: string;
  audienceHash: string;
}

export interface AdmittedTurnSemantics {
  readonly scope: typeof ADMITTED_SCOPE;
  readonly source: Readonly<AdmittedTurnSemanticsSource>;
  readonly policyRevision: string;
  readonly clamped: AdmittedClampedSemanticsV1;
  readonly payloadHash: string;
  readonly contextHash: string;
  readonly [ADMITTED_TURN_SEMANTICS]: true;
}

export function isAdmittedTurnSemantics(value: unknown): value is AdmittedTurnSemantics {
  return Boolean(value && typeof value === 'object' && admittedEnvelopes.has(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function sealAdmittedTurnSemantics(input: {
  source: AdmittedTurnSemanticsSource;
  policyRevision: string;
  clamped: AdmittedClampedSemanticsV1;
  payloadHash: string;
  contextHash: string;
}): AdmittedTurnSemantics {
  const admitted = deepFreeze({
    scope: ADMITTED_SCOPE,
    source: { ...input.source },
    policyRevision: input.policyRevision,
    clamped: input.clamped,
    payloadHash: input.payloadHash,
    contextHash: input.contextHash,
    [ADMITTED_TURN_SEMANTICS]: true as const,
  });
  admittedEnvelopes.add(admitted);
  return admitted;
}

export interface CompileDurableAcceptedTurnGraphInput {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface: TurnGraphSurface;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  verifiedTaskContinuation?: TaskContinuationContext;
}

export type CompileDurableAcceptedTurnGraphResult =
  | {
      ok: true;
      compiled: CompileTurnGraphResult;
      persistenceTicket: DurableAcceptedTurnGraphPersistenceTicket;
    }
  | { ok: false; reason: string };

async function compilePreparedAcceptedTurnGraph(
  input: CompileDurableAcceptedTurnGraphInput,
  prepared: Awaited<ReturnType<
    typeof import('../semantic-boundary/admit-and-compile-accepted-source.js')['prepareDurableAcceptedTurnCompile']
  >>,
): Promise<CompileDurableAcceptedTurnGraphResult> {
  if (!prepared.ok) return prepared;

  if (prepared.source.sessionId !== input.identity.sessionId) {
    return { ok: false, reason: 'admitted session does not match compile identity' };
  }
  if (prepared.source.sourceUserSeq !== input.identity.sourceUserSeq) {
    return { ok: false, reason: 'admitted source does not match compile identity' };
  }
  const inputHash = createHash('sha256').update(prepared.acceptedText, 'utf8').digest('hex');
  if (prepared.source.inputHash !== inputHash) {
    return { ok: false, reason: 'admitted input hash does not match accepted text' };
  }
  if (prepared.source.audienceHash !== prepared.authority.audienceHash) {
    return { ok: false, reason: 'admitted audience does not match durable authority' };
  }
  if (prepared.policyRevision !== prepared.authority.policyRevision) {
    return { ok: false, reason: 'admitted policy does not match durable authority' };
  }

  const admitted = sealAdmittedTurnSemantics({
    source: prepared.source,
    policyRevision: prepared.policyRevision,
    clamped: prepared.clamped,
    payloadHash: prepared.payloadHash,
    contextHash: prepared.contextHash,
  });
  const { compileTurnGraph } = await import('./turn-graph-compiler.js');
  const compiled = compileTurnGraph({
    identity: input.identity,
    input: prepared.acceptedText,
    sessionKind: prepared.sessionKind,
    surface: input.surface,
    policy: prepared.policy,
    admitted,
    allowedToolNames: input.allowedToolNames,
    excludedToolNames: input.excludedToolNames,
  });
  return {
    ok: true,
    compiled,
    persistenceTicket: issueDurableAcceptedTurnGraphPersistenceTicket({
      graph: compiled.graph,
      semanticProvenanceDigest: prepared.semanticProvenanceDigest,
    }),
  };
}

/**
 * The sole executable-authority minting seam. The caller supplies only a
 * durable source identity and presentation constraints. Source text,
 * audience, policy, model judgment, and admitted semantics are loaded and
 * checked inside the atomic semantic boundary; no callback or seal escapes.
 */
export async function compileDurableAcceptedTurnGraph(
  input: CompileDurableAcceptedTurnGraphInput,
): Promise<CompileDurableAcceptedTurnGraphResult> {
  const { prepareDurableAcceptedTurnCompile } = await import(
    '../semantic-boundary/admit-and-compile-accepted-source.js'
  );
  const prepared = await prepareDurableAcceptedTurnCompile(input);
  return compilePreparedAcceptedTurnGraph(input, prepared);
}

/**
 * Primary-model planning seam. The proposal is authored inside the foreground
 * model loop, but it acquires no authority until this boundary reloads the
 * accepted source/catalog/policy and admits it through the same opaque sealer.
 * No semantic model port or judge is called here.
 */
export async function compilePrimaryModelAcceptedTurnGraph(
  input: CompileDurableAcceptedTurnGraphInput,
  proposal: TurnSemanticProposalV1,
  planningCatalogAuthority: PrimaryModelPlanningCatalogAuthorityV1,
): Promise<CompileDurableAcceptedTurnGraphResult> {
  const { prepareDurableAcceptedTurnCompile } = await import(
    '../semantic-boundary/admit-and-compile-accepted-source.js'
  );
  const prepared = await prepareDurableAcceptedTurnCompile(
    input,
    proposal,
    planningCatalogAuthority,
  );
  return compilePreparedAcceptedTurnGraph(input, prepared);
}
