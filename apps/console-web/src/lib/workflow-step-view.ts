/**
 * What the step panel says about one step, derived from what the daemon
 * already returns: the graph node (how the engine classifies the step), the
 * stored step (what was authored), and the dry-run trace (what it reads and
 * produces). Pure, so the panel's wording is testable without a browser.
 */
import type { WorkflowStep } from './automate';
import type { CanvasGraph, CanvasGraphNode } from './workflow-canvas';

export interface StepRunAs {
  kind: 'model' | 'skill' | 'script' | 'call';
  /** "AI · Sonnet", "Skill · people-lookup", "Script", "Direct call · SLACK_SEND_MESSAGE" */
  label: string;
}

/** A model id the way a person says it; anything unrecognised is shown as is. */
export function shortModelName(id?: string | null): string {
  if (!id) return 'default model';
  const m = id.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('fable')) return 'Fable';
  if (m.startsWith('gpt')) return id.toUpperCase().replace(/^GPT-?/, 'GPT-');
  return id;
}

export function describeStepRun(node: CanvasGraphNode, step?: WorkflowStep): StepRunAs {
  const executor = node.meta?.executor ?? 'model';
  if (executor === 'call') {
    const tool = node.meta?.callTool ?? node.meta?.tools?.[0];
    return { kind: 'call', label: tool ? `Direct call · ${tool}` : 'Direct call' };
  }
  if (executor === 'deterministic') {
    const runner = node.meta?.runner;
    return { kind: 'script', label: runner ? `Script · ${runner}` : 'Script' };
  }
  if (executor === 'skill') {
    const skill = node.flags?.skill ?? step?.usesSkill;
    return { kind: 'skill', label: skill ? `Skill · ${skill}` : 'Skill' };
  }
  const model = node.meta?.model ?? step?.model ?? null;
  return { kind: 'model', label: `AI · ${shortModelName(model)}` };
}

export interface StepFlags {
  /** The step waits for the owner before it does anything. */
  asksFirst: boolean;
  /** A failure leaves a gap and the run continues. */
  keepGoing: boolean;
  /** The upstream output it runs once per item of, or null. */
  perItem: string | null;
  /** Only items not seen by an earlier run. */
  newItemsOnly: boolean;
}

export function stepFlags(node: CanvasGraphNode, step?: WorkflowStep): StepFlags {
  const perItem = (typeof node.meta?.forEach === 'string' && node.meta.forEach.trim())
    ? node.meta.forEach.trim()
    : (typeof step?.forEach === 'string' && step.forEach.trim()) ? step.forEach.trim() : null;
  return {
    asksFirst: node.flags?.approval === true || step?.requiresApproval === true,
    keepGoing: step?.optional === true,
    perItem,
    newItemsOnly: perItem !== null && step?.forEachNewOnly === true,
  };
}

/** Steps that wait for this one, in graph order. */
export function dependentsOf(graph: CanvasGraph, id: string): string[] {
  return (graph.nodes ?? [])
    .filter((n) => Array.isArray(n.dependsOn) && n.dependsOn.includes(id))
    .map((n) => n.id);
}

/** The first sentence of a prompt, for a one-line summary; the whole prompt when it has no sentence break. */
export function firstSentence(prompt?: string | null, max = 160): string {
  if (!prompt) return '';
  const text = prompt.trim().replace(/\s+/g, ' ');
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * The opening line of a chat about one step. It names the workflow and the
 * step and stops, so the owner says what should change in their own words.
 */
export function askAboutStepPrompt(workflowName: string, stepId: string): string {
  return `About the "${stepId}" step of my "${workflowName}" workflow: `;
}

export interface WorkflowShape {
  steps: number;
  reads: number;
  writes: number;
  sends: number;
  approvals: number;
}

/** Counts for the panel shown before any step is picked. */
export function workflowShape(graph: CanvasGraph): WorkflowShape {
  const nodes = graph.nodes ?? [];
  const count = (effect: string) => nodes.filter((n) => n.meta?.sideEffect === effect).length;
  return {
    steps: nodes.length,
    reads: count('read'),
    writes: count('write'),
    sends: count('send'),
    approvals: nodes.filter((n) => n.flags?.approval === true).length,
  };
}

/* ---------- editing the everyday four ---------- */

/** The four things a person changes on a step without going through Clementine. */
export interface StepDraft {
  prompt: string;
  asksFirst: boolean;
  keepGoing: boolean;
  /** The upstream output to run once per item of; '' when the step runs once. */
  perItem: string;
}

export function stepDraftFrom(node: CanvasGraphNode, step?: WorkflowStep): StepDraft {
  const flags = stepFlags(node, step);
  return {
    prompt: step?.prompt ?? '',
    asksFirst: flags.asksFirst,
    keepGoing: flags.keepGoing,
    perItem: flags.perItem ?? '',
  };
}

export function draftChanged(base: StepDraft, draft: StepDraft): boolean {
  return base.prompt.trim() !== draft.prompt.trim()
    || base.asksFirst !== draft.asksFirst
    || base.keepGoing !== draft.keepGoing
    || base.perItem.trim() !== draft.perItem.trim();
}

/**
 * The patch to send: only what changed. A flag turned off is removed (`null`)
 * rather than stored as false, so the file reads the way an author writes it.
 */
export function stepPatchFromDraft(base: StepDraft, draft: StepDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (base.prompt.trim() !== draft.prompt.trim()) patch.prompt = draft.prompt.trim();
  if (base.asksFirst !== draft.asksFirst) patch.requiresApproval = draft.asksFirst ? true : null;
  if (base.keepGoing !== draft.keepGoing) patch.optional = draft.keepGoing ? true : null;
  if (base.perItem.trim() !== draft.perItem.trim()) patch.forEach = draft.perItem.trim() ? draft.perItem.trim() : null;
  return patch;
}

/** The statuses under which a run is still going, for polling a step test. */
export const RUN_STILL_GOING = new Set(['queued', 'running', 'finalizing', 'parked', 'blocked_capability', 'blocked_mutation']);
