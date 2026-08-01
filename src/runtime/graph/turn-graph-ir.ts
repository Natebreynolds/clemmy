import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
import type { ExternalEffectKind } from '../../assistant/external-effect-taxonomy.js';
import type { MessageIntent } from '../../assistant/message-intent.js';
import type { SessionKind } from '../harness/eventlog.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type { TurnEvidenceKind, TurnIdentity } from '../harness/turn-outcome.js';

/**
 * Provider-neutral graph compiled for one accepted chat turn.
 *
 * Version 1 is deliberately observational. It is persisted so Clementine can
 * compare a small deterministic plan with the legacy engines, but no field in
 * this IR grants tool authority or changes the v3.6 execution path.
 */
export const TURN_GRAPH_IR_VERSION = 1 as const;
export const TURN_GRAPH_COMPILER_VERSION = 'turn-graph-shadow-v1' as const;
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
  | 'fanout_action';

export type TurnGraphNodeKind =
  | 'turn_accepted'
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

export interface TurnGraphNode {
  id: string;
  kind: TurnGraphNodeKind;
  runner: TurnGraphRunner;
  effect: TurnGraphEffect;
  authority: TurnGraphAuthority;
  capabilities: TurnGraphCapabilityRequirement[];
  evidence: TurnGraphEvidenceRequirement;
  multiplicity?: {
    kind: 'per_item';
    estimatedItems: number;
    maxConcurrency: number;
  };
}

export interface TurnGraphEdge {
  id: string;
  source: string;
  target: string;
  when: 'success' | 'evidence_sufficient' | 'input_available' | 'authority_available';
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
  classification: {
    messageIntent: MessageIntent;
    confidence: number;
    route: TurnGraphRoute;
    externalEffectRequested: boolean;
    externalEffectKinds: ExternalEffectKind[];
    multiItem: {
      detected: boolean;
      itemCount: number;
      explicitParallelRequest: boolean;
    };
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
