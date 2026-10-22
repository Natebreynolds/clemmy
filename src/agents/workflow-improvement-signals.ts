/**
 * What a workflow's recent runs say about the workflow itself, for Clem to
 * notice and offer to fix.
 *
 * A run that completes can still waste the owner's time and tokens in ways
 * only a change to the workflow fixes: a call its own permissions refuse on
 * every run, or a goal review that keeps finding the same gap. Owner
 * 10-21: Clem should always be offering to improve workflows. These facts
 * reach the noticing model, which decides whether one is worth proposing and
 * says it in her own words; nothing here decides or phrases an offer.
 *
 * Content-free: tool names, step ids and criteria counts from the run's own
 * records. No step output, argument or result text is read.
 */
import { readWorkflowEvents } from '../execution/workflow-events.js';
import { workflowRunAuthorityRefusals } from '../execution/workflow-run-authority-refusals.js';

export interface WorkflowImprovementSignal {
  workflow: string;
  /** Recent runs looked at, newest first. */
  runsSeen: number;
  /** Tools this workflow's own permissions refused, in any of those runs. */
  refusedByOwnDefinition: string[];
  /** Goal reviews that found a gap, as criteria met / total, newest first. */
  goalShortfalls: string[];
}

interface RunRef { runId: string; workflow: string; status: string; targetStepId?: string | null }

interface SignalDeps {
  readEvents?: (workflow: string, runId: string) => Array<{ kind?: string; stepId?: string; meta?: Record<string, unknown> }>;
  refusals?: typeof workflowRunAuthorityRefusals;
}

const RUNS_PER_WORKFLOW = 3;
const MAX_WORKFLOWS = 6;

/** Workflows whose recent runs carry at least one such signal. */
export function workflowImprovementSignals(runs: readonly RunRef[], deps: SignalDeps = {}): WorkflowImprovementSignal[] {
  const readEvents = deps.readEvents ?? (readWorkflowEvents as NonNullable<SignalDeps['readEvents']>);
  const refusals = deps.refusals ?? workflowRunAuthorityRefusals;
  const byWorkflow = new Map<string, RunRef[]>();
  for (const run of runs) {
    // A single re-run step is a repair of another run, not the workflow's own run.
    if (run.targetStepId) continue;
    const list = byWorkflow.get(run.workflow) ?? [];
    if (list.length < RUNS_PER_WORKFLOW) list.push(run);
    byWorkflow.set(run.workflow, list);
  }
  const out: WorkflowImprovementSignal[] = [];
  for (const [workflow, recent] of byWorkflow) {
    const refused = new Set<string>();
    const goalShortfalls: string[] = [];
    for (const run of recent) {
      let events: ReturnType<NonNullable<SignalDeps['readEvents']>>;
      try { events = readEvents(workflow, run.runId); } catch { continue; }
      const stepIds = [...new Set(events.map((event) => event.stepId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !id.startsWith('(')))];
      try {
        for (const refusal of refusals(run.runId, stepIds)) refused.add(refusal.tool);
      } catch { /* the event log is unavailable; the goal facts still count */ }
      for (const event of events) {
        if (event.kind !== 'verdict_recorded' || event.meta?.door !== 'goal_validation' || event.meta.pass !== false) continue;
        const met = event.meta.criteriaMet;
        const total = event.meta.criteriaTotal;
        if (typeof met === 'number' && typeof total === 'number') goalShortfalls.push(`${met}/${total}`);
      }
    }
    if (refused.size === 0 && goalShortfalls.length === 0) continue;
    out.push({ workflow, runsSeen: recent.length, refusedByOwnDefinition: [...refused].sort(), goalShortfalls });
    if (out.length >= MAX_WORKFLOWS) break;
  }
  return out;
}
