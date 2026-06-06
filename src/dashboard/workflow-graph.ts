/**
 * Build a renderable flow graph from a workflow's steps: nodes = steps,
 * edges = `dependsOn` (the DAG). Pure + dependency-light so it can be
 * unit-tested and so the console route can return a ready-to-draw graph
 * (the browser just hands {nodes, edges} to Cytoscape).
 *
 * Node `flags` drive the little badges in the UI (forEach / approval /
 * skill / deterministic). Edges only ever reference steps that exist, so
 * a dangling `dependsOn` never produces a half-edge.
 */
import type { WorkflowStepInput } from '../memory/workflow-store.js';
import { shortStepLabel } from '../execution/workflow-describe.js';

export interface FlowNodeFlags {
  forEach: boolean;
  approval: boolean;
  skill: string | null;
  deterministic: boolean;
}
export interface FlowNode {
  id: string;
  label: string;
  flags: FlowNodeFlags;
  dependsOn: string[];
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}
export interface WorkflowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function buildWorkflowGraph(steps: WorkflowStepInput[] | undefined | null): WorkflowGraph {
  const list = Array.isArray(steps) ? steps : [];
  const ids = new Set(list.map((s) => s.id));
  const nodes: FlowNode[] = list.map((s) => ({
    id: s.id,
    label: shortStepLabel(s.prompt || s.id),
    flags: {
      forEach: Boolean(s.forEach),
      approval: Boolean(s.requiresApproval),
      skill: s.usesSkill ?? null,
      deterministic: Boolean(s.deterministic),
    },
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => ids.has(d)) : [],
  }));
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    for (const d of deps) {
      if (!ids.has(d)) continue;             // skip dangling deps
      const id = `${d}->${s.id}`;
      if (seen.has(id)) continue;            // de-dupe repeated deps
      seen.add(id);
      edges.push({ id, source: d, target: s.id });
    }
  }
  return { nodes, edges };
}
