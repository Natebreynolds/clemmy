import type { QuestionPresentationItem } from './inbox';
import { unifiedChatSessionId } from './last-session';
import type { SessionProjectLabel } from './project-labels';
import { attentionItemContext, type AttentionPresentationItem } from './attention-presentation';

export type SetAsideView = 'all' | 'later' | 'dismissed';
export type SetAsideItem = { target: 'question'; key: string; row: QuestionPresentationItem }
  | { target: 'attention'; key: string; row: AttentionPresentationItem };

export function mergeSetAsideItems(questions: readonly QuestionPresentationItem[], attention: readonly AttentionPresentationItem[]): SetAsideItem[] {
  return [
    ...questions.map((row): SetAsideItem => ({ target: 'question', key: `question:${row.id}`, row })),
    ...attention.map((row): SetAsideItem => ({ target: 'attention', key: `attention:${row.key}`, row })),
  ].sort((a, b) => setAsideItemDate(b).localeCompare(setAsideItemDate(a)) || a.key.localeCompare(b.key));
}
export const setAsideItemTitle = (item: SetAsideItem) => item.target === 'question' ? item.row.question : item.row.title;
export function setAsideItemDate(item: SetAsideItem): string {
  const date = item.target === 'question' ? item.row.askedAt : item.row.createdAt;
  return date && Number.isFinite(Date.parse(date)) ? date : '';
}
export const setAsideItemDetail = (item: SetAsideItem) => item.target === 'question' ? item.row.context : item.row.detail;
export const setAsideItemContext = (item: SetAsideItem) => item.target === 'question' ? setAsideQuestionContext(item.row) : attentionItemContext(item.row);
export const setAsideItemSource = (item: SetAsideItem) => item.target === 'question'
  ? item.row.agentLabel || 'Clem’s question'
  : item.row.kind === 'workflow' ? 'Workflow' : item.row.kind === 'conversation' ? 'Conversation'
    : item.row.kind === 'calendar' ? 'Calendar' : 'From Clem';

export function matchesSetAsideItem(item: SetAsideItem, filter: { view: SetAsideView; search: string; projectId: string }, project?: SessionProjectLabel): boolean {
  if (item.target === 'question') return matchesSetAsideQuestion(item.row, filter, project);
  if (filter.view === 'later' && item.row.action !== 'defer' || filter.view === 'dismissed' && item.row.action !== 'dismiss') return false;
  if (filter.projectId && project?.projectId !== filter.projectId) return false;
  const haystack = [item.row.title, item.row.detail, setAsideItemSource(item), item.row.workflow, project?.projectName, project?.agentName]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return filter.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}
export function setAsideView(value: string | null): SetAsideView {
  return value === 'later' || value === 'dismissed' ? value : 'all';
}

export function matchesSetAsideQuestion(row: QuestionPresentationItem, filter: { view: SetAsideView; search: string; projectId: string }, project?: SessionProjectLabel): boolean {
  if (filter.view === 'later' && row.action !== 'defer') return false;
  if (filter.view === 'dismissed' && row.action !== 'dismiss') return false;
  if (filter.projectId && project?.projectId !== filter.projectId) return false;
  const haystack = [row.question, row.context, row.agentLabel, row.workflowName, project?.projectName, project?.agentName].filter(Boolean).join(' ').toLocaleLowerCase();
  return filter.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** These links only open existing context; restoring never follows them. */
export function setAsideQuestionContext(row: QuestionPresentationItem): { href: string; label: string } {
  if (row.source === 'workflow' && row.workflowName && row.runId) {
    const params = new URLSearchParams({ workflow: row.workflowName, run: row.runId });
    return { href: `/automate?${params}`, label: 'Open workflow run' };
  }
  if (row.sessionId) return { href: `/chat/${encodeURIComponent(unifiedChatSessionId(row.sessionId))}`, label: 'Open conversation' };
  return { href: '/tasks', label: 'View saved work' };
}

export function setAsideReturnLabel(row: Pick<QuestionPresentationItem, 'action' | 'until'>): string {
  if (row.action === 'dismiss') return 'Dismissed';
  const until = row.until ? new Date(row.until) : null;
  return until && Number.isFinite(until.getTime())
    ? `Back ${until.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : 'Set aside for later';
}
