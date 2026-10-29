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
  { id: 'inbox', name: 'Inbox', purpose: 'Decisions, updates, and anything waiting on you', desktop: '/inbox', phone: '?tab=inbox' },
  { id: 'needs-you', name: 'Needs you', purpose: 'Approvals, questions and anything waiting on you', desktop: '/inbox', phone: '?tab=inbox' },
  { id: 'clem-thread', name: "Clem's thread", purpose: 'Where Clem writes to you on her own, and you answer', desktop: '/chat/harness:clem', phone: '?tab=chats&session=harness%3Aclem' },
  { id: 'work', name: 'Work', purpose: 'Your projects, tasks, agents, and results', desktop: '/projects', phone: '?tab=projects' },
  { id: 'projects', name: 'Projects', purpose: 'What you are working on, who is on it and what it needs', desktop: '/projects', phone: '?tab=projects' },
  { id: 'agents', name: 'Agents', purpose: 'Specialist agents you work with', desktop: '/agents', phone: '?tab=agents' },
  { id: 'spaces', name: 'Spaces', purpose: 'Live pages Clem built for you', desktop: '/workspaces', phone: '?tab=spaces' },
  { id: 'automate', name: 'Automations', purpose: 'Work Clem does for you on a schedule or with one tap, and her skills', desktop: '/automate', phone: '?tab=workflows' },
  { id: 'triggers', name: 'Automations › Schedule & events', purpose: 'What starts work: schedules, app events, webhooks, and reminders', desktop: '/triggers', phone: null },
  { id: 'watching', name: 'Automations › Watching', purpose: 'Sources Clem keeps an eye on and the changes that matter', desktop: '/watching', phone: null },
  { id: 'running', name: 'Work › Tasks', purpose: 'Work in progress, waiting tasks, and retained results', desktop: '/tasks', phone: '?tab=activity' },
  { id: 'heartbeats', name: 'Automations › Check-ins', purpose: 'What Clem checks on her own, and how often', desktop: '/heartbeats', phone: null },
  { id: 'connect', name: 'Apps & devices', purpose: 'Connect an app, tool, account, or phone', desktop: '/connect', phone: '?tab=settings&section=connections' },
  { id: 'phone', name: 'Pair your phone', purpose: 'Pair a phone with this computer', desktop: '/connect#phone', phone: '?tab=settings&section=devices' },
  { id: 'memory', name: 'Memory', purpose: 'What Clem knows about you', desktop: '/memory', phone: '?tab=memory' },
  { id: 'meetings', name: 'Meetings', purpose: 'Recorded meetings and their summaries', desktop: '/meetings', phone: null },
  { id: 'goals', name: 'Goals', purpose: 'Long-running outcomes', desktop: '/goals', phone: null },
  { id: 'made', name: 'Work › Results', purpose: 'Files and other things Clem delivered, with their receipts', desktop: '/made', phone: null },
  { id: 'models', name: 'Settings › Who does what', purpose: 'Which model does which job', desktop: '/settings#who-does-what', phone: '?tab=settings&section=models' },
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

/** One thing Clem built that a reply can open directly, as
 *  `[Open <title>](app:space:<id>)` or `[Open <name>](app:workflow:<name>)`.
 *  The id is the slug Clementine assigned, so only that thing's own page opens. */
const APP_ITEM_ID = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

/** Where one Space or workflow opens on a surface; undefined when the link is
 *  not a known kind with a well-formed id. */
export function appItemHref(kind: string, id: string, surface: 'desktop' | 'phone'): string | undefined {
  if (!APP_ITEM_ID.test(id)) return undefined;
  if (kind === 'guide') return appGuidanceHref(id, surface) ?? undefined;
  if (kind === 'space') return surface === 'desktop' ? `/workspaces/${id}` : `/m/?tab=spaces&workspace=${id}`;
  if (kind === 'workflow') return surface === 'desktop' ? `/automate/${id}` : `/m/?tab=workflows&workflow=${id}`;
  return undefined;
}

/** Guidance opens a known place; it never performs the action being explained. */
export const GUIDED_APP_PLACES: ReadonlySet<string> = new Set([
  'inbox', 'needs-you', 'work', 'projects', 'agents', 'spaces', 'automate', 'connect', 'phone',
  'memory', 'models', 'model-accounts', 'notifications',
]);

export function appGuidanceHref(id: string, surface: 'desktop' | 'phone'): string | null {
  if (!GUIDED_APP_PLACES.has(id)) return null;
  const href = appPlaceHref(id, surface);
  if (!href) return null;
  const [route, anchor] = href.split('#');
  return `${route}${route.includes('?') ? '&' : '?'}guide=${id}${anchor ? `#${anchor}` : ''}`;
}

/** Resolve only the exact internal destinations emitted by the markdown renderer. */
export function resolveAppLink(link: { href?: string | null; place?: string | null; item?: string | null }, surface: 'desktop' | 'phone'): { href: string; kind: 'place' | 'guide' | 'space' | 'workflow' } | null {
  const { href, place, item } = link;
  if (!href || !href.startsWith('/') || href.startsWith('//') || (place && item)) return null;
  if (place) return appPlaceHref(place, surface) === href ? { href, kind: 'place' } : null;
  if (item !== 'guide' && item !== 'space' && item !== 'workflow') return null;
  let parsed: URL;
  try { parsed = new URL(href, 'http://clem.invalid'); } catch { return null; }
  if (parsed.origin !== 'http://clem.invalid') return null;
  const id = item === 'guide' ? parsed.searchParams.get('guide')
    : surface === 'phone' ? parsed.searchParams.get(item === 'space' ? 'workspace' : 'workflow')
      : parsed.pathname.match(item === 'space' ? /^\/workspaces\/([^/]+)$/ : /^\/automate\/([^/]+)$/)?.[1];
  return id && appItemHref(item, id, surface) === href ? { href, kind: item } : null;
}
