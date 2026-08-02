import { createHash } from 'node:crypto';
import type { ProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import { classifyProjectShape } from '../../assistant/project-shape.js';
import {
  classifyExternalEffectRequest,
  type ExternalEffectClassification,
} from '../../assistant/external-effect-taxonomy.js';
import {
  classifyMessageIntent,
  type IntentClassification,
} from '../../assistant/message-intent.js';
import {
  detectMultiItemIntent,
  type MultiItemIntent,
} from '../harness/multi-item-intent.js';
import type { SessionKind } from '../harness/eventlog.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import {
  TURN_GRAPH_COMPILER_VERSION,
  TURN_GRAPH_IR_VERSION,
  TURN_GRAPH_POLICY_VERSION,
  type CompileTurnGraphResult,
  type TurnGraphAuthority,
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

export interface CompileTurnGraphInput {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  /** Used transiently for deterministic classifiers and hashing. It is never
   * copied into the graph or telemetry payload. */
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

function effectForRoute(route: TurnGraphRoute, externalEffectRequested: boolean): TurnGraphEffect {
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
  return {
    kind: externalEffectRequested ? 'external_write' : 'unknown',
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

function routeFor(intent: IntentClassification, externalEffect: ExternalEffectClassification): TurnGraphRoute {
  if (externalEffect.requested || intent.intent === 'action' || intent.intent === 'tool_intent') return 'act';
  if (intent.intent === 'lookup') return 'retrieve';
  return 'direct_reply';
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
  return multiItem.isMultiItem ? 'fanout_action' : 'single_action';
}

function graphHashMaterial(graph: TurnGraphIR): unknown {
  const { graphHash: _graphHash, ...compiler } = graph.compiler;
  return { ...graph, compiler };
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

  const intent = input.signals?.intent ?? classifyMessageIntent(input.input);
  const externalEffect = input.signals?.externalEffect ?? classifyExternalEffectRequest(input.input);
  const multiItem = input.signals?.multiItem ?? detectMultiItemIntent(input.input);
  const projectShape = classifyProjectShape(input.input, intent);
  // Work shape may choose an execution envelope only after intent has already
  // selected the action route. It must never turn advice or a lookup into work.
  const route = routeFor(intent, externalEffect);
  const fastPath = fastPathFor(route, multiItem, projectShape.isProject);
  const routeEffect = effectForRoute(route, externalEffect.requested);
  const allowedToolNames = normalizedNames(input.allowedToolNames);
  const excludedToolNames = normalizedNames(input.excludedToolNames) ?? [];
  const policy = canonicalPolicy(input.policy);
  const externalEffectKinds = [...new Set(externalEffect.kinds)].sort();
  const warnings: string[] = [];
  if (allowedToolNames !== undefined && allowedToolNames.length === 0) warnings.push('explicit_zero_tool_authority');
  if (route === 'act' && routeEffect.kind === 'unknown') warnings.push('effect_requires_runtime_classification');
  if (externalEffect.requested) warnings.push('external_effect_authority_deferred');
  if (route === 'act' && multiItem.isMultiItem) warnings.push('multi_item_fanout_shadow_only');

  const nodes: TurnGraphNode[] = [];
  const edges: TurnGraphEdge[] = [];
  let prior: TurnGraphNode | null = null;
  const addNode = (opts: {
    kind: TurnGraphNodeKind;
    runner: TurnGraphRunner;
    effect?: TurnGraphEffect;
    capabilities?: TurnGraphCapabilityRequirement[];
    evidence?: TurnGraphNode['evidence'];
    multiplicity?: TurnGraphNode['multiplicity'];
    edgeWhen?: TurnGraphEdge['when'];
  }): TurnGraphNode => {
    const effect = opts.effect ?? noEffect();
    const node: TurnGraphNode = {
      id: `n${nodes.length}:${opts.kind}`,
      kind: opts.kind,
      runner: opts.runner,
      effect,
      authority: authorityFor(input.identity.sourceUserSeq, effect),
      capabilities: opts.capabilities ?? [],
      evidence: opts.evidence ?? { mode: 'none', kinds: [] },
      ...(opts.multiplicity ? { multiplicity: opts.multiplicity } : {}),
    };
    nodes.push(node);
    if (prior) {
      edges.push({
        id: `e${edges.length}:${prior.id}->${node.id}`,
        source: prior.id,
        target: node.id,
        when: opts.edgeWhen ?? 'success',
      });
    }
    prior = node;
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
    addNode({
      kind: 'retrieve',
      runner: { kind: 'tool' },
      effect: routeEffect,
    });
    addNode({
      kind: 'verify',
      runner: { kind: 'runtime' },
      evidence: { mode: 'any', kinds: ['tool_result', 'source', 'memory'] },
    });
  } else if (route === 'act') {
    if (multiItem.isMultiItem) {
      const multiplicity = {
        kind: 'per_item' as const,
        estimatedItems: multiItem.itemCount,
        maxConcurrency: 8,
      };
      addNode({ kind: 'fanout', runner: { kind: 'runtime' }, multiplicity });
      addNode({
        kind: 'execute',
        runner: { kind: 'model', role: 'worker' },
        effect: routeEffect,
        multiplicity,
      });
      addNode({ kind: 'reduce', runner: { kind: 'runtime' } });
    } else {
      addNode({
        kind: 'execute',
        runner: { kind: 'model', role: 'brain' },
        effect: routeEffect,
      });
    }
    addNode({
      kind: 'verify',
      runner: { kind: 'runtime' },
      evidence: externalEffect.requested
        ? { mode: 'all', kinds: ['external_receipt'] }
        : { mode: 'any', kinds: ['tool_result', 'artifact', 'external_receipt'] },
    });
  }

  addNode({
    kind: 'compose_reply',
    runner: { kind: 'model', role: 'reply_composer' },
    edgeWhen: route === 'direct_reply' ? 'success' : 'evidence_sufficient',
  });
  addNode({ kind: 'publish', runner: { kind: 'runtime' } });

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
    classification: {
      messageIntent: intent.intent,
      confidence: Number(Math.max(0, Math.min(1, intent.confidence)).toFixed(3)),
      route,
      externalEffectRequested: externalEffect.requested,
      projectShaped: projectShape.isProject,
      projectSignals: [...projectShape.signals].sort(),
      externalEffectKinds,
      multiItem: {
        detected: multiItem.isMultiItem,
        itemCount: multiItem.itemCount,
        explicitParallelRequest: multiItem.explicitParallelRequest,
      },
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
