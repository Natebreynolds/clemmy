import { apiGet, apiPost } from './api';

// Tidy: the one door for clearing clutter. Plan first (exact counts; nothing
// changes), then apply the classes the person chose. The phone reads the same
// daemon module.
export type TidyClass = 'updates' | 'staleAsks' | 'stuckRuns' | 'oldConversations';
export interface TidyCounts { updates: number; staleAsks: number; stuckRuns: number; oldConversations: number }
export interface TidyResult {
  appliedAt: string;
  updatesCleared: number;
  updatesHeld: number;
  asksCancelled: number;
  runsStopped: number;
  conversationsArchived: number;
  errors: string[];
}
/** 'stale' clears what sat past the age policy; 'all' clears every item in
 *  the class regardless of age — the person's "clear all". */
export type TidyScope = 'stale' | 'all';
export const getTidyPlan = (scope: TidyScope = 'stale') =>
  apiGet<{ counts: TidyCounts; scope: TidyScope }>(`/api/console/tidy/plan?scope=${scope}`);
export const applyTidy = (classes: TidyClass[], scope: TidyScope = 'stale') =>
  apiPost<{ result: TidyResult; planned: TidyCounts; scope: TidyScope }>('/api/console/tidy/apply', { classes, scope });

export const TIDY_ROWS: Array<{ id: TidyClass; label: string; note: string; verb: (n: number) => string }> = [
  { id: 'updates', label: 'Updates', note: 'Unread updates from finished work. Open questions are never touched.', verb: (n) => `${n} marked read` },
  { id: 'staleAsks', label: 'Asks', note: 'Approval cards, plan and trust proposals, and check-in questions. Stale = unanswered for a day.', verb: (n) => `${n} cancelled` },
  { id: 'stuckRuns', label: 'Stuck runs', note: 'Workflow runs blocked or parked, and chat turns no runner holds. Stale = over a day.', verb: (n) => `${n} stopped` },
  { id: 'oldConversations', label: 'Conversations', note: 'Stale = nobody has spoken in them for two weeks; all = every unpinned conversation. Archived, not deleted — still openable from the archive.', verb: (n) => `${n} archived` },
];

export function describeTidy(result: TidyResult): string {
  const parts = [
    result.updatesCleared > 0 ? TIDY_ROWS[0].verb(result.updatesCleared) : '',
    result.asksCancelled > 0 ? TIDY_ROWS[1].verb(result.asksCancelled) : '',
    result.runsStopped > 0 ? TIDY_ROWS[2].verb(result.runsStopped) : '',
    result.conversationsArchived > 0 ? TIDY_ROWS[3].verb(result.conversationsArchived) : '',
  ].filter(Boolean);
  const held = result.updatesHeld > 0 ? ` ${result.updatesHeld} update${result.updatesHeld === 1 ? '' : 's'} still need an answer and were kept.` : '';
  const errors = result.errors.length > 0 ? ` ${result.errors.length} item${result.errors.length === 1 ? '' : 's'} could not be cleared.` : '';
  return (parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Nothing needed clearing.') + held + errors;
}

/** Every live list a tidy can change; invalidated together after apply. */
export const TIDY_INVALIDATIONS = [
  'notifications', 'inbox', 'approvals', 'approvals-count', 'working-now-badge', 'command-center',
  'sessions', 'conversations', 'runs', 'tidy-plan',
];
