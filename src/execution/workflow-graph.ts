import type {
  WorkflowStepInput,
  WorkflowStepInputBinding,
  WorkflowStepOutputContract,
} from '../memory/workflow-store.js';

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
  deterministic?: { runner: string };
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

export function workflowGraphEdgeId(
  source: string,
  target: string,
  type: WorkflowGraphEdgeType = 'dependency',
): string {
  return `${type}:${source}->${target}`;
}

export function compileWorkflowStepsToGraph(
  steps: WorkflowStepInput[] | undefined | null,
  opts: { id?: string; name?: string; version?: number; metadata?: Record<string, unknown> } = {},
): WorkflowGraphDefinition {
  const list = Array.isArray(steps) ? steps : [];
  const nodes = list.map(stepToGraphNode);
  const edges: WorkflowGraphEdge[] = [];
  const seen = new Set<string>();

  for (const step of list) {
    for (const dep of step.dependsOn ?? []) {
      const id = workflowGraphEdgeId(dep, step.id, 'dependency');
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source: dep, target: step.id, type: 'dependency' });
    }
  }

  return {
    id: opts.id,
    name: opts.name,
    version: opts.version,
    nodes,
    edges,
    entryNodeIds: computeEntryNodeIds(nodes, edges),
    metadata: opts.metadata,
  };
}

export function validateWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphValidation {
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
    if (node.sideEffect === 'send' && node.requiresApproval !== true) {
      warnings.push(`Send-class node "${id}" has no declarative approval gate.`);
    }
    if (node.forEach && !nodeIds.has(node.forEach) && !nodes.some((candidate) => candidate.id === node.forEach)) {
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

export function getReadyWorkflowGraphNodes(
  graph: WorkflowGraphDefinition,
  completedNodeIds: Iterable<string>,
  blockedNodeIds: Iterable<string> = [],
): WorkflowGraphNode[] {
  const completed = new Set(completedNodeIds);
  const blocked = new Set(blockedNodeIds);
  const enabledEdges = graph.edges.filter((edge) => !edge.disabled);
  return graph.nodes.filter((node) => {
    if (completed.has(node.id) || blocked.has(node.id)) return false;
    const structuralIncoming = graph.edges.filter((edge) => edge.target === node.id);
    const incoming = enabledEdges.filter((edge) => edge.target === node.id);
    if (structuralIncoming.length > 0 && incoming.length === 0) return false;
    return incoming.every((edge) => completed.has(edge.source));
  });
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
  return {
    id: step.id,
    type: 'step',
    stepId: step.id,
    label: step.id,
    prompt: step.prompt,
    model: step.model,
    intent: step.intent,
    tier: step.tier,
    maxTurns: step.maxTurns,
    forEach: step.forEach,
    deterministic: step.deterministic,
    allowedTools: step.allowedTools,
    sideEffect: step.sideEffect,
    usesSkill: step.usesSkill,
    requiresApproval: step.requiresApproval,
    approvalPreview: step.approvalPreview,
    inputs: step.inputs,
    output: step.output,
    retryBudget: step.retryBudget,
    loopUntil: step.loopUntil,
    loopSafe: step.loopSafe,
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
    deterministic: node.deterministic ? { ...node.deterministic } : undefined,
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
