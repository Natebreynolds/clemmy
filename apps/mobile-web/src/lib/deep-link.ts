/**
 * Where a URL says the phone should be.
 *
 * The app is one page with a tab and, sometimes, one addressed thing inside it
 * (an Inbox notification, a workspace, a run). Every entry point writes that as
 * query parameters: a push tap, the native shell's parked route, a terminal
 * handoff, the back gesture's own history entries.
 *
 * These live here rather than inside app.tsx because they are the contract two
 * other systems already depend on — src/runtime/notification-delivery.ts builds
 * these URLs, and apps/ios parks them — so they need to be readable and
 * testable without a renderer.
 */
export type TabId =
  | 'home' | 'inbox' | 'chats' | 'agents' | 'spaces' | 'workflows' | 'memory' | 'activity' | 'settings';

export const TAB_IDS: ReadonlySet<TabId> = new Set<TabId>([
  'home', 'inbox', 'chats', 'agents', 'spaces', 'workflows', 'memory', 'activity', 'settings',
]);

/** Every parameter that names a destination. A cold launch carrying any of
 *  them is an explicit request and outranks the "open on launch" preference. */
const DESTINATION_KEYS = ['tab', 'notification', 'workspace', 'run', 'pair', 'adopt'] as const;

export function tabFromSearch(search: string): TabId {
  const value = new URLSearchParams(search).get('tab');
  return value && TAB_IDS.has(value as TabId) ? value as TabId : 'home';
}

export function inboxNotificationFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('notification');
}

/**
 * The run a URL addresses, by harness session id — the same id
 * /m/api/runs/:sessionId is keyed on. Only meaningful on the Activity tab,
 * which owns the run view; a run named on any other tab is ignored rather than
 * silently opening a screen the URL did not ask for.
 */
export function runFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('tab') !== 'activity') return null;
  const value = params.get('run');
  return value && value.trim() ? value : null;
}

export function searchHasDestination(search: string): boolean {
  const params = new URLSearchParams(search);
  return DESTINATION_KEYS.some((key) => params.has(key));
}

/** The URL for a destination — the one place that decides which parameters a
 *  tab is allowed to carry, so navigation and history can never disagree. */
export function destinationSearch(input: {
  tab: TabId;
  notificationId?: string | null;
  runId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (input.tab !== 'home') params.set('tab', input.tab);
  if (input.tab === 'inbox' && input.notificationId) params.set('notification', input.notificationId);
  if (input.tab === 'activity' && input.runId) params.set('run', input.runId);
  const query = params.toString();
  return query ? `?${query}` : '';
}
