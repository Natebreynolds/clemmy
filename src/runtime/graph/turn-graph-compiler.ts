import { createHash } from 'node:crypto';
export { attachEvidenceObligations, type EvidenceObligation, type NodeObligation } from './turn-graph-obligations.js';
import type { ProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import { classifyProjectShape } from '../../assistant/project-shape.js';
import {
  classifyExternalEffectRequest,
  type ExternalEffectClassification,
} from '../../assistant/external-effect-taxonomy.js';
import {
  classifyMessageIntent,
  isExplicitMemoryInstruction,
  type IntentClassification,
} from '../../assistant/message-intent.js';
import {
  detectMultiItemIntent,
  type MultiItemIntent,
} from '../harness/multi-item-intent.js';
import {
  compileAcceptedGoal,
  destinationsOf,
  goalConstraintsOf,
  type AcceptedGoalV1,
} from './accepted-goal.js';
import {
  isAdmittedTurnSemantics,
  type AdmittedTurnSemantics,
} from './admitted-turn-semantics.js';
import type { SessionKind } from '../harness/eventlog.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import {
  canonicalWorkTopologyJson,
  validateWorkTopology,
  workTopologyDigest,
} from './work-topology.js';
import {
  TURN_GRAPH_COMPILER_VERSION,
  TURN_GRAPH_IR_VERSION,
  TURN_GRAPH_POLICY_VERSION,
  type CompileTurnGraphResult,
  type TurnGraphAuthority,
  type TurnGraphAwaitInput,
  type TurnGraphCapabilityRequirement,
  type TurnGraphEdge,
  type TurnGraphEffect,
  type TurnGraphFastPath,
  type TurnGraphIR,
  type TurnGraphNode,
  type TurnGraphNodeKind,
  type TurnGraphPolicySnapshot,
  type TurnGraphRoute,
  type TurnGraphRunner,
  type TurnGraphSurface,
  type TurnGraphValidation,
} from './turn-graph-ir.js';

/** Typed semantic state the compiler may consume. Route, construct, count,
 *  ceiling, and executable operations come only from this admitted state;
 *  canonical descriptive effect kinds remain source-derived. */
export interface CompileTurnGraphSemantics {
  construct: AcceptedGoalV1['construct'];
  effectCeiling: AcceptedGoalV1['effectCeiling'];
  collection?: AcceptedGoalV1['collection'];
  destinations?: AcceptedGoalV1['destinations'];
  destination?: AcceptedGoalV1['destination'];
  route?: TurnGraphRoute;
  goalId?: string;
  revision?: number;
  /** When set, the compiled graph parks at this exact open slot. */
  openSlot?: TurnGraphAwaitInput;
  /** Shadow telemetry only. Does not grant authority. */
  messageIntent?: IntentClassification['intent'];
}

export interface CompileTurnGraphInput {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  /** Hashed into source.inputHash. When `admitted` is present, typed semantics
   * own route, construct, count, ceiling, and completion. The host's canonical
   * external-effect taxonomy may still project descriptive effect kinds from
   * this exact hash-bound accepted source; those kinds grant no authority. */
  input: string;
  sessionKind: SessionKind;
  surface: TurnGraphSurface;
  policy: TurnGraphPolicySnapshot;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  /** Test/future enrichment seam. Supplying a signal replaces only that pure
   * classifier; it cannot grant authority or select a provider. */
  signals?: {
    intent?: IntentClassification;
    externalEffect?: ExternalEffectClassification;
    multiItem?: MultiItemIntent;
    /** Prior retrieve/act in this session — see sessionContinuesHostedWorld. */
    continueHostedWorld?: boolean;
  };
  /**
   * Opaque host-admitted semantics. A plain structural object is rejected.
   * When present, route/construct/ceiling come from this value — `input` is
   * hashed only and must match the admitted source.
   */
  admitted?: AdmittedTurnSemantics;
}

function routeFromSemantics(semantics: CompileTurnGraphSemantics): TurnGraphRoute {
  if (semantics.route) return semantics.route;
  if (semantics.openSlot) return 'direct_reply';
  if (semantics.construct !== 'none') return 'act';
  if (
    semantics.effectCeiling === 'external_write'
    || semantics.effectCeiling === 'local_write'
    || semantics.effectCeiling === 'admin'
  ) return 'act';
  if (semantics.effectCeiling === 'read') return 'retrieve';
  return 'direct_reply';
}

function shadowIntentFromSemantics(semantics: CompileTurnGraphSemantics, route: TurnGraphRoute): IntentClassification {
  if (semantics.messageIntent) {
    return { intent: semantics.messageIntent, confidence: 1, reasons: ['typed_semantics'] };
  }
  if (route === 'direct_reply') return { intent: 'conversation', confidence: 1, reasons: ['typed_semantics'] };
  if (route === 'retrieve') return { intent: 'lookup', confidence: 1, reasons: ['typed_semantics'] };
  return { intent: 'action', confidence: 1, reasons: ['typed_semantics'] };
}

function multiItemFromSemantics(semantics: CompileTurnGraphSemantics): MultiItemIntent {
  const count = semantics.collection?.count ?? 0;
  return {
    isMultiItem: semantics.construct === 'fanout',
    itemCount: count,
    itemKind: null,
    sameShapeWork: false,
    explicitParallelRequest: false,
    collectThenConstruct: semantics.construct === 'collect_then_construct',
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry ?? null)).join(',')}]`;
  if (!value || typeof value !== 'object') return 'null';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedNames(names: readonly string[] | undefined): string[] | undefined {
  if (names === undefined) return undefined;
  return [...new Set(names
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean))].sort();
}

/** Copy only the closed, authority-relevant policy schema. Besides keeping the
 * graph hash stable across object construction order, this prevents accidental
 * caller-only fields from becoming durable shadow telemetry. */
function canonicalPolicy(snapshot: TurnGraphPolicySnapshot): TurnGraphPolicySnapshot {
  const threshold = Number.isFinite(snapshot.batchConfirmThreshold)
    ? Math.max(2, Math.floor(snapshot.batchConfirmThreshold))
    : 2;
  return {
    version: TURN_GRAPH_POLICY_VERSION,
    autoApproveScope: snapshot.autoApproveScope === 'workspace' || snapshot.autoApproveScope === 'yolo'
      ? snapshot.autoApproveScope
      : 'strict',
    proactiveWorkAllowed: snapshot.proactiveWorkAllowed === true,
    allowComposioActions: snapshot.allowComposioActions === true,
    allowComputerActions: snapshot.allowComputerActions === true,
    requireWorkflowApprovalForExecution: snapshot.requireWorkflowApprovalForExecution === true,
    batchConfirmThreshold: threshold,
  };
}

export function snapshotTurnGraphPolicy(snapshot: ProactivityPolicySnapshot): TurnGraphPolicySnapshot {
  return {
    version: TURN_GRAPH_POLICY_VERSION,
    autoApproveScope: snapshot.policy.autoApproveScope,
    proactiveWorkAllowed: snapshot.proactiveWorkAllowed,
    allowComposioActions: snapshot.policy.allowComposioActions,
    allowComputerActions: snapshot.policy.allowComputerActions,
    requireWorkflowApprovalForExecution: snapshot.policy.requireWorkflowApprovalForExecution,
    batchConfirmThreshold: Math.max(2, Math.floor(snapshot.policy.batchConfirmThreshold)),
  };
}

function noEffect(): TurnGraphEffect {
  return {
    kind: 'none',
    certainty: 'exact',
    reversibility: 'not_applicable',
    idempotency: 'not_required',
    receipt: 'none',
  };
}

function effectForRoute(
  route: TurnGraphRoute,
  externalEffectRequested: boolean,
  goalCeiling?: RuntimeToolEffect | 'none',
): TurnGraphEffect {
  if (route === 'direct_reply') return noEffect();
  if (route === 'retrieve') {
    return {
      kind: 'read',
      certainty: 'exact',
      reversibility: 'read_only',
      idempotency: 'not_required',
      receipt: 'evidence_ref',
    };
  }
  // An admitted act whose goal ceiling is READ keeps that exact authority.
  // Widening it to 'unknown' erased what the semantic clamp sealed and made
  // the single-read act unexecutable (the freeze then refused "read-only
  // work" against a ceiling the admission never granted).
  if (goalCeiling === 'read' && !externalEffectRequested) {
    return {
      kind: 'read',
      certainty: 'exact',
      reversibility: 'read_only',
      idempotency: 'not_required',
      receipt: 'evidence_ref',
    };
  }
  const ceiling = goalCeiling === 'external_write' || goalCeiling === 'local_write' || goalCeiling === 'admin'
    ? goalCeiling
    : externalEffectRequested ? 'external_write' : 'unknown';
  return {
    kind: ceiling,
    certainty: 'ceiling',
    reversibility: 'unknown',
    idempotency: 'required_before_dispatch',
    receipt: 'durable_effect_receipt',
  };
}

function authorityFor(
  sourceUserSeq: number,
  effect: TurnGraphEffect,
): TurnGraphAuthority {
  if (effect.kind === 'none') {
    return {
      intentSource: { kind: 'accepted_turn', sourceUserSeq },
      requirement: 'none',
      state: 'not_required',
      decisionOwner: 'none',
    };
  }
  return {
    intentSource: { kind: 'accepted_turn', sourceUserSeq },
    requirement: 'runtime_tool_admission',
    state: 'deferred',
    decisionOwner: 'runtime_tool_boundary',
  };
}

function routeFor(
  intent: IntentClassification,
  externalEffect: ExternalEffectClassification,
  memoryInstruction: boolean,
  collectThenConstruct = false,
): TurnGraphRoute {
  // A counted set landing in one container is a construct, even when the
  // sentence opens with a find/lookup verb. Leaving it on retrieve froze a
  // one-read contract and never compiled the write.
  if (collectThenConstruct) return 'act';
  if (
    externalEffect.requested
    || intent.intent === 'action'
    || intent.intent === 'tool_intent'
  ) return 'act';
  // An explicit memory instruction reads nothing: its completion authority is
  // the durable intake receipt on the ACTION path. Routing it through the
  // default tool_intent bucket froze a one-read retrieve contract for
  // "Remember this: …" and bypassed intake completion entirely
  // (post-routing-change sweep, 2026-08-12).
  if (memoryInstruction && intent.intent !== 'lookup') return 'act';
  // Only an affirmative lookup may freeze the exact one-read topology. The
  // conservative tool fallback deliberately stays on an unknown-effect action
  // route above so novel wording is reasoned about rather than silently
  // weakened to a read. Runtime tool admission still owns effect authority.
  if (intent.intent === 'lookup') return 'retrieve';
  return 'direct_reply';
}

/** A compiled direct_reply is conversation-only. Callers that did not pass
 *  an explicit allowlist must not assemble discovery, MCP, or a capability
 *  hunt — compose_reply still runs the model, with zero tool authority. */
export function factorySkipForCompiledRoute(
  route: TurnGraphRoute | undefined,
  allowedToolNames: readonly string[] | undefined,
): boolean {
  return route === 'direct_reply' && allowedToolNames === undefined;
}

function fastPathFor(
  route: TurnGraphRoute,
  multiItem: MultiItemIntent,
  projectShaped: boolean,
): TurnGraphFastPath {
  if (route === 'direct_reply') return 'direct_reply';
  // A project outranks the single/fan-out action split even when it names one
  // deliverable: "one dashboard" is still bounded-node, durable work. Reading
  // it as a single action is exactly how the live regression ended up trying to
  // serve a whole project inside one chat turn.
  if (projectShaped) return 'project';
  if (route === 'retrieve') return 'single_retrieval';
  // A counted collection landing in ONE artifact is one aggregate source phase
  // plus one construct phase. Per-item siblings belong only to a true fanout
  // goal; labeling this fanout made the host manufacture N worker jobs after a
  // provider had already returned the collection as one result.
  if (multiItem.collectThenConstruct) return 'single_action';
  return multiItem.isMultiItem ? 'fanout_action' : 'single_action';
}

function graphHashMaterial(graph: TurnGraphIR): unknown {
  const { graphHash: _graphHash, ...compiler } = graph.compiler;
  return { ...graph, compiler };
}

/**
 * Recompute the graph's content address from the closed IR.
 *
 * A persisted graph is about to become the accepted task's expectation. Merely
 * checking that `graphHash` looks like a SHA-256 digest is not enough: a damaged
 * or hand-edited graph could otherwise keep its old digest and still be treated
 * as the graph that ran. Keep the calculation beside the compiler so every
 * reader uses exactly the same canonical material.
 */
export function turnGraphHashMatches(graph: TurnGraphIR): boolean {
  return graph.compiler.graphHash === sha256(stableJson(graphHashMaterial(graph)));
}

export function validateTurnGraph(graph: TurnGraphIR): TurnGraphValidation {
  const errors: string[] = [];
  const warnings = [...graph.diagnostics.warnings];
  if (graph.version !== TURN_GRAPH_IR_VERSION || graph.mode !== 'shadow') {
    errors.push('Turn graph must be the supported shadow IR version.');
  }
  if (!graph.identity.sessionId.trim()) errors.push('Turn graph sessionId is required.');
  if (!Number.isSafeInteger(graph.identity.turn) || graph.identity.turn < 0) {
    errors.push('Turn graph turn must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(graph.identity.sourceUserSeq) || graph.identity.sourceUserSeq <= 0) {
    errors.push('Turn graph sourceUserSeq must name an accepted user event.');
  }
  if (graph.graphId !== `turn-graph:v${TURN_GRAPH_IR_VERSION}:${graph.identity.sourceUserSeq}`) {
    errors.push('Turn graph id does not match its logical accepted source.');
  }
  if (!/^[a-f0-9]{64}$/.test(graph.compiler.policyHash)) errors.push('Turn graph policy hash is invalid.');
  if (!/^[a-f0-9]{64}$/.test(graph.compiler.graphHash)) errors.push('Turn graph content hash is invalid.');
  else if (!turnGraphHashMatches(graph)) errors.push('Turn graph content does not match its hash.');

  if (graph.workTopology) {
    const validatedTopology = validateWorkTopology(graph.workTopology.topology);
    if (!validatedTopology.ok) {
      errors.push(`Turn graph work topology is invalid: ${validatedTopology.errors.join('; ')}`);
    } else {
      if (
        canonicalWorkTopologyJson(validatedTopology.topology)
        !== canonicalWorkTopologyJson(graph.workTopology.topology)
      ) {
        errors.push('Turn graph work topology is not in canonical normalized form.');
      }
      if (workTopologyDigest(validatedTopology.topology) !== graph.workTopology.topologyHash) {
        errors.push('Turn graph work topology does not match its hash.');
      }
      const graphOperationIds = graph.nodes
        .flatMap((node) => node.operationId ? [node.operationId] : [])
        .sort();
      const topologyOperationIds = validatedTopology.topology.operations.map((operation) => operation.id);
      if (
        graphOperationIds.length !== topologyOperationIds.length
        || graphOperationIds.some((id, index) => id !== topologyOperationIds[index])
      ) {
        errors.push('Turn graph operation nodes do not exactly cover the work topology.');
      }
      for (const operation of validatedTopology.topology.operations) {
        const graphNode = graph.nodes.find((node) => node.operationId === operation.id);
        if (!graphNode || graphNode.effect.kind !== operation.effect) {
          errors.push(`Turn graph node ${operation.id} does not preserve its work topology effect.`);
        }
        for (const dependency of operation.dependsOn) {
          if (!graph.edges.some((edge) => edge.source === dependency && edge.target === operation.id)) {
            errors.push(`Turn graph is missing work topology edge ${dependency}->${operation.id}.`);
          }
        }
      }
    }
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id.trim()) errors.push('Turn graph contains a node without an id.');
    if (nodeIds.has(node.id)) errors.push(`Duplicate turn graph node id "${node.id}".`);
    nodeIds.add(node.id);
    if (
      node.effect.kind === 'unknown'
      || node.effect.kind === 'local_write'
      || node.effect.kind === 'external_write'
      || node.effect.kind === 'admin'
    ) {
      if (
        node.authority.requirement !== 'runtime_tool_admission'
        || node.authority.state !== 'deferred'
        || node.authority.decisionOwner !== 'runtime_tool_boundary'
      ) {
        errors.push(`Effectful node "${node.id}" must defer authority to the runtime tool boundary.`);
      }
      if (node.effect.idempotency !== 'required_before_dispatch') {
        errors.push(`Effectful node "${node.id}" must require idempotency before dispatch.`);
      }
      if (node.effect.receipt !== 'durable_effect_receipt') {
        errors.push(`Effectful node "${node.id}" must require a durable effect receipt.`);
      }
    }
  }

  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) errors.push(`Duplicate turn graph edge id "${edge.id}".`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) errors.push(`Edge "${edge.id}" has an unknown source.`);
    if (!nodeIds.has(edge.target)) errors.push(`Edge "${edge.id}" has an unknown target.`);
    if (edge.source === edge.target) errors.push(`Edge "${edge.id}" points to itself.`);
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      outgoing.get(edge.source)?.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift() as string;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== graph.nodes.length) errors.push('Turn graph must be acyclic.');

  if (graph.nodes.filter((node) => node.kind === 'turn_accepted').length !== 1) {
    errors.push('Turn graph must contain exactly one accepted-turn node.');
  }
  const publishNodes = graph.nodes.filter((node) => node.kind === 'publish');
  if (publishNodes.length !== 1) errors.push('Turn graph must contain exactly one publish node.');
  if (publishNodes.some((node) => graph.edges.some((edge) => edge.source === node.id))) {
    errors.push('The publish node must be terminal.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}

export function compileTurnGraph(input: CompileTurnGraphInput): CompileTurnGraphResult {
  if (!input.identity.sessionId.trim()) throw new Error('Cannot compile a turn graph without a session id.');
  if (!Number.isSafeInteger(input.identity.sourceUserSeq) || input.identity.sourceUserSeq <= 0) {
    throw new Error('Cannot compile a turn graph without an accepted sourceUserSeq.');
  }
  if (!Number.isSafeInteger(input.identity.turn) || input.identity.turn < 0) {
    throw new Error('Cannot compile a turn graph with an invalid turn number.');
  }

  if (input.admitted !== undefined && !isAdmittedTurnSemantics(input.admitted)) {
    throw new Error('compileTurnGraph rejects unsealed semantics');
  }
  if (input.admitted) {
    const admitted = input.admitted;
    if (admitted.source.sessionId !== input.identity.sessionId) {
      throw new Error('admitted semantics belong to a different session');
    }
    if (admitted.source.sourceUserSeq !== input.identity.sourceUserSeq) {
      throw new Error('admitted semantics belong to a different accepted source');
    }
    if (admitted.source.inputHash !== sha256(input.input)) {
      throw new Error('admitted semantics do not match the accepted input hash');
    }
  }
  const typed = input.admitted?.clamped;
  const acceptedGoal: AcceptedGoalV1 = typed
    ? {
        sourceUserSeq: input.identity.sourceUserSeq,
        construct: typed.construct,
        effectCeiling: typed.effectCeiling,
        ...(typed.goalId ? { goalId: typed.goalId } : {}),
        ...(typed.revision !== undefined ? { revision: typed.revision } : {}),
        ...(typed.collection ? { collection: typed.collection } : {}),
        ...(typed.destinations?.length
          ? { destinations: typed.destinations.map((entry) => ({ ...entry })) }
          : {}),
        ...(typed.destination ? { destination: typed.destination } : {}),
        ...(typed.evidenceRequirements ? { evidenceRequirements: [...typed.evidenceRequirements] } : {}),
        route: typed.route,
      }
    : compileAcceptedGoal({
        text: input.input,
        sourceUserSeq: input.identity.sourceUserSeq,
        multiItem: input.signals?.multiItem ?? detectMultiItemIntent(input.input),
      });
  const typedRoute = typed ? typed.route : acceptedGoal.route;
  const intent = typed
    ? shadowIntentFromSemantics(typed, typedRoute)
    : (input.signals?.intent ?? classifyMessageIntent(input.input, {
      continueHostedWorld: input.signals?.continueHostedWorld === true,
    }));
  const writeCeiling = acceptedGoal.effectCeiling === 'external_write'
    || acceptedGoal.effectCeiling === 'local_write'
    || acceptedGoal.effectCeiling === 'admin';
  const externalEffect = typed
    ? {
        requested: writeCeiling,
        // `input` is the exact accepted source proven by the admitted
        // inputHash check above. Preserve the canonical provider-neutral
        // effect kinds so downstream contracts cannot lose a later delivery
        // merely because route/construct authority came from typed semantics.
        kinds: classifyExternalEffectRequest(input.input).kinds,
      }
    : (input.signals?.externalEffect ?? classifyExternalEffectRequest(input.input));
  const multiItem = typed
    ? multiItemFromSemantics(typed)
    : (input.signals?.multiItem ?? detectMultiItemIntent(input.input));
  const projectShape = typed
    ? { isProject: false, signals: [] as string[] }
    : classifyProjectShape(input.input, intent);
  const collectThenConstruct = multiItem.collectThenConstruct === true
    || acceptedGoal.construct === 'collect_then_construct';
  // Typed semantics own the route. Legacy compile may only WIDEN a find-lead
  // construct to act + write; observation-only asks still use the classifier.
  const route = typed
    ? typedRoute
    : (acceptedGoal.construct !== 'none' || acceptedGoal.effectCeiling === 'external_write'
      ? 'act'
      : routeFor(
        intent,
        externalEffect,
        isExplicitMemoryInstruction(input.input),
        collectThenConstruct,
      ));
  const fastPath = fastPathFor(route, {
    ...multiItem,
    collectThenConstruct,
  }, projectShape.isProject);
  const routeEffect = effectForRoute(
    route,
    externalEffect.requested || acceptedGoal.effectCeiling === 'external_write',
    acceptedGoal.effectCeiling,
  );
  const allowedToolNames = normalizedNames(input.allowedToolNames);
  const excludedToolNames = normalizedNames(input.excludedToolNames) ?? [];
  const policy = canonicalPolicy(input.policy);
  const externalEffectKinds = [...new Set(externalEffect.kinds)].sort();
  const warnings: string[] = [];
  if (allowedToolNames !== undefined && allowedToolNames.length === 0) warnings.push('explicit_zero_tool_authority');
  if (route === 'act' && routeEffect.kind === 'unknown') warnings.push('effect_requires_runtime_classification');
  if (externalEffect.requested) warnings.push('external_effect_authority_deferred');
  // E6.2: the fanout node dispatches through the durable manifest adapter
  // (execution/work-disposition.ts -> the mature background/workflow
  // substrate). It is no longer a shadow-only annotation on a mega-core, so
  // the shadow warning is retired; the contract below names the adapter.
  if (route === 'act' && multiItem.isMultiItem) warnings.push('durable_manifest_dispatch');

  const nodes: TurnGraphNode[] = [];
  const edges: TurnGraphEdge[] = [];
  let prior: TurnGraphNode | null = null;
  const addNode = (opts: {
    id?: string;
    kind: TurnGraphNodeKind;
    runner: TurnGraphRunner;
    effect?: TurnGraphEffect;
    capabilities?: TurnGraphCapabilityRequirement[];
    evidence?: TurnGraphNode['evidence'];
    emitsTopology?: TurnGraphNode['emitsTopology'];
    awaitInput?: TurnGraphAwaitInput;
    operationId?: string;
    capabilityRole?: string;
    cardinality?: number;
    requiredFields?: string[];
    structuredCollectionLocator?: TurnGraphNode['structuredCollectionLocator'];
    edgeWhen?: TurnGraphEdge['when'];
    connectPrior?: boolean;
  }): TurnGraphNode => {
    const effect = opts.effect ?? noEffect();
    const node: TurnGraphNode = {
      id: opts.id ?? `n${nodes.length}:${opts.kind}`,
      kind: opts.kind,
      runner: opts.runner,
      effect,
      authority: authorityFor(input.identity.sourceUserSeq, effect),
      capabilities: opts.capabilities ?? [],
      evidence: opts.evidence ?? { mode: 'none', kinds: [] },
      ...(opts.emitsTopology ? { emitsTopology: opts.emitsTopology } : {}),
      ...(opts.awaitInput ? { awaitInput: opts.awaitInput } : {}),
      ...(opts.operationId ? { operationId: opts.operationId } : {}),
      ...(opts.capabilityRole ? { capabilityRole: opts.capabilityRole } : {}),
      ...(opts.cardinality !== undefined ? { cardinality: opts.cardinality } : {}),
      ...(opts.requiredFields ? { requiredFields: opts.requiredFields } : {}),
      ...(opts.structuredCollectionLocator
        ? { structuredCollectionLocator: { ...opts.structuredCollectionLocator } }
        : {}),
    };
    nodes.push(node);
    if (prior && opts.connectPrior !== false) {
      edges.push({
        id: `e${edges.length}:${prior.id}->${node.id}`,
        source: prior.id,
        target: node.id,
        when: opts.edgeWhen ?? 'success',
      });
    }
    if (opts.connectPrior !== false) prior = node;
    return node;
  };

  addNode({ kind: 'turn_accepted', runner: { kind: 'runtime' } });
  addNode({ kind: 'policy_snapshot', runner: { kind: 'runtime' } });
  addNode({ kind: 'intent_authority', runner: { kind: 'runtime' } });

  if (route !== 'direct_reply') {
    addNode({
      kind: 'context_resolve',
      runner: { kind: 'runtime' },
      capabilities: [{ kind: 'memory', resolution: 'deferred' }],
    });
    addNode({
      kind: 'capability_resolve',
      runner: { kind: 'runtime' },
      capabilities: [
        {
          kind: 'tool',
          resolution: allowedToolNames === undefined ? 'deferred' : 'explicit',
          ...(allowedToolNames === undefined ? {} : { names: allowedToolNames }),
        },
        { kind: 'mcp_server', resolution: 'deferred' },
        { kind: 'skill', resolution: 'deferred' },
        { kind: 'workflow', resolution: 'deferred' },
      ],
    });
  }

  if (route === 'retrieve') {
    // A unique attested read already bound onto this source must compile as
    // an executable retrieve node. The sketch retrieve (no operationId) is
    // only for unbound reads, which dispatch may still answer in conversation.
    const boundReads = (typed?.operations ?? []).filter((operation) => (
      operation.requestedEffect === 'read'
      && Boolean(operation.capabilityRef)
    ));
    if (boundReads.length > 0) {
      for (const operation of boundReads) {
        addNode({
          id: operation.id,
          kind: 'retrieve',
          runner: { kind: 'tool' },
          effect: {
            kind: 'read',
            certainty: 'exact',
            reversibility: 'read_only',
            idempotency: 'not_required',
            receipt: 'evidence_ref',
          },
          operationId: operation.id,
          capabilityRole: operation.role,
          capabilities: [{
            kind: 'tool',
            resolution: 'explicit',
            names: [operation.capabilityRef!],
          }],
        });
      }
    } else {
      addNode({
        kind: 'retrieve',
        runner: { kind: 'tool' },
        effect: routeEffect,
      });
    }
    addNode({
      kind: 'verify',
      runner: { kind: 'runtime' },
      evidence: { mode: 'any', kinds: ['tool_result', 'source', 'memory'] },
    });
  } else if (route === 'act') {
    const workNodeIds: string[] = [];
    // Host-bound operations arrive ALREADY injected into the admitted clamped
    // semantics (prepareDurableAcceptedTurnCompile's bind pass) — one
    // synthesis owner, so the destination binder and this branch see the same
    // operations. An act construct that still has none compiles unbound and
    // dispatch fails CLOSED as blocked.
    const boundOperations = typed?.operations;
    if (typed && boundOperations && boundOperations.length > 0) {
      const headerPrior = nodes.at(-1) ?? null;
      const byId = new Map<string, TurnGraphNode>();
      const structuredWriteCandidates = typed.construct === 'collect_then_construct'
        && typed.collection
        && (typed.destinations?.length ?? (typed.destination ? 1 : 0)) === 1
        ? boundOperations.filter((operation) => (
            operation.requestedEffect === 'local_write'
            || operation.requestedEffect === 'external_write'
            || operation.requestedEffect === 'admin'
          ))
        : [];
      const preferredStructuredWrites = structuredWriteCandidates.filter((operation) => (
        operation.role === 'destination' || operation.role === 'create'
      ));
      const structuredWriteOwner = preferredStructuredWrites.length === 1
        ? preferredStructuredWrites[0]
        : structuredWriteCandidates.length === 1
          ? structuredWriteCandidates[0]
          : undefined;
      for (const operation of boundOperations) {
        const requested = operation.requestedEffect;
        const write = requested === 'external_write'
          || requested === 'local_write'
          || requested === 'admin';
        const ceilingRank = (
          typed.effectCeiling === 'admin' ? 5
            : typed.effectCeiling === 'external_write' ? 4
              : typed.effectCeiling === 'local_write' ? 3
                : typed.effectCeiling === 'unknown' ? 2
                  : typed.effectCeiling === 'read'
                    || typed.effectCeiling === 'compute'
                    || typed.effectCeiling === 'host_only' ? 1
                    : 0
        );
        const requestedRank = (
          requested === 'admin' ? 5
            : requested === 'external_write' ? 4
              : requested === 'local_write' ? 3
                : requested === 'unknown' ? 2
                  : requested === 'read' || requested === 'compute' || requested === 'host_only' ? 1
                    : 0
        );
        if (requestedRank > ceilingRank) {
          throw new Error(`operation ${operation.id} exceeds the admitted effect ceiling`);
        }
        const opEffect = requested;
        const kind: TurnGraphNodeKind = opEffect === 'read'
          ? 'retrieve'
          : operation.role === 'transform' || operation.role === 'extract'
            ? 'execute'
            : write && opEffect !== 'unknown'
              ? 'execute'
              : operation.role === 'readback'
                ? 'retrieve'
                : 'execute';
        const effect: TurnGraphEffect = opEffect === 'read'
          ? {
              kind: 'read',
              certainty: 'exact',
              reversibility: 'read_only',
              idempotency: 'not_required',
              receipt: 'evidence_ref',
            }
          : write && opEffect !== 'unknown'
            ? {
                kind: opEffect,
                certainty: 'ceiling',
                reversibility: 'unknown',
                idempotency: 'required_before_dispatch',
                receipt: 'durable_effect_receipt',
              }
            : opEffect === 'compute' || opEffect === 'host_only'
              ? {
                  kind: opEffect,
                  certainty: 'exact',
                  reversibility: 'not_applicable',
                  idempotency: 'not_required',
                  receipt: 'evidence_ref',
                }
            : {
                kind: opEffect === 'none' ? 'none' : 'unknown',
                certainty: 'ceiling',
                reversibility: 'unknown',
                idempotency: 'not_required',
                receipt: 'evidence_ref',
              };
        // A collect-then-construct cardinality describes the structured
        // deliverable when there is one exact destination write. Attaching it
        // to the upstream search conflates "five authored posts" with "five
        // search hits" and lets a four-item Workspace terminalize. Collection
        // reads keep the historical role-based projection only when no unique
        // structured destination owns the accepted collection contract.
        const ownsStructuredCollection = structuredWriteOwner
          ? operation.id === structuredWriteOwner.id
          : operation.role === 'collection';
        const node = addNode({
          id: operation.id,
          kind,
          runner: (write && opEffect !== 'unknown') || opEffect === 'read' ? { kind: 'tool' } : { kind: 'runtime' },
          effect,
          operationId: operation.id,
          capabilityRole: operation.role,
          ...(operation.capabilityRef
            ? {
                capabilities: [{
                  kind: 'tool' as const,
                  resolution: 'explicit' as const,
                  // Admission already resolved this opaque ref to the current
                  // successor. The pure graph compiler emits it verbatim; it
                  // never reaches back into mutable runtime manifest state.
                  names: [operation.capabilityRef],
                }],
              }
            : {}),
          cardinality: ownsStructuredCollection ? typed.collection?.count : undefined,
          requiredFields: ownsStructuredCollection ? typed.collection?.projection : undefined,
          structuredCollectionLocator: ownsStructuredCollection
            ? typed.collection?.locator
            : undefined,
          connectPrior: false,
        });
        byId.set(operation.id, node);
        workNodeIds.push(node.id);
      }
      for (const operation of boundOperations) {
        const node = byId.get(operation.id);
        if (!node) continue;
        if (operation.dependsOn.length === 0 && headerPrior) {
          const already = edges.some((edge) => edge.source === headerPrior.id && edge.target === node.id);
          if (!already) {
            edges.push({
              id: `e${edges.length}:${headerPrior.id}->${node.id}`,
              source: headerPrior.id,
              target: node.id,
              when: 'success',
            });
          }
        }
        for (const dep of operation.dependsOn) {
          if (!byId.has(dep)) {
            warnings.push(`operation ${operation.id} depends on unknown ${dep}`);
            continue;
          }
          const already = edges.some((edge) => edge.source === dep && edge.target === node.id);
          if (already) continue;
          edges.push({
            id: `e${edges.length}:${dep}->${node.id}`,
            source: dep,
            target: node.id,
            when: 'success',
          });
        }
      }
      const referenced = new Set(boundOperations.flatMap((operation) => operation.dependsOn));
      const sinks = boundOperations.filter((operation) => !referenced.has(operation.id));
      prior = (sinks.length > 0 ? byId.get(sinks[sinks.length - 1]!.id) : null) ?? [...byId.values()].at(-1) ?? headerPrior;
    } else if (collectThenConstruct) {
      // AGGREGATE CONSTRUCT: one source/read phase returns the bounded set and
      // its projected fields; one execute creates and populates the single
      // destination artifact. The runtime/tool may parallelize independent I/O
      // inside the aggregate read, but the graph must not manufacture one
      // worker or one destination write per returned row.
      addNode({
        kind: 'retrieve',
        runner: { kind: 'tool' },
        effect: {
          kind: 'read',
          certainty: 'exact',
          reversibility: 'read_only',
          idempotency: 'not_required',
          receipt: 'evidence_ref',
        },
      });
      addNode({
        kind: 'execute',
        runner: { kind: 'model', role: 'brain' },
        effect: routeEffect,
      });
    } else if (multiItem.isMultiItem) {
      // G5a + E6.2: the fanout node is a PLANNER under a runtime-topology
      // contract. At execution it produces the canonical item manifest and
      // hands it to the DURABLE MANIFEST ADAPTER
      // (dispositionToDurableWork), which owns item scheduling, bounded
      // concurrency, retries, checkpointing, and reducer readiness over the
      // mature background/workflow substrate — the model never has to
      // remember to call a worker N times, and items beyond one worker
      // window span additional durable windows rather than refusing.
      // Graph-native worker siblings remain future work (the admitted
      // executor is not activated for effects in this release).
      const reduceNodeId = `n${nodes.length + 1}:reduce`;
      addNode({
        kind: 'fanout',
        runner: { kind: 'model', role: 'brain' },
        emitsTopology: {
          kind: 'per_item_siblings',
          joinNodeId: reduceNodeId,
          workerRunner: { kind: 'model', role: 'worker' },
          workerEffect: routeEffect,
          maxConcurrency: 8,
          estimatedItems: multiItem.itemCount,
          /** The adapter that owns durable dispatch for this node's manifest. */
          durableAdapter: 'dispositionToDurableWork',
        },
      });
      const reduceNode = addNode({ kind: 'reduce', runner: { kind: 'runtime' } });
      if (reduceNode.id !== reduceNodeId) {
        // The contract names its join by id; a drifted id would orphan the
        // runtime siblings. Deterministic by construction, asserted anyway.
        throw new Error(`fanout contract join drift: expected ${reduceNodeId}, got ${reduceNode.id}`);
      }
    } else {
      addNode({
        kind: 'execute',
        runner: { kind: 'model', role: 'brain' },
        effect: routeEffect,
      });
    }
    const verifyNode = addNode({
      kind: 'verify',
      runner: { kind: 'runtime' },
      evidence: externalEffect.requested
        ? { mode: 'all', kinds: ['external_receipt'] }
        : { mode: 'any', kinds: ['tool_result', 'artifact', 'external_receipt'] },
      connectPrior: workNodeIds.length > 0 ? false : undefined,
    });
    if (workNodeIds.length > 0) {
      for (const sourceId of workNodeIds) {
        if (edges.some((edge) => edge.source === sourceId && edge.target === verifyNode.id)) continue;
        edges.push({
          id: `e${edges.length}:${sourceId}->${verifyNode.id}`,
          source: sourceId,
          target: verifyNode.id,
          when: 'success',
        });
      }
      prior = verifyNode;
    }
  }

  if (route === 'direct_reply') {
    if (typed?.openSlot) {
      addNode({
        kind: 'await_input',
        runner: { kind: 'human' },
        awaitInput: typed.openSlot,
      });
    }
    addNode({
      kind: 'compose_reply',
      runner: { kind: 'model', role: 'reply_composer' },
      edgeWhen: 'success',
    });
    addNode({ kind: 'publish', runner: { kind: 'runtime' } });
  } else {
    // Phase 1(a) of the verify extraction: BOTH verdict routes are topology.
    // Production has always published both outcomes — a delivered answer or a
    // blocked/needs-input question (the terminal-reduction table) — but the
    // compiled graph carried only the delivered route, which made
    // `evidence_sufficient` ungateable without stranding undelivered turns.
    // Exactly one route fires per turn under AND-join semantics; the other is
    // unreached-by-design, exactly like a workflow failure branch.
    const verifyNode = nodes[nodes.length - 1]!;
    const composeReply = addNode({
      kind: 'compose_reply',
      runner: { kind: 'model', role: 'reply_composer' },
      edgeWhen: 'evidence_sufficient',
    });
    let blockedSource = verifyNode.id;
    let blockedWhen: TurnGraphEdge['when'] = 'evidence_insufficient';
    if (typed?.openSlot) {
      const awaitInputNode: TurnGraphNode = {
        id: `n${nodes.length}:await_input`,
        kind: 'await_input',
        runner: { kind: 'human' },
        effect: noEffect(),
        authority: authorityFor(input.identity.sourceUserSeq, noEffect()),
        capabilities: [],
        evidence: { mode: 'none', kinds: [] },
        awaitInput: typed.openSlot,
      };
      nodes.push(awaitInputNode);
      edges.push({
        id: `e${edges.length}:${verifyNode.id}->${awaitInputNode.id}`,
        source: verifyNode.id,
        target: awaitInputNode.id,
        when: 'evidence_insufficient',
      });
      blockedSource = awaitInputNode.id;
      blockedWhen = 'success';
    }
    const composeBlocked: TurnGraphNode = {
      id: `n${nodes.length}:compose_blocked`,
      kind: 'compose_blocked',
      runner: { kind: 'model', role: 'reply_composer' },
      effect: noEffect(),
      authority: authorityFor(input.identity.sourceUserSeq, noEffect()),
      capabilities: [],
      evidence: { mode: 'none', kinds: [] },
    };
    nodes.push(composeBlocked);
    edges.push({
      id: `e${edges.length}:${blockedSource}->${composeBlocked.id}`,
      source: blockedSource,
      target: composeBlocked.id,
      when: blockedWhen,
    });
    // ONE publish node — the one-public-committer invariant as structure —
    // with an explicit ANY-join: the two verdict routes converge here and
    // exactly one fires per turn.
    const publishNode: TurnGraphNode = {
      id: `n${nodes.length}:publish`,
      kind: 'publish',
      runner: { kind: 'runtime' },
      joinMode: 'any',
      effect: noEffect(),
      authority: authorityFor(input.identity.sourceUserSeq, noEffect()),
      capabilities: [],
      evidence: { mode: 'none', kinds: [] },
    };
    nodes.push(publishNode);
    edges.push({
      id: `e${edges.length}:${composeReply.id}->${publishNode.id}`,
      source: composeReply.id,
      target: publishNode.id,
      when: 'success',
    });
    edges.push({
      id: `e${edges.length}:${composeBlocked.id}->${publishNode.id}`,
      source: composeBlocked.id,
      target: publishNode.id,
      when: 'success',
    });
  }

  const policyHash = sha256(stableJson(policy));
  const graph: TurnGraphIR = {
    version: TURN_GRAPH_IR_VERSION,
    mode: 'shadow',
    graphId: `turn-graph:v${TURN_GRAPH_IR_VERSION}:${input.identity.sourceUserSeq}`,
    identity: { ...input.identity },
    source: {
      sessionKind: input.sessionKind,
      surface: input.surface,
      inputHash: sha256(input.input),
    },
    compiler: {
      version: TURN_GRAPH_COMPILER_VERSION,
      policyHash,
      graphHash: '',
    },
    policy,
    toolAuthority: {
      explicit: allowedToolNames !== undefined,
      ...(allowedToolNames === undefined ? {} : { allowedToolNames }),
      excludedToolNames,
    },
    ...(typed?.workTopology && typed.workTopologyHash
      ? {
          workTopology: {
            topology: typed.workTopology,
            topologyHash: typed.workTopologyHash,
          },
        }
      : {}),
    classification: {
      messageIntent: intent.intent,
      confidence: Number(Math.max(0, Math.min(1, intent.confidence)).toFixed(3)),
      route,
      // The accepted goal is typed authority. A find-led construct can evade
      // the surface verb taxonomy while still carrying a create-new external
      // destination; never publish a read-only classification beside that
      // write ceiling.
      externalEffectRequested: externalEffect.requested
        || acceptedGoal.effectCeiling === 'external_write',
      projectShaped: projectShape.isProject,
      projectSignals: [...projectShape.signals].sort(),
      externalEffectKinds,
      multiItem: {
        detected: multiItem.isMultiItem,
        itemCount: Math.max(multiItem.itemCount, acceptedGoal.collection?.count ?? 0),
        explicitParallelRequest: multiItem.explicitParallelRequest,
        collectThenConstruct,
      },
      ...(acceptedGoal.construct !== 'none' || acceptedGoal.collection || destinationsOf(acceptedGoal).length > 0
        ? { goalConstraints: goalConstraintsOf(acceptedGoal) }
        : {}),
      ...(acceptedGoal.goalId
        ? { goalIdentity: { goalId: acceptedGoal.goalId, revision: acceptedGoal.revision ?? 0 } }
        : {}),
    },
    fastPath,
    effectCeiling: routeEffect.kind,
    nodes,
    edges,
    diagnostics: { warnings },
  };
  graph.compiler.graphHash = sha256(stableJson(graphHashMaterial(graph)));
  return { graph, validation: validateTurnGraph(graph) };
}
