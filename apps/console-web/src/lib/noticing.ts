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
