/**
 * The calls a workflow run's own definition refused, which a run of the same
 * definition will be refused again.
 *
 * A step's write authority is fixed by its saved definition. A call refused
 * because that authority does not cover it (coverage_missing) or reaches
 * beyond it (scope_mismatch) is refused the same way on every run until the
 * workflow itself changes. Live 10-21 (a scheduled channel review, two
 * runs): the step's board refresh was refused as coverage_missing, the goal
 * review scored the run 67% for it, and the goal follow-up re-ran the whole
 * workflow, about eight minutes and ~30k reviewer output tokens, into the
 * same refusal.
 *
 * Read from each step's per-call settlements: the refusal code the consent
 * check wrote, by tool, and whether the same tool later succeeded in that
 * step. Content-free; no argument or result text is read.
 */
import { listEvents } from '../runtime/harness/eventlog.js';

/** Consent reasons fixed by the workflow definition, not by the arguments. */
const DEFINITION_BOUND_REASONS = ['coverage_missing', 'scope_mismatch'] as const;

export interface WorkflowRunAuthorityRefusal {
  stepId: string;
  tool: string;
  reason: (typeof DEFINITION_BOUND_REASONS)[number];
}

type EventReader = (sessionId: string, opts: { types: string[] }) => Array<{ data: Record<string, unknown> }>;

function definitionBoundReason(detail: unknown): WorkflowRunAuthorityRefusal['reason'] | null {
  if (typeof detail !== 'string') return null;
  for (const reason of DEFINITION_BOUND_REASONS) {
    if (detail === `work_binding:consent_repair_${reason}`) return reason;
  }
  return null;
}

/** Tools each step's definition refused and that never succeeded later in
 *  the same step, one row per step and tool. */
export function workflowRunAuthorityRefusals(
  runId: string,
  stepIds: readonly string[],
  read: EventReader = listEvents as unknown as EventReader,
): WorkflowRunAuthorityRefusal[] {
  const out: WorkflowRunAuthorityRefusal[] = [];
  for (const stepId of stepIds) {
    let settled: Array<{ data: Record<string, unknown> }>;
    try {
      settled = read(`workflow:${runId}:${stepId}`, { types: ['tool_attempt_settled'] });
    } catch {
      continue;
    }
    const refused = new Map<string, WorkflowRunAuthorityRefusal['reason']>();
    const succeeded = new Set<string>();
    for (const event of settled) {
      const tool = typeof event.data.tool === 'string' ? event.data.tool.trim() : '';
      if (!tool) continue;
      if (event.data.kind === 'succeeded') {
        succeeded.add(tool);
        continue;
      }
      if (event.data.kind !== 'policy_denial') continue;
      const reason = definitionBoundReason(event.data.detail);
      if (reason && !refused.has(tool)) refused.set(tool, reason);
    }
    for (const [tool, reason] of refused) {
      if (!succeeded.has(tool)) out.push({ stepId, tool, reason });
    }
  }
  return out;
}
