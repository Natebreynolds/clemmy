/** Presentation only: a pending verification is not authority to execute a workflow. */
export function matchingPendingWorkflowVerification(
  record: unknown,
  expected: { runId: string; workflowName: string; definitionHash: string },
): boolean {
  if (!record || typeof record !== 'object') return false;
  const run = record as Record<string, unknown>;
  const snapshot = run.workflowDefinitionSnapshot as Record<string, unknown> | undefined;
  return run.id === expected.runId
    && run.workflow === expected.workflowName
    && run.status === 'creation_test'
    && !run.finishedAt && !run.terminalOutcome
    && snapshot?.definitionHash === expected.definitionHash;
}

export function disabledWorkflowRunMessage(name: string, verificationRunId?: string): string {
  return verificationRunId
    ? `Workflow "${name}" is awaiting verification (run ${verificationRunId}); the requested execution has NOT been queued. `
      + `This verification checks read-only steps and previews mutations; it is not the requested workflow execution. `
      + `Preserve the user's request to run this saved workflow. Do not recreate it, repeatedly enable it, or substitute ad-hoc work. `
      + `After verification passes and the workflow is enabled, the authorized workflow_run can be submitted. Report the pending state accurately; do not claim the requested work is done.`
    : `Workflow "${name}" is disabled; no execution was queued. `
      + `Preserve the user's request to use this saved workflow. If enabling it is already authorized, use workflow_set_enabled and follow its verification result; otherwise ask whether to enable it. `
      + `Do not substitute ad-hoc work or claim completion.`;
}

export function workflowVerificationDependencyState(input: {
  verification: unknown;
  runId: string;
  workflowName: string;
  definitionHash: string;
  currentDefinitionMatches: boolean;
  enabled: boolean;
}): 'pending' | 'ready' | 'blocked' {
  const record = input.verification as Record<string, unknown> | null;
  const snapshot = record?.workflowDefinitionSnapshot as Record<string, unknown> | undefined;
  if (!input.currentDefinitionMatches || !record || record.id !== input.runId
    || record.workflow !== input.workflowName || record.status !== 'creation_test'
    || snapshot?.definitionHash !== input.definitionHash) return 'blocked';
  if (!record.finishedAt && !record.terminalOutcome) return 'pending';
  return record.finishedAt && record.terminalOutcome === 'succeeded' && input.enabled ? 'ready' : 'blocked';
}
