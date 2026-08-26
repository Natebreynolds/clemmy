/**
 * Production workflow subprocesses are retired until their execution can be
 * represented by the same exact accepted-source and logical/physical ownership
 * kernel as every other body crossing. Script existence and a sandbox-shaped
 * child environment are not execution authority.
 */

export type WorkflowRawSubprocessKind =
  | 'deterministic.runner'
  | 'loopUntil.probe.runner';

export interface WorkflowRawSubprocessDeclaration {
  kind: WorkflowRawSubprocessKind;
  runner: string;
  stepId: string;
}

interface WorkflowRawSubprocessStepShape {
  id?: unknown;
  deterministic?: { runner?: unknown } | null;
  loopUntil?: { probe?: { runner?: unknown } | null } | null;
  loop_until?: { probe?: { runner?: unknown } | null } | null;
}

export function workflowRawSubprocessDeclarations(
  step: WorkflowRawSubprocessStepShape,
): WorkflowRawSubprocessDeclaration[] {
  const declarations: WorkflowRawSubprocessDeclaration[] = [];
  const stepId = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : '?';
  const deterministicRunner = typeof step.deterministic?.runner === 'string'
    ? step.deterministic.runner.trim()
    : '';
  if (deterministicRunner) {
    declarations.push({
      kind: 'deterministic.runner',
      runner: deterministicRunner,
      stepId,
    });
  }
  const loop = step.loopUntil ?? step.loop_until;
  const probeRunner = typeof loop?.probe?.runner === 'string'
    ? loop.probe.runner.trim()
    : '';
  if (probeRunner) {
    declarations.push({
      kind: 'loopUntil.probe.runner',
      runner: probeRunner,
      stepId,
    });
  }
  return declarations;
}

export function workflowRawSubprocessRetirementReason(
  declaration: WorkflowRawSubprocessDeclaration,
): string {
  return 'workflow_raw_subprocess_authority_unrepresented: '
    + `Step "${declaration.stepId}" declares ${declaration.kind} "${declaration.runner}", `
    + 'but raw workflow subprocess execution is retired until this executor compiles to shared exact authority.';
}
