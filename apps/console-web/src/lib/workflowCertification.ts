import type { Tone } from '@/components/ui/StatusPill';
import type {
  WorkflowCertification,
  WorkflowCertificationAction,
  WorkflowCertificationState,
} from './automate';

export interface WorkflowCertificationCounts {
  waves: number;
  parallelWaves: number;
  tools: number;
  sends: number;
  writes: number;
  reads: number;
  approvals: number;
  blockers: number;
  readinessGaps: number;
  advisories: number;
  missingInputs: number;
  resourceGaps: number;
}

export function certificationTone(state?: WorkflowCertificationState): Tone {
  if (state === 'ready_to_run' || state === 'ready_to_enable') return 'success';
  if (state === 'needs_creation_test' || state === 'needs_run_inputs') return 'warning';
  if (state === 'needs_creation_inputs' || state === 'needs_info' || state === 'needs_resource_binding') return 'info';
  if (state === 'blocked') return 'danger';
  return 'neutral';
}

export function certificationActionLabel(action: WorkflowCertificationAction): string {
  switch (action) {
    case 'fix_blockers': return 'Fix blockers';
    case 'bind_resources': return 'Bind resources';
    case 'answer_readiness_questions': return 'Answer readiness questions';
    case 'provide_test_inputs': return 'Provide test inputs';
    case 'start_creation_test': return 'Start creation test';
    case 'enable_workflow': return 'Enable workflow';
    case 'provide_run_inputs': return 'Provide run inputs';
    case 'run_workflow': return 'Run workflow';
    case 'review_contract_advisories': return 'Review contract advisories';
  }
}

export function workflowCertificationCounts(cert?: WorkflowCertification | null): WorkflowCertificationCounts {
  const dryRun = cert?.dryRun;
  const effects = dryRun?.effects;
  const effectCounts = dryRun?.effectCounts;
  return {
    waves: dryRun?.waves?.length ?? dryRun?.waveCount ?? 0,
    parallelWaves: dryRun?.waves?.filter((wave) => wave.parallel).length ?? dryRun?.parallelWaveCount ?? 0,
    tools: effects?.toolsTouched?.length ?? dryRun?.toolsTouched?.length ?? 0,
    sends: effects?.sends?.length ?? effectCounts?.sends ?? 0,
    writes: effects?.writes?.length ?? effectCounts?.writes ?? 0,
    reads: effects?.readSteps ?? effectCounts?.readSteps ?? 0,
    approvals: effects?.approvals?.length ?? effectCounts?.approvals ?? 0,
    blockers: cert?.blockingReasons?.length ?? cert?.blockerCount ?? 0,
    readinessGaps: cert?.readinessGaps?.length ?? cert?.readinessGapCount ?? 0,
    advisories: cert?.contractAdvisories?.length ?? cert?.contractAdvisoryCount ?? 0,
    missingInputs: (cert?.missingRunInputs?.length ?? 0) + (cert?.missingTestInputs?.length ?? 0),
    resourceGaps: cert?.resourceGaps?.length ?? cert?.resourceGapCount ?? 0,
  };
}

export type CertPrimaryActionKind = 'run' | 'enable' | 'guide';

export interface CertPrimaryAction {
  action: WorkflowCertificationAction;
  /** Full button label, e.g. "Enable workflow" / "Run workflow". */
  label: string;
  /** run/enable are one-click; guide needs the operator to fill something in. */
  kind: CertPrimaryActionKind;
  tone: Tone;
}

/**
 * The single, context-aware next step for a workflow — the whole point of
 * certification. `run`/`enable` are directly actionable (one click);
 * `guide` states (bind resources, answer readiness, provide inputs, fix
 * blockers) need the operator to fill something in, so the button scrolls them
 * to the details instead of firing a no-op. `start_creation_test` maps to
 * enable because the enable route queues the creation test when one is needed.
 */
export function certPrimaryAction(cert?: WorkflowCertification | null): CertPrimaryAction | null {
  const action = cert?.nextActions?.[0];
  if (!action) return null;
  const kind: CertPrimaryActionKind =
    action === 'run_workflow' ? 'run'
    : (action === 'enable_workflow' || action === 'start_creation_test') ? 'enable'
    : 'guide';
  return { action, label: certificationActionLabel(action), kind, tone: certificationTone(cert?.state) };
}

export function workflowPrimaryAction(cert?: WorkflowCertification | null): string {
  switch (cert?.state) {
    case 'blocked': return 'Fix';
    case 'needs_resource_binding': return 'Bind';
    case 'needs_info': return 'Clarify';
    case 'needs_creation_inputs': return 'Inputs';
    case 'needs_creation_test': return 'Test';
    case 'ready_to_enable': return 'Enable';
    case 'needs_run_inputs': return 'Inputs';
    case 'ready_to_run': return 'Run';
    default: return 'Open';
  }
}
