import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { analyzeWorkflowGaps, type WorkflowGap } from './workflow-gap-test.js';
import { analyzeWorkflowRouting, renderWorkflowRoutingAdvisories } from './workflow-routing-check.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from './workflow-inputs.js';
import { prepareWorkflowVerification } from './workflow-authoring.js';
import {
  simulateWorkflowDryRun,
  type WorkflowDryRunPlanOptions,
  type WorkflowDryRunSimulation,
} from './workflow-dry-run-simulation.js';
import { classifyWorkflowExecutionMode, type WorkflowExecutionMode, type WorkflowCodifyCandidate } from './workflow-execution-mode.js';
import { resourceHasSurface, resourceHasSelector } from './workflow-resource-binding.js';

export type WorkflowCertificationState =
  | 'blocked'
  | 'needs_resource_binding'
  | 'needs_info'
  | 'needs_creation_inputs'
  | 'needs_creation_test'
  | 'ready_to_enable'
  | 'needs_run_inputs'
  | 'ready_to_run';

export type WorkflowCertificationAction =
  | 'fix_blockers'
  | 'bind_resources'
  | 'answer_readiness_questions'
  | 'provide_test_inputs'
  | 'start_creation_test'
  | 'enable_workflow'
  | 'provide_run_inputs'
  | 'run_workflow'
  | 'review_contract_advisories';

export interface WorkflowCertificationOptions {
  workflowSlug?: string;
  runInputs?: Record<string, string>;
  testInputs?: Record<string, string>;
  planOptions?: WorkflowDryRunPlanOptions;
}

export interface WorkflowCertification {
  workflow: string;
  enabled: boolean;
  state: WorkflowCertificationState;
  executionMode: WorkflowExecutionMode;
  /** Token-efficiency nudge: LLM steps that look mechanical enough to run as
   *  free `call` code (already computed for the execution mode — surfaced so the
   *  UI can show the savings on the table). Advisory only; never gates a run. */
  codifyCandidateCount: number;
  codifyCandidates: WorkflowCodifyCandidate[];
  label: string;
  summary: string;
  canRun: boolean;
  canEnableDirectly: boolean;
  canQueueCreationTest: boolean;
  needsCreationTest: boolean;
  missingRunInputs: string[];
  missingTestInputs: string[];
  resourceGaps: string[];
  readinessGaps: WorkflowGap[];
  blockingReasons: string[];
  contractAdvisories: string[];
  nextActions: WorkflowCertificationAction[];
  dryRun: WorkflowDryRunSimulation;
}

export function certifyWorkflow(
  def: WorkflowDefinition,
  options: WorkflowCertificationOptions = {},
): WorkflowCertification {
  const runInputs = normalizeWorkflowRunInputs(options.runInputs ?? {});
  const testInputs = normalizeWorkflowRunInputs(options.testInputs ?? {});
  const dryRun = simulateWorkflowDryRun(def, {
    workflowSlug: options.workflowSlug,
    inputs: runInputs,
    planOptions: options.planOptions,
  });
  const execution = classifyWorkflowExecutionMode(def);
  const readinessGaps = analyzeWorkflowGaps(def);
  // Model-routing advisories (silent no-op tag / missed routing) ride the
  // contract-advisory channel so the Automate UI surfaces them alongside other
  // advisories. Advisory only — they never flip canRun/canEnable.
  const routingAdvisories = renderWorkflowRoutingAdvisories(analyzeWorkflowRouting(def));
  const contractAdvisories = [...dryRun.contractAdvisories, ...routingAdvisories];
  const verification = prepareWorkflowVerification(def, testInputs);
  const missingRunInputs = missingWorkflowRunInputs(def, runInputs);
  const resourceGaps = workflowResourceBindingGaps(def);
  const blockingReasons = dryRun.blockingReasons;
  const hardBlocked = blockingReasons.length > 0;
  const hasResourceGaps = resourceGaps.length > 0;
  const hasGaps = readinessGaps.length > 0;
  const enabled = def.enabled !== false;
  const needsCreationTest = verification.needsTest;
  // F2 (live 2026-07-23, guardrails-inform-not-override): readiness gaps are
  // QUESTIONS, not walls. They used to gate all three capability bits, which
  // produced an exitless needs_info state — the card refused BOTH the toggle
  // and the creation test while offering "answer readiness questions" with no
  // surface to answer them on. Gaps now ride the advisory rail (rendered
  // loudly in the drawer + asked conversationally at authoring); hard blocks
  // remain what they should be: real blockers, unbound resources, missing
  // inputs.
  const canQueueCreationTest = !hardBlocked && !hasResourceGaps && needsCreationTest && verification.missing.length === 0;
  const canEnableDirectly = !enabled && !hardBlocked && !hasResourceGaps && !needsCreationTest;
  const canRun = enabled && !hardBlocked && !hasResourceGaps && missingRunInputs.length === 0;

  const state = certificationState({
    enabled,
    hardBlocked,
    hasResourceGaps,
    needsCreationTest,
    missingTestInputs: verification.missing,
    missingRunInputs,
  });
  const nextActions = certificationActions({
    state,
    hasContractAdvisories: contractAdvisories.length > 0,
    hasReadinessGaps: hasGaps,
  });

  return {
    workflow: def.name,
    enabled,
    state,
    executionMode: execution.mode,
    codifyCandidateCount: execution.codifyCandidates.length,
    codifyCandidates: execution.codifyCandidates,
    label: certificationLabel(state),
    summary: certificationSummary(def.name, state),
    canRun,
    canEnableDirectly,
    canQueueCreationTest,
    needsCreationTest,
    missingRunInputs,
    missingTestInputs: verification.missing,
    resourceGaps,
    readinessGaps,
    blockingReasons,
    contractAdvisories,
    nextActions,
    dryRun,
  };
}

function certificationState(input: {
  enabled: boolean;
  hardBlocked: boolean;
  hasResourceGaps: boolean;
  needsCreationTest: boolean;
  missingTestInputs: string[];
  missingRunInputs: string[];
}): WorkflowCertificationState {
  if (input.hardBlocked) return 'blocked';
  if (input.hasResourceGaps) return 'needs_resource_binding';
  if (!input.enabled && input.needsCreationTest && input.missingTestInputs.length > 0) return 'needs_creation_inputs';
  if (!input.enabled && input.needsCreationTest) return 'needs_creation_test';
  if (!input.enabled) return 'ready_to_enable';
  if (input.missingRunInputs.length > 0) return 'needs_run_inputs';
  return 'ready_to_run';
}

function certificationActions(input: {
  state: WorkflowCertificationState;
  hasContractAdvisories: boolean;
  hasReadinessGaps?: boolean;
}): WorkflowCertificationAction[] {
  const actions: WorkflowCertificationAction[] = [];
  switch (input.state) {
    case 'blocked':
      actions.push('fix_blockers');
      break;
    case 'needs_resource_binding':
      actions.push('bind_resources');
      break;
    case 'needs_info':
      actions.push('answer_readiness_questions');
      break;
    case 'needs_creation_inputs':
      actions.push('provide_test_inputs');
      break;
    case 'needs_creation_test':
      actions.push('start_creation_test');
      break;
    case 'ready_to_enable':
      actions.push('enable_workflow');
      break;
    case 'needs_run_inputs':
      actions.push('provide_run_inputs');
      break;
    case 'ready_to_run':
      actions.push('run_workflow');
      break;
  }
  if (input.hasContractAdvisories) actions.push('review_contract_advisories');
  // Readiness questions ride ALONGSIDE the state's primary action (advisory,
  // never the only exit): the user can enable/test AND is invited to answer.
  if (input.hasReadinessGaps) actions.push('answer_readiness_questions');
  return actions;
}

function certificationLabel(state: WorkflowCertificationState): string {
  switch (state) {
    case 'blocked': return 'BLOCKED';
    case 'needs_resource_binding': return 'NEEDS RESOURCE BINDING';
    case 'needs_info': return 'NEEDS INFO';
    case 'needs_creation_inputs': return 'NEEDS CREATION INPUTS';
    case 'needs_creation_test': return 'NEEDS CREATION TEST';
    case 'ready_to_enable': return 'READY TO ENABLE';
    case 'needs_run_inputs': return 'NEEDS RUN INPUTS';
    case 'ready_to_run': return 'READY TO RUN';
  }
}

function certificationSummary(name: string, state: WorkflowCertificationState): string {
  switch (state) {
    case 'blocked':
      return `Workflow "${name}" cannot be trusted yet because a structural or authoritative runtime blocker is present.`;
    case 'needs_resource_binding':
      return `Workflow "${name}" needs a durable source/account/object binding before it can run repeatably.`;
    case 'needs_info':
      return `Workflow "${name}" needs authoring clarification before it should run autonomously.`;
    case 'needs_creation_inputs':
      return `Workflow "${name}" needs concrete non-secret test inputs before its creation test can run.`;
    case 'needs_creation_test':
      return `Workflow "${name}" is ready for a creation test against real read-only tools before going live.`;
    case 'ready_to_enable':
      return `Workflow "${name}" does not need a creation test and can be enabled.`;
    case 'needs_run_inputs':
      return `Workflow "${name}" is live, but this run still needs required inputs.`;
    case 'ready_to_run':
      return `Workflow "${name}" is live and has enough inputs to queue a run.`;
  }
}

function actionLabel(action: WorkflowCertificationAction): string {
  switch (action) {
    case 'fix_blockers': return 'Fix blockers';
    case 'bind_resources': return 'Bind resources';
    case 'answer_readiness_questions': return 'Answer readiness questions';
    case 'provide_test_inputs': return 'Provide test_inputs';
    case 'start_creation_test': return 'Start creation test';
    case 'enable_workflow': return 'Enable workflow';
    case 'provide_run_inputs': return 'Provide run inputs';
    case 'run_workflow': return 'Run workflow';
    case 'review_contract_advisories': return 'Review contract advisories';
  }
}

// Synchronous, inventory-free resource gaps for the certification verdict. The
// "bound?" predicates (surface + selector) are the SAME ones the runtime
// resource-binding report uses — imported, not re-derived, so there is one
// definition of what makes a resource bound. See [[workflow-resource-binding]].
function workflowResourceBindingGaps(def: WorkflowDefinition): string[] {
  const gaps: string[] = [];
  const resources = Object.entries(def.resources ?? {});
  for (const [fallbackId, resource] of resources) {
    if (!resource || resource.required === false) continue;
    const label = resource.label?.trim() || resource.id || fallbackId;
    if (!resourceHasSurface(resource, def)) {
      gaps.push(`${label}: choose a connector, CLI, MCP server, or URL-backed execution surface for this ${resource.kind} resource.`);
    }
    if (!resourceHasSelector(resource, def)) {
      gaps.push(`${label}: bind a concrete ${resourceSelectorName(resource.kind)}.`);
    }
  }
  return gaps;
}

function resourceSelectorName(kind: string): string {
  switch (kind) {
    case 'account':
    case 'email_account':
      return 'account or connection';
    case 'sheet':
      return 'spreadsheet, tab, or sheet URL';
    case 'document':
      return 'document id or URL';
    case 'folder':
      return 'folder id or path';
    case 'channel':
      return 'channel';
    case 'campaign':
      return 'account/campaign scope';
    case 'analytics_property':
      return 'analytics property';
    case 'database':
      return 'database';
    case 'table':
      return 'table';
    case 'repository':
      return 'repository';
    case 'calendar':
      return 'calendar';
    case 'webhook':
      return 'webhook URL or path';
    case 'api':
      return 'API base URL or named endpoint';
    case 'cli':
      return 'CLI command/profile';
    case 'project':
      return 'project name or path';
    default:
      return 'resource id, name, URL, or scope';
  }
}

export function renderWorkflowCertification(cert: WorkflowCertification): string {
  const lines: string[] = [
    `Workflow certification: ${cert.label}`,
    cert.summary,
    '',
    `Dry-run: ${cert.dryRun.summary}`,
    `Enabled: ${cert.enabled ? 'yes' : 'no'}`,
    `Can run now: ${cert.canRun ? 'yes' : 'no'}`,
    `Can enable directly: ${cert.canEnableDirectly ? 'yes' : 'no'}`,
    `Can start creation test: ${cert.canQueueCreationTest ? 'yes' : 'no'}`,
    '',
    'Next action:',
    ...cert.nextActions.map((action) => `- ${actionLabel(action)}`),
  ];

  if (cert.missingTestInputs.length > 0) {
    lines.push('', 'Missing creation-test inputs:', ...cert.missingTestInputs.map((key) => `- ${key}`));
  }
  if (cert.missingRunInputs.length > 0) {
    lines.push('', 'Missing run inputs:', ...cert.missingRunInputs.map((key) => `- ${key}`));
  }
  if (cert.resourceGaps.length > 0) {
    lines.push('', 'Resource bindings:', ...cert.resourceGaps.map((gap) => `- ${gap}`));
  }
  if (cert.blockingReasons.length > 0) {
    lines.push('', 'Blockers:', ...cert.blockingReasons.slice(0, 8).map((reason) => `- ${reason}`));
  }
  if (cert.readinessGaps.length > 0) {
    lines.push(
      '',
      'Readiness questions:',
      ...cert.readinessGaps.map((gap) => `- ${gap.stepId ? `${gap.stepId}: ` : ''}${gap.question} (${gap.why})`),
    );
  }
  if (cert.contractAdvisories.length > 0) {
    lines.push('', 'Contract advisories:', ...cert.contractAdvisories.slice(0, 6).map((advisory) => `- ${advisory}`));
  }
  return lines.join('\n');
}
