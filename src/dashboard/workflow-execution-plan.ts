import type { WorkflowAllowedTool, WorkflowStepInput } from '../memory/workflow-store.js';
import { classifyStepSideEffect } from '../execution/workflow-enforce.js';

export interface WorkflowExecutionPlanOptions {
  stepConcurrency?: number;
  runConcurrency?: number;
  forEachBatchSize?: number;
  workflowAllowedTools?: WorkflowAllowedTool[];
  workflowProject?: string;
  workflowGoal?: WorkflowExecutionPlanGoal;
  readiness?: WorkflowToolReadinessInventory;
}

export type WorkflowToolReadinessStatus = 'ready' | 'missing' | 'unknown';
export type WorkflowToolReadinessKind = 'tool' | 'composio' | 'mcp' | 'cli' | 'local' | 'skill' | 'script' | 'project';

export interface WorkflowToolReadinessMcpServer {
  name: string;
  slug?: string;
  enabled?: boolean;
  state?: 'connected' | 'connecting' | 'degraded' | 'unavailable' | 'unknown' | string;
  toolCount?: number;
}

export interface WorkflowToolReadinessInventory {
  availableTools?: string[];
  availableClis?: string[];
  installedSkills?: string[];
  workflowScripts?: string[];
  mcpServers?: WorkflowToolReadinessMcpServer[];
  workspaceProjects?: WorkflowProjectReadinessProject[];
}

export type WorkflowToolRequirementSource =
  | 'workflow_allowed_tool'
  | 'step_allowed_tool'
  | 'step_call'
  | 'deterministic_runner'
  | 'loop_probe_runner'
  | 'uses_skill'
  | 'workflow_project'
  | 'step_project';

export type WorkflowToolReadinessEvidenceKind =
  | 'tool_catalog'
  | 'composio_broker'
  | 'mcp_server'
  | 'cli_command'
  | 'skill'
  | 'script'
  | 'project';

export interface WorkflowToolReadinessEvidence {
  kind: WorkflowToolReadinessEvidenceKind;
  name: string;
  status: WorkflowToolReadinessStatus;
  detail?: string;
}

export interface WorkflowProjectReadinessProject {
  name: string;
  path: string;
  type?: string;
}

export interface WorkflowToolReadinessItem {
  kind: WorkflowToolReadinessKind;
  name: string;
  status: WorkflowToolReadinessStatus;
  reason: string;
  stepIds: string[];
  sources?: WorkflowToolRequirementSource[];
  evidence?: WorkflowToolReadinessEvidence[];
}

export interface WorkflowToolReadiness {
  ready: boolean;
  readyCount: number;
  missingCount: number;
  unknownCount: number;
  items: WorkflowToolReadinessItem[];
}

export interface WorkflowExecutionPlanLevel {
  index: number;
  stepIds: string[];
  width: number;
  cappedWidth: number;
  parallel: boolean;
}

export interface WorkflowExecutionPlanFanout {
  stepId: string;
  source: string;
  newOnly: boolean;
  concurrency: number;
  batchSize: number;
  sideEffect: 'read' | 'write' | 'send' | 'unknown';
  executor: 'model' | 'skill' | 'deterministic' | 'call';
  workerIntent: string | null;
  workerModel: string | null;
  safeToResume: boolean;
}

export interface WorkflowExecutionPlanGate {
  stepId: string;
  kind: 'approval' | 'output_contract' | 'loop_until' | 'skill_judge' | 'side_effect_guard' | 'grounding_judge' | 'run_goal_judge';
  label: string;
  severity: 'info' | 'warn' | 'block';
}

export interface WorkflowExecutionPlanGoal {
  objective: string;
  successCriteria?: string[];
  maxAttempts?: number;
}

export interface WorkflowExecutionPlanToolSurface {
  tools: string[];
  composioTools: string[];
  mcpTools: string[];
  cliTools: string[];
  localTools: string[];
  deterministicRunners: string[];
  skills: string[];
  projects: string[];
}

export type WorkflowModelBinding = 'default' | 'intent' | 'explicit_model' | 'non_model';
export type WorkflowModelPortability = 'portable' | 'mixed' | 'pinned';

export interface WorkflowExecutionPlanModelRoute {
  stepId: string;
  executor: 'model' | 'skill' | 'deterministic' | 'call';
  binding: WorkflowModelBinding;
  model: string | null;
  intent: string | null;
  provider: string | null;
  portable: boolean;
}

export interface WorkflowExecutionPlanModelSurface {
  portability: WorkflowModelPortability;
  portable: boolean;
  modelSteps: number;
  nonModelSteps: number;
  defaultModelSteps: number;
  intentRoutedSteps: number;
  explicitModelSteps: number;
  explicitModels: string[];
  intents: string[];
  providers: string[];
  routes: WorkflowExecutionPlanModelRoute[];
  warnings: string[];
}

export type WorkflowVisualContractStatus = 'trusted' | 'attention' | 'blocked';
export type WorkflowVisualContractCheckStatus = 'pass' | 'warn' | 'block';
export type WorkflowVisualContractCheckKind =
  | 'structure'
  | 'parallelism'
  | 'fanout'
  | 'judges'
  | 'tool_readiness'
  | 'model_portability'
  | 'recovery';
export type WorkflowVisualContractRemediationKind =
  | 'fix_graph_structure'
  | 'increase_concurrency'
  | 'make_fanout_resumable'
  | 'add_judge_gate'
  | 'confirm_tool_connection'
  | 'install_skill'
  | 'add_workflow_script'
  | 'select_local_project'
  | 'make_models_portable';
export type WorkflowVisualContractRemediationActionKind =
  | 'apply_contract_fix'
  | 'edit_workflow_steps'
  | 'configure_concurrency'
  | 'confirm_tool_connection'
  | 'install_skill'
  | 'add_workflow_script'
  | 'select_local_project';

export interface WorkflowVisualContractRemediationAction {
  kind: WorkflowVisualContractRemediationActionKind;
  label: string;
  detail: string;
  command?: string;
  safeToAutomate: boolean;
}

export interface WorkflowVisualContractCheck {
  kind: WorkflowVisualContractCheckKind;
  status: WorkflowVisualContractCheckStatus;
  label: string;
  detail: string;
  stepIds: string[];
  evidence: string[];
}

export interface WorkflowVisualContractRemediation {
  kind: WorkflowVisualContractRemediationKind;
  status: WorkflowVisualContractCheckStatus;
  title: string;
  detail: string;
  stepIds: string[];
  evidence: string[];
  actions?: WorkflowVisualContractRemediationAction[];
}

export interface WorkflowExecutionVisualContract {
  status: WorkflowVisualContractStatus;
  summary: string;
  passCount: number;
  warningCount: number;
  blockedCount: number;
  checks: WorkflowVisualContractCheck[];
  remediations: WorkflowVisualContractRemediation[];
}

export interface WorkflowExecutionPlan {
  stepCount: number;
  levels: WorkflowExecutionPlanLevel[];
  criticalPath: string[];
  maxParallelWidth: number;
  estimatedRounds: number;
  sequentialRounds: number;
  parallelSavings: number;
  runner: {
    stepConcurrency: number;
    runConcurrency: number;
    forEachBatchSize: number;
  };
  fanout: WorkflowExecutionPlanFanout[];
  gates: WorkflowExecutionPlanGate[];
  toolSurface: WorkflowExecutionPlanToolSurface;
  toolReadiness: WorkflowToolReadiness;
  modelSurface: WorkflowExecutionPlanModelSurface;
  visualContract: WorkflowExecutionVisualContract;
  issues: string[];
}

const DEFAULT_STEP_CONCURRENCY = 5;
const DEFAULT_RUN_CONCURRENCY = 1;
const DEFAULT_FOREACH_BATCH_SIZE = 200;

export function buildWorkflowExecutionPlan(
  steps: WorkflowStepInput[] | undefined | null,
  options: WorkflowExecutionPlanOptions = {},
): WorkflowExecutionPlan {
  const list = Array.isArray(steps) ? steps : [];
  const runner = {
    stepConcurrency: positiveInt(options.stepConcurrency, DEFAULT_STEP_CONCURRENCY),
    runConcurrency: positiveInt(options.runConcurrency, DEFAULT_RUN_CONCURRENCY),
    forEachBatchSize: positiveInt(options.forEachBatchSize, DEFAULT_FOREACH_BATCH_SIZE),
  };
  const ids = new Set(list.map((step) => step.id));
  const issues: string[] = [];
  const depsByStep = new Map<string, string[]>();
  for (const step of list) {
    const rawDeps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    const validDeps = unique(rawDeps.filter((dep) => {
      const ok = ids.has(dep);
      if (!ok) issues.push(`Step "${step.id}" depends on missing step "${dep}".`);
      return ok;
    }));
    depsByStep.set(step.id, validDeps);
    const forEachSource = forEachSourceStepId(step.forEach);
    if (forEachSource && !ids.has(forEachSource)) {
      issues.push(`Step "${step.id}" forEach source "${forEachSource}" is not a workflow step.`);
    }
  }

  const levels = buildLevels(list, depsByStep, runner.stepConcurrency, issues);
  const criticalPath = longestPath(list, depsByStep);
  const maxParallelWidth = levels.reduce((max, level) => Math.max(max, level.width), 0);
  const workflowAllowedTools = normalizeAllowedToolNames(options.workflowAllowedTools);
  const workflowProject = normalizeRequirementName(options.workflowProject);
  const toolSurface = buildToolSurface(list, workflowAllowedTools, options.readiness, workflowProject);
  const toolReadiness = buildToolReadiness(list, workflowAllowedTools, options.readiness, workflowProject);
  const modelSurface = buildModelSurface(list);
  const fanout = list.filter((step) => Boolean(step.forEach)).map((step) => ({
    stepId: step.id,
    source: step.forEach ?? '',
    newOnly: step.forEachNewOnly === true,
    concurrency: runner.stepConcurrency,
    batchSize: runner.forEachBatchSize,
    sideEffect: classifyStepSideEffect(step),
    executor: executorFor(step),
    workerIntent: step.intent ?? null,
    workerModel: step.model ?? null,
    safeToResume: classifyStepSideEffect(step) === 'read' || step.requiresApproval === true || step.forEachNewOnly === true,
  }));
  const gates = buildGates(list, options.workflowGoal);
  const visualContract = buildVisualContract({
    steps: list,
    levels,
    criticalPath,
    maxParallelWidth,
    parallelSavings: Math.max(0, list.length - levels.length),
    fanout,
    gates,
    toolReadiness,
    modelSurface,
    issues,
  });

  return {
    stepCount: list.length,
    levels,
    criticalPath,
    maxParallelWidth,
    estimatedRounds: levels.length,
    sequentialRounds: list.length,
    parallelSavings: Math.max(0, list.length - levels.length),
    runner,
    fanout,
    gates,
    toolSurface,
    toolReadiness,
    modelSurface,
    visualContract,
    issues,
  };
}

function buildLevels(
  steps: WorkflowStepInput[],
  depsByStep: Map<string, string[]>,
  stepConcurrency: number,
  issues: string[],
): WorkflowExecutionPlanLevel[] {
  const completed = new Set<string>();
  const emitted = new Set<string>();
  const levels: WorkflowExecutionPlanLevel[] = [];
  while (emitted.size < steps.length) {
    const ready = steps
      .filter((step) => !emitted.has(step.id))
      .filter((step) => (depsByStep.get(step.id) ?? []).every((dep) => completed.has(dep)));
    if (ready.length === 0) {
      const stuck = steps.filter((step) => !emitted.has(step.id)).map((step) => step.id);
      if (stuck.length) issues.push(`Dependency cycle or unsatisfied dependency among: ${stuck.join(', ')}.`);
      break;
    }
    const stepIds = ready.map((step) => step.id);
    stepIds.forEach((id) => {
      emitted.add(id);
      completed.add(id);
    });
    levels.push({
      index: levels.length,
      stepIds,
      width: stepIds.length,
      cappedWidth: Math.min(stepIds.length, stepConcurrency),
      parallel: stepIds.length > 1,
    });
  }
  return levels;
}

function longestPath(steps: WorkflowStepInput[], depsByStep: Map<string, string[]>): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  const pathTo = (id: string): string[] => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return [id];
    visiting.add(id);
    const deps = (depsByStep.get(id) ?? []).filter((dep) => byId.has(dep));
    let best: string[] = [];
    for (const dep of deps) {
      const candidate = pathTo(dep);
      if (candidate.length > best.length) best = candidate;
    }
    visiting.delete(id);
    const out = [...best, id];
    memo.set(id, out);
    return out;
  };
  let best: string[] = [];
  for (const step of steps) {
    const candidate = pathTo(step.id);
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function buildGates(steps: WorkflowStepInput[], workflowGoal?: WorkflowExecutionPlanGoal): WorkflowExecutionPlanGate[] {
  const gates: WorkflowExecutionPlanGate[] = [];
  const goalObjective = typeof workflowGoal?.objective === 'string' ? workflowGoal.objective.trim() : '';
  if (goalObjective) {
    const criteria = Array.isArray(workflowGoal?.successCriteria)
      ? workflowGoal.successCriteria.map((criterion) => criterion.trim()).filter(Boolean)
      : [];
    const attempts = typeof workflowGoal?.maxAttempts === 'number' && Number.isFinite(workflowGoal.maxAttempts)
      ? Math.max(1, Math.min(3, Math.floor(workflowGoal.maxAttempts)))
      : 2;
    gates.push({
      stepId: '(run goal)',
      kind: 'run_goal_judge',
      label: `run goal judge: ${criteria.length ? `${criteria.length} criteria` : goalObjective}${attempts > 1 ? ` · ${attempts} attempts` : ''}`,
      severity: 'block',
    });
  }
  for (const step of steps) {
    const sideEffect = classifyStepSideEffect(step);
    if (step.requiresApproval) {
      gates.push({
        stepId: step.id,
        kind: 'approval',
        label: step.approvalPreview || 'human approval before this step',
        severity: sideEffect === 'send' ? 'warn' : 'info',
      });
    }
    if (step.output) {
      gates.push({
        stepId: step.id,
        kind: 'output_contract',
        label: `output contract${step.output.type ? `: ${step.output.type}` : ''}`,
        severity: 'info',
      });
    }
    if (step.loopUntil) {
      gates.push({
        stepId: step.id,
        kind: 'loop_until',
        label: `loop until contract passes${step.loopUntil.maxAttempts ? ` (${step.loopUntil.maxAttempts} max)` : ''}`,
        severity: sideEffect === 'send' ? 'block' : 'info',
      });
    }
    if (step.usesSkill) {
      gates.push({
        stepId: step.id,
        kind: 'skill_judge',
        label: `skill execution judge: ${step.usesSkill}`,
        severity: 'info',
      });
    }
    if (sideEffect === 'write' || sideEffect === 'send') {
      gates.push({
        stepId: step.id,
        kind: 'side_effect_guard',
        label: `${sideEffect} resume/duplicate guard`,
        severity: sideEffect === 'send' ? 'warn' : 'info',
      });
      gates.push({
        stepId: step.id,
        kind: 'grounding_judge',
        label: `${sideEffect} payload grounding judge`,
        severity: 'info',
      });
    }
  }
  return gates;
}

function buildVisualContract(input: {
  steps: WorkflowStepInput[];
  levels: WorkflowExecutionPlanLevel[];
  criticalPath: string[];
  maxParallelWidth: number;
  parallelSavings: number;
  fanout: WorkflowExecutionPlanFanout[];
  gates: WorkflowExecutionPlanGate[];
  toolReadiness: WorkflowToolReadiness;
  modelSurface: WorkflowExecutionPlanModelSurface;
  issues: string[];
}): WorkflowExecutionVisualContract {
  const checks: WorkflowVisualContractCheck[] = [];
  const remediations: WorkflowVisualContractRemediation[] = [];
  const add = (
    kind: WorkflowVisualContractCheckKind,
    status: WorkflowVisualContractCheckStatus,
    label: string,
    detail: string,
    stepIds: string[] = [],
    evidence: string[] = [],
  ): void => {
    checks.push({ kind, status, label, detail, stepIds: unique(stepIds), evidence: unique(evidence) });
  };
  const addRemediation = (
    kind: WorkflowVisualContractRemediationKind,
    status: WorkflowVisualContractCheckStatus,
    title: string,
    detail: string,
    stepIds: string[] = [],
    evidence: string[] = [],
    actions: WorkflowVisualContractRemediationAction[] = [],
  ): void => {
    remediations.push({
      kind,
      status,
      title,
      detail,
      stepIds: unique(stepIds),
      evidence: unique(evidence),
      ...(actions.length ? { actions } : {}),
    });
  };

  add(
    'structure',
    input.issues.length ? 'block' : 'pass',
    'Graph structure',
    input.issues.length
      ? `Graph has ${input.issues.length} structural issue${input.issues.length === 1 ? '' : 's'} that must be fixed before this is a repeatable workflow.`
      : `DAG has ${input.levels.length} execution level${input.levels.length === 1 ? '' : 's'} across ${input.steps.length} step${input.steps.length === 1 ? '' : 's'}.`,
    [],
    input.issues.slice(0, 4),
  );
  if (input.issues.length > 0) {
    addRemediation(
      'fix_graph_structure',
      'block',
      'Fix workflow graph structure',
      'Correct missing dependencies, dependency cycles, or invalid forEach sources before relying on this workflow.',
      [],
      input.issues.slice(0, 4),
      [remediationAction('edit_workflow_steps', 'Edit workflow graph', 'Open the affected steps and repair dependsOn or forEach references before running.', false)],
    );
  }

  const cappedLevels = input.levels.filter((level) => level.width > level.cappedWidth);
  add(
    'parallelism',
    cappedLevels.length ? 'warn' : 'pass',
    'Parallel execution',
    input.maxParallelWidth > 1
      ? `Plans up to ${input.maxParallelWidth}-wide work with ${input.parallelSavings} saved round${input.parallelSavings === 1 ? '' : 's'} versus serial execution.`
      : 'No independent branches were found; this workflow will run as a serial path.',
    cappedLevels.flatMap((level) => level.stepIds),
    cappedLevels.map((level) => `L${level.index + 1} has width ${level.width} but runner cap ${level.cappedWidth}.`),
  );
  if (cappedLevels.length > 0) {
    addRemediation(
      'increase_concurrency',
      'warn',
      'Raise step concurrency or reduce same-level fan-in',
      'The plan has more ready work than the runner cap allows. Increase CLEMENTINE_WORKFLOW_CONCURRENCY for this environment or split heavyweight lanes into later levels.',
      cappedLevels.flatMap((level) => level.stepIds),
      cappedLevels.map((level) => `L${level.index + 1}: width ${level.width}, cap ${level.cappedWidth}`),
      [remediationAction('configure_concurrency', 'Tune runner concurrency', 'Raise CLEMENTINE_WORKFLOW_CONCURRENCY or intentionally split heavy branches across later levels.', false, 'CLEMENTINE_WORKFLOW_CONCURRENCY=<workers>')],
    );
  }

  const riskyFanout = input.fanout.filter((row) => !row.safeToResume);
  const maxFanoutWorkers = input.fanout.reduce((max, row) => Math.max(max, row.concurrency), 0);
  add(
    'fanout',
    riskyFanout.length ? 'warn' : 'pass',
    'Fan-out and sub-agents',
    input.fanout.length
      ? `${input.fanout.length} fan-out lane${input.fanout.length === 1 ? '' : 's'} can spawn up to ${maxFanoutWorkers} worker${maxFanoutWorkers === 1 ? '' : 's'} per lane.`
      : 'No fan-out lanes are declared for this workflow.',
    riskyFanout.map((row) => row.stepId),
    riskyFanout.map((row) => `${row.stepId} is ${row.sideEffect} fan-out without a safe resume marker.`),
  );
  for (const row of riskyFanout) {
    addRemediation(
      'make_fanout_resumable',
      'warn',
      `Make fan-out resumable for ${row.stepId}`,
      'Set forEachNewOnly when items have stable ids, add an approval gate, or make the write idempotent before depending on targeted failed-item retries.',
      [row.stepId],
      [`sideEffect=${row.sideEffect}`, `source=${row.source}`],
      [remediationAction('apply_contract_fix', 'Mark fan-out resumable', 'Apply the safe contract fix after confirming item keys are stable for write fan-out lanes.', row.sideEffect === 'read')],
    );
  }

  const judgeKinds = new Set(input.gates.map((gate) => gate.kind));
  const judgeGateCount = input.gates.filter((gate) => (
    gate.kind === 'output_contract'
    || gate.kind === 'skill_judge'
    || gate.kind === 'grounding_judge'
    || gate.kind === 'run_goal_judge'
  )).length;
  const hasTrustGate = judgeGateCount > 0 || judgeKinds.has('approval') || judgeKinds.has('loop_until');
  add(
    'judges',
    hasTrustGate ? 'pass' : 'warn',
    'Judges and gates',
    hasTrustGate
      ? `${input.gates.length} gate${input.gates.length === 1 ? '' : 's'} are visible, including ${judgeGateCount} judge-backed check${judgeGateCount === 1 ? '' : 's'}.`
      : 'No judge, approval, loop, or output-contract gate is visible; add at least one before trusting unattended execution.',
    input.gates.map((gate) => gate.stepId).filter((stepId) => stepId !== '(run goal)'),
    Array.from(judgeKinds),
  );
  if (!hasTrustGate) {
    addRemediation(
      'add_judge_gate',
      'warn',
      'Add a judge or output contract',
      'Add a step output contract, pinned workflow goal, loop-until condition, approval gate, or skill judge before trusting unattended execution.',
      input.steps.map((step) => step.id).slice(0, 6),
      ['no output_contract, run_goal_judge, loop_until, approval, or skill_judge gate found'],
      [remediationAction('apply_contract_fix', 'Add judge metadata', 'Let Clementine add the safest available workflow goal or step output contract.', true)],
    );
  }

  const nonReadyTools = input.toolReadiness.items.filter((item) => item.status !== 'ready');
  add(
    'tool_readiness',
    input.toolReadiness.missingCount > 0 ? 'block' : input.toolReadiness.unknownCount > 0 ? 'warn' : 'pass',
    'Tool readiness',
    input.toolReadiness.ready
      ? `${input.toolReadiness.readyCount} required tool surface item${input.toolReadiness.readyCount === 1 ? '' : 's'} confirmed.`
      : `${input.toolReadiness.missingCount} missing and ${input.toolReadiness.unknownCount} unknown tool surface item${input.toolReadiness.missingCount + input.toolReadiness.unknownCount === 1 ? '' : 's'}.`,
    nonReadyTools.flatMap((item) => item.stepIds),
    nonReadyTools.slice(0, 6).map((item) => `${item.status}: ${item.kind} ${item.name}`),
  );
  for (const item of nonReadyTools.slice(0, 12)) {
    if (item.kind === 'skill' && item.status === 'missing') {
      addRemediation(
        'install_skill',
        'block',
        `Install or replace skill ${item.name}`,
        `Install the "${item.name}" skill locally, or update the affected step to use an installed skill or explicit tools.`,
        item.stepIds,
        [`${item.status}: ${item.kind} ${item.name}`, item.reason],
        [
          remediationAction('install_skill', 'Install missing skill', `Install "${item.name}" in this Clementine environment.`, false),
          remediationAction('edit_workflow_steps', 'Replace skill binding', 'Edit the affected step to use an installed skill or explicit tools.', false),
        ],
      );
    } else if (item.kind === 'script' && item.status === 'missing') {
      addRemediation(
        'add_workflow_script',
        'block',
        `Add workflow script ${item.name}`,
        `Add "${item.name}" under this workflow's scripts/ directory, or update the deterministic runner path to an existing script.`,
        item.stepIds,
        [`${item.status}: ${item.kind} ${item.name}`, item.reason],
        [
          remediationAction('add_workflow_script', 'Add workflow script', `Create "${item.name}" in the workflow scripts directory.`, false),
          remediationAction('edit_workflow_steps', 'Change runner path', 'Edit deterministic.runner to point at a script that exists for this workflow.', false),
        ],
      );
    } else if (item.kind === 'project' && item.status === 'missing') {
      addRemediation(
        'select_local_project',
        'block',
        `Select local project ${item.name}`,
        `Add "${item.name}" to the workspace projects inventory, change the workflow project binding, or clear the project requirement if this step does not need a local repo.`,
        item.stepIds,
        [`${item.status}: ${item.kind} ${item.name}`, item.reason],
        [
          remediationAction('select_local_project', 'Bind local project', `Select an available workspace project instead of "${item.name}".`, false),
          remediationAction('edit_workflow_steps', 'Clear project requirement', 'Clear workflow.project or step.project if this step does not need a local repo.', false),
        ],
      );
    } else {
      addRemediation(
        'confirm_tool_connection',
        item.status === 'missing' ? 'warn' : 'warn',
        `Confirm ${item.kind} ${item.name}`,
        `Confirm the runtime can access "${item.name}" before unattended execution. For Composio/MCP tools, verify the exact app/action and account connection at runtime.`,
        item.stepIds,
        [`${item.status}: ${item.kind} ${item.name}`, item.reason],
        connectionActionsForReadinessItem(item),
      );
    }
  }

  add(
    'model_portability',
    input.modelSurface.portable ? 'pass' : 'warn',
    'Model portability',
    input.modelSurface.portable
      ? `${input.modelSurface.modelSteps} model step${input.modelSurface.modelSteps === 1 ? '' : 's'} use default or intent routing, so the workflow can move across model providers.`
      : `${input.modelSurface.explicitModelSteps} step${input.modelSurface.explicitModelSteps === 1 ? '' : 's'} pin exact models; portable execution may degrade on other providers.`,
    input.modelSurface.routes.filter((route) => !route.portable).map((route) => route.stepId),
    input.modelSurface.warnings.slice(0, 4),
  );
  if (!input.modelSurface.portable) {
    addRemediation(
      'make_models_portable',
      'warn',
      'Remove exact model pins',
      'Use workflow_update with portable_models=true, or replace exact per-step model pins with intent/default routing so the workflow can run on Codex or another model provider.',
      input.modelSurface.routes.filter((route) => !route.portable).map((route) => route.stepId),
      input.modelSurface.warnings.slice(0, 4),
      [remediationAction('apply_contract_fix', 'Make models portable', 'Remove exact per-step model pins and let workflow intent/default routing choose the model.', true)],
    );
  }

  add(
    'recovery',
    riskyFanout.length ? 'warn' : 'pass',
    'Recovery actions',
    riskyFanout.length
      ? `${riskyFanout.length} fan-out lane${riskyFanout.length === 1 ? '' : 's'} need safer resume markers before failed-item retries are fully trustworthy.`
      : input.fanout.length
        ? 'Fan-out lanes are marked safe for targeted failed-item retry and graph recovery actions.'
        : 'Graph-level safe rerun recovery is available; no targeted fan-out retry lane is required.',
    riskyFanout.map((row) => row.stepId),
    input.criticalPath.length ? [`critical path: ${input.criticalPath.join(' -> ')}`] : [],
  );

  const blockedCount = checks.filter((check) => check.status === 'block').length;
  const warningCount = checks.filter((check) => check.status === 'warn').length;
  const passCount = checks.filter((check) => check.status === 'pass').length;
  const status: WorkflowVisualContractStatus = blockedCount > 0 ? 'blocked' : warningCount > 0 ? 'attention' : 'trusted';
  const summary = status === 'blocked'
    ? `${blockedCount} contract blocker${blockedCount === 1 ? '' : 's'} must be fixed before this workflow is reliable.`
    : status === 'attention'
      ? `${warningCount} contract warning${warningCount === 1 ? '' : 's'} should be reviewed before unattended use.`
      : 'Workflow graph contract is trusted for repeatable execution.';
  return { status, summary, passCount, warningCount, blockedCount, checks, remediations };
}

function remediationAction(
  kind: WorkflowVisualContractRemediationActionKind,
  label: string,
  detail: string,
  safeToAutomate: boolean,
  command?: string,
): WorkflowVisualContractRemediationAction {
  const trimmedCommand = command?.trim();
  return {
    kind,
    label,
    detail,
    safeToAutomate,
    ...(trimmedCommand ? { command: trimmedCommand } : {}),
  };
}

function connectionActionsForReadinessItem(item: WorkflowToolReadinessItem): WorkflowVisualContractRemediationAction[] {
  if (item.kind === 'composio') {
    return [
      remediationAction('confirm_tool_connection', 'Confirm Composio action', `Verify the exact "${item.name}" action schema and account connection before unattended execution.`, false, `composio search "${item.name}"`),
    ];
  }
  if (item.kind === 'mcp') {
    const parsed = item.name.match(/^mcp__(.+?)__/i)?.[1]
      ?? item.name.match(/^([a-z0-9][a-z0-9_.-]*)__[A-Za-z0-9_.-]+/)?.[1];
    return [
      remediationAction('confirm_tool_connection', 'Confirm MCP server', `Enable the MCP server that provides "${item.name}" and verify the tool appears in the runtime catalog.`, false, parsed ? `mcp_status query="${parsed}"` : 'mcp_status'),
    ];
  }
  if (item.kind === 'cli') {
    const command = cliCommandForTool(item.name, undefined);
    return [
      remediationAction('confirm_tool_connection', 'Confirm CLI command', `Verify "${command ?? item.name}" is installed and saved in the runtime CLI inventory.`, false, command ? `which ${command}` : undefined),
    ];
  }
  return [
    remediationAction('confirm_tool_connection', 'Confirm runtime tool', `Verify "${item.name}" is available in the active Clementine tool catalog before unattended execution.`, false),
  ];
}

function buildToolSurface(
  steps: WorkflowStepInput[],
  workflowAllowedTools: string[],
  inventory: WorkflowToolReadinessInventory | undefined,
  workflowProject: string | undefined,
): WorkflowExecutionPlanToolSurface {
  const requirements = collectToolRequirements(steps, workflowAllowedTools, inventory, workflowProject);
  const tools = unique(requirements
    .filter((req) => req.kind !== 'script' && req.kind !== 'skill' && req.kind !== 'project')
    .map((req) => req.name));
  const deterministicRunners = unique(requirements
    .filter((req) => req.kind === 'script')
    .map((req) => req.name));
  const skills = unique(requirements
    .filter((req) => req.kind === 'skill')
    .map((req) => req.name));
  const projects = unique(requirements
    .filter((req) => req.kind === 'project')
    .map((req) => req.name));
  return {
    tools,
    composioTools: tools.filter((tool) => toolKindForTool(tool, inventory) === 'composio'),
    mcpTools: tools.filter((tool) => toolKindForTool(tool, inventory) === 'mcp'),
    cliTools: tools.filter((tool) => toolKindForTool(tool, inventory) === 'cli'),
    localTools: tools.filter((tool) => toolKindForTool(tool, inventory) === 'local'),
    deterministicRunners,
    skills,
    projects,
  };
}

function buildModelSurface(steps: WorkflowStepInput[]): WorkflowExecutionPlanModelSurface {
  const routes = steps.map(modelRouteForStep);
  const modelRoutes = routes.filter((route) => route.binding !== 'non_model');
  const explicitModelRoutes = modelRoutes.filter((route) => route.binding === 'explicit_model');
  const defaultRoutes = modelRoutes.filter((route) => route.binding === 'default');
  const intentRoutes = modelRoutes.filter((route) => route.binding === 'intent');
  const explicitModels = unique(explicitModelRoutes.map((route) => route.model));
  const intents = unique(intentRoutes.map((route) => route.intent));
  const providers = unique(explicitModelRoutes.map((route) => route.provider));
  const portability: WorkflowModelPortability = explicitModelRoutes.length === 0
    ? 'portable'
    : explicitModelRoutes.length === modelRoutes.length ? 'pinned' : 'mixed';
  const warnings = explicitModelRoutes.map((route) => {
    const family = route.provider ? `${route.provider} ` : '';
    return `Step "${route.stepId}" pins ${family}model "${route.model}". Prefer intent or default routing when this workflow should run on any model.`;
  });
  return {
    portability,
    portable: explicitModelRoutes.length === 0,
    modelSteps: modelRoutes.length,
    nonModelSteps: routes.length - modelRoutes.length,
    defaultModelSteps: defaultRoutes.length,
    intentRoutedSteps: intentRoutes.length,
    explicitModelSteps: explicitModelRoutes.length,
    explicitModels,
    intents,
    providers,
    routes,
    warnings,
  };
}

function modelRouteForStep(step: WorkflowStepInput): WorkflowExecutionPlanModelRoute {
  const executor = executorFor(step);
  if (executor === 'call' || executor === 'deterministic') {
    return {
      stepId: step.id,
      executor,
      binding: 'non_model',
      model: null,
      intent: null,
      provider: null,
      portable: true,
    };
  }
  if (step.model) {
    return {
      stepId: step.id,
      executor,
      binding: 'explicit_model',
      model: step.model,
      intent: step.intent ?? null,
      provider: providerFamilyForModel(step.model),
      portable: false,
    };
  }
  if (step.intent) {
    return {
      stepId: step.id,
      executor,
      binding: 'intent',
      model: null,
      intent: step.intent,
      provider: null,
      portable: true,
    };
  }
  return {
    stepId: step.id,
    executor,
    binding: 'default',
    model: null,
    intent: null,
    provider: null,
    portable: true,
  };
}

function providerFamilyForModel(model: string | undefined | null): string | null {
  const id = model?.trim().toLowerCase();
  if (!id) return null;
  if (id.includes('claude') || id.startsWith('anthropic/')) return 'claude';
  if (id.includes('codex') || id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('o5')) return 'codex';
  if (id.includes('gemini') || id.startsWith('google/')) return 'gemini';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('grok') || id.includes('xai')) return 'xai';
  return 'byo';
}

interface ToolRequirement {
  kind: WorkflowToolReadinessKind;
  name: string;
  stepId: string;
  source: WorkflowToolRequirementSource;
}

interface ToolReadinessResult {
  status: WorkflowToolReadinessStatus;
  reason: string;
  evidence: WorkflowToolReadinessEvidence[];
}

function buildToolReadiness(
  steps: WorkflowStepInput[],
  workflowAllowedTools: string[],
  inventory: WorkflowToolReadinessInventory | undefined,
  workflowProject: string | undefined,
): WorkflowToolReadiness {
  const grouped = new Map<string, { kind: WorkflowToolReadinessKind; name: string; stepIds: string[]; sources: WorkflowToolRequirementSource[] }>();
  for (const req of collectToolRequirements(steps, workflowAllowedTools, inventory, workflowProject)) {
    const key = `${req.kind}:${req.name}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.stepIds.includes(req.stepId)) existing.stepIds.push(req.stepId);
      if (!existing.sources.includes(req.source)) existing.sources.push(req.source);
    } else {
      grouped.set(key, { kind: req.kind, name: req.name, stepIds: [req.stepId], sources: [req.source] });
    }
  }

  const items = Array.from(grouped.values()).map((req) => {
    const result = readinessForRequirement(req.kind, req.name, inventory);
    return {
      kind: req.kind,
      name: req.name,
      status: result.status,
      reason: result.reason,
      stepIds: req.stepIds,
      sources: req.sources,
      evidence: result.evidence,
    };
  }).sort(compareReadinessItems);
  const missingCount = items.filter((item) => item.status === 'missing').length;
  const unknownCount = items.filter((item) => item.status === 'unknown').length;
  const readyCount = items.filter((item) => item.status === 'ready').length;
  return {
    ready: missingCount === 0 && unknownCount === 0,
    readyCount,
    missingCount,
    unknownCount,
    items,
  };
}

function collectToolRequirements(
  steps: WorkflowStepInput[],
  workflowAllowedTools: string[],
  inventory: WorkflowToolReadinessInventory | undefined,
  workflowProject: string | undefined,
): ToolRequirement[] {
  const requirements: ToolRequirement[] = [];
  for (const step of steps) {
    const stepProject = normalizeRequirementName(step.project);
    const project = stepProject ?? workflowProject;
    if (project) {
      requirements.push({
        kind: 'project',
        name: project,
        stepId: step.id,
        source: stepProject ? 'step_project' : 'workflow_project',
      });
    }
    const stepTools = normalizeAllowedToolNames(step.allowedTools);
    const inheritedTools = stepTools.length === 0 && stepUsesModelToolSurface(step) ? workflowAllowedTools : [];
    for (const tool of stepTools) {
      requirements.push({ kind: toolKindForTool(tool, inventory), name: tool, stepId: step.id, source: 'step_allowed_tool' });
    }
    for (const tool of inheritedTools) {
      requirements.push({ kind: toolKindForTool(tool, inventory), name: tool, stepId: step.id, source: 'workflow_allowed_tool' });
    }
    if (step.call?.tool) {
      requirements.push({ kind: toolKindForTool(step.call.tool, inventory), name: step.call.tool, stepId: step.id, source: 'step_call' });
    }
    if (step.deterministic?.runner) {
      requirements.push({ kind: 'script', name: step.deterministic.runner, stepId: step.id, source: 'deterministic_runner' });
    }
    if (step.loopUntil?.probe?.runner) {
      requirements.push({ kind: 'script', name: step.loopUntil.probe.runner, stepId: step.id, source: 'loop_probe_runner' });
    }
    if (step.usesSkill) {
      requirements.push({ kind: 'skill', name: step.usesSkill, stepId: step.id, source: 'uses_skill' });
    }
  }
  return requirements;
}

function stepUsesModelToolSurface(step: WorkflowStepInput): boolean {
  return !step.call?.tool && !step.deterministic?.runner;
}

function normalizeAllowedToolNames(items: Array<WorkflowAllowedTool | string> | undefined | null): string[] {
  if (!Array.isArray(items)) return [];
  return unique(items.map((item) => typeof item === 'string' ? item : item?.name));
}

function toolKindForTool(tool: string, inventory: WorkflowToolReadinessInventory | undefined): WorkflowToolReadinessKind {
  if (isMcpTool(tool)) return 'mcp';
  if (isComposioTool(tool)) return 'composio';
  if (isCliTool(tool) || cliCommandForTool(tool, inventory)) return 'cli';
  if (isLocalTool(tool)) return 'local';
  return 'tool';
}

function readinessForRequirement(
  kind: WorkflowToolReadinessKind,
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  switch (kind) {
    case 'project':
      return readinessForProject(name, inventory);
    case 'script':
      return readinessForScript(name, inventory);
    case 'skill':
      return readinessForSkill(name, inventory);
    case 'composio':
      return readinessForComposioTool(name, inventory);
    case 'mcp':
      return readinessForMcpTool(name, inventory);
    case 'cli':
      return readinessForCliTool(name, inventory);
    case 'local':
    case 'tool':
    default:
      return readinessForCatalogTool(name, inventory);
  }
}

function readinessForCatalogTool(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasCatalog = Array.isArray(inventory?.availableTools);
  if (hasCatalog && toolSet(inventory).has(name)) {
    return {
      status: 'ready',
      reason: 'Available in the local Clementine tool catalog.',
      evidence: [{ kind: 'tool_catalog', name, status: 'ready', detail: 'local catalog match' }],
    };
  }
  if (!hasCatalog) {
    return {
      status: 'unknown',
      reason: 'No local tool catalog was provided for this preflight.',
      evidence: [{ kind: 'tool_catalog', name, status: 'unknown', detail: 'catalog not checked' }],
    };
  }
  return {
    status: 'missing',
    reason: 'Not present in the local Clementine tool catalog.',
    evidence: [{ kind: 'tool_catalog', name, status: 'missing', detail: 'no catalog match' }],
  };
}

function readinessForComposioTool(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasCatalog = Array.isArray(inventory?.availableTools);
  const tools = toolSet(inventory);
  if (hasCatalog && tools.has(name)) {
    return {
      status: 'ready',
      reason: 'Exact Composio tool wrapper is available.',
      evidence: [{ kind: 'tool_catalog', name, status: 'ready', detail: 'exact Composio wrapper' }],
    };
  }
  if (!hasCatalog) {
    return {
      status: 'unknown',
      reason: 'No local tool catalog was provided for this preflight.',
      evidence: [{ kind: 'tool_catalog', name, status: 'unknown', detail: 'catalog not checked' }],
    };
  }
  if (tools.has('composio_execute_tool')) {
    return {
      status: 'unknown',
      reason: 'Composio broker is available; exact app slug and account connection still need runtime schema confirmation.',
      evidence: [
        { kind: 'composio_broker', name: 'composio_execute_tool', status: 'ready', detail: 'broker can resolve app tools at runtime' },
        { kind: 'tool_catalog', name, status: 'missing', detail: 'exact wrapper not listed' },
      ],
    };
  }
  return {
    status: 'missing',
    reason: 'Composio broker tool is not available in this environment.',
    evidence: [{ kind: 'composio_broker', name: 'composio_execute_tool', status: 'missing', detail: 'broker unavailable' }],
  };
}

function readinessForMcpTool(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasCatalog = Array.isArray(inventory?.availableTools);
  const tools = toolSet(inventory);
  if (hasCatalog && tools.has(name)) {
    return {
      status: 'ready',
      reason: 'Exact MCP tool is available in the local tool catalog.',
      evidence: [{ kind: 'tool_catalog', name, status: 'ready', detail: 'exact MCP tool' }],
    };
  }
  const serverId = mcpServerIdFromTool(name);
  const hasMcpInventory = Array.isArray(inventory?.mcpServers);
  if (!serverId) {
    return hasCatalog
      ? {
        status: 'missing',
        reason: 'MCP tool is not present in the local tool catalog.',
        evidence: [{ kind: 'tool_catalog', name, status: 'missing', detail: 'no exact MCP tool match' }],
      }
      : {
        status: 'unknown',
        reason: 'No local MCP tool catalog was provided for this preflight.',
        evidence: [{ kind: 'tool_catalog', name, status: 'unknown', detail: 'catalog not checked' }],
      };
  }
  if (!hasMcpInventory) {
    return {
      status: 'unknown',
      reason: `MCP server "${serverId}" was not checked in this preflight.`,
      evidence: [{ kind: 'mcp_server', name: serverId, status: 'unknown', detail: 'server inventory not checked' }],
    };
  }
  const server = findMcpServer(inventory?.mcpServers ?? [], serverId);
  if (!server) {
    return {
      status: 'missing',
      reason: `MCP server "${serverId}" is not configured.`,
      evidence: [{ kind: 'mcp_server', name: serverId, status: 'missing', detail: 'not configured' }],
    };
  }
  if (server.enabled === false) {
    return {
      status: 'missing',
      reason: `MCP server "${server.name}" is disabled.`,
      evidence: [{ kind: 'mcp_server', name: server.name, status: 'missing', detail: 'disabled' }],
    };
  }
  if (server.state === 'unavailable') {
    return {
      status: 'missing',
      reason: `MCP server "${server.name}" is unavailable${server.toolCount ? '' : ' and has no ready tools'}.`,
      evidence: [{ kind: 'mcp_server', name: server.name, status: 'missing', detail: mcpServerEvidenceDetail(server) }],
    };
  }
  if (server.state === 'connected') {
    return {
      status: 'unknown',
      reason: `MCP server "${server.name}" is connected, but this exact tool was not in the local tool catalog.`,
      evidence: [
        { kind: 'mcp_server', name: server.name, status: 'ready', detail: mcpServerEvidenceDetail(server) },
        { kind: 'tool_catalog', name, status: hasCatalog ? 'missing' : 'unknown', detail: hasCatalog ? 'exact tool not listed' : 'catalog not checked' },
      ],
    };
  }
  if (server.state === 'connecting' || server.state === 'degraded') {
    return {
      status: 'unknown',
      reason: `MCP server "${server.name}" is ${server.state}; exact tool availability is not confirmed yet.`,
      evidence: [{ kind: 'mcp_server', name: server.name, status: 'unknown', detail: mcpServerEvidenceDetail(server) }],
    };
  }
  return {
    status: 'unknown',
    reason: `MCP server "${server.name}" is configured, but health is not known yet.`,
    evidence: [{ kind: 'mcp_server', name: server.name, status: 'unknown', detail: mcpServerEvidenceDetail(server) }],
  };
}

function readinessForCliTool(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const catalogReady = readinessForCatalogTool(name, inventory);
  if (catalogReady.status === 'ready') return catalogReady;
  const command = cliCommandForTool(name, inventory) ?? cliCommandName(name);
  const hasCliInventory = Array.isArray(inventory?.availableClis);
  if (command && hasCliInventory && cliSet(inventory).has(command)) {
    return {
      status: 'ready',
      reason: `CLI "${command}" is present in the local CLI inventory.`,
      evidence: [{ kind: 'cli_command', name: command, status: 'ready', detail: 'local CLI inventory match' }],
    };
  }
  if (command && hasCliInventory) {
    return {
      status: 'missing',
      reason: `CLI "${command}" was not found in the local CLI inventory.`,
      evidence: [{ kind: 'cli_command', name: command, status: 'missing', detail: 'not found in local CLI inventory' }],
    };
  }
  if (!Array.isArray(inventory?.availableTools) && !hasCliInventory) {
    return {
      status: 'unknown',
      reason: 'No local tool or CLI inventory was provided for this preflight.',
      evidence: [
        { kind: 'tool_catalog', name, status: 'unknown', detail: 'catalog not checked' },
        { kind: 'cli_command', name: cliCommandName(name) ?? name, status: 'unknown', detail: 'CLI inventory not checked' },
      ],
    };
  }
  return catalogReady;
}

function readinessForSkill(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasSkills = Array.isArray(inventory?.installedSkills);
  if (hasSkills && skillSet(inventory).has(name)) {
    return {
      status: 'ready',
      reason: 'Skill is installed locally.',
      evidence: [{ kind: 'skill', name, status: 'ready', detail: 'installed locally' }],
    };
  }
  if (!hasSkills) {
    return {
      status: 'unknown',
      reason: 'Installed skills were not checked in this preflight.',
      evidence: [{ kind: 'skill', name, status: 'unknown', detail: 'skill inventory not checked' }],
    };
  }
  return {
    status: 'missing',
    reason: 'Skill is not installed locally.',
    evidence: [{ kind: 'skill', name, status: 'missing', detail: 'not installed locally' }],
  };
}

function readinessForScript(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasScripts = Array.isArray(inventory?.workflowScripts);
  if (!hasScripts) {
    return {
      status: 'unknown',
      reason: 'Workflow-local scripts were not checked in this preflight.',
      evidence: [{ kind: 'script', name, status: 'unknown', detail: 'scripts/ not checked' }],
    };
  }
  const match = findWorkflowScript(inventory?.workflowScripts ?? [], name);
  if (match) {
    return {
      status: 'ready',
      reason: 'Workflow-local script exists.',
      evidence: [{ kind: 'script', name: match, status: 'ready', detail: 'matched workflow scripts/' }],
    };
  }
  return {
    status: 'missing',
    reason: 'Workflow-local script is missing from scripts/.',
    evidence: [{ kind: 'script', name, status: 'missing', detail: `looked for ${scriptCandidateNames(name).join(', ')}` }],
  };
}

function readinessForProject(
  name: string,
  inventory: WorkflowToolReadinessInventory | undefined,
): ToolReadinessResult {
  const hasProjects = Array.isArray(inventory?.workspaceProjects);
  if (!hasProjects) {
    return {
      status: 'unknown',
      reason: 'Workspace projects were not checked in this preflight.',
      evidence: [{ kind: 'project', name, status: 'unknown', detail: 'workspace inventory not checked' }],
    };
  }
  const project = findWorkspaceProject(inventory?.workspaceProjects ?? [], name);
  if (project) {
    return {
      status: 'ready',
      reason: `Workspace project is available at ${project.path}.`,
      evidence: [{ kind: 'project', name: project.name, status: 'ready', detail: [project.type, project.path].filter(Boolean).join(' at ') }],
    };
  }
  return {
    status: 'missing',
    reason: 'Workspace project was not found in the configured local workspace inventory.',
    evidence: [{ kind: 'project', name, status: 'missing', detail: 'no workspace project match' }],
  };
}

function compareReadinessItems(a: WorkflowToolReadinessItem, b: WorkflowToolReadinessItem): number {
  const statusRank: Record<WorkflowToolReadinessStatus, number> = { missing: 0, unknown: 1, ready: 2 };
  return statusRank[a.status] - statusRank[b.status]
    || a.kind.localeCompare(b.kind)
    || a.name.localeCompare(b.name);
}

function toolSet(inventory: WorkflowToolReadinessInventory | undefined): Set<string> {
  return new Set(unique(inventory?.availableTools ?? []));
}

function cliSet(inventory: WorkflowToolReadinessInventory | undefined): Set<string> {
  return new Set(unique(inventory?.availableClis ?? []));
}

function skillSet(inventory: WorkflowToolReadinessInventory | undefined): Set<string> {
  return new Set(unique(inventory?.installedSkills ?? []));
}

function scriptSet(inventory: WorkflowToolReadinessInventory | undefined): Set<string> {
  return new Set(unique(inventory?.workflowScripts ?? []).flatMap((script) => scriptCandidateNames(script)));
}

function findWorkspaceProject(projects: WorkflowProjectReadinessProject[], ref: string): WorkflowProjectReadinessProject | null {
  const wanted = normalizeProjectRef(ref);
  const wantedSlug = slugifyName(wanted);
  return projects.find((project) => {
    const aliases = unique([
      project.name,
      project.path,
      project.path.split(/[\\/]/).filter(Boolean).at(-1),
    ]).map(normalizeProjectRef);
    return aliases.some((alias) => alias === wanted || slugifyName(alias) === wantedSlug);
  }) ?? null;
}

function findWorkflowScript(scripts: string[], ref: string): string | null {
  const wanted = new Set(scriptCandidateNames(ref));
  return scripts.find((script) => scriptCandidateNames(script).some((candidate) => wanted.has(candidate))) ?? null;
}

function executorFor(step: WorkflowStepInput): WorkflowExecutionPlanFanout['executor'] {
  if (step.call?.tool) return 'call';
  if (step.deterministic?.runner) return 'deterministic';
  if (step.usesSkill) return 'skill';
  return 'model';
}

function forEachSourceStepId(expr: string | undefined): string | null {
  if (!expr) return null;
  const raw = expr.trim();
  if (!raw || raw.startsWith('input.') || raw === 'items') return null;
  return raw.split('.')[0] || null;
}

function unique(items: Array<string | undefined | null>): string[] {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

function normalizeRequirementName(name: string | undefined | null): string | undefined {
  const trimmed = name?.trim();
  return trimmed || undefined;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isComposioTool(tool: string): boolean {
  return /^composio/i.test(tool) || /^[A-Z0-9]+_[A-Z0-9_]+$/.test(tool);
}

function isMcpTool(tool: string): boolean {
  return /^mcp/i.test(tool) || tool.includes('__mcp') || tool.includes('mcp__') || /^[a-z0-9][a-z0-9_.-]*__[A-Za-z0-9_.-]+/.test(tool);
}

function isCliTool(tool: string): boolean {
  return tool === 'run_shell_command'
    || tool.startsWith('local_cli_')
    || tool.startsWith('cli:')
    || tool.startsWith('local_cli:')
    || tool.endsWith('_cli')
    || tool.includes('shell')
    || tool.includes('command');
}

function isLocalTool(tool: string): boolean {
  return tool === 'read_file' || tool === 'write_file' || tool === 'list_files' || tool.startsWith('local_');
}

function cliCommandForTool(tool: string, inventory: WorkflowToolReadinessInventory | undefined): string | null {
  const explicit = cliCommandName(tool);
  if (explicit) return explicit;
  if (!Array.isArray(inventory?.availableClis)) return null;
  return cliSet(inventory).has(tool) ? tool : null;
}

function cliCommandName(tool: string): string | null {
  const match = tool.match(/^(?:cli|local_cli):([A-Za-z0-9._+-]{1,80})$/);
  return match?.[1] ?? null;
}

function mcpServerIdFromTool(tool: string): string | null {
  const mcpPrefixed = tool.match(/^mcp__(.+?)__/i);
  if (mcpPrefixed?.[1]) return mcpPrefixed[1];
  const namespace = tool.match(/^([a-z0-9][a-z0-9_.-]*)__[A-Za-z0-9_.-]+/);
  return namespace?.[1] ?? null;
}

function findMcpServer(servers: WorkflowToolReadinessMcpServer[], serverId: string): WorkflowToolReadinessMcpServer | null {
  const wanted = slugifyName(serverId);
  return servers.find((server) => {
    const names = [server.slug, server.name].filter((value): value is string => Boolean(value));
    return names.some((name) => slugifyName(name) === wanted);
  }) ?? null;
}

function mcpServerEvidenceDetail(server: WorkflowToolReadinessMcpServer): string {
  return [
    server.state ? `state ${server.state}` : '',
    typeof server.toolCount === 'number' ? `${server.toolCount} tools` : '',
    server.enabled === false ? 'disabled' : '',
  ].filter(Boolean).join(' · ') || 'configured';
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeProjectRef(name: string): string {
  return name.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function scriptCandidateNames(name: string): string[] {
  const normalized = name.trim().replace(/\\/g, '/').replace(/^\.?\/*/, '').replace(/^scripts\//, '');
  const parts = normalized.split('/').filter(Boolean);
  return unique([
    name,
    normalized,
    parts[parts.length - 1],
  ]);
}
