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
import { classifyStepSideEffect } from '../execution/workflow-enforce.js';
import type {
  WorkflowExecutionPlan,
  WorkflowExecutionPlanFanout,
  WorkflowExecutionPlanGate,
  WorkflowExecutionPlanModelRoute,
  WorkflowToolReadinessItem,
  WorkflowToolReadinessStatus,
  WorkflowVisualContractCheckStatus,
  WorkflowVisualContractRemediation,
} from './workflow-execution-plan.js';

export interface FlowNodeFlags {
  forEach: boolean;
  approval: boolean;
  skill: string | null;
  deterministic: boolean;
}
export type FlowNodeSideEffect = 'read' | 'write' | 'send' | 'unknown';
export type FlowNodeExecutor = 'model' | 'skill' | 'deterministic' | 'call';
export interface FlowNodeMeta {
  sideEffect: FlowNodeSideEffect;
  executor: FlowNodeExecutor;
  tools: string[];
  toolCount: number;
  inputKeys: string[];
  outputType: string | null;
  approvalPreview: string | null;
  forEach: string | null;
  forEachNewOnly: boolean;
  runner: string | null;
  callTool: string | null;
  project: string | null;
  model: string | null;
  intent: string | null;
}
export interface FlowNodeReadiness {
  status: WorkflowToolReadinessStatus;
  readyCount: number;
  missingCount: number;
  unknownCount: number;
  items: WorkflowToolReadinessItem[];
}
export interface FlowNodePlanFanout {
  source: string;
  newOnly: boolean;
  concurrency: number;
  batchSize: number;
  safeToResume: boolean;
  workerIntent: string | null;
  workerModel: string | null;
  sideEffect: WorkflowExecutionPlanFanout['sideEffect'];
  executor: WorkflowExecutionPlanFanout['executor'];
}
export interface FlowNodePlanGate {
  kind: WorkflowExecutionPlanGate['kind'];
  label: string;
  severity: WorkflowExecutionPlanGate['severity'];
}
export interface FlowNodePlanModelRoute {
  binding: WorkflowExecutionPlanModelRoute['binding'];
  model: string | null;
  intent: string | null;
  provider: string | null;
  portable: boolean;
}
export interface FlowNodePlan {
  levelIndex: number | null;
  laneIndex: number | null;
  parallelWidth: number;
  cappedByConcurrency: boolean;
  critical: boolean;
  fanout: FlowNodePlanFanout | null;
  gates: FlowNodePlanGate[];
  modelRoute: FlowNodePlanModelRoute | null;
}
export interface FlowNodeContract {
  status: WorkflowVisualContractCheckStatus;
  fixCount: number;
  blockCount: number;
  warningCount: number;
  fixes: WorkflowVisualContractRemediation[];
}
export type FlowNodeVerdictStatus = 'trusted' | 'attention' | 'blocked';
export interface FlowNodeVerdict {
  status: FlowNodeVerdictStatus;
  label: string;
  reasons: string[];
  primaryAction: string | null;
}
export interface FlowNode {
  id: string;
  label: string;
  flags: FlowNodeFlags;
  meta: FlowNodeMeta;
  readiness: FlowNodeReadiness;
  plan: FlowNodePlan;
  contract: FlowNodeContract;
  verdict: FlowNodeVerdict;
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
export interface WorkflowGraphOptions {
  readinessItems?: WorkflowToolReadinessItem[];
  workflowProject?: string;
  executionPlan?: WorkflowExecutionPlan;
}

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

function inferSideEffect(step: WorkflowStepInput): FlowNodeSideEffect {
  return classifyStepSideEffect(step);
}

function executorFor(step: WorkflowStepInput): FlowNodeExecutor {
  if (step.call?.tool) return 'call';
  if (step.deterministic?.runner) return 'deterministic';
  if (step.usesSkill) return 'skill';
  return 'model';
}

function nodeMeta(step: WorkflowStepInput, workflowProject?: string): FlowNodeMeta {
  const tools = uniqueStrings([
    ...(step.allowedTools ?? []),
    step.call?.tool,
  ]);
  const project = typeof step.project === 'string' && step.project.trim()
    ? step.project.trim()
    : typeof workflowProject === 'string' && workflowProject.trim()
      ? workflowProject.trim()
      : null;
  return {
    sideEffect: inferSideEffect(step),
    executor: executorFor(step),
    tools,
    toolCount: tools.length,
    inputKeys: Object.keys(step.inputs ?? {}),
    outputType: typeof step.output?.type === 'string' ? step.output.type : null,
    approvalPreview: typeof step.approvalPreview === 'string' && step.approvalPreview.trim() ? step.approvalPreview.trim() : null,
    forEach: typeof step.forEach === 'string' && step.forEach.trim() ? step.forEach.trim() : null,
    forEachNewOnly: step.forEachNewOnly === true,
    runner: step.deterministic?.runner ?? null,
    callTool: step.call?.tool ?? null,
    project,
    model: step.model ?? null,
    intent: step.intent ?? null,
  };
}

function nodeReadiness(stepId: string, readinessItems: WorkflowToolReadinessItem[] | undefined): FlowNodeReadiness {
  const items = (readinessItems ?? []).filter((item) => item.stepIds.includes(stepId));
  const missingCount = items.filter((item) => item.status === 'missing').length;
  const unknownCount = items.filter((item) => item.status === 'unknown').length;
  const readyCount = items.filter((item) => item.status === 'ready').length;
  const status: WorkflowToolReadinessStatus = missingCount > 0 ? 'missing' : unknownCount > 0 ? 'unknown' : 'ready';
  return { status, readyCount, missingCount, unknownCount, items };
}

function nodePlan(stepId: string, plan: WorkflowExecutionPlan | undefined): FlowNodePlan {
  const level = plan?.levels.find((row) => row.stepIds.includes(stepId));
  const laneIndex = level ? level.stepIds.indexOf(stepId) : -1;
  const fanout = plan?.fanout.find((row) => row.stepId === stepId) ?? null;
  const gates = (plan?.gates ?? [])
    .filter((gate) => gate.stepId === stepId)
    .map((gate) => ({
      kind: gate.kind,
      label: gate.label,
      severity: gate.severity,
    }));
  const modelRoute = plan?.modelSurface.routes.find((route) => route.stepId === stepId) ?? null;
  return {
    levelIndex: level ? level.index : null,
    laneIndex: laneIndex >= 0 ? laneIndex : null,
    parallelWidth: level ? level.width : 0,
    cappedByConcurrency: level ? level.width > level.cappedWidth : false,
    critical: Array.isArray(plan?.criticalPath) ? plan.criticalPath.includes(stepId) : false,
    fanout: fanout ? {
      source: fanout.source,
      newOnly: fanout.newOnly,
      concurrency: fanout.concurrency,
      batchSize: fanout.batchSize,
      safeToResume: fanout.safeToResume,
      workerIntent: fanout.workerIntent,
      workerModel: fanout.workerModel,
      sideEffect: fanout.sideEffect,
      executor: fanout.executor,
    } : null,
    gates,
    modelRoute: modelRoute ? {
      binding: modelRoute.binding,
      model: modelRoute.model,
      intent: modelRoute.intent,
      provider: modelRoute.provider,
      portable: modelRoute.portable,
    } : null,
  };
}

function nodeContract(stepId: string, plan: WorkflowExecutionPlan | undefined): FlowNodeContract {
  const fixes = (plan?.visualContract?.remediations ?? [])
    .filter((fix) => Array.isArray(fix.stepIds) && fix.stepIds.includes(stepId));
  const blockCount = fixes.filter((fix) => fix.status === 'block').length;
  const warningCount = fixes.filter((fix) => fix.status === 'warn').length;
  return {
    status: blockCount > 0 ? 'block' : warningCount > 0 ? 'warn' : 'pass',
    fixCount: fixes.length,
    blockCount,
    warningCount,
    fixes,
  };
}

function countLine(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function firstContractFixAction(contract: FlowNodeContract): string | null {
  const ordered = [
    ...contract.fixes.filter((fix) => fix.status === 'block'),
    ...contract.fixes.filter((fix) => fix.status !== 'block'),
  ];
  for (const fix of ordered) {
    const action = fix.actions?.find((item) => typeof item.label === 'string' && item.label.trim());
    if (action?.label) return action.label.trim();
    if (fix.title.trim()) return fix.title.trim();
  }
  return null;
}

function firstReadinessAction(readiness: FlowNodeReadiness): string | null {
  const item = readiness.items.find((candidate) => candidate.status !== 'ready');
  if (!item) return null;
  if (item.kind === 'script') return `Add workflow script ${item.name}`;
  if (item.kind === 'project') return `Bind local project ${item.name}`;
  if (item.kind === 'skill') return `Install skill ${item.name}`;
  return `Confirm ${item.kind} ${item.name}`;
}

function nodeVerdict(
  readiness: FlowNodeReadiness,
  plan: FlowNodePlan,
  contract: FlowNodeContract,
): FlowNodeVerdict {
  const reasons: string[] = [];
  const blocked = readiness.missingCount > 0 || contract.blockCount > 0;
  if (readiness.missingCount > 0) reasons.push(`${countLine(readiness.missingCount, 'missing requirement')}`);
  if (contract.blockCount > 0) reasons.push(`${countLine(contract.blockCount, 'contract block')}`);
  if (readiness.unknownCount > 0) reasons.push(`${countLine(readiness.unknownCount, 'unconfirmed requirement')}`);
  if (contract.warningCount > 0) reasons.push(`${countLine(contract.warningCount, 'contract warning')}`);
  if (plan.cappedByConcurrency) reasons.push('runner concurrency cap');
  if (plan.fanout && !plan.fanout.safeToResume) reasons.push('fan-out resume not proven safe');
  if (plan.modelRoute && plan.modelRoute.portable === false) reasons.push('pinned model route');

  const status: FlowNodeVerdictStatus = blocked ? 'blocked' : reasons.length ? 'attention' : 'trusted';
  const primaryAction = firstContractFixAction(contract)
    ?? firstReadinessAction(readiness)
    ?? (plan.cappedByConcurrency ? 'Tune runner concurrency' : null)
    ?? (plan.fanout && !plan.fanout.safeToResume ? 'Make fan-out resumable' : null)
    ?? (plan.modelRoute && plan.modelRoute.portable === false ? 'Make models portable' : null);

  return {
    status,
    label: status === 'blocked' ? 'Blocked' : status === 'attention' ? 'Needs attention' : 'Trusted',
    reasons: uniqueStrings(reasons),
    primaryAction: status === 'trusted' ? null : primaryAction,
  };
}

export function buildWorkflowGraph(
  steps: WorkflowStepInput[] | undefined | null,
  options: WorkflowGraphOptions = {},
): WorkflowGraph {
  const list = Array.isArray(steps) ? steps : [];
  const ids = new Set(list.map((s) => s.id));
  const nodes: FlowNode[] = list.map((s) => {
    const meta = nodeMeta(s, options.workflowProject);
    const readiness = nodeReadiness(s.id, options.readinessItems);
    const plan = nodePlan(s.id, options.executionPlan);
    const contract = nodeContract(s.id, options.executionPlan);
    return {
      id: s.id,
      label: shortStepLabel(s.prompt || s.id),
      flags: {
        forEach: Boolean(s.forEach),
        approval: Boolean(s.requiresApproval),
        skill: s.usesSkill ?? null,
        deterministic: Boolean(s.deterministic),
      },
      meta,
      readiness,
      plan,
      contract,
      verdict: nodeVerdict(readiness, plan, contract),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => ids.has(d)) : [],
    };
  });
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
