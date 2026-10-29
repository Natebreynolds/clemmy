import type { QuestionPresentationItem } from './api';

export type InboxView = 'needs' | 'updates' | 'set-aside';
export type SetAsideView = 'all' | 'later' | 'dismissed';

export function inboxViewFromSearch(search: string): InboxView {
  const params = new URLSearchParams(search);
  if (params.get('tab') !== 'inbox' || params.has('item')) return 'needs';
  const view = params.get('inbox');
  return view === 'updates' || view === 'set-aside' ? view : 'needs';
}

/** Addressed delivery must still belong to the current URL before it can focus a view. */
export function inboxNotificationIsCurrent(search: string, notificationId: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('tab') === 'inbox' && params.get('notification') === notificationId;
}

interface InboxNavigationHost {
  location: Pick<Location, 'search' | 'pathname'>;
  history: Pick<History, 'state' | 'pushState'>;
  dispatchEvent: (event: Event) => boolean;
}
/** Notify the shell as well as the local view: the previous addressed row ends here. */
export function navigateInboxView(next: InboxView, host: InboxNavigationHost = window): void {
  const params = new URLSearchParams(host.location.search);
  params.set('tab', 'inbox');
  for (const key of ['item', 'notification', 'view']) params.delete(key);
  if (next === 'needs') params.delete('inbox'); else params.set('inbox', next);
  host.history.pushState(host.history.state, '', `${host.location.pathname}?${params}`);
  // Preserve depth ownership for listeners that also service native Back.
  const event = typeof PopStateEvent === 'function'
    ? new PopStateEvent('popstate', { state: host.history.state })
    : Object.assign(new Event('popstate'), { state: host.history.state });
  host.dispatchEvent(event);
}
export function setAsideViewFromSearch(search: string): SetAsideView {
  if (inboxViewFromSearch(search) !== 'set-aside') return 'all';
  const view = new URLSearchParams(search).get('view');
  return view === 'later' || view === 'dismissed' ? view : 'all';
}
export function matchesSetAsideQuestion(row: QuestionPresentationItem, view: SetAsideView, search: string): boolean {
  if (view === 'later' && row.action !== 'defer') return false;
  if (view === 'dismissed' && row.action !== 'dismiss') return false;
  const text = [row.question, row.context, row.agentLabel, row.workflowName, row.projectName].filter(Boolean).join(' ').toLocaleLowerCase();
  return search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}
export function setAsideReturnLabel(row: Pick<QuestionPresentationItem, 'action' | 'until'>): string {
  if (row.action === 'dismiss') return 'Dismissed';
  const until = row.until ? new Date(row.until) : null;
  return until && Number.isFinite(until.getTime())
    ? `Returns ${until.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : 'Set aside for later';
}
