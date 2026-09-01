import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
import type { ExternalEffectKind } from '../../assistant/external-effect-taxonomy.js';
import type { MessageIntent } from '../../assistant/message-intent.js';
import type { SessionKind } from '../harness/eventlog.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type { TurnEvidenceKind, TurnIdentity } from '../harness/turn-outcome.js';
import type { WorkTopologyV1 } from './work-topology.js';

/**
 * Provider-neutral graph compiled for one accepted chat turn.
 *
 * Version 1 is deliberately observational. It is persisted so Clementine can
 * compare a small deterministic plan with the legacy engines, but no field in
 * this IR grants tool authority or changes the v3.6 execution path.
 */
export const TURN_GRAPH_IR_VERSION = 1 as const;
export const TURN_GRAPH_COMPILER_VERSION = 'turn-graph-shadow-v2' as const;
export const TURN_GRAPH_POLICY_VERSION = 'turn-policy-v1' as const;

export type TurnGraphSurface =
  | 'webhook'
  | 'cron'
  | 'background'
  | 'cli'
  | 'dashboard'
  | 'home'
  | 'workflow'
  | 'discord'
  | 'slack'
  | 'direct'
  | 'approval_resume';

export type TurnGraphRoute = 'direct_reply' | 'retrieve' | 'act';

export type TurnGraphFastPath =
  | 'direct_reply'
  | 'single_retrieval'
  | 'single_action'
  | 'fanout_action'
  /** Project-shaped work: too large for one chat turn, must compile to a
   *  durable execution with bounded nodes rather than a single action. */
  | 'project';

export type TurnGraphNodeKind =
  | 'turn_accepted'
  /** Composes the blocked/needs-input public answer when evidence was
   *  INSUFFICIENT — the terminal-reduction table's needs_input/question route,
   *  as topology instead of only as loop behavior. */
  | 'compose_blocked'
  | 'policy_snapshot'
  | 'intent_authority'
  | 'context_resolve'
  | 'capability_resolve'
  | 'retrieve'
  | 'execute'
  | 'fanout'
  | 'reduce'
  | 'verify'
  | 'await_input'
  | 'await_approval'
  | 'compose_reply'
  | 'publish';

export type TurnGraphRunner =
  | { kind: 'runtime' }
  | { kind: 'model'; role: 'brain' | 'worker' | 'reply_composer' }
  | { kind: 'tool' }
  | { kind: 'human' };

export type TurnGraphEffectReversibility =
  | 'not_applicable'
  | 'read_only'
  | 'reversible'
  | 'irreversible'
  | 'unknown';

export interface TurnGraphEffect {
  /** Exact for deterministic nodes; a conservative upper bound before a tool
   * and its arguments are selected. Unknown is never treated as read-only. */
  kind: RuntimeToolEffect | 'none';
  certainty: 'exact' | 'ceiling';
  reversibility: TurnGraphEffectReversibility;
  idempotency: 'not_required' | 'required_before_dispatch';
  receipt: 'none' | 'evidence_ref' | 'durable_effect_receipt';
}

export type TurnGraphAuthorityRequirement =
  | 'none'
  | 'runtime_tool_admission'
  | 'exact_approval';

export interface TurnGraphAuthority {
  /** The accepted request is evidence of intent, not a permission grant. */
  intentSource: {
    kind: 'accepted_turn';
    sourceUserSeq: number;
  };
  requirement: TurnGraphAuthorityRequirement;
  /** A shadow compiler can only say that a later runtime boundary must decide. */
  state: 'not_required' | 'deferred';
  decisionOwner: 'none' | 'runtime_tool_boundary';
}

export interface TurnGraphCapabilityRequirement {
  kind: 'memory' | 'skill' | 'workflow' | 'tool' | 'mcp_server';
  resolution: 'deferred' | 'explicit';
  /** Present (including an empty array) only when the caller supplied exact
   * tool authority. This preserves undefined-versus-empty semantics. */
  names?: string[];
}

export interface TurnGraphEvidenceRequirement {
  mode: 'none' | 'any' | 'all';
  kinds: TurnEvidenceKind[];
}

/** Canonical open-slot bytes owned by an await_input node. A later reply is a
 *  distinct accepted-source audit event that must settle or amend this same
 *  root goal — it does not mint a sibling goal. */
export interface TurnGraphAwaitInput {
  goalId: string;
  revision: number;
  questionId: string;
  slotId: string;
  deliveredQuestion: string;
  visibleOptions: ReadonlyArray<{ optionId: string; label: string }>;
  candidateRefs?: readonly string[];
  predecessorRefs?: readonly string[];
}

export interface TurnGraphNode {
  id: string;
  kind: TurnGraphNodeKind;
  /** Join semantics for incoming edges. Default 'all' (rendezvous). 'any' is
   *  the branch-merge: alternative verdict routes converge and exactly one
   *  fires — the publish node's shape once both verdict routes are topology. */
  joinMode?: 'all' | 'any';
  runner: TurnGraphRunner;
  effect: TurnGraphEffect;
  authority: TurnGraphAuthority;
  capabilities: TurnGraphCapabilityRequirement[];
  evidence: TurnGraphEvidenceRequirement;
  /** Present only on await_input. Packet bytes are copied from this tuple. */
  awaitInput?: TurnGraphAwaitInput;
  /** Stable admitted operation identity. */
  operationId?: string;
  capabilityRole?: string;
  cardinality?: number;
  requiredFields?: string[];
  structuredCollectionLocator?: {
    contract: 'workspace_social_posts_v1';
    collectionPointer: '/posts';
    visibleMirrorPointer: '/_mobile/records/items';
    calendarPointer: '/calendar';
    calendarRequiredFields: ['date', 'channel', 'theme'];
    sourceEvidence: {
      operationId: string;
      recordsPointer: string;
      minDistinctRecords: number;
      titlePointer: string;
      urlPointer: string;
      publishedDatePointer: string;
      findingPointers: [string, string, string, string];
      publisherPointer: string;
      maxAgeDays: number;
      asOf: string;
    };
  };
  /**
   * The runtime-topology CONTRACT for a planner node (Clem 4 G5a).
   *
   * Replaces the old `multiplicity` metadata, which stored an estimated item
   * count on a single node — a number a scheduler cannot spread. A planner
   * instead emits one identity-bound sibling per item of the CANONICAL
   * manifest at execution time, as a validated graph patch joined at
   * `joinNodeId`. `estimatedItems` is diagnostic only and never manufactures
   * a node: the real count is decided by the manifest the planner produces,
   * which is how "handle any task" stays unbounded by compile-time guesses.
   */
  emitsTopology?: {
    kind: 'per_item_siblings';
    joinNodeId: string;
    workerRunner: TurnGraphRunner;
    workerEffect: TurnGraphEffect;
    maxConcurrency: number;
    estimatedItems: number;
    /** E6.2: the durable manifest adapter that owns item scheduling,
     *  bounded concurrency, retries, checkpointing, and reducer readiness
     *  for this node — the runtime owns dispatch, not the model. */
    durableAdapter?: 'dispositionToDurableWork';
  };
}

export interface TurnGraphEdge {
  id: string;
  source: string;
  target: string;
  when: 'success' | 'evidence_sufficient' | 'evidence_insufficient' | 'input_available' | 'authority_available';
}

/** Only authority-relevant policy is copied into the turn graph. Mutable
 * process flags and timestamps are intentionally absent. */
export interface TurnGraphPolicySnapshot {
  version: typeof TURN_GRAPH_POLICY_VERSION;
  autoApproveScope: AutoApproveScope;
  proactiveWorkAllowed: boolean;
  allowComposioActions: boolean;
  allowComputerActions: boolean;
  requireWorkflowApprovalForExecution: boolean;
  batchConfirmThreshold: number;
}

export interface TurnGraphIR {
  version: typeof TURN_GRAPH_IR_VERSION;
  mode: 'shadow';
  graphId: string;
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  source: {
    sessionKind: SessionKind;
    surface: TurnGraphSurface;
    inputHash: string;
  };
  compiler: {
    version: typeof TURN_GRAPH_COMPILER_VERSION;
    policyHash: string;
    /** SHA-256 over the canonical graph with this field omitted. */
    graphHash: string;
  };
  policy: TurnGraphPolicySnapshot;
  toolAuthority: {
    explicit: boolean;
    allowedToolNames?: string[];
    excludedToolNames: string[];
  };
  /** The normalized semantic work topology, content-addressed before graph
   * persistence. Absent on legacy/deterministic graphs. */
  workTopology?: {
    topology: WorkTopologyV1;
    topologyHash: string;
  };
  classification: {
    messageIntent: MessageIntent;
    confidence: number;
    route: TurnGraphRoute;
    externalEffectRequested: boolean;
    /** Structural project verdict — see assistant/project-shape.ts. */
    projectShaped: boolean;
    projectSignals: string[];
    externalEffectKinds: ExternalEffectKind[];
    multiItem: {
      detected: boolean;
      itemCount: number;
      explicitParallelRequest: boolean;
      /** Counted set is read once; the write is one artifact from that set. */
      collectThenConstruct: boolean;
    };
    /** Durable goal shape. No request prose. Cardinality, projection, and
     *  destinations survive compilation as evidence requirements. */
    goalConstraints?: {
      construct: 'none' | 'collect_then_construct' | 'fanout' | 'single_act';
      collection?: {
        count: number;
        projection: string[];
        completeness?: 'count' | 'exhaust';
        identityFields?: string[];
        locator?: {
          contract: 'workspace_social_posts_v1';
          collectionPointer: '/posts';
          visibleMirrorPointer: '/_mobile/records/items';
          calendarPointer: '/calendar';
          calendarRequiredFields: ['date', 'channel', 'theme'];
          sourceEvidence: {
            operationId: string;
            recordsPointer: string;
            minDistinctRecords: number;
            titlePointer: string;
            urlPointer: string;
            publishedDatePointer: string;
            findingPointers: [string, string, string, string];
            publisherPointer: string;
            maxAgeDays: number;
            asOf: string;
          };
        };
      };
      evidenceRequirements?: readonly string[];
      destinations?: Array<{
        posture: 'create_new' | 'named_existing';
        family: string;
        handleRequired: boolean;
        binding?: {
          manifestId: string;
          manifestDigest: string;
          accountId: string;
          operationId: string;
          schemaVersion: string;
          definitionFingerprint: string;
          effect: string;
          posture: 'create_new' | 'named_existing';
        };
      }>;
      /** Projection of destinations[0]. Not a second authority field. */
      destination?: {
        posture: 'create_new' | 'named_existing';
        family: string;
        handleRequired: boolean;
        binding?: {
          manifestId: string;
          manifestDigest: string;
          accountId: string;
          operationId: string;
          schemaVersion: string;
          definitionFingerprint: string;
          effect: string;
          posture: 'create_new' | 'named_existing';
        };
      };
    };
    /** Root goal identity that outlives one sourceUserSeq. */
    goalIdentity?: { goalId: string; revision: number };
  };
  fastPath: TurnGraphFastPath;
  effectCeiling: RuntimeToolEffect | 'none';
  nodes: TurnGraphNode[];
  edges: TurnGraphEdge[];
  diagnostics: {
    warnings: string[];
  };
}

export interface TurnGraphValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
}

export interface CompileTurnGraphResult {
  graph: TurnGraphIR;
  validation: TurnGraphValidation;
}
