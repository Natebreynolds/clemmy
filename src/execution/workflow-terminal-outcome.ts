/**
 * Canonical WORK OUTCOME for a workflow occurrence.
 *
 * `status` remains the runner/lifecycle state for backwards compatibility
 * (`completed` means the process reached a terminal checkpoint). It is not
 * sufficient evidence that the user's objective succeeded: a run can finish
 * mechanically with a blocked external write, failed fan-out items, or an
 * unmet pinned goal.
 *
 * Every new terminal record persists `terminalOutcome`; legacy records are
 * projected through `deriveWorkflowTerminalOutcome` so every reader gets the
 * same truthful interpretation without rewriting user state during a read.
 */

export const WORKFLOW_TERMINAL_OUTCOMES = [
  'succeeded',
  'partial',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type WorkflowTerminalOutcome = (typeof WORKFLOW_TERMINAL_OUTCOMES)[number];
export type WorkflowReportOutcome = 'done' | 'blocked' | 'failed';

export interface WorkflowTerminalOutcomeInput {
  status?: unknown;
  finishedAt?: unknown;
  needsAttention?: unknown;
  terminalOutcome?: unknown;
  reportBack?: {
    outcome?: unknown;
  } | null;
}

const OUTCOME_SET = new Set<string>(WORKFLOW_TERMINAL_OUTCOMES);

export function isWorkflowTerminalOutcome(value: unknown): value is WorkflowTerminalOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

function reportOutcomeFrom(
  input: WorkflowTerminalOutcomeInput,
  explicit?: WorkflowReportOutcome,
): WorkflowReportOutcome | undefined {
  if (explicit) return explicit;
  const value = input.reportBack?.outcome;
  return value === 'done' || value === 'blocked' || value === 'failed' ? value : undefined;
}

/**
 * Derive user-facing truth from durable evidence, strongest signal first.
 *
 * `completed_with_errors` is a PARTIAL result even when an old report envelope
 * called it done. A recoverable blocked report on an `error` lifecycle record
 * remains BLOCKED rather than being flattened into FAILED.
 */
export function deriveWorkflowTerminalOutcome(
  input: WorkflowTerminalOutcomeInput,
  reportOutcome?: WorkflowReportOutcome,
): WorkflowTerminalOutcome | undefined {
  // A persisted canonical outcome is durable truth. The remaining branches
  // are only a compatibility projection for records written before this field
  // existed (or for a terminal writer that deliberately removed stale state
  // before deriving a fresh value).
  if (isWorkflowTerminalOutcome(input.terminalOutcome)) {
    return input.terminalOutcome;
  }
  const status = typeof input.status === 'string' ? input.status : '';
  const report = reportOutcomeFrom(input, reportOutcome);

  if (status === 'cancelled') return 'cancelled';
  if (report === 'failed') return 'failed';
  if (status === 'completed_with_errors') return 'partial';
  if (report === 'blocked') return 'blocked';
  // A legacy/corrupt done envelope must not erase stronger failure evidence.
  // New writers persist a canonical outcome, but compatibility projection is
  // deliberately fail-closed for old records with contradictory fields.
  if (status === 'error' || status === 'failed') return 'failed';
  if (input.needsAttention === true) return 'blocked';
  if (report === 'done') return 'succeeded';
  if (status === 'completed') return 'succeeded';
  if (
    (status === 'dry_run' || status === 'creation_test')
    && typeof input.finishedAt === 'string'
  ) {
    return input.needsAttention === true ? 'blocked' : 'succeeded';
  }
  return undefined;
}

export function workflowTerminalOutcomeReportLane(
  outcome: WorkflowTerminalOutcome,
): WorkflowReportOutcome {
  switch (outcome) {
    case 'succeeded':
      return 'done';
    case 'partial':
    case 'blocked':
      return 'blocked';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

/**
 * Compatibility validation for durable report envelopes. Historical
 * `completed_with_errors` records sometimes used the done lane; the canonical
 * outcome still projects PARTIAL, while new writers use blocked.
 */
export function workflowTerminalOutcomeMatchesReport(
  outcome: WorkflowTerminalOutcome,
  report: WorkflowReportOutcome,
): boolean {
  if (outcome === 'partial') return report === 'blocked' || report === 'done';
  return workflowTerminalOutcomeReportLane(outcome) === report;
}

export function workflowTerminalOutcomeNeedsAttention(
  outcome: WorkflowTerminalOutcome | undefined,
): boolean {
  return outcome === 'partial' || outcome === 'blocked' || outcome === 'failed';
}

export function workflowTerminalOutcomeLabel(
  outcome: WorkflowTerminalOutcome,
): string {
  switch (outcome) {
    case 'succeeded': return 'Succeeded';
    case 'partial': return 'Partial';
    case 'blocked': return 'Blocked';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}
