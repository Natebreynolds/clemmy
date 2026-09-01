import { createHash } from 'node:crypto';
import { WORKFLOW_STEP_RESULT_CHANNEL } from '../runtime/harness/tool-effect.js';
import { irreversibleBoundaryViolations } from './workflow-graph-boundaries.js';
import {
  firedEdgesFromCompleted,
  readyExecutableNodes,
  type ExecutableGraph,
} from '../runtime/graph/graph-executor.js';
import type {
  WorkflowStepInput,
  WorkflowStepInputBinding,
  WorkflowStepCall,
  WorkflowStepOutputContract,
  WorkflowTransformV1,
} from '../memory/workflow-store.js';
import {
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';
import { validateWorkflowTransform } from './workflow-transform.js';

export type WorkflowGraphNodeType =
  | 'step'
  | 'condition'
  | 'fanout'
  | 'join'
  | 'approval'
  | 'checkpoint'
  | 'graph_patch'
  | 'side_effect';

export type WorkflowGraphEdgeType =
  | 'dependency'
  | 'condition'
  | 'failure'
  | 'always';

export interface WorkflowGraphNode {
  id: string;
  type: WorkflowGraphNodeType;
  label?: string;
  prompt?: string;
  stepId?: string;
  model?: string;
  intent?: string;
  tier?: number;
  maxTurns?: number;
  forEach?: string;
  transform?: WorkflowTransformV1;
  deterministic?: { runner: string };
  call?: WorkflowStepCall;
  invocationPlan?: WorkflowNodeInvocationPlanV1;
  allowedTools?: string[];
  sideEffect?: 'read' | 'write' | 'send';
  usesSkill?: string;
  requiresApproval?: boolean;
  approvalPreview?: string;
  inputs?: Record<string, WorkflowStepInputBinding>;
  output?: WorkflowStepOutputContract;
  retryBudget?: number;
  loopUntil?: { maxAttempts?: number };
  loopSafe?: boolean;
  config?: Record<string, unknown>;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  type: WorkflowGraphEdgeType;
  condition?: Record<string, unknown>;
  priority?: number;
  disabled?: boolean;
}

export interface WorkflowGraphDefinition {
  id?: string;
  name?: string;
  version?: number;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  entryNodeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowGraphValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
  hasCycles: boolean;
  entryNodeIds: string[];
}

export type WorkflowGraphPatchOperation =
  | { op: 'add_node'; node: WorkflowGraphNode }
  | { op: 'add_edge'; edge: WorkflowGraphEdge }
  | { op: 'disable_edge'; edgeId: string; reason?: string }
  | { op: 'enable_edge'; edgeId: string };

export interface WorkflowGraphPatch {
  operations: WorkflowGraphPatchOperation[];
  reason?: string;
  proposedByNodeId?: string;
}

export interface WorkflowGraphPatchResult {
  ok: boolean;
  graph: WorkflowGraphDefinition;
  errors: string[];
  warnings: string[];
}

/**
 * Release-v3 authority carried by a model-added prompt node.
 *
 * Neither tool is work authority: `workflow_step_result` is the structural
 * return channel, and `workspace_artifact_query` is confined to the owning
 * run workspace by the ephemeral graph-step agent. This exact pair must never
 * be replaced with `*` or treated as an empty/inherited allowlist.
 */
export const WORKFLOW_GRAPH_RESULT_ONLY_TOOL = WORKFLOW_STEP_RESULT_CHANNEL;
export const WORKFLOW_GRAPH_CONTEXT_QUERY_TOOL = 'workspace_artifact_query';
export const WORKFLOW_GRAPH_ALLOWED_TOOLS = [
  WORKFLOW_GRAPH_RESULT_ONLY_TOOL,
  WORKFLOW_GRAPH_CONTEXT_QUERY_TOOL,
] as const;
export const WORKFLOW_GRAPH_ADDITIVE_NODE_MODE = 'additive_read_only_v3';
export const WORKFLOW_READ_PARALLEL_SUBGRAPH_MODE = 'read_parallel_v1';
const WORKFLOW_GRAPH_DYNAMIC_NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKFLOW_GRAPH_RESERVED_DYNAMIC_NODE_IDS = new Set([
  '__synthesis__',
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Validate an id that may become a runtime-created step/session/object key.
 * Kept beside the graph model so both mutation admission and persisted-snapshot
 * execution enforce the same rule.
 */
export function workflowGraphDynamicNodeIdError(nodeId: unknown): string | null {
  if (typeof nodeId !== 'string') {
    return 'Dynamic node id must be a string.';
  }
  if (WORKFLOW_GRAPH_RESERVED_DYNAMIC_NODE_IDS.has(nodeId.toLowerCase())) {
    return `Dynamic node id "${nodeId}" is reserved by the workflow runtime.`;
  }
  if (!WORKFLOW_GRAPH_DYNAMIC_NODE_ID_RE.test(nodeId)) {
    return `Dynamic node id "${nodeId}" must match ${WORKFLOW_GRAPH_DYNAMIC_NODE_ID_RE} (1-64 safe identifier characters).`;
  }
  return null;
}

export function workflowGraphEdgeId(
  source: string,
  target: string,
  type: WorkflowGraphEdgeType = 'dependency',
): string {
  return `${type}:${source}->${target}`;
}

/**
 * Stable runtime id for an authored specialist branch. Prefer the readable
 * parent/specialist pair; when a long authored parent would exceed the graph's
 * dynamic-id contract, retain readable prefixes plus a deterministic hash.
 */
export function workflowSubgraphSpecialistNodeId(stepId: string, specialistId: string): string {
  const readable = `${stepId}__${specialistId}`;
  if (!workflowGraphDynamicNodeIdError(readable)) return readable;
  const safeParent = stepId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) || 'step';
  const safeSpecialist = specialistId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16) || 'specialist';
  const digest = createHash('sha256').update(`${stepId}\0${specialistId}`).digest('hex').slice(0, 12);
  return `sg_${safeParent}_${safeSpecialist}_${digest}`.slice(0, 64);
}

function readParallelSpecialists(step: WorkflowStepInput) {
  return step.subgraph?.mode === WORKFLOW_READ_PARALLEL_SUBGRAPH_MODE
    ? step.subgraph.specialists
    : [];
}

export function workflowHasReadParallelSubgraph(steps: WorkflowStepInput[] | undefined | null): boolean {
  return (steps ?? []).some((step) => readParallelSpecialists(step).length > 0);
}

export function compileWorkflowStepsToGraph(
  steps: WorkflowStepInput[] | undefined | null,
  opts: { id?: string; name?: string; version?: number; metadata?: Record<string, unknown> } = {},
): WorkflowGraphDefinition {
  const list = Array.isArray(steps) ? steps : [];
  const nodes: WorkflowGraphNode[] = [];
  for (const step of list) {
    nodes.push(stepToGraphNode(step));
    for (const specialist of readParallelSpecialists(step)) {
      const nodeId = workflowSubgraphSpecialistNodeId(step.id, specialist.id);
      nodes.push({
        id: nodeId,
        type: 'step',
        stepId: nodeId,
        label: specialist.label?.trim() || specialist.id,
        prompt: [
          `You are the "${specialist.label?.trim() || specialist.id}" specialist for reducer step "${step.id}".`,
          specialist.prompt.trim(),
          `Return a compact, evidence-grounded result for reducer "${step.id}". Do not perform external writes or sends.`,
        ].join('\n\n'),
        ...(specialist.model ? { model: specialist.model } : {}),
        ...(specialist.intent ?? step.intent
          ? { intent: specialist.intent ?? step.intent }
          : {}),
        ...(specialist.maxTurns !== undefined ? { maxTurns: specialist.maxTurns } : {}),
        ...(step.inputs ? { inputs: step.inputs } : {}),
        sideEffect: 'read',
        allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS],
        requiresApproval: false,
        config: {
          runtimeMode: WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
          toolAuthority: 'result_only',
          subgraphMode: WORKFLOW_READ_PARALLEL_SUBGRAPH_MODE,
          subgraphRole: 'specialist',
          parentNodeId: step.id,
          specialistId: specialist.id,
        },
      });
    }
  }
  const edges: WorkflowGraphEdge[] = [];
  const seen = new Set<string>();

  for (const step of list) {
    for (const dep of step.dependsOn ?? []) {
      const id = workflowGraphEdgeId(dep, step.id, 'dependency');
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source: dep, target: step.id, type: 'dependency' });
    }
    for (const specialist of readParallelSpecialists(step)) {
      const specialistNodeId = workflowSubgraphSpecialistNodeId(step.id, specialist.id);
      for (const dep of step.dependsOn ?? []) {
        const id = workflowGraphEdgeId(dep, specialistNodeId, 'dependency');
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source: dep, target: specialistNodeId, type: 'dependency' });
      }
      const joinId = workflowGraphEdgeId(specialistNodeId, step.id, 'dependency');
      if (!seen.has(joinId)) {
        seen.add(joinId);
        edges.push({
          id: joinId,
          source: specialistNodeId,
          target: step.id,
          type: 'dependency',
        });
      }
    }
  }

  return {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    nodes,
    edges,
    entryNodeIds: computeEntryNodeIds(nodes, edges),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
}

function validateWorkflowGraphWithAuthoredBareCalls(
  graph: WorkflowGraphDefinition,
  authoredBareCallNodes: ReadonlySet<WorkflowGraphNode>,
  authoredTransformNodes: ReadonlySet<WorkflowGraphNode>,
): WorkflowGraphValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  if (nodes.length === 0) errors.push('Workflow graph has no nodes.');

  const nodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();
  for (const node of nodes) {
    const id = (node.id ?? '').trim();
    if (!id) {
      errors.push('Workflow graph contains a node with no id.');
      continue;
    }
    if (nodeIds.has(id)) duplicateNodeIds.add(id);
    nodeIds.add(id);

    if (node.type === 'condition') {
      const outgoing = edges.filter((edge) => !edge.disabled && edge.source === id);
      if (outgoing.length === 0) warnings.push(`Condition node "${id}" has no outgoing branches.`);
      for (const edge of outgoing) {
        if (edge.type !== 'condition') {
          warnings.push(`Condition node "${id}" has non-condition outgoing edge "${edge.id}".`);
        }
      }
    }

    if (node.type === 'side_effect' && !node.sideEffect) {
      errors.push(`Side-effect node "${id}" must declare sideEffect.`);
    }
    if (
      node.call !== undefined
      && node.invocationPlan === undefined
      && !authoredBareCallNodes.has(node)
    ) {
      errors.push(`Node "${id}" structured call is missing its exact invocation plan.`);
    }
    if (node.transform !== undefined) {
      if (!authoredTransformNodes.has(node)) {
        errors.push(`Node "${id}" transform is not byte-identical authored transform semantics.`);
      }
      const transform = validateWorkflowTransform(node.transform);
      if (!transform.ok) {
        errors.push(...transform.errors.map((error) => `Node "${id}" ${error}`));
      }
      if (node.type !== 'step') errors.push(`Node "${id}" transform must remain a first-class step node.`);
      if (node.sideEffect !== 'read') errors.push(`Node "${id}" transform must remain read-class.`);
      const incompatible: string[] = [];
      if (node.deterministic) incompatible.push('script');
      if (node.call) incompatible.push('call');
      if (node.invocationPlan) incompatible.push('invocation plan');
      if (node.forEach) incompatible.push('fan-out');
      if ((node.allowedTools?.length ?? 0) > 0) incompatible.push('tool authority');
      if (node.requiresApproval) incompatible.push('approval');
      if (node.loopUntil || node.loopSafe) incompatible.push('loop');
      if (incompatible.length > 0) {
        errors.push(`Node "${id}" transform cannot combine with ${incompatible.join(', ')}.`);
      }
    }
    if (node.invocationPlan !== undefined) {
      const parsed = parseWorkflowNodeInvocationPlan(node.invocationPlan);
      const exactCallPair = node.call !== undefined;
      if (!parsed.ok) {
        errors.push(`Node "${id}" has an invalid invocation plan: ${parsed.errors.join(' ')}`);
      } else if (exactCallPair) {
        const effect = parsed.plan.binding.effect;
        if (effect === 'compute') {
          errors.push(`Node "${id}" exact call cannot use a compute invocation plan.`);
        }
        if (node.call?.tool !== parsed.plan.binding.operationId) {
          errors.push(`Node "${id}" call tool differs from its exact invocation plan operation.`);
        }
        const sideEffectMatches = effect === 'read' || effect === 'host_only'
          ? node.sideEffect === 'read'
          : effect === 'external_write'
            ? node.sideEffect === 'write' || node.sideEffect === 'send'
            : node.sideEffect === 'write';
        if (!sideEffectMatches) {
          errors.push(`Node "${id}" side-effect class differs from its exact invocation plan effect "${effect}".`);
        }
        if (node.forEach) {
          errors.push(`Node "${id}" exact call cannot fan out until per-item occurrence identity is represented.`);
        }
      } else if (parsed.plan.binding.effect !== 'read') {
        errors.push(`Node "${id}" standalone invocation plan effect must be read; compute purity is not represented yet.`);
      }
      if (node.type !== 'step') {
        errors.push(`Node "${id}" invocation plan must remain a first-class step node.`);
      }
      if (!exactCallPair && node.sideEffect !== 'read') {
        errors.push(`Node "${id}" invocation plan must remain read-class in workflow graph v1.`);
      }
      if (
        node.deterministic
        || node.transform
        || node.loopUntil
        || (node.allowedTools?.length ?? 0) > 0
      ) {
        errors.push(`Node "${id}" invocation plan cannot combine with script, transform, loop, or name-based tool authority.`);
      }
      if (!exactCallPair && node.requiresApproval) {
        errors.push(`Node "${id}" standalone invocation plan cannot combine with generic approval authority.`);
      }
    }
    if (node.sideEffect === 'send' && node.invocationPlan === undefined && node.requiresApproval !== true) {
      warnings.push(`Send-class node "${id}" has no declarative approval gate.`);
    }
    const forEachUsesInput = typeof node.forEach === 'string'
      && /^(?:input\.[A-Za-z0-9_-]+|\{\{\s*input\.[A-Za-z0-9_-]+\s*\}\})$/.test(node.forEach.trim());
    if (node.forEach && !forEachUsesInput && !nodeIds.has(node.forEach) && !nodes.some((candidate) => candidate.id === node.forEach)) {
      errors.push(`Node "${id}" has forEach "${node.forEach}" but no such node exists.`);
    }
  }
  for (const id of duplicateNodeIds) errors.push(`Duplicate graph node id "${id}".`);

  const edgeIds = new Set<string>();
  const duplicateEdgeIds = new Set<string>();
  for (const edge of edges) {
    const id = (edge.id ?? '').trim();
    if (!id) {
      errors.push('Workflow graph contains an edge with no id.');
      continue;
    }
    if (edgeIds.has(id)) duplicateEdgeIds.add(id);
    edgeIds.add(id);
    if (!nodeIds.has(edge.source)) errors.push(`Edge "${id}" references unknown source node "${edge.source}".`);
    if (!nodeIds.has(edge.target)) errors.push(`Edge "${id}" references unknown target node "${edge.target}".`);
    if (edge.source === edge.target) errors.push(`Edge "${id}" points from a node to itself.`);
    if (edge.type === 'condition' && !edge.disabled && isEmptyObject(edge.condition)) {
      errors.push(`Condition edge "${id}" must declare a condition.`);
    }
  }
  for (const id of duplicateEdgeIds) errors.push(`Duplicate graph edge id "${id}".`);

  const declaredEntryIds = graph.entryNodeIds ?? [];
  for (const entry of declaredEntryIds) {
    if (!nodeIds.has(entry)) errors.push(`Entry node "${entry}" does not exist.`);
  }

  const enabledEdges = edges.filter((edge) => !edge.disabled);
  const hasCycles = graphHasCycle(nodes, enabledEdges);
  if (hasCycles) errors.push('Workflow graph has a cycle.');

  const computedEntryIds = computeEntryNodeIds(nodes, edges);
  for (const entry of declaredEntryIds) {
    if (enabledEdges.some((edge) => edge.target === entry)) {
      warnings.push(`Entry node "${entry}" has incoming enabled edges.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    hasCycles,
    entryNodeIds: declaredEntryIds.length > 0 ? declaredEntryIds : computedEntryIds,
  };
}

/**
 * The general graph contract remains exact-plan-only. A catalog workflow has
 * one narrower execution lane: an authored bare call may reach the shared v3
 * live-catalog compiler, but only while the persisted node is byte-identical
 * to the node compiled from the admitted authored step. This context never
 * authorizes graph-added calls or a graph rewrite of an authored call.
 */
export function validateWorkflowGraphAgainstAuthoredSteps(
  graph: WorkflowGraphDefinition,
  authoredSteps: WorkflowStepInput[],
): WorkflowGraphValidation {
  const authoredIds = new Set(authoredSteps.map((step) => step.id));
  const compiledById = new Map(
    compileWorkflowStepsToGraph(authoredSteps).nodes.map((node) => [node.id, node]),
  );
  const authoredBareCallNodes = new Set<WorkflowGraphNode>();
  const authoredTransformNodes = new Set<WorkflowGraphNode>();
  for (const node of graph.nodes) {
    if (!authoredIds.has(node.id)) continue;
    const compiled = compiledById.get(node.id);
    if (
      compiled?.call !== undefined
      && compiled.invocationPlan === undefined
      && JSON.stringify(node) === JSON.stringify(compiled)
    ) {
      authoredBareCallNodes.add(node);
    }
    if (
      compiled?.transform !== undefined
      && JSON.stringify(node) === JSON.stringify(compiled)
    ) {
      authoredTransformNodes.add(node);
    }
  }
  return validateWorkflowGraphWithAuthoredBareCalls(graph, authoredBareCallNodes, authoredTransformNodes);
}

export function validateWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphValidation {
  return validateWorkflowGraphWithAuthoredBareCalls(graph, new Set(), new Set());
}

/**
 * Present a compiled workflow graph as the executor's structural contract.
 *
 * Every edge maps to `success` because this engine has never distinguished
 * them: readiness asked only whether the source completed. Only `dependency`
 * edges are compiled today, so nothing is lost — and when `failure` edges
 * eventually are emitted, this is the one line that has to change.
 */
export function toExecutableGraph(graph: WorkflowGraphDefinition): ExecutableGraph {
  return {
    graphId: `${graph.name ?? 'workflow'}:${graph.version ?? 0}`,
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.type })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      when: 'success' as const,
      disabled: edge.disabled,
    })),
  };
}

/**
 * Which workflow nodes can run next?
 *
 * Delegates to the graph executor's readiness so there is ONE implementation of
 * this question in the system rather than two that must be kept in agreement.
 * The previous local copy is deleted rather than kept as a reference: two
 * implementations of one question is how the graph became a photograph in the
 * first place.
 *
 * Behavior is unchanged. Graph order is preserved, blocked nodes are excluded,
 * and a node whose every route was disabled stays out of the run.
 */
export function getReadyWorkflowGraphNodes(
  graph: WorkflowGraphDefinition,
  completedNodeIds: Iterable<string>,
  blockedNodeIds: Iterable<string> = [],
): WorkflowGraphNode[] {
  const executable = toExecutableGraph(graph);
  const completed = new Set(completedNodeIds);
  // Blocked nodes are settled for scheduling purposes: never dispatched, but
  // also never treated as having completed, so their dependents stay waiting.
  const settled = new Set([...completed, ...blockedNodeIds]);
  const ready = readyExecutableNodes(
    executable,
    firedEdgesFromCompleted(executable, completed),
    settled,
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return ready.map((node) => byId.get(node.id)!).filter(Boolean);
}

export function applyWorkflowGraphPatch(
  graph: WorkflowGraphDefinition,
  patch: WorkflowGraphPatch,
): WorkflowGraphPatchResult {
  const next = cloneGraph(graph);
  const errors: string[] = [];

  for (const op of patch.operations) {
    if (op.op === 'add_node') {
      if (next.nodes.some((node) => node.id === op.node.id)) {
        errors.push(`Cannot add duplicate node "${op.node.id}".`);
      } else {
        next.nodes.push(cloneNode(op.node));
      }
    } else if (op.op === 'add_edge') {
      if (next.edges.some((edge) => edge.id === op.edge.id)) {
        errors.push(`Cannot add duplicate edge "${op.edge.id}".`);
      } else {
        next.edges.push(cloneEdge(op.edge));
      }
    } else if (op.op === 'disable_edge' || op.op === 'enable_edge') {
      const edge = next.edges.find((candidate) => candidate.id === op.edgeId);
      if (!edge) {
        errors.push(`Cannot ${op.op === 'disable_edge' ? 'disable' : 'enable'} unknown edge "${op.edgeId}".`);
      } else {
        edge.disabled = op.op === 'disable_edge';
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, graph, errors, warnings: [] };
  }

  const validation = validateWorkflowGraph(next);
  if (!validation.ok) {
    return { ok: false, graph, errors: validation.errors, warnings: validation.warnings };
  }

  // One-way doors are enforced here, inside apply, so no caller can reshape a
  // running graph around an approval gate by skipping a separate check.
  const boundaryViolations = irreversibleBoundaryViolations(graph, next);
  if (boundaryViolations.length > 0) {
    return { ok: false, graph, errors: boundaryViolations, warnings: validation.warnings };
  }

  next.entryNodeIds = computeEntryNodeIds(next.nodes, next.edges);
  return { ok: true, graph: next, errors: [], warnings: validation.warnings };
}

export function applyWorkflowGraphBranchDecision(
  graph: WorkflowGraphDefinition,
  sourceNodeId: string,
  selectedEdgeIds: Iterable<string>,
): WorkflowGraphPatchResult {
  const selected = new Set(selectedEdgeIds);
  const operations: WorkflowGraphPatchOperation[] = [];
  for (const edge of graph.edges) {
    if (edge.source !== sourceNodeId || edge.type !== 'condition') continue;
    if (!selected.has(edge.id)) operations.push({ op: 'disable_edge', edgeId: edge.id, reason: 'branch_not_selected' });
  }
  return applyWorkflowGraphPatch(graph, { proposedByNodeId: sourceNodeId, operations, reason: 'branch_decision' });
}

function stepToGraphNode(step: WorkflowStepInput): WorkflowGraphNode {
  const specialists = readParallelSpecialists(step);
  const isReducer = specialists.length > 0;
  return {
    id: step.id,
    type: isReducer ? 'join' : 'step',
    stepId: step.id,
    label: step.id,
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(step.intent !== undefined ? { intent: step.intent } : {}),
    ...(step.tier !== undefined ? { tier: step.tier } : {}),
    ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
    ...(!isReducer && step.forEach !== undefined ? { forEach: step.forEach } : {}),
    ...(!isReducer && step.transform !== undefined ? { transform: step.transform } : {}),
    ...(!isReducer && step.deterministic !== undefined ? { deterministic: step.deterministic } : {}),
    ...(!isReducer && step.call !== undefined ? { call: step.call } : {}),
    ...(!isReducer && step.invocationPlan !== undefined ? { invocationPlan: step.invocationPlan } : {}),
    ...(isReducer
      ? { allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS] }
      : step.allowedTools !== undefined
        ? { allowedTools: step.allowedTools }
        : {}),
    ...(isReducer ? { sideEffect: 'read' as const } : step.sideEffect !== undefined ? { sideEffect: step.sideEffect } : {}),
    ...(!isReducer && step.usesSkill !== undefined ? { usesSkill: step.usesSkill } : {}),
    ...(isReducer ? { requiresApproval: false } : step.requiresApproval !== undefined ? { requiresApproval: step.requiresApproval } : {}),
    ...(!isReducer && step.approvalPreview !== undefined ? { approvalPreview: step.approvalPreview } : {}),
    ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
    ...(step.output !== undefined ? { output: step.output } : {}),
    ...(step.retryBudget !== undefined ? { retryBudget: step.retryBudget } : {}),
    ...(!isReducer && step.loopUntil !== undefined ? { loopUntil: step.loopUntil } : {}),
    ...(!isReducer && step.loopSafe !== undefined ? { loopSafe: step.loopSafe } : {}),
    ...(isReducer
      ? {
          config: {
            subgraphMode: WORKFLOW_READ_PARALLEL_SUBGRAPH_MODE,
            subgraphRole: 'reducer',
            specialistNodeIds: specialists.map((specialist) =>
              workflowSubgraphSpecialistNodeId(step.id, specialist.id)),
            toolAuthority: 'result_only',
          },
        }
      : {}),
  };
}

function computeEntryNodeIds(nodes: WorkflowGraphNode[], edges: WorkflowGraphEdge[]): string[] {
  const incoming = new Set(edges.filter((edge) => !edge.disabled).map((edge) => edge.target));
  return nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
}

function graphHasCycle(nodes: WorkflowGraphNode[], edges: WorkflowGraphEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (!adj.has(edge.source) || !adj.has(edge.target)) continue;
    adj.get(edge.source)?.push(edge.target);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return nodes.some((node) => visit(node.id));
}

function isEmptyObject(value: unknown): boolean {
  return !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0;
}

function cloneGraph(graph: WorkflowGraphDefinition): WorkflowGraphDefinition {
  return {
    id: graph.id,
    name: graph.name,
    version: graph.version,
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map(cloneEdge),
    entryNodeIds: graph.entryNodeIds ? [...graph.entryNodeIds] : undefined,
    metadata: cloneRecord(graph.metadata),
  };
}

function cloneNode(node: WorkflowGraphNode): WorkflowGraphNode {
  return {
    ...node,
    transform: node.transform ? structuredClone(node.transform) : undefined,
    deterministic: node.deterministic ? { ...node.deterministic } : undefined,
    call: node.call
      ? { tool: node.call.tool, ...(node.call.args ? { args: structuredClone(node.call.args) } : {}) }
      : undefined,
    invocationPlan: node.invocationPlan
      ? structuredClone(node.invocationPlan)
      : undefined,
    allowedTools: node.allowedTools ? [...node.allowedTools] : undefined,
    inputs: cloneRecord(node.inputs) as Record<string, WorkflowStepInputBinding> | undefined,
    output: cloneRecord(node.output) as WorkflowStepOutputContract | undefined,
    loopUntil: node.loopUntil ? { ...node.loopUntil } : undefined,
    config: cloneRecord(node.config),
  };
}

function cloneEdge(edge: WorkflowGraphEdge): WorkflowGraphEdge {
  return {
    ...edge,
    condition: cloneRecord(edge.condition),
  };
}

function cloneRecord<T extends object | undefined>(value: T): T {
  if (!value) return undefined as T;
  return JSON.parse(JSON.stringify(value)) as T;
}
