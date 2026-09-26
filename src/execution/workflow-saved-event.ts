/**
 * What a chat shows after Clementine creates or changes a workflow: the saved
 * definition, as a small graph, with the steps that changed marked.
 *
 * The card is built from what is ON DISK after the write, never from the
 * arguments the model passed to the tool: the public event plane withholds
 * tool arguments, and a card drawn from them would show what the model asked
 * for rather than what was stored. `changedStepIds` compares the definition
 * before the call with the one after it on the fields that decide what a step
 * does, so a reworded description or a new schedule marks no step.
 */
import { readWorkflow, type WorkflowDefinition, type WorkflowStepInput } from '../memory/workflow-store.js';
import { buildWorkflowGraph } from '../dashboard/workflow-graph.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';

export interface WorkflowSavedStep {
  id: string;
  label: string;
  effect: 'read' | 'write' | 'send' | 'unknown';
  approval: boolean;
  forEach: boolean;
  dependsOn: string[];
}

export interface WorkflowSavedEventData {
  name: string;
  slug: string;
  op: 'created' | 'updated';
  enabled: boolean;
  steps: WorkflowSavedStep[];
  /** Steps whose behaviour differs from before (added steps are listed here too). */
  changedStepIds: string[];
  addedStepIds: string[];
  removedStepIds: string[];
}

/** The fields that decide what a step does; a change to any of them marks the step. */
function stepBehaviourKey(step: WorkflowStepInput): string {
  return JSON.stringify({
    prompt: step.prompt ?? '',
    dependsOn: [...(step.dependsOn ?? [])].sort(),
    requiresApproval: step.requiresApproval === true,
    optional: step.optional === true,
    forEach: step.forEach ?? null,
    forEachNewOnly: step.forEachNewOnly === true,
    allowedTools: [...(step.allowedTools ?? [])].sort(),
    call: step.call ?? null,
    usesSkill: step.usesSkill ?? null,
    model: step.model ?? null,
    output: step.output ?? null,
    inputs: step.inputs ?? null,
    sideEffect: step.sideEffect ?? null,
    deterministic: step.deterministic ?? null,
    transform: step.transform ?? null,
    subgraph: step.subgraph ?? null,
  });
}

export function workflowSavedEventData(
  slug: string,
  before: WorkflowDefinition | null,
  after: WorkflowDefinition,
): WorkflowSavedEventData {
  const graph = buildWorkflowGraph(after.steps);
  const steps: WorkflowSavedStep[] = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    effect: node.meta.sideEffect,
    approval: node.flags.approval,
    forEach: node.flags.forEach,
    dependsOn: node.dependsOn,
  }));
  const beforeById = new Map((before?.steps ?? []).map((s) => [s.id, s]));
  const afterIds = new Set((after.steps ?? []).map((s) => s.id));
  const addedStepIds: string[] = [];
  const changedStepIds: string[] = [];
  for (const step of after.steps ?? []) {
    const prior = beforeById.get(step.id);
    if (!prior) { addedStepIds.push(step.id); changedStepIds.push(step.id); continue; }
    if (stepBehaviourKey(prior) !== stepBehaviourKey(step)) changedStepIds.push(step.id);
  }
  const removedStepIds = [...beforeById.keys()].filter((id) => !afterIds.has(id));
  return {
    name: after.name,
    slug,
    op: before ? 'updated' : 'created',
    enabled: after.enabled === true,
    steps,
    changedStepIds,
    addedStepIds,
    removedStepIds,
  };
}

/**
 * Publish the saved workflow to the chat that asked for the change. Silent
 * when no chat is asking (a scheduled job, a test) and never fails the write:
 * the card is a courtesy of the reply, not part of the commit.
 */
export function emitWorkflowSaved(
  slug: string,
  before: WorkflowDefinition | null,
  opts: { sessionId?: string } = {},
): WorkflowSavedEventData | null {
  const context = getToolOutputContext();
  const sessionId = opts.sessionId ?? context?.sessionId;
  if (!sessionId) return null;
  const entry = readWorkflow(slug);
  if (!entry) return null;
  const data = workflowSavedEventData(slug, before, entry.data);
  // The exact accepted user input this change answers, so a reopened
  // conversation can put the card under the right reply.
  const sourceUserSeq = Number.isSafeInteger(context?.sourceUserSeq) && Number(context?.sourceUserSeq) > 0
    ? Number(context?.sourceUserSeq)
    : undefined;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'workflow_saved',
      data: { ...(data as unknown as Record<string, unknown>), ...(sourceUserSeq ? { sourceUserSeq } : {}) },
    });
  } catch {
    /* the reply still carries the text receipt */
  }
  return data;
}
