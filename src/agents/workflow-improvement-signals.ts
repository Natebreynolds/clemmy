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
import { listPendingProposals } from '../autoresearch/improvement-proposer.js';

export interface WorkflowImprovementSignal {
  workflow: string;
  /** Recent runs looked at, newest first. */
  runsSeen: number;
  /** Tools this workflow's own permissions refused, in any of those runs. */
  refusedByOwnDefinition: string[];
  /** Goal reviews that found a gap, as criteria met / total, newest first. */
  goalShortfalls: string[];
  /** The same step problem seen across runs, from the nightly improvement
   * queue (a recorded failure, never step output). Owner 10-22: that queue
   * sat in a developer-only screen; Clem now raises it herself. */
  recurringStepProblems?: string[];
}

interface RunRef { runId: string; workflow: string; status: string; createdAt?: string; targetStepId?: string | null }

interface SignalDeps {
  readEvents?: (workflow: string, runId: string) => Array<{ kind?: string; stepId?: string; meta?: Record<string, unknown> }>;
  refusals?: typeof workflowRunAuthorityRefusals;
  now?: number;
  pendingStepProposals?: () => Array<{ kind: string; target: string; evidence: string }>;
}

const RUNS_PER_WORKFLOW = 3;
const MAX_WORKFLOWS = 6;
/** Older runs say little about the workflow as it is saved now. */
const RECENT_MS = 7 * 24 * 60 * 60_000;

/** Workflows whose recent runs carry at least one such signal. */
export function workflowImprovementSignals(runs: readonly RunRef[], deps: SignalDeps = {}): WorkflowImprovementSignal[] {
  const readEvents = deps.readEvents ?? (readWorkflowEvents as NonNullable<SignalDeps['readEvents']>);
  const refusals = deps.refusals ?? workflowRunAuthorityRefusals;
  const cutoff = (deps.now ?? Date.now()) - RECENT_MS;
  // The observed window is ordered by file name, not by time (scheduled runs
  // are named trigger-…, others by timestamp), so order by when each run
  // started and keep only recent ones.
  const recentFirst = runs
    .map((run) => ({ run, at: run.createdAt ? Date.parse(run.createdAt) : Number.NaN }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.run);
  const byWorkflow = new Map<string, RunRef[]>();
  for (const run of recentFirst) {
    // A single re-run step is a repair of another run, not the workflow's own run.
    if (run.targetStepId) continue;
    const list = byWorkflow.get(run.workflow) ?? [];
    if (list.length < RUNS_PER_WORKFLOW) list.push(run);
    byWorkflow.set(run.workflow, list);
  }
  const problemsByWorkflow = new Map<string, string[]>();
  try {
    for (const proposal of (deps.pendingStepProposals ?? listPendingProposals)()) {
      if (proposal.kind !== 'workflow_step') continue;
      const workflow = proposal.target.split('::')[0]?.trim() ?? '';
      const evidence = proposal.evidence.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!workflow || !evidence) continue;
      const list = problemsByWorkflow.get(workflow) ?? [];
      if (list.length < 3 && !list.includes(evidence)) list.push(evidence);
      problemsByWorkflow.set(workflow, list);
    }
  } catch { /* the queue is unavailable; the run facts still count */ }
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
    const recurringStepProblems = problemsByWorkflow.get(workflow) ?? [];
    if (refused.size === 0 && goalShortfalls.length === 0 && recurringStepProblems.length === 0) continue;
    out.push({ workflow, runsSeen: recent.length, refusedByOwnDefinition: [...refused].sort(), goalShortfalls,
      ...(recurringStepProblems.length > 0 ? { recurringStepProblems } : {}) });
    if (out.length >= MAX_WORKFLOWS) break;
  }
  return out;
}
