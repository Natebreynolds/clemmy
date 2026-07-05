import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { analyzeWorkflowGaps } from '../execution/workflow-gap-test.js';
import { classifyStepSideEffect } from '../execution/workflow-enforce.js';

export type WorkflowLifecycleState = 'draft' | 'needs_info' | 'testing' | 'live';

export interface WorkflowProofRun {
  id: string;
  workflow: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
  targetStepId: string | null;
  needsAttention: boolean;
}

export interface WorkflowProof {
  lifecycle: WorkflowLifecycleState;
  label: 'DRAFT' | 'NEEDS INFO' | 'TESTING' | 'LIVE';
  reason: string;
  canRun: boolean;
  canEnable: boolean;
  triggerSummary: string[];
  inputKeys: string[];
  requiredInputKeys: string[];
  toolNames: string[];
  skillNames: string[];
  approvalStepCount: number;
  sideEffects: { read: number; write: number; send: number; unknown: number };
  readinessGaps: Array<{ stepId?: string; question: string; why: string }>;
  evidence: {
    latestRun: WorkflowProofRun | null;
    latestCreationTest: WorkflowProofRun | null;
    latestSuccessfulRun: WorkflowProofRun | null;
  };
}

function runAt(run: WorkflowProofRun): string {
  return run.finishedAt ?? run.startedAt ?? run.createdAt ?? '';
}

function isActiveCreationTest(run: WorkflowProofRun): boolean {
  return run.status === 'creation_test' && !run.finishedAt;
}

function normalizeToolName(tool: unknown): string | null {
  if (typeof tool === 'string' && tool.trim()) return tool.trim();
  if (tool && typeof tool === 'object') {
    const name = (tool as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

function stepSideEffect(step: WorkflowStepInput): keyof WorkflowProof['sideEffects'] {
  return classifyStepSideEffect(step);
}

function triggerSummary(def: WorkflowDefinition): string[] {
  const trigger = def.trigger ?? {};
  const out: string[] = [];
  if (trigger.manual || (!trigger.schedule && !trigger.webhookPath && (!trigger.events || trigger.events.length === 0))) out.push('manual');
  if (trigger.schedule) out.push(`schedule: ${trigger.schedule}`);
  if (trigger.webhookPath) out.push(`webhook: ${trigger.webhookPath}`);
  for (const event of trigger.events ?? []) {
    if (event?.type) out.push(`event: ${event.type}`);
  }
  return out;
}

function lifecycleLabel(state: WorkflowLifecycleState): WorkflowProof['label'] {
  if (state === 'needs_info') return 'NEEDS INFO';
  return state.toUpperCase() as WorkflowProof['label'];
}

export function buildWorkflowProof(def: WorkflowDefinition, runs: WorkflowProofRun[] = [], aliases: string[] = []): WorkflowProof {
  const workflowNames = new Set([def.name, ...aliases].filter(Boolean));
  const workflowRuns = runs
    .filter((run) => workflowNames.has(run.workflow))
    .sort((a, b) => runAt(b).localeCompare(runAt(a)));
  const latestRun = workflowRuns[0] ?? null;
  const creationRuns = workflowRuns.filter((run) => run.status === 'creation_test');
  const latestCreationTest = creationRuns[0] ?? null;
  const latestSuccessfulRun = workflowRuns.find((run) =>
    (run.status === 'completed' || run.status === 'success') && run.needsAttention !== true,
  ) ?? null;
  const readinessGaps = analyzeWorkflowGaps(def).map((gap) => ({
    ...(gap.stepId ? { stepId: gap.stepId } : {}),
    question: gap.question,
    why: gap.why,
  }));

  let lifecycle: WorkflowLifecycleState = 'draft';
  let reason = 'Saved as a draft. Enable it when the definition and test evidence look right.';
  if (creationRuns.some(isActiveCreationTest)) {
    lifecycle = 'testing';
    reason = 'Creation test is running against the real tools before this workflow can go live.';
  } else if (readinessGaps.length > 0) {
    lifecycle = 'needs_info';
    reason = 'Clementine needs clearer instructions or approval boundaries before this can run autonomously.';
  } else if (def.enabled !== false) {
    lifecycle = 'live';
    reason = 'Enabled and eligible to run from manual, scheduled, webhook, or event triggers.';
  }

  const toolNames = new Set<string>();
  for (const tool of def.allowedTools ?? []) {
    const name = normalizeToolName(tool);
    if (name) toolNames.add(name);
  }
  const skillNames = new Set<string>();
  const sideEffects: WorkflowProof['sideEffects'] = { read: 0, write: 0, send: 0, unknown: 0 };
  let approvalStepCount = 0;
  for (const step of def.steps ?? []) {
    for (const tool of step.allowedTools ?? []) {
      const name = normalizeToolName(tool);
      if (name) toolNames.add(name);
    }
    if (step.call?.tool) toolNames.add(step.call.tool);
    if (step.usesSkill) skillNames.add(step.usesSkill);
    if (step.requiresApproval) approvalStepCount += 1;
    sideEffects[stepSideEffect(step)] += 1;
  }

  const inputKeys = Object.keys(def.inputs ?? {});
  const requiredInputKeys = Object.entries(def.inputs ?? {})
    .filter(([, meta]) => meta.default === undefined || meta.default === '')
    .map(([key]) => key);

  return {
    lifecycle,
    label: lifecycleLabel(lifecycle),
    reason,
    canRun: lifecycle === 'live',
    canEnable: lifecycle !== 'testing' && readinessGaps.length === 0,
    triggerSummary: triggerSummary(def),
    inputKeys,
    requiredInputKeys,
    toolNames: Array.from(toolNames).sort(),
    skillNames: Array.from(skillNames).sort(),
    approvalStepCount,
    sideEffects,
    readinessGaps,
    evidence: {
      latestRun,
      latestCreationTest,
      latestSuccessfulRun,
    },
  };
}
