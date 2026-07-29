/**
 * `workflow_reshape` — the model's structural verb for work already running.
 *
 * `workflow_update` replaces an entire step list at authoring time. This is its
 * surgical, mid-run counterpart: widen a bottleneck into parallel branches,
 * withhold a route whose source went dark, or restore one when it recovers,
 * without disturbing a single completed result.
 *
 * Discoverable rather than first-class: it stays out of the always-loaded
 * schema kernel and is acquired through tool_search/call_tool like any other
 * on-demand capability, so an ordinary turn pays nothing for it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from './shared.js';
import { reshapeWorkflowGraph, loadLiveWorkflowGraph } from '../execution/workflow-graph-reshape.js';
import { irreversibleBoundaries } from '../execution/workflow-graph-boundaries.js';
import type { WorkflowGraphPatchOperation } from '../execution/workflow-graph.js';

/**
 * Operations arrive as a JSON array STRING, matching this codebase's
 * convention for nested payloads on the deferred transport (call_tool's
 * args_json, workflow_state's values, composio_args_json).
 *
 * This is not cosmetic. A nested array-of-objects with optional fields is
 * hostile to the strict schema transport: the model must supply every
 * nullable key, and omitted nested optionals fail validation. Live pass^k
 * caught exactly that — one run in three fumbled operations.0.label /
 * .prompt / .side_effect and the reshape silently never happened. A JSON
 * string has one shape the model cannot get partially wrong, and parse
 * errors become readable guidance instead of schema noise.
 */
export interface OperationInput {
  op?: string;
  node_id?: string;
  label?: string;
  prompt?: string;
  side_effect?: string;
  requires_approval?: boolean;
  source?: string;
  target?: string;
  edge_id?: string;
  reason?: string;
}

/** Parse the operations payload. Returns typed errors, never throws. */
export function parseOperationsJson(raw: string): { inputs: OperationInput[]; errors: string[] } {
  const text = (raw ?? '').trim();
  if (!text) return { inputs: [], errors: ['operations_json is required — pass a JSON array of operations.'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { inputs: [], errors: ['operations_json is not valid JSON. Pass a JSON ARRAY string, e.g. [{"op":"add_node","node_id":"analyze-b"}].'] };
  }
  if (!Array.isArray(parsed)) {
    return { inputs: [], errors: ['operations_json must be a JSON ARRAY of operations.'] };
  }
  const inputs: OperationInput[] = [];
  const errors: string[] = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`operation ${index + 1}: each entry must be an object.`);
      return;
    }
    inputs.push(entry as OperationInput);
  });
  return { inputs, errors };
}


/** Translate the flat model-facing shape into graph operations. Kept pure and
 *  exported so the mapping is testable without a live graph. */
export function toGraphOperations(inputs: OperationInput[]): { operations: WorkflowGraphPatchOperation[]; errors: string[] } {
  const operations: WorkflowGraphPatchOperation[] = [];
  const errors: string[] = [];
  const VALID_OPS = new Set(['add_node', 'add_edge', 'disable_edge', 'enable_edge']);
  inputs.forEach((input, index) => {
    const at = `operation ${index + 1} (${input.op ?? 'missing op'})`;
    if (!input.op || !VALID_OPS.has(input.op)) {
      errors.push(`${at}: op must be one of add_node, add_edge, disable_edge, enable_edge.`);
      return;
    }
    if (input.side_effect && !['read', 'write', 'send'].includes(input.side_effect)) {
      errors.push(`${at}: side_effect must be read, write, or send.`);
      return;
    }
    if (input.op === 'add_node') {
      if (!input.node_id) { errors.push(`${at}: node_id is required.`); return; }
      operations.push({
        op: 'add_node',
        node: {
          id: input.node_id,
          type: 'step',
          stepId: input.node_id,
          ...(input.label ? { label: input.label } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.side_effect ? { sideEffect: input.side_effect as 'read' | 'write' | 'send' } : {}),
          ...(input.requires_approval == null ? {} : { requiresApproval: input.requires_approval }),
        },
      });
      return;
    }
    if (input.op === 'add_edge') {
      if (!input.source || !input.target) { errors.push(`${at}: source and target are required.`); return; }
      operations.push({
        op: 'add_edge',
        edge: { id: `dependency:${input.source}->${input.target}`, source: input.source, target: input.target, type: 'dependency' },
      });
      return;
    }
    if (!input.edge_id) { errors.push(`${at}: edge_id is required.`); return; }
    operations.push(input.op === 'disable_edge'
      ? { op: 'disable_edge', edgeId: input.edge_id, ...(input.reason ? { reason: input.reason } : {}) }
      : { op: 'enable_edge', edgeId: input.edge_id });
  });
  return { operations, errors };
}

export function registerWorkflowReshapeTools(server: McpServer): void {
  server.tool(
    'workflow_reshape',
    [
      'Change the SHAPE of a workflow run that is already in flight — the mid-run counterpart to workflow_update (which replaces a whole definition at authoring time). ',
      'Use it when reality diverges from the plan: split a bottleneck node into parallel branches, add a follow-up branch, withhold a route whose source is rate-limited or dark (disable_edge), or restore one when it recovers (enable_edge). ',
      'action "inspect" returns the live graph — node ids, edge ids, and which nodes are irreversible one-way doors — so operations reference real ids. Inspect before reshaping. ',
      'Completed work is immutable: a reshape redirects what happens NEXT and can never edit or remove a node whose result is recorded. ',
      'A reshape that would let work run without waiting for an approval-gated send is refused, as is a new send node without requires_approval. ',
      'Refusals name the exact problem so the next attempt can correct it.',
    ].join(''),
    {
      workflow: z.string().min(1).describe('Workflow name (slug) that owns the run.'),
      run_id: z.string().min(1).describe('The in-flight run to reshape.'),
      action: z.enum(['inspect', 'apply']).describe('"inspect" reads the live graph; "apply" performs the reshape.'),
      reason: z.string().nullish().describe('For "apply": one plain sentence on why the shape must change. Surfaced to the user.'),
      operations_json: z.string().nullish().describe('For "apply": a JSON ARRAY string of operations. Each entry: {"op":"add_node","node_id":"analyze-b","label":"second branch","prompt":"...","side_effect":"read"} | {"op":"add_edge","source":"pull","target":"analyze-b"} | {"op":"disable_edge","edge_id":"dependency:a->b","reason":"source is dark"} | {"op":"enable_edge","edge_id":"dependency:a->b"}. Only op and its own required keys are needed; omit the rest.'),
      completed_node_ids_json: z.string().nullish().describe('Optional JSON array string of already-finished node ids; their structure is protected.'),
    },
    async ({ workflow, run_id, action, reason, operations_json, completed_node_ids_json }) => {
      try {
        if (action === 'inspect') {
          const graph = loadLiveWorkflowGraph(run_id);
          if (!graph) return textResult(`No live graph is stored for run "${run_id}".`);
          return textResult(JSON.stringify({
            nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label, sideEffect: node.sideEffect, requiresApproval: node.requiresApproval })),
            edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, disabled: edge.disabled === true })),
            irreversibleBoundaries: irreversibleBoundaries(graph),
          }, null, 2));
        }

        const parsedOps = parseOperationsJson(operations_json ?? '');
        if (parsedOps.errors.length > 0) return textResult(`Refused: ${parsedOps.errors.join(' ')} Call action "inspect" first to see real node and edge ids.`);
        if (parsedOps.inputs.length === 0) return textResult('Refused: "apply" needs at least one operation. Call action "inspect" first to see real node and edge ids.');

        const mapped = toGraphOperations(parsedOps.inputs);
        if (mapped.errors.length > 0) return textResult(`Refused: ${mapped.errors.join(' ')}`);

        let completedNodeIds: string[] = [];
        if (completed_node_ids_json?.trim()) {
          try {
            const parsed = JSON.parse(completed_node_ids_json) as unknown;
            if (Array.isArray(parsed)) completedNodeIds = parsed.map((id) => String(id));
          } catch { /* an unreadable hint must never block a valid reshape */ }
        }

        const result = reshapeWorkflowGraph({
          workflowName: workflow,
          runId: run_id,
          completedNodeIds,
          patch: { operations: mapped.operations, reason: reason ?? undefined },
        });

        if (!result.ok) {
          return textResult(`Reshape refused — the run is unchanged.\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
        }
        return textResult([
          `Reshaped run ${run_id}: ${result.appliedOperations} operation${result.appliedOperations === 1 ? '' : 's'} applied.`,
          `The run now has ${result.graph?.nodes.length ?? 0} nodes and ${result.graph?.edges.length ?? 0} edges; completed work was preserved.`,
          ...(result.warnings.length > 0 ? [`Warnings: ${result.warnings.join('; ')}`] : []),
        ].join(' '));
      } catch (error) {
        return textResult(`Reshape failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
