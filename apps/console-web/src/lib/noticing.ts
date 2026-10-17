/** Noticing: what Clementine read, weighed, proposed and set aside, and the owner's goals it proposes against. */
import { api, apiGet, apiPost } from './api';

export interface NoticingProposal {
  id: string;
  title: string;
  action: string;
  why: string;
  evidence: string[];
  goalId: string | null;
  confidence: number;
  createdAt: string;
  status: 'open' | 'answered' | 'expired' | 'retired';
  answer?: { text: string; decision: 'do_it' | 'not_now' | 'never' | 'unclear'; at: string; instruction?: string };
  retiredReason?: string;
}
export interface NoticingThinking {
  tickId: string;
  at: string;
  source: string;
  durationMs: number;
  read: { goals: number; runs: number; waits: number; drafts: number; calendar: number; conversations: number; memories: number };
  considered: Array<{ subject: string; outcome: 'proposed' | 'set_aside' | 'duplicate' | 'standing_no' | 'capped' | 'low_confidence'; why: string }>;
  proposalId?: string;
  model?: string;
  quiet: boolean;
  summary: string;
  error?: string;
}
export interface NoticingStatus {
  enabled: boolean;
  cadenceMinutes: number;
  dailyCap: number;
  quietHoursActive: boolean;
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  metrics: { ticks: number; quietTicks: number; modelCalls: number; modelFailures: number; itemsProduced: number; itemsAcknowledged: number; itemsRetired: number; doIt: number; notNow: number; never: number };
  openItems: NoticingProposal[];
  recentlyRetired: NoticingProposal[];
  thinking: NoticingThinking[];
  standingAnswers: Array<{ text: string; about: string; at: string }>;
}

export const getNoticing = () => apiGet<{ noticing: NoticingStatus }>('/api/console/noticing');
export const patchNoticing = (patch: { enabled?: boolean; cadenceMinutes?: number; dailyCap?: number }) =>
  api<{ noticing: NoticingStatus }>('/api/console/noticing', { method: 'PATCH', body: JSON.stringify(patch) });

/** Informational evidence from existing exact task/run records. These rows
 * do not complete the owner's goal or grant execution authority. */
export interface GoalWorkflowOutcome {
  runId: string;
  workflowName: string;
  state: 'in_progress' | 'satisfied' | 'not_satisfied' | 'unavailable';
  contractId?: string;
  criteria: { total: number; passed: number; remaining: string[] };
  artifactReadback: 'verified' | 'superseded' | 'changed_or_unavailable' | 'not_checked';
  detail: string;
}
export interface GoalOutcomeTask {
  proposalId: string;
  title: string;
  sessionId?: string;
  sourceUserSeq?: number;
  goalBinding: 'current' | 'historical' | 'pending' | 'unavailable';
  state: 'pending' | 'partial' | 'in_progress' | 'needs_attention' | 'outcome_retained' | 'unavailable';
  detail: string;
  workflows: GoalWorkflowOutcome[];
  omittedWorkflows?: number;
}
export interface GoalOutcomeProgress {
  version: 1;
  availability: 'available' | 'unavailable';
  summary: string;
  linkedTasks: GoalOutcomeTask[];
  omittedTasks: number;
}
export function goalOutcomeTaskWords(task: Pick<GoalOutcomeTask, 'goalBinding' | 'state'>): string {
  switch (task.state) {
    case 'pending': return 'Waiting to start';
    case 'partial': return 'More work in the chat';
    case 'in_progress': return 'Work in progress';
    case 'needs_attention': return 'Needs attention';
    case 'outcome_retained': return task.goalBinding === 'historical' ? 'For an earlier version of this goal'
      : task.goalBinding === 'unavailable' ? 'Couldn’t confirm the goal link' : 'Result recorded';
    default: return 'Couldn’t check this result';
  }
}
export function goalWorkflowOutcomeWords(state: GoalWorkflowOutcome['state']): string {
  switch (state) {
    case 'satisfied': return 'Requirements met';
    case 'not_satisfied': return 'Needs attention';
    case 'in_progress': return 'In progress';
    default: return 'Couldn’t check this run';
  }
}
export function goalArtifactReadbackWords(state: GoalWorkflowOutcome['artifactReadback']): string {
  switch (state) {
    case 'verified': return 'Saved output matches this run’s result.';
    case 'superseded': return 'Another saved result has replaced this one. This run’s result is still verified.';
    case 'changed_or_unavailable': return 'Saved output has changed or couldn’t be checked.';
    default: return 'The current saved output hasn’t been checked.';
  }
}
export function goalWorkflowHref(workflow: Pick<GoalWorkflowOutcome, 'workflowName' | 'runId'>): string | null {
  return workflow.workflowName.trim() && workflow.runId
    ? `/automate?workflow=${encodeURIComponent(workflow.workflowName)}&run=${encodeURIComponent(workflow.runId)}` : null;
}

export interface MyGoal {
  id: string;
  title: string;
  description: string;
  owner: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'paused' | 'completed' | 'blocked';
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  reviewFrequency: 'daily' | 'weekly' | 'on-demand';
  outcomeProgress?: GoalOutcomeProgress;
  progressNotes: string[];
  nextActions: string[];
  blockers: string[];
  proposals: Array<Pick<NoticingProposal, 'id' | 'title' | 'action' | 'why' | 'status' | 'createdAt'> & { answer: NoticingProposal['answer'] | null }>;
}
export interface MyGoalPatch {
  id?: string;
  title?: string;
  description?: string;
  priority?: MyGoal['priority'];
  status?: MyGoal['status'];
  targetDate?: string;
  progressNote?: string;
  nextActions?: string[];
  blockers?: string[];
  reviewFrequency?: MyGoal['reviewFrequency'];
}
export const listMyGoals = () => apiGet<{ goals: MyGoal[]; unassignedProposals: Array<{ id: string; title: string; why: string; createdAt: string }> }>('/api/console/my-goals');
export const upsertMyGoal = (patch: MyGoalPatch) => apiPost<{ goal: MyGoal; created: boolean }>('/api/console/my-goals', patch);

export const OUTCOME_WORDS: Record<NoticingThinking['considered'][number]['outcome'], string> = {
  proposed: 'Proposed',
  set_aside: 'Set aside',
  duplicate: 'Already asked',
  standing_no: 'You said never',
  capped: 'Cap reached',
  low_confidence: 'Not sure enough',
};
export const DECISION_WORDS: Record<NonNullable<NoticingProposal['answer']>['decision'], string> = {
  do_it: 'You said do it',
  not_now: 'You said not now',
  never: 'You said never',
  unclear: 'Answered',
};

function daysAgoWords(iso?: string): string {
  if (!iso) return '';
  const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(d)) return '';
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

/** A goal's progress, read from what the record carries: notes written,
 * actions still open, blockers standing. Not a percentage no one measured. */
export function progressWords(goal: Pick<MyGoal, 'progressNotes' | 'nextActions' | 'blockers' | 'updatedAt' | 'status'>): string {
  if (goal.status === 'completed') return 'Done';
  const parts: string[] = [];
  if (goal.progressNotes.length) parts.push(`${goal.progressNotes.length} note${goal.progressNotes.length === 1 ? '' : 's'}`);
  if (goal.nextActions.length) parts.push(`${goal.nextActions.length} next action${goal.nextActions.length === 1 ? '' : 's'}`);
  if (goal.blockers.length) parts.push(`${goal.blockers.length} blocker${goal.blockers.length === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' · ')} · moved ${daysAgoWords(goal.updatedAt)}` : `No progress recorded yet · moved ${daysAgoWords(goal.updatedAt)}`;
}
