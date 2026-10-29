import { resolveAppLink } from '@clem/chat-engine';
import type { ChatLocation } from './chat-location';

export interface AppLinkMarker { place?: string | null; item?: string | null }

export function appLinkClickIsPlain(event: Pick<MouseEvent, 'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, target: string | null, download: boolean): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && !download && (!target || target === '_self');
}

/** Only the exact internal destinations emitted by the shared renderer are routed. */
export function mobileAppLinkDestination(href: string, marker: AppLinkMarker, currentHref: string): URL | null {
  const current = new URL(currentHref);
  const resolved = resolveAppLink({ href, ...marker }, 'phone');
  if (!resolved) return null;
  const destination = new URL(resolved.href, current);
  if (destination.origin !== current.origin || destination.pathname !== '/m/') return null;
  return destination;
}

const text = (value: unknown, max = 1024): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const label = (value: unknown): string | undefined => text(value, 500) ? value : undefined;

/** History carries navigation identity only. It can never replay an initial send. */
export function guidanceReturnFromHistory(state: unknown): ChatLocation {
  if (!state || typeof state !== 'object') return null;
  const raw = (state as { clemGuidanceReturn?: unknown }).clemGuidanceReturn;
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === 'chat' && text(row.sessionId)) return { kind: 'chat', sessionId: row.sessionId, title: label(row.title) };
  if (row.kind !== 'new' || !text(row.scope) || !row.scope.startsWith('new:')) return null;
  return { kind: 'new', scope: row.scope,
    agentId: label(row.agentId), agentName: label(row.agentName),
    projectId: label(row.projectId), projectName: label(row.projectName) };
}

export function guidanceOrigin(search: string, current: ChatLocation, prior: ChatLocation): ChatLocation {
  const params = new URLSearchParams(search);
  const origin = params.has('guide') ? prior : params.get('tab') === 'chats' ? current : null;
  return guidanceReturnFromHistory({ clemGuidanceReturn: origin });
}

export function guidanceReturnSearch(origin: ChatLocation): string {
  const params = new URLSearchParams({ tab: 'chats' });
  if (origin?.kind === 'chat') params.set('session', origin.sessionId);
  return `?${params}`;
}
