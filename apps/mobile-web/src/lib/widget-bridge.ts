export interface WidgetSpaceSnapshot { slug: string; name: string; summary: string; updatedAt: string }
interface WidgetReceipt { requestId: string; ok: boolean; slug?: string }
const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const WIDGET_ROUTE_EVENT = 'clem:widget-route';

/** Native uses byte limits, so multibyte names must be bounded before posting. */
export function widgetText(value: string, byteLimit: number): string {
  const clean = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
  const encoder = new TextEncoder();
  let result = ''; let bytes = 0;
  for (const character of clean) {
    const length = encoder.encode(character).length;
    if (bytes + length > byteLimit) break;
    result += character; bytes += length;
  }
  return result.trimEnd();
}

/** Same-document delivery preserves unsent drafts when a widget wakes the app. */
export function openWidgetRoute(value: { path: string; navigationId: string }): boolean {
  if (!value || typeof value.path !== 'string' || !value.path.startsWith('/m/?') || value.path.length > 2048 || typeof value.navigationId !== 'string' || !UUID.test(value.navigationId)) return false;
  const url = new URL(value.path, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== '/m/' || url.hash || widgetNavigationFromSearch(url.search) !== value.navigationId) return false;
  const params = url.searchParams;
  const tab = params.get('tab');
  if (params.getAll('tab').length !== 1) return false;
  if (tab === 'chats') {
    if (params.getAll('compose').length !== 1 || !['voice', 'dictate'].includes(params.get('compose') ?? '')) return false;
    if ([...params.keys()].some(key => !['tab', 'compose', 'widgetNavigation'].includes(key))) return false;
  } else if (tab === 'spaces') {
    const workspaces = params.getAll('workspace');
    if (workspaces.length > 1 || (workspaces.length === 1 && !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(workspaces[0]))) return false;
    if ([...params.keys()].some(key => !['tab', 'workspace', 'widgetNavigation'].includes(key))) return false;
  } else return false;
  const event = new CustomEvent(WIDGET_ROUTE_EVENT, { cancelable: true, detail: { path: `${url.pathname}${url.search}` } });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function widgetAvailable(): boolean { return Boolean(window.webkit?.messageHandlers?.clemWidgetSpace); }

/** Native confirms durable storage before the UI says the widget was changed. */
export function saveWidgetSpace(snapshot: WidgetSpaceSnapshot | null): Promise<void> {
  const handler = window.webkit?.messageHandlers?.clemWidgetSpace;
  if (!handler) return Promise.reject(new Error('Widgets need the latest Clem iPhone app.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new Error('The iPhone did not confirm the widget update. Try again.'));
    }, 6000);
    waiting.set(requestId, { resolve, reject, timer });
    try { handler.postMessage({ requestId, ...(snapshot ?? { clear: true }) }); }
    catch {
      clearTimeout(timer); waiting.delete(requestId);
      reject(new Error('The widget could not be updated. Try again.'));
    }
  });
}

export function widgetSpaceStored(receipt: WidgetReceipt): void {
  if (!receipt || typeof receipt.requestId !== 'string') return;
  const request = waiting.get(receipt.requestId);
  if (!request) return;
  waiting.delete(receipt.requestId); clearTimeout(request.timer);
  if (receipt.ok === true) request.resolve();
  else request.reject(new Error('The widget could not save this Space. Try again.'));
}

export function widgetNavigationFromSearch(search: string): string | null {
  const values = new URLSearchParams(search).getAll('widgetNavigation');
  return values.length === 1 && UUID.test(values[0]) ? values[0] : null;
}

/** Called by the destination after it is shown, never just by the app shell. */
export function reportWidgetLanding(navigationId: string | null, destination: { tab: 'chats'; compose: string } | { tab: 'spaces'; workspace?: string | null }, outcome: 'presented' | 'unavailable' = 'presented'): void {
  const handler = window.webkit?.messageHandlers?.clemWidgetNavigationHandled;
  if (!navigationId || widgetNavigationFromSearch(window.location.search) !== navigationId || !handler) return;
  const selected = new URLSearchParams(window.location.search);
  if (selected.get('tab') !== destination.tab) return;
  if (destination.tab === 'chats' && selected.get('compose') && selected.get('compose') !== destination.compose) return;
  if (destination.tab === 'spaces' && selected.get('workspace') !== (destination.workspace ?? null)) return;
  handler.postMessage({ navigationId, outcome });
  const params = new URLSearchParams(window.location.search);
  params.delete('widgetNavigation');
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
}
