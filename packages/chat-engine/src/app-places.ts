/**
 * The places in Clementine that Clem can send the owner to.
 *
 * Clem links a place in a reply as `[Open Meetings](app:meetings)`; the shared
 * markdown renderer turns a known id into an in-app link for the surface
 * rendering it, and anything else into plain text. A link only moves the
 * owner when they tap it, and only to a place listed here.
 *
 * `desktop` is the console route (with the Settings anchor where one exists);
 * `phone` is the phone's query string, or null when the place lives only on
 * the Mac. The daemon keeps a copy of APP_PLACES in
 * src/runtime/app-guide/app-places.ts; its test fails when the two differ.
 */

export interface AppPlace {
  id: string;
  name: string;
  purpose: string;
  desktop: string;
  phone: string | null;
}

export const APP_PLACES: readonly AppPlace[] = [
  { id: 'today', name: 'Today', purpose: 'Your day and your conversation with Clem', desktop: '/chat', phone: '?tab=home' },
  { id: 'needs-you', name: 'Needs you', purpose: 'Approvals, questions and anything waiting on you', desktop: '/inbox', phone: '?tab=inbox' },
  { id: 'clem-thread', name: "Clem's thread", purpose: 'Where Clem writes to you on her own, and you answer', desktop: '/chat/harness:clem', phone: '?tab=chats' },
  { id: 'projects', name: 'Projects', purpose: 'What you are working on, who is on it and what it needs', desktop: '/projects', phone: '?tab=projects' },
  { id: 'agents', name: 'Agents', purpose: 'Specialist agents you work with', desktop: '/agents', phone: '?tab=agents' },
  { id: 'spaces', name: 'Spaces', purpose: 'Live pages Clem built for you', desktop: '/workspaces', phone: '?tab=spaces' },
  { id: 'automate', name: 'Automate', purpose: 'Workflows and skills', desktop: '/automate', phone: '?tab=workflows' },
  { id: 'running', name: 'Running', purpose: 'Everything Clem is working on right now', desktop: '/tasks', phone: '?tab=activity' },
  { id: 'heartbeats', name: 'Heartbeats', purpose: 'What Clem checks on her own, and how often', desktop: '/heartbeats', phone: null },
  { id: 'connect', name: 'Connect', purpose: 'Apps, keys, command-line tools, MCP servers and your phone', desktop: '/connect', phone: '?tab=settings&section=connections' },
  { id: 'phone', name: 'Your phone', purpose: 'Pair a phone with this Mac', desktop: '/connect', phone: '?tab=settings&section=devices' },
  { id: 'memory', name: 'Memory', purpose: 'What Clem knows about you', desktop: '/memory', phone: '?tab=memory' },
  { id: 'meetings', name: 'Meetings', purpose: 'Recorded meetings and their summaries', desktop: '/meetings', phone: null },
  { id: 'goals', name: 'Goals', purpose: 'Long-running outcomes', desktop: '/goals', phone: null },
  { id: 'models', name: 'Settings › Models', purpose: 'Which model does which job', desktop: '/settings#models', phone: '?tab=settings&section=models' },
  { id: 'model-accounts', name: 'Settings › Model accounts', purpose: 'Sign in to a model provider, connect Jev or add a model key', desktop: '/settings#accounts', phone: '?tab=settings&section=accounts' },
  { id: 'notifications', name: 'Settings › Notifications', purpose: 'How Clem reaches you', desktop: '/settings#notifications', phone: '?tab=settings&section=notifications' },
  { id: 'settings', name: 'Settings', purpose: 'Models, profile, notifications and storage', desktop: '/settings', phone: '?tab=settings' },
  { id: 'help', name: 'Help', purpose: 'Guides, shortcuts and version', desktop: '/help', phone: null },
] as const;

const BY_ID = new Map(APP_PLACES.map((place) => [place.id, place]));

export function appPlace(id: string): AppPlace | null {
  return BY_ID.get(id) ?? null;
}

/** Where a place opens on one surface; null when it has no page there. */
export function appPlaceHref(id: string, surface: 'desktop' | 'phone'): string | null {
  const place = appPlace(id);
  if (!place) return null;
  if (surface === 'desktop') return place.desktop;
  return place.phone ? `/m/${place.phone}` : null;
}
