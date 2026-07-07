import type {
  WorkflowDefinition,
  WorkflowGoal,
  WorkflowStepInput,
} from '../memory/workflow-store.js';
import type {
  WorkflowExecutionPlan,
  WorkflowVisualContractRemediationKind,
} from '../dashboard/workflow-execution-plan.js';
import { classifyStepSideEffect } from './workflow-enforce.js';
import {
  applyWorkflowContractUpgrades,
  proposeWorkflowContractUpgrades,
  type WorkflowContractProposal,
} from './workflow-contract-proposals.js';
import {
  normalizeWorkflowModelPortability,
} from './workflow-authoring.js';
import { buildWorkflowExecutionPlanWithReadiness } from './workflow-run-readiness.js';

export type WorkflowVisualContractFixKind = WorkflowVisualContractRemediationKind;

export interface WorkflowVisualContractFixOptions {
  fixes?: WorkflowVisualContractFixKind[];
  stepIds?: string[];
  assumeStableItemKeys?: boolean;
}

export interface WorkflowVisualContractFixResult {
  def: WorkflowDefinition;
  changes: string[];
  skipped: string[];
  beforePlan: WorkflowExecutionPlan;
  afterPlan: WorkflowExecutionPlan;
}

const MANUAL_FIX_MESSAGES: Record<WorkflowVisualContractFixKind, string | undefined> = {
  fix_graph_structure: 'Graph structure needs an authored step/dependency edit; review the listed dependency or forEach evidence and update the workflow steps.',
  increase_concurrency: 'Runner concurrency is environment/runtime configuration, not workflow metadata; raise CLEMENTINE_WORKFLOW_CONCURRENCY or split heavy branches deliberately.',
  make_fanout_resumable: undefined,
  add_judge_gate: undefined,
  confirm_tool_connection: 'Tool connections must be verified against the live runtime/account; reconnect or bind the exact Composio/MCP/CLI tool before unattended execution.',
  install_skill: 'Missing skills must be installed locally or the affected step must be rewritten to use an installed skill/tool.',
  add_workflow_script: 'Missing deterministic scripts must be added under this workflow\'s scripts/ directory or the runner path must be changed.',
  select_local_project: 'Missing local projects must be added to the workspace inventory, rebound to an available project, or cleared intentionally.',
  make_models_portable: undefined,
};

export function applyWorkflowVisualContractFixes(
  workflow: WorkflowDefinition,
  workflowSlug: string,
  options: WorkflowVisualContractFixOptions = {},
): WorkflowVisualContractFixResult {
  const beforePlan = buildWorkflowExecutionPlanWithReadiness(workflow, workflowSlug);
  const visibleFixes = beforePlan.visualContract.remediations ?? [];
  const requestedKinds = new Set<WorkflowVisualContractFixKind>(
    options.fixes && options.fixes.length > 0
      ? options.fixes
      : visibleFixes.map((fix) => fix.kind),
  );
  const scopedStepIds = compactUnique(options.stepIds ?? []);
  const scoped = new Set(scopedStepIds);
  const changes: string[] = [];
  const skipped: string[] = [];
  let next = cloneWorkflow(workflow);

  const selectedFixes = visibleFixes.filter((fix) => {
    if (!requestedKinds.has(fix.kind)) return false;
    if (scoped.size === 0) return true;
    return fix.stepIds.length === 0 || fix.stepIds.some((stepId) => scoped.has(stepId));
  });
  const selectedKinds = new Set<WorkflowVisualContractFixKind>(selectedFixes.map((fix) => fix.kind));
  for (const kind of requestedKinds) {
    if (!selectedKinds.has(kind)) {
      skipped.push(`No current visual-contract remediation matched "${kind}"${scoped.size ? ` for step(s): ${[...scoped].join(', ')}` : ''}.`);
    }
  }

  if (selectedKinds.has('make_models_portable')) {
    const portability = normalizeWorkflowModelPortability(next, 'portable', {
      stepIds: scoped.size ? [...scoped] : undefined,
    });
    next = portability.def;
    if (portability.repairs.length > 0) changes.push(...portability.repairs);
    else skipped.push('No exact model pins matched the selected model-portability remediation.');
  }

  if (selectedKinds.has('add_judge_gate')) {
    const applied = applyJudgeGateFix(next, scopedStepIds);
    next = applied.def;
    if (applied.changes.length > 0) changes.push(...applied.changes);
    else skipped.push('No safe judge/output-contract metadata proposal was available for the selected steps.');
  }

  if (selectedKinds.has('make_fanout_resumable')) {
    const fanout = applyFanoutResumeFix(next, selectedFixes
      .filter((fix) => fix.kind === 'make_fanout_resumable')
      .flatMap((fix) => fix.stepIds), {
      assumeStableItemKeys: options.assumeStableItemKeys === true,
      scopedStepIds,
    });
    next = fanout.def;
    changes.push(...fanout.changes);
    skipped.push(...fanout.skipped);
  }

  for (const fix of selectedFixes) {
    const message = MANUAL_FIX_MESSAGES[fix.kind];
    if (!message) continue;
    skipped.push(`${fix.title}: ${message}`);
  }

  const afterPlan = buildWorkflowExecutionPlanWithReadiness(next, workflowSlug);
  return {
    def: next,
    changes: compactUnique(changes),
    skipped: compactUnique(skipped),
    beforePlan,
    afterPlan,
  };
}

function applyJudgeGateFix(
  workflow: WorkflowDefinition,
  stepIds: string[],
): { def: WorkflowDefinition; changes: string[] } {
  const proposal = scopedContractProposal(proposeWorkflowContractUpgrades(workflow), stepIds);
  const applied = applyWorkflowContractUpgrades(workflow, proposal);
  if (hasJudgeGate(applied.def)) return applied;

  return {
    def: {
      ...applied.def,
      goal: fallbackGoal(workflow),
    },
    changes: [
      ...applied.changes,
      'Pinned workflow goal from the workflow description so completed runs have an external judge gate.',
    ],
  };
}

function hasJudgeGate(workflow: WorkflowDefinition): boolean {
  return Boolean(workflow.goal?.objective)
    || workflow.steps.some((step) => Boolean(step.output && Object.keys(step.output).length > 0))
    || workflow.steps.some((step) => Boolean(step.loopUntil || step.usesSkill || step.requiresApproval));
}

function scopedContractProposal(
  proposal: WorkflowContractProposal,
  stepIds: string[],
): WorkflowContractProposal {
  if (stepIds.length === 0) return proposal;
  const scoped = new Set(stepIds);
  const proposedStepOutputs = proposal.proposedStepOutputs.filter((output) => scoped.has(output.stepId));
  return {
    ...proposal,
    proposedStepOutputs,
    needsUpgrade: proposal.proposedInputs.length > 0 || proposedStepOutputs.length > 0 || Boolean(proposal.proposedGoal),
  };
}

function fallbackGoal(workflow: WorkflowDefinition): WorkflowGoal {
  const objective = [
    workflow.description,
    workflow.description_body,
    workflow.synthesis?.prompt,
    workflow.steps[workflow.steps.length - 1]?.prompt,
  ]
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .find((part): part is string => Boolean(part && part.length >= 4 && !/^(?:x|test|todo|tbd|n\/a|na)$/i.test(part)));
  return {
    objective: objective ?? `Complete workflow "${workflow.name}" and produce its expected result.`,
    maxAttempts: 2,
  };
}

function applyFanoutResumeFix(
  workflow: WorkflowDefinition,
  remediationStepIds: string[],
  options: { assumeStableItemKeys: boolean; scopedStepIds: string[] },
): { def: WorkflowDefinition; changes: string[]; skipped: string[] } {
  const remediationScope = new Set(compactUnique(remediationStepIds));
  const explicitScope = new Set(options.scopedStepIds);
  const changes: string[] = [];
  const skipped: string[] = [];
  const steps = workflow.steps.map((step) => {
    if (!step.forEach) return step;
    if (remediationScope.size > 0 && !remediationScope.has(step.id)) return step;
    if (explicitScope.size > 0 && !explicitScope.has(step.id)) return step;
    if (step.forEachNewOnly === true) return step;
    const sideEffect = classifyStepSideEffect(step);
    if (sideEffect === 'read') {
      changes.push(`Marked read fan-out step "${step.id}" as forEachNewOnly for cross-run item watermarks.`);
      return { ...step, forEachNewOnly: true };
    }
    if (sideEffect === 'write' && options.assumeStableItemKeys) {
      changes.push(`Marked write fan-out step "${step.id}" as forEachNewOnly after stable item keys were explicitly confirmed.`);
      return { ...step, forEachNewOnly: true };
    }
    if (sideEffect === 'send') {
      skipped.push(`Step "${step.id}" is send fan-out; add an approval gate or redesign it as an idempotent write before automated resume.`);
    } else {
      skipped.push(`Step "${step.id}" is ${sideEffect} fan-out; pass assume_stable_item_keys=true only after confirming each item has a stable id/key/slug.`);
    }
    return step;
  });
  return {
    def: changes.length > 0 ? { ...workflow, steps } : workflow,
    changes,
    skipped,
  };
}

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}

function compactUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
