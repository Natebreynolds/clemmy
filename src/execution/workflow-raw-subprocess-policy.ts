/**
 * Raw workflow subprocesses are not an execution authority. A relative path,
 * source digest, scrubbed environment, timeout, and output contract constrain
 * launch mechanics; they do not represent the filesystem, network, CLI, or
 * child-process effects the program may perform.
 *
 * Production workflows must express external work as exact `call` steps that
 * enter the shared capability kernel, or use a reviewed in-process host
 * primitive. Legacy declarations remain readable for non-destructive
 * migration, but must fail before any body crossing.
 */

export const WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE =
  'workflow_raw_subprocess_authority_unrepresented' as const;

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
  return `${WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE}: `
    + `Step "${declaration.stepId}" declares ${declaration.kind} "${declaration.runner}", `
    + 'but raw workflow subprocess execution has no shared exact authority. '
    + 'Migrate external work to an exact call step and pure computation to a reviewed in-process host primitive.';
}
