import type { AttemptRecord, WorkflowEvent, WorkflowEventKind } from '../execution/workflow-events.js';
import type { WorkflowExecutionPlan, WorkflowToolReadiness, WorkflowToolReadinessItem } from './workflow-execution-plan.js';

export type WorkflowRunGraphStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type WorkflowRunGraphAttentionLevel = 'none' | 'watch' | 'blocked' | 'failed';
export type WorkflowRunGoalStatus = 'unknown' | 'satisfied' | 'repursue' | 'escalate' | 'advisory';
export type WorkflowRunGraphStepVerdictStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'proven'
  | 'attention'
  | 'blocked'
  | 'failed'
  | 'skipped';
export type WorkflowRunExecutionEfficiencyIssueKind =
  | 'parallel_underused'
  | 'concurrency_cap'
  | 'fanout_underused'
  | 'fanout_worker_cap'
  | 'critical_path_blocked';

export interface WorkflowRunStepExecutionEfficiency {
  plannedLevelIndex?: number;
  plannedLaneIndex?: number;
  plannedParallelWidth: number;
  plannedCritical: boolean;
  plannedFanoutConcurrency?: number;
  plannedFanoutBatchSize?: number;
  issueKinds: WorkflowRunExecutionEfficiencyIssueKind[];
  attentionLevel: WorkflowRunGraphAttentionLevel;
  notes: string[];
}

export interface WorkflowRunExecutionEfficiencyIssue {
  kind: WorkflowRunExecutionEfficiencyIssueKind;
  stepId?: string;
  severity: WorkflowRunGraphAttentionLevel;
  message: string;
}

export interface WorkflowRunExecutionEfficiencyOverlay {
  plannedMaxParallelWidth: number;
  runtimeMaxParallelWidth: number;
  plannedEstimatedRounds: number;
  runtimeReadyRounds?: number;
  plannedParallelSavings: number;
  fanoutStepCount: number;
  criticalPath: string[];
  attentionLevel: WorkflowRunGraphAttentionLevel;
  issues: WorkflowRunExecutionEfficiencyIssue[];
  notes: string[];
}

export interface WorkflowRunGraphStepVerdict {
  status: WorkflowRunGraphStepVerdictStatus;
  label: string;
  reasons: string[];
  primaryAction: string | null;
}

export interface WorkflowRunGraphStepOverlay {
  stepId: string;
  status: WorkflowRunGraphStepStatus;
  runVerdict: WorkflowRunGraphStepVerdict;
  sessionIds: string[];
  readyAt?: string;
  startedAt?: string;
  finishedAt?: string;
  queueWaitMs?: number;
  readyRound?: number;
  readyWidth?: number;
  concurrencyCap?: number;
  laneIndex?: number;
  deferredByConcurrency: boolean;
  durationMs?: number;
  retries: number;
  attempts: number;
  toolCalls: number;
  tools: string[];
  failedTools: string[];
  launchComparison?: WorkflowRunLaunchRuntimeComparison | null;
  executionEfficiency?: WorkflowRunStepExecutionEfficiency | null;
  models: string[];
  routes: string[];
  itemsStarted: number;
  itemsCompleted: number;
  itemsFailed: number;
  approvalsRequested: number;
  approvalsResolved: number;
  advisories: number;
  judgeVerdicts: number;
  externalWrites: number;
  externalWriteFailures: number;
  workerBranches: number;
  workerFailures: number;
  workerCapped: number;
  attentionLevel: WorkflowRunGraphAttentionLevel;
  attentionReasons: string[];
  bottleneck: string | null;
  riskSignals: string[];
  throughput: {
    itemsTotal: number;
    itemsCompleted: number;
    itemsFailed: number;
    completionPct?: number;
  };
  error?: string;
  outputPreview?: string;
}

export interface WorkflowRunGraphOverlaySummary {
  totalSteps: number;
  pendingSteps: number;
  runningSteps: number;
  doneSteps: number;
  failedSteps: number;
  skippedSteps: number;
  attentionSteps: number;
  concurrencyCapPressureSteps: number;
  maxBatchWidth: number;
  maxQueueWaitMs: number;
  toolCalls: number;
  workerBranches: number;
  externalWrites: number;
  judgeVerdicts: number;
  goalStatus: WorkflowRunGoalStatus | null;
  goalAttempt?: number;
  goalMaxAttempts?: number;
  goalSuccessRatePercent?: number;
  goalNeedsAttention: boolean;
  bottleneckStepId: string | null;
  bottleneck: string | null;
}

export interface WorkflowRunGoalOverlay {
  status: WorkflowRunGoalStatus;
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  successRatePercent?: number;
  criteriaMet?: number;
  criteriaTotal?: number;
  judgeFailedOpen?: boolean;
  requeueRunId?: string;
  feedbackPreview?: string;
  failedCriteria: string[];
  attempts: AttemptRecord[];
  lineage?: WorkflowRunGoalLineageEntry[];
  attentionLevel: WorkflowRunGraphAttentionLevel;
}

export interface WorkflowRunGoalLineageEntry {
  runId: string;
  sourceRunId?: string;
  createdAt?: string;
  finishedAt?: string;
  status?: string;
  goalStatus: WorkflowRunGoalStatus | null;
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  successRatePercent?: number;
  criteriaMet?: number;
  criteriaTotal?: number;
  requeueRunId?: string;
  isCurrent: boolean;
}

export interface WorkflowRunLaunchReadinessOverlay {
  ok: boolean;
  checkedAt?: string;
  scope: 'run' | 'step' | 'unknown';
  targetStepId?: string;
  blockers: WorkflowToolReadinessItem[];
  warnings: WorkflowToolReadinessItem[];
  toolReadiness?: WorkflowToolReadiness;
}

export interface WorkflowRunLaunchRuntimeComparison {
  launchToolCount: number;
  launchIssueCount: number;
  runtimeToolCount: number;
  confirmedLaunchTools: string[];
  unconfirmedLaunchTools: string[];
  runtimeOnlyTools: string[];
  failedTools: string[];
  preflightRiskHits: string[];
  attentionLevel: WorkflowRunGraphAttentionLevel;
  notes: string[];
}

export interface WorkflowRunRecoveryIntentOverlay {
  kind: string;
  createdAt?: string;
  sourceRunId?: string;
  sourceStepId?: string;
  requestedFrom?: string;
  reason?: string;
}

export interface WorkflowRunRecoveryLineageEntry {
  runId: string;
  sourceRunId?: string;
  sourceStepId?: string;
  createdAt?: string;
  finishedAt?: string;
  status?: string;
  kind?: string;
  requestedFrom?: string;
  reason?: string;
  sourceMissing?: boolean;
  isCurrent: boolean;
}

export interface WorkflowRunGraphOverlay {
  runStatus: 'unknown' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  runStartedAt?: string;
  runFinishedAt?: string;
  terminal: boolean;
  summary: WorkflowRunGraphOverlaySummary;
  goal: WorkflowRunGoalOverlay | null;
  launchReadiness: WorkflowRunLaunchReadinessOverlay | null;
  launchComparison: WorkflowRunLaunchRuntimeComparison | null;
  executionEfficiency: WorkflowRunExecutionEfficiencyOverlay | null;
  recoveryIntent: WorkflowRunRecoveryIntentOverlay | null;
  recoveryLineage: WorkflowRunRecoveryLineageEntry[];
  steps: WorkflowRunGraphStepOverlay[];
}

export interface WorkflowRunGraphOverlayOptions {
  stepIds?: readonly string[];
  harnessSessions?: readonly WorkflowRunHarnessSessionEvidence[];
  launchReadiness?: WorkflowRunLaunchReadinessOverlay | null;
  executionPlan?: WorkflowExecutionPlan | null;
  recoveryIntent?: WorkflowRunRecoveryIntentOverlay | null;
  recoveryLineage?: readonly WorkflowRunRecoveryLineageEntry[];
}

export interface WorkflowRunHarnessSessionEvidence {
  sessionId: string;
  stepId?: string;
  status?: string;
  events: readonly WorkflowRunHarnessEventEvidence[];
}

export interface WorkflowRunHarnessEventEvidence {
  type: string;
  data?: Record<string, unknown>;
}

interface MutableStepOverlay extends WorkflowRunGraphStepOverlay {
  explicitToolEvents: number;
  attemptToolCalls: number;
  harnessToolEvents: number;
}

interface ExecutionEfficiencyDiagnosis {
  overlay: WorkflowRunExecutionEfficiencyOverlay;
  stepsById: Map<string, WorkflowRunStepExecutionEfficiency>;
}

const RUN_GOAL_STEP_ID = '(run goal)';

const STEP_STATUS_BY_KIND: Partial<Record<WorkflowEventKind, WorkflowRunGraphStepStatus>> = {
  step_started: 'running',
  workflow_node_started: 'running',
  step_completed: 'done',
  workflow_node_completed: 'done',
  step_failed: 'failed',
  workflow_node_failed: 'failed',
  step_skipped: 'skipped',
};

function pendingRunVerdict(): WorkflowRunGraphStepVerdict {
  return { status: 'pending', label: 'Pending', reasons: [], primaryAction: null };
}

export function buildWorkflowRunGraphOverlay(
  events: readonly WorkflowEvent[],
  options: WorkflowRunGraphOverlayOptions = {},
): WorkflowRunGraphOverlay {
  const order: string[] = [];
  const byStep = new Map<string, MutableStepOverlay>();
  let runStatus: WorkflowRunGraphOverlay['runStatus'] = 'unknown';
  let runStartedAt: string | undefined;
  let runFinishedAt: string | undefined;
  let goal: WorkflowRunGoalOverlay | null = null;

  const ensureStep = (stepId: string): MutableStepOverlay => {
    const existing = byStep.get(stepId);
    if (existing) return existing;
    const row: MutableStepOverlay = {
      stepId,
      status: 'pending',
      runVerdict: pendingRunVerdict(),
      sessionIds: [],
      deferredByConcurrency: false,
      retries: 0,
      attempts: 0,
      toolCalls: 0,
      tools: [],
      failedTools: [],
      models: [],
      routes: [],
      itemsStarted: 0,
      itemsCompleted: 0,
      itemsFailed: 0,
      approvalsRequested: 0,
      approvalsResolved: 0,
      advisories: 0,
      judgeVerdicts: 0,
      externalWrites: 0,
      externalWriteFailures: 0,
      workerBranches: 0,
      workerFailures: 0,
      workerCapped: 0,
      attentionLevel: 'none',
      attentionReasons: [],
      bottleneck: null,
      riskSignals: [],
      throughput: { itemsTotal: 0, itemsCompleted: 0, itemsFailed: 0 },
      explicitToolEvents: 0,
      attemptToolCalls: 0,
      harnessToolEvents: 0,
    };
    byStep.set(stepId, row);
    order.push(stepId);
    return row;
  };
  const ensureGoal = (): WorkflowRunGoalOverlay => {
    if (goal) return goal;
    goal = {
      status: 'unknown',
      failedCriteria: [],
      attempts: [],
      attentionLevel: 'none',
    };
    return goal;
  };

  for (const stepId of options.stepIds ?? []) {
    if (stepId) ensureStep(stepId);
  }

  for (const event of events ?? []) {
    const kind = event?.kind;
    if (!kind) continue;

    if (kind === 'run_started') {
      runStatus = 'running';
      runStartedAt = event.t;
      continue;
    }
    if (kind === 'run_completed') {
      runStatus = 'completed';
      runFinishedAt = event.t;
      continue;
    }
    if (kind === 'run_failed') {
      runStatus = 'failed';
      runFinishedAt = event.t;
      continue;
    }
    if (kind === 'run_cancelled') {
      runStatus = 'cancelled';
      runFinishedAt = event.t;
      continue;
    }
    if (kind === 'run_paused') {
      runStatus = 'paused';
      continue;
    }
    if (kind === 'run_resumed') {
      runStatus = 'running';
      continue;
    }

    const stepId = typeof event.stepId === 'string' && event.stepId ? event.stepId : '';
    if (kind === 'attempt_record' && event.attempt && !stepId) {
      ensureGoal().attempts.push(event.attempt);
      continue;
    }
    if (stepId === RUN_GOAL_STEP_ID) {
      applyRunGoalEvent(ensureGoal(), event);
      continue;
    }
    if (!stepId) continue;
    const step = ensureStep(stepId);
    const nextStatus = STEP_STATUS_BY_KIND[kind];
    if (kind === 'workflow_node_ready') {
      if (!step.readyAt) step.readyAt = event.t;
      step.readyRound = numberFromMeta(event.meta, 'round') ?? step.readyRound;
      step.readyWidth = numberFromMeta(event.meta, 'readyWidth') ?? step.readyWidth;
      step.concurrencyCap = numberFromMeta(event.meta, 'concurrencyCap') ?? step.concurrencyCap;
      step.laneIndex = numberFromMeta(event.meta, 'laneIndex') ?? step.laneIndex;
      const deferred = booleanFromMeta(event.meta, 'deferredByConcurrency');
      if (deferred !== undefined) step.deferredByConcurrency = deferred;
    } else if (nextStatus) {
      step.status = nextStatus;
      if (nextStatus === 'running') step.startedAt = event.t;
      if (nextStatus === 'done' || nextStatus === 'failed' || nextStatus === 'skipped') {
        step.finishedAt = event.t;
      }
      if (nextStatus === 'failed') {
        step.error = event.error || step.error;
        pushUnique(step.failedTools, toolNameFromEvent(event));
      }
      if (nextStatus === 'done') step.outputPreview = previewValue(event.output);
      if (nextStatus === 'skipped') step.outputPreview = stringFromMeta(event.meta, 'reason') || step.outputPreview;
    } else if (kind === 'step_retry' || kind === 'step_loop_retry' || kind === 'item_retry' || kind === 'workflow_node_failed') {
      step.retries += 1;
      if (event.error) step.error = event.error;
    } else if (kind === 'attempt_record' && event.attempt) {
      step.attempts += 1;
      const tools = Number(event.attempt.metrics?.toolCalls);
      if (Number.isFinite(tools) && tools > 0) step.attemptToolCalls += tools;
    } else if (kind === 'item_started') {
      step.itemsStarted += 1;
      if (step.status === 'pending') step.status = 'running';
    } else if (kind === 'item_completed') {
      step.itemsCompleted += 1;
      step.outputPreview = previewValue(event.output) || step.outputPreview;
    } else if (kind === 'item_failed') {
      step.itemsFailed += 1;
      if (event.error) step.error = event.error;
      pushUnique(step.failedTools, toolNameFromEvent(event));
    } else if (kind === 'tool_called') {
      step.explicitToolEvents += 1;
      const tool = toolNameFromEvent(event);
      if (tool && !step.tools.includes(tool)) step.tools.push(tool);
    } else if (kind === 'approval_requested') {
      step.approvalsRequested += 1;
      if (step.status === 'pending') step.status = 'running';
    } else if (kind === 'approval_granted' || kind === 'approval_rejected') {
      step.approvalsResolved += 1;
    } else if (kind === 'step_advisory') {
      step.advisories += 1;
      if (looksLikeJudgeVerdict(event.meta)) step.judgeVerdicts += 1;
      if (event.error) step.error = event.error;
    }
  }

  for (const session of options.harnessSessions ?? []) {
    const stepId = typeof session.stepId === 'string' && session.stepId ? session.stepId : '';
    if (!stepId) continue;
    const step = ensureStep(stepId);
    pushUnique(step.sessionIds, session.sessionId);
    for (const event of session.events ?? []) {
      applyHarnessEventToStep(step, event);
    }
  }

  const steps = order.map((stepId) => {
    const row = byStep.get(stepId)!;
    const directToolCalls = row.explicitToolEvents + row.harnessToolEvents;
    const toolCalls = directToolCalls > 0 ? directToolCalls : row.attemptToolCalls;
    const durationMs = row.startedAt && row.finishedAt
      ? Math.max(0, new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime())
      : undefined;
    const queueWaitMs = row.readyAt && row.startedAt
      ? Math.max(0, new Date(row.startedAt).getTime() - new Date(row.readyAt).getTime())
      : undefined;
    const derived = deriveStepOperations(row, toolCalls);
    return {
      stepId: row.stepId,
      status: row.status,
      runVerdict: pendingRunVerdict(),
      sessionIds: row.sessionIds,
      readyAt: row.readyAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      queueWaitMs: Number.isFinite(queueWaitMs) ? queueWaitMs : undefined,
      readyRound: row.readyRound,
      readyWidth: row.readyWidth,
      concurrencyCap: row.concurrencyCap,
      laneIndex: row.laneIndex,
      deferredByConcurrency: row.deferredByConcurrency,
      retries: row.retries,
      attempts: row.attempts,
      toolCalls,
      tools: row.tools,
      failedTools: row.failedTools,
      models: row.models,
      routes: row.routes,
      itemsStarted: row.itemsStarted,
      itemsCompleted: row.itemsCompleted,
      itemsFailed: row.itemsFailed,
      approvalsRequested: row.approvalsRequested,
      approvalsResolved: row.approvalsResolved,
      advisories: row.advisories,
      judgeVerdicts: row.judgeVerdicts,
      externalWrites: row.externalWrites,
      externalWriteFailures: row.externalWriteFailures,
      workerBranches: row.workerBranches,
      workerFailures: row.workerFailures,
      workerCapped: row.workerCapped,
      attentionLevel: derived.attentionLevel,
      attentionReasons: derived.attentionReasons,
      bottleneck: derived.bottleneck,
      riskSignals: derived.riskSignals,
      throughput: derived.throughput,
      error: row.error,
      outputPreview: row.outputPreview,
    };
  });

  const summary = summarizeOverlaySteps(steps, goal);
  const launchReadiness = options.launchReadiness ?? null;
  const launchComparison = launchReadiness ? compareLaunchReadinessToRuntime(launchReadiness, steps) : null;
  const executionEfficiency = options.executionPlan ? diagnoseExecutionEfficiency(options.executionPlan, steps) : null;
  const overlaySteps = steps.map((step) => {
    const executionStep = executionEfficiency?.stepsById.get(step.stepId) ?? null;
    const withExecution = executionStep ? { ...step, executionEfficiency: executionStep } : step;
    let enriched: WorkflowRunGraphStepOverlay = withExecution;
    if (launchReadiness) {
      const stepComparison = compareLaunchReadinessToRuntime(launchReadiness, [step], step.stepId);
      enriched = meaningfulLaunchComparison(stepComparison)
        ? { ...withExecution, launchComparison: stepComparison }
        : withExecution;
    }
    return { ...enriched, runVerdict: runtimeVerdictForStep(enriched) };
  });
  return {
    runStatus,
    runStartedAt,
    runFinishedAt,
    terminal: runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled',
    summary,
    goal,
    launchReadiness,
    launchComparison,
    executionEfficiency: executionEfficiency?.overlay ?? null,
    recoveryIntent: options.recoveryIntent ?? null,
    recoveryLineage: [...(options.recoveryLineage ?? [])],
    steps: overlaySteps,
  };
}

function deriveStepOperations(
  row: MutableStepOverlay,
  toolCalls: number,
): Pick<WorkflowRunGraphStepOverlay, 'attentionLevel' | 'attentionReasons' | 'bottleneck' | 'riskSignals' | 'throughput'> {
  const attentionReasons: string[] = [];
  const riskSignals: string[] = [];

  if (row.status === 'failed') attentionReasons.push(row.error ? `failed: ${row.error}` : 'failed');
  if (row.approvalsRequested > row.approvalsResolved) attentionReasons.push('waiting for approval');
  if (row.deferredByConcurrency && row.status === 'pending') attentionReasons.push('deferred by concurrency cap');
  if (row.itemsFailed > 0) attentionReasons.push(`${row.itemsFailed} failed item${row.itemsFailed === 1 ? '' : 's'}`);
  if (row.externalWriteFailures > 0) attentionReasons.push(`${row.externalWriteFailures} external write failure${row.externalWriteFailures === 1 ? '' : 's'}`);
  if (row.workerFailures > 0) attentionReasons.push(`${row.workerFailures} worker failure${row.workerFailures === 1 ? '' : 's'}`);
  if (row.workerCapped > 0) attentionReasons.push(`${row.workerCapped} worker capped`);
  if (row.retries > 0) attentionReasons.push(`${row.retries} retr${row.retries === 1 ? 'y' : 'ies'}`);
  if (row.advisories > 0) attentionReasons.push(`${row.advisories} advisory`);
  if (row.judgeVerdicts > 0) riskSignals.push(`${row.judgeVerdicts} judge verdict${row.judgeVerdicts === 1 ? '' : 's'}`);
  if (row.approvalsRequested > 0) riskSignals.push('approval gate');
  if (row.externalWrites > 0) riskSignals.push(`${row.externalWrites} external write${row.externalWrites === 1 ? '' : 's'}`);
  if (row.workerBranches > 0) riskSignals.push(`${row.workerBranches} worker branch${row.workerBranches === 1 ? '' : 'es'}`);
  if (toolCalls > 0) riskSignals.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
  if ((row.readyWidth ?? 0) > (row.concurrencyCap ?? Number.POSITIVE_INFINITY)) {
    riskSignals.push(`batch width ${row.readyWidth} > cap ${row.concurrencyCap}`);
  }

  let attentionLevel: WorkflowRunGraphAttentionLevel = 'none';
  if (row.status === 'failed') attentionLevel = 'failed';
  else if (row.approvalsRequested > row.approvalsResolved) attentionLevel = 'blocked';
  else if (attentionReasons.length > 0) attentionLevel = 'watch';

  const itemsTotal = Math.max(row.itemsStarted, row.itemsCompleted + row.itemsFailed);
  const throughput = {
    itemsTotal,
    itemsCompleted: row.itemsCompleted,
    itemsFailed: row.itemsFailed,
    ...(itemsTotal > 0 ? { completionPct: Math.round((row.itemsCompleted / itemsTotal) * 100) } : {}),
  };

  return {
    attentionLevel,
    attentionReasons,
    bottleneck: bottleneckForStep(row),
    riskSignals,
    throughput,
  };
}

function runtimeVerdictForStep(step: WorkflowRunGraphStepOverlay): WorkflowRunGraphStepVerdict {
  const comparison = step.launchComparison ?? null;
  const efficiency = step.executionEfficiency ?? null;
  const reasons = [
    ...step.attentionReasons,
    ...(comparison && comparison.attentionLevel !== 'none' ? comparison.notes : []),
    ...(efficiency && efficiency.issueKinds.length ? efficiency.notes : []),
  ];
  if (step.deferredByConcurrency && step.status === 'pending') reasons.push('deferred by concurrency cap');
  if (step.status === 'done' && step.judgeVerdicts > 0) {
    reasons.push(`${step.judgeVerdicts} judge verdict${step.judgeVerdicts === 1 ? '' : 's'} recorded`);
  }

  const comparisonAttention = comparison?.attentionLevel ?? 'none';
  const efficiencyAttention = efficiency?.attentionLevel ?? 'none';
  const maxAttention = maxAttentionLevel(maxAttentionLevel(step.attentionLevel, comparisonAttention), efficiencyAttention);

  let status: WorkflowRunGraphStepVerdictStatus;
  if (step.status === 'failed' || maxAttention === 'failed') status = 'failed';
  else if (maxAttention === 'blocked') status = 'blocked';
  else if (step.status === 'skipped') status = 'skipped';
  else if (maxAttention === 'watch') status = 'attention';
  else if (step.status === 'running') status = 'running';
  else if (step.status === 'done' && step.judgeVerdicts > 0) status = 'proven';
  else if (step.status === 'done') status = 'completed';
  else status = 'pending';

  if (!reasons.length) {
    if (status === 'running') reasons.push('step is running');
    else if (status === 'completed') reasons.push('completed without runtime attention');
    else if (status === 'pending') reasons.push('waiting for dependencies or scheduler slot');
    else if (status === 'skipped') reasons.push(step.outputPreview || 'step skipped');
  }

  return {
    status,
    label: runtimeVerdictLabel(status),
    reasons: uniqueStrings(reasons).slice(0, 8),
    primaryAction: runtimeVerdictPrimaryAction(step, status),
  };
}

function runtimeVerdictLabel(status: WorkflowRunGraphStepVerdictStatus): string {
  if (status === 'proven') return 'Proven';
  if (status === 'completed') return 'Completed';
  if (status === 'attention') return 'Needs attention';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runtimeVerdictPrimaryAction(
  step: WorkflowRunGraphStepOverlay,
  status: WorkflowRunGraphStepVerdictStatus,
): string | null {
  const comparison = step.launchComparison ?? null;
  const efficiency = step.executionEfficiency ?? null;
  const issues = efficiency?.issueKinds ?? [];
  const hasToolFailure = Boolean(
    (comparison?.failedTools?.length ?? 0) > 0
    || (comparison?.preflightRiskHits?.length ?? 0) > 0
    || step.failedTools.length > 0,
  );

  if (status === 'failed') {
    if (hasToolFailure) return 'Repair failed tool connection';
    if (step.itemsFailed > 0) return 'Retry failed items';
    return 'Retry failed step';
  }
  if (status === 'blocked') {
    if (step.approvalsRequested > step.approvalsResolved) return 'Resolve approval';
    if (issues.includes('concurrency_cap') || step.deferredByConcurrency) return 'Tune runner concurrency';
    if (hasToolFailure) return 'Repair failed tool connection';
    if (issues.includes('critical_path_blocked')) return 'Re-run critical path';
    return 'Review blocker';
  }
  if (status === 'attention') {
    if (issues.includes('fanout_underused') || issues.includes('fanout_worker_cap')) return 'Re-run fan-out to plan';
    if (issues.includes('parallel_underused') || issues.includes('concurrency_cap')) return 'Tune runner concurrency';
    if ((comparison?.runtimeOnlyTools?.length ?? 0) > 0 || (comparison?.unconfirmedLaunchTools?.length ?? 0) > 0) {
      return 'Review tool preflight';
    }
    if (step.externalWriteFailures > 0 || step.workerFailures > 0 || step.workerCapped > 0) return 'Review run evidence';
    if (step.advisories > 0 || step.judgeVerdicts > 0) return 'Review judge evidence';
    return 'Review run evidence';
  }
  if (status === 'pending' && step.deferredByConcurrency) return 'Tune runner concurrency';
  return null;
}

function bottleneckForStep(row: MutableStepOverlay): string | null {
  if (row.status === 'failed') return 'failed step';
  if (row.approvalsRequested > row.approvalsResolved) return 'approval wait';
  if (row.deferredByConcurrency && row.status === 'pending') return 'concurrency cap';
  if (row.itemsFailed > 0) return 'failed items';
  if (row.externalWriteFailures > 0) return 'external write failure';
  if (row.workerFailures > 0) return 'worker failure';
  if (row.workerCapped > 0) return 'worker cap';
  if (row.retries > 0) return 'retry loop';
  if (row.status === 'running') return 'running';
  return null;
}

function summarizeOverlaySteps(steps: WorkflowRunGraphStepOverlay[], goal: WorkflowRunGoalOverlay | null): WorkflowRunGraphOverlaySummary {
  const summary: WorkflowRunGraphOverlaySummary = {
    totalSteps: steps.length,
    pendingSteps: 0,
    runningSteps: 0,
    doneSteps: 0,
    failedSteps: 0,
    skippedSteps: 0,
    attentionSteps: 0,
    concurrencyCapPressureSteps: 0,
    maxBatchWidth: 0,
    maxQueueWaitMs: 0,
    toolCalls: 0,
    workerBranches: 0,
    externalWrites: 0,
    judgeVerdicts: 0,
    goalStatus: goal?.status && goal.status !== 'unknown' ? goal.status : null,
    goalAttempt: goal?.attempt,
    goalMaxAttempts: goal?.maxAttempts,
    goalSuccessRatePercent: goal?.successRatePercent,
    goalNeedsAttention: goal ? goal.attentionLevel !== 'none' : false,
    bottleneckStepId: null,
    bottleneck: null,
  };
  for (const step of steps) {
    if (step.status === 'pending') summary.pendingSteps += 1;
    else if (step.status === 'running') summary.runningSteps += 1;
    else if (step.status === 'done') summary.doneSteps += 1;
    else if (step.status === 'failed') summary.failedSteps += 1;
    else if (step.status === 'skipped') summary.skippedSteps += 1;
    if (step.attentionLevel !== 'none') summary.attentionSteps += 1;
    if ((step.readyWidth ?? 0) > (step.concurrencyCap ?? Number.POSITIVE_INFINITY)) {
      summary.concurrencyCapPressureSteps += 1;
    }
    summary.maxBatchWidth = Math.max(summary.maxBatchWidth, step.readyWidth ?? 0);
    summary.maxQueueWaitMs = Math.max(summary.maxQueueWaitMs, step.queueWaitMs ?? 0);
    summary.toolCalls += step.toolCalls;
    summary.workerBranches += step.workerBranches;
    summary.externalWrites += step.externalWrites;
    summary.judgeVerdicts += step.judgeVerdicts;
    if (!summary.bottleneckStepId && step.bottleneck) {
      summary.bottleneckStepId = step.stepId;
      summary.bottleneck = step.bottleneck;
    }
  }
  if (goal?.status && goal.status !== 'unknown') summary.judgeVerdicts += 1;
  return summary;
}

function diagnoseExecutionEfficiency(
  plan: WorkflowExecutionPlan,
  steps: WorkflowRunGraphStepOverlay[],
): ExecutionEfficiencyDiagnosis {
  const issues: WorkflowRunExecutionEfficiencyIssue[] = [];
  const notes: string[] = [];
  const stepsById = new Map<string, WorkflowRunStepExecutionEfficiency>();
  const stepById = new Map(steps.map((step) => [step.stepId, step]));
  const levelByStep = new Map<string, { index: number; laneIndex: number; width: number; cappedWidth: number }>();
  const fanoutByStep = new Map(plan.fanout.map((row) => [row.stepId, row]));
  const criticalPath = Array.isArray(plan.criticalPath) ? plan.criticalPath : [];
  const critical = new Set(criticalPath);

  for (const level of plan.levels ?? []) {
    (level.stepIds ?? []).forEach((stepId, laneIndex) => {
      levelByStep.set(stepId, {
        index: level.index,
        laneIndex,
        width: level.width,
        cappedWidth: level.cappedWidth,
      });
    });
  }

  const readyWidths = steps
    .map((step) => Number(step.readyWidth))
    .filter((width) => Number.isFinite(width) && width > 0);
  const runtimeMaxParallelWidth = readyWidths.length ? Math.max(...readyWidths) : 0;
  const readyRounds = steps
    .map((step) => Number(step.readyRound))
    .filter((round) => Number.isFinite(round) && round > 0);
  const runtimeReadyRounds = readyRounds.length ? Math.max(...readyRounds) : undefined;
  const plannedMaxParallelWidth = Number(plan.maxParallelWidth || 0);

  if (plannedMaxParallelWidth > 1 && runtimeMaxParallelWidth > 0 && runtimeMaxParallelWidth < plannedMaxParallelWidth) {
    issues.push({
      kind: 'parallel_underused',
      severity: 'watch',
      message: `planned ${plannedMaxParallelWidth}-wide parallelism, observed max ${runtimeMaxParallelWidth}-wide runtime readiness`,
    });
  }
  notes.push(`planned width ${plannedMaxParallelWidth || 0}; observed width ${runtimeMaxParallelWidth || 'unknown'}`);
  if (Number.isFinite(Number(plan.estimatedRounds))) {
    notes.push(`planned rounds ${plan.estimatedRounds}; observed ready rounds ${runtimeReadyRounds ?? 'unknown'}`);
  }
  if (Number(plan.parallelSavings) > 0) notes.push(`planned parallel savings ${plan.parallelSavings} step${plan.parallelSavings === 1 ? '' : 's'}`);

  for (const step of steps) {
    const level = levelByStep.get(step.stepId);
    const fanout = fanoutByStep.get(step.stepId);
    const stepIssues: WorkflowRunExecutionEfficiencyIssueKind[] = [];
    const stepNotes: string[] = [];
    let stepAttention: WorkflowRunGraphAttentionLevel = 'none';
    const addStepIssue = (
      kind: WorkflowRunExecutionEfficiencyIssueKind,
      severity: WorkflowRunGraphAttentionLevel,
      message: string,
    ): void => {
      stepIssues.push(kind);
      stepAttention = maxAttentionLevel(stepAttention, severity);
      issues.push({ kind, stepId: step.stepId, severity, message });
      stepNotes.push(message);
    };

    if (level) {
      stepNotes.push(`planned L${level.index + 1}.${level.laneIndex + 1} width ${level.width}`);
    }
    if (critical.has(step.stepId)) stepNotes.push('critical path');
    if ((Number(step.readyWidth) > Number(step.concurrencyCap || Number.POSITIVE_INFINITY)) || step.deferredByConcurrency) {
      addStepIssue(
        'concurrency_cap',
        step.status === 'pending' ? 'blocked' : 'watch',
        `runtime concurrency cap constrained ${step.stepId}`,
      );
    }
    if (fanout) {
      stepNotes.push(`planned fanout x${fanout.concurrency} batch ${fanout.batchSize}`);
      if (step.itemsStarted > 1 && step.workerBranches === 0) {
        addStepIssue(
          'fanout_underused',
          'watch',
          `planned fanout for ${step.stepId}, but ${step.itemsStarted} items ran with no worker branch evidence`,
        );
      }
      if (step.workerCapped > 0) {
        addStepIssue(
          'fanout_worker_cap',
          'watch',
          `${step.workerCapped} worker cap${step.workerCapped === 1 ? '' : 's'} hit during fanout ${step.stepId}`,
        );
      }
    }
    if (critical.has(step.stepId) && step.attentionLevel !== 'none') {
      addStepIssue(
        'critical_path_blocked',
        step.attentionLevel,
        `critical path step ${step.stepId} needs attention: ${step.bottleneck || step.attentionReasons[0] || step.status}`,
      );
    }

    stepsById.set(step.stepId, {
      ...(level ? { plannedLevelIndex: level.index, plannedLaneIndex: level.laneIndex } : {}),
      plannedParallelWidth: level?.width ?? 0,
      plannedCritical: critical.has(step.stepId),
      ...(fanout ? { plannedFanoutConcurrency: fanout.concurrency, plannedFanoutBatchSize: fanout.batchSize } : {}),
      issueKinds: stepIssues,
      attentionLevel: stepAttention,
      notes: uniqueStrings(stepNotes),
    });
  }

  const attentionLevel = issues.reduce<WorkflowRunGraphAttentionLevel>(
    (level, issue) => maxAttentionLevel(level, issue.severity),
    'none',
  );
  return {
    overlay: {
      plannedMaxParallelWidth,
      runtimeMaxParallelWidth,
      plannedEstimatedRounds: Number(plan.estimatedRounds || 0),
      ...(runtimeReadyRounds !== undefined ? { runtimeReadyRounds } : {}),
      plannedParallelSavings: Number(plan.parallelSavings || 0),
      fanoutStepCount: Array.isArray(plan.fanout) ? plan.fanout.length : 0,
      criticalPath,
      attentionLevel,
      issues,
      notes: uniqueStrings(notes),
    },
    stepsById,
  };
}

function maxAttentionLevel(
  a: WorkflowRunGraphAttentionLevel,
  b: WorkflowRunGraphAttentionLevel,
): WorkflowRunGraphAttentionLevel {
  const rank: Record<WorkflowRunGraphAttentionLevel, number> = {
    none: 0,
    watch: 1,
    blocked: 2,
    failed: 3,
  };
  return rank[b] > rank[a] ? b : a;
}

function compareLaunchReadinessToRuntime(
  readiness: WorkflowRunLaunchReadinessOverlay,
  steps: WorkflowRunGraphStepOverlay[],
  stepId?: string,
): WorkflowRunLaunchRuntimeComparison {
  const launchItems = readinessItemsForComparison(readiness, stepId);
  const launchIssueItems = launchItems.filter((item) => item.status !== 'ready');
  const runtimeTools = uniqueStrings(steps.flatMap((step) => step.tools));
  const failedTools = uniqueStrings(steps.flatMap((step) => step.failedTools));
  const runtimeKeys = new Set(runtimeTools.map(normalizeToolKey).filter(Boolean));
  const failedKeys = new Set(failedTools.map(normalizeToolKey).filter(Boolean));
  const launchAliasKeys = new Set<string>();

  for (const item of launchItems) {
    for (const alias of readinessItemAliases(item)) {
      const key = normalizeToolKey(alias);
      if (key) launchAliasKeys.add(key);
    }
  }

  const confirmedLaunchTools = uniqueStrings(launchItems
    .filter((item) => readinessItemAliases(item).some((alias) => runtimeKeys.has(normalizeToolKey(alias))))
    .map((item) => item.name));
  const unconfirmedLaunchTools = uniqueStrings(launchItems
    .filter((item) => !readinessItemAliases(item).some((alias) => runtimeKeys.has(normalizeToolKey(alias))))
    .map((item) => item.name));
  const runtimeOnlyTools = runtimeTools.filter((tool) => !launchAliasKeys.has(normalizeToolKey(tool)));
  const preflightRiskHits = uniqueStrings(launchIssueItems
    .filter((item) => readinessItemAliases(item).some((alias) => failedKeys.has(normalizeToolKey(alias))))
    .map((item) => item.name));

  const notes: string[] = [];
  if (confirmedLaunchTools.length > 0) notes.push(`${confirmedLaunchTools.length} launch tool${confirmedLaunchTools.length === 1 ? '' : 's'} confirmed by runtime evidence`);
  if (unconfirmedLaunchTools.length > 0) notes.push(`${unconfirmedLaunchTools.length} launch tool${unconfirmedLaunchTools.length === 1 ? '' : 's'} not observed in runtime events`);
  if (runtimeOnlyTools.length > 0) notes.push(`${runtimeOnlyTools.length} runtime tool${runtimeOnlyTools.length === 1 ? '' : 's'} lacked launch preflight evidence`);
  if (failedTools.length > 0) notes.push(`${failedTools.length} runtime tool${failedTools.length === 1 ? '' : 's'} recorded failure evidence`);
  if (preflightRiskHits.length > 0) notes.push(`${preflightRiskHits.length} preflight risk${preflightRiskHits.length === 1 ? '' : 's'} also failed at runtime`);
  if (notes.length === 0) notes.push('Runtime tool evidence matched launch preflight.');

  let attentionLevel: WorkflowRunGraphAttentionLevel = 'none';
  if (failedTools.length > 0 || preflightRiskHits.length > 0) attentionLevel = 'failed';
  else if (runtimeOnlyTools.length > 0 || unconfirmedLaunchTools.length > 0) attentionLevel = 'watch';

  return {
    launchToolCount: launchItems.length,
    launchIssueCount: launchIssueItems.length,
    runtimeToolCount: runtimeTools.length,
    confirmedLaunchTools,
    unconfirmedLaunchTools,
    runtimeOnlyTools,
    failedTools,
    preflightRiskHits,
    attentionLevel,
    notes,
  };
}

function readinessItemsForComparison(
  readiness: WorkflowRunLaunchReadinessOverlay,
  stepId?: string,
): WorkflowToolReadinessItem[] {
  const out = new Map<string, WorkflowToolReadinessItem>();
  const add = (item: WorkflowToolReadinessItem | undefined): void => {
    if (!item?.name) return;
    if (stepId && !readinessItemAppliesToStep(item, stepId)) return;
    const key = `${item.kind}:${item.status}:${normalizeToolKey(item.name)}`;
    if (!out.has(key)) out.set(key, item);
  };
  for (const item of readiness.toolReadiness?.items ?? []) add(item);
  for (const item of readiness.blockers ?? []) add(item);
  for (const item of readiness.warnings ?? []) add(item);
  return [...out.values()];
}

function readinessItemAppliesToStep(item: WorkflowToolReadinessItem, stepId: string): boolean {
  return Array.isArray(item.stepIds) && item.stepIds.includes(stepId);
}

function readinessItemAliases(item: WorkflowToolReadinessItem): string[] {
  return uniqueStrings([item.name]);
}

function meaningfulLaunchComparison(comparison: WorkflowRunLaunchRuntimeComparison): boolean {
  return comparison.launchToolCount > 0
    || comparison.runtimeToolCount > 0
    || comparison.failedTools.length > 0
    || comparison.runtimeOnlyTools.length > 0
    || comparison.preflightRiskHits.length > 0;
}

function applyRunGoalEvent(goal: WorkflowRunGoalOverlay, event: WorkflowEvent): void {
  if (event.kind === 'attempt_record' && event.attempt) {
    goal.attempts.push(event.attempt);
    return;
  }
  if (event.kind !== 'step_advisory') return;
  const meta = event.meta ?? {};
  const status = goalStatusFromMeta(meta);
  if (status) goal.status = status;
  goal.reason = stringFromMeta(meta, 'reason') ?? goal.reason;
  goal.attempt = numberFromMeta(meta, 'attempt') ?? goal.attempt;
  goal.maxAttempts = numberFromMeta(meta, 'max') ?? numberFromMeta(meta, 'maxAttempts') ?? goal.maxAttempts;
  goal.successRatePercent = numberFromMeta(meta, 'successRatePercent') ?? goal.successRatePercent;
  goal.criteriaMet = numberFromMeta(meta, 'criteriaMet') ?? goal.criteriaMet;
  goal.criteriaTotal = numberFromMeta(meta, 'criteriaTotal') ?? goal.criteriaTotal;
  goal.judgeFailedOpen = booleanFromMeta(meta, 'judgeFailedOpen') ?? goal.judgeFailedOpen;
  goal.requeueRunId = stringFromMeta(meta, 'requeueRunId') ?? goal.requeueRunId;
  goal.feedbackPreview = stringFromMeta(meta, 'feedbackPreview') ?? goal.feedbackPreview;
  const failed = stringArrayFromMeta(meta, 'failedCriteria');
  if (failed.length > 0) goal.failedCriteria = failed;
  goal.attentionLevel = attentionForGoalStatus(goal.status);
}

function goalStatusFromMeta(meta: Record<string, unknown>): WorkflowRunGoalStatus | undefined {
  const raw = stringFromMeta(meta, 'goal') ?? stringFromMeta(meta, 'goalOutcome') ?? stringFromMeta(meta, 'outcome');
  if (raw === 'satisfied' || raw === 'repursue' || raw === 'escalate' || raw === 'advisory') return raw;
  return undefined;
}

function attentionForGoalStatus(status: WorkflowRunGoalStatus): WorkflowRunGraphAttentionLevel {
  if (status === 'escalate') return 'blocked';
  if (status === 'repursue' || status === 'advisory') return 'watch';
  return 'none';
}

function previewValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}...` : flat;
}

function stringFromMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberFromMeta(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function booleanFromMeta(meta: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = meta?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayFromMeta(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function toolNameFromEvent(event: WorkflowEvent): string {
  return stringFromMeta(event.meta, 'tool')
    ?? stringFromMeta(event.meta, 'name')
    ?? stringFromMeta(event.meta, 'toolName')
    ?? '';
}

function applyHarnessEventToStep(step: MutableStepOverlay, event: WorkflowRunHarnessEventEvidence): void {
  const type = event.type;
  const data = event.data ?? {};
  if (type === 'tool_called') {
    step.harnessToolEvents += 1;
    pushUnique(step.tools, toolNameFromHarnessRecord(data));
    return;
  }
  if (type === 'tool_returned') return;
  if (type === 'approval_requested') {
    step.approvalsRequested += 1;
    return;
  }
  if (type === 'approval_resolved') {
    step.approvalsResolved += 1;
    return;
  }
  if (type === 'external_write') {
    step.externalWrites += 1;
    return;
  }
  if (type === 'external_write_failed' || type === 'external_write_orphaned') {
    step.externalWriteFailures += 1;
    pushUnique(step.failedTools, toolNameFromHarnessRecord(data));
    return;
  }
  if (type === 'worker_result') {
    step.workerBranches += 1;
    if (data.ok === false || data.status === 'failed') step.workerFailures += 1;
    pushUnique(step.models, stringFromRecord(data, 'model') ?? stringFromRecord(data, 'modelId'));
    return;
  }
  if (type === 'worker_capped') {
    step.workerCapped += 1;
    return;
  }
  if (type === 'worker_model_routed' || type === 'turn_model_routed') {
    pushUnique(step.models, stringFromRecord(data, 'modelId') ?? stringFromRecord(data, 'model') ?? stringFromRecord(data, 'effectiveModel'));
    pushUnique(step.routes, routeLabel(data));
    return;
  }
  if (type === 'brain_fallover') {
    step.advisories += 1;
    pushUnique(step.models, stringFromRecord(data, 'toModel') ?? stringFromRecord(data, 'recoveryModel'));
    pushUnique(step.routes, 'brain_fallover');
    return;
  }
  if (type === 'goal_validation' || type === 'goal_alignment_judged' || type === 'output_grounding_judged') {
    step.judgeVerdicts += 1;
    return;
  }
  if (type === 'guardrail_tripped' || type === 'stuck_detected') {
    step.advisories += 1;
  }
}

function looksLikeJudgeVerdict(meta: Record<string, unknown> | undefined): boolean {
  const reason = stringFromMeta(meta, 'reason')?.toLowerCase() ?? '';
  if (reason.includes('judge') || reason.includes('validation') || reason.includes('quality') || reason.includes('verdict')) return true;
  return meta?.judge != null || meta?.verdict != null;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pushUnique(values: string[], value: string | undefined): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) pushUnique(out, typeof value === 'string' ? value.trim() : undefined);
  return out;
}

function normalizeToolKey(value: string | undefined): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
}

function toolNameFromHarnessRecord(data: Record<string, unknown>): string | undefined {
  const raw = stringFromRecord(data, 'tool')
    ?? stringFromRecord(data, 'name')
    ?? stringFromRecord(data, 'toolName')
    ?? stringFromRecord(data, 'shapeKey');
  const nested = nestedToolNameFromHarnessRecord(data);
  if (normalizeToolKey(raw) === 'composio_execute_tool' && nested) return nested;
  return raw ?? nested;
}

function nestedToolNameFromHarnessRecord(data: Record<string, unknown>): string | undefined {
  for (const key of ['args', 'arguments', 'input']) {
    const value = data[key];
    const record = recordFromUnknown(value);
    const nested = record
      ? stringFromRecord(record, 'tool_slug')
        ?? stringFromRecord(record, 'toolSlug')
        ?? stringFromRecord(record, 'slug')
        ?? stringFromRecord(record, 'tool')
      : stringComposioSlug(value);
    if (nested) return nested;
  }
  return undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringComposioSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/)?.[0];
}

function routeLabel(data: Record<string, unknown>): string | undefined {
  const routeKind = stringFromRecord(data, 'routeKind');
  const provider = stringFromRecord(data, 'provider');
  const transport = stringFromRecord(data, 'transport');
  const source = stringFromRecord(data, 'source');
  return [routeKind, provider, transport, source].filter(Boolean).join(':') || undefined;
}
