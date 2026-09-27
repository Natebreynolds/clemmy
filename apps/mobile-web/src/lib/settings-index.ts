/**
 * Settings on the phone is an index: a few recognisable rows, each with one
 * line of truth under it, opening a page. These are the pure pieces of that
 * index, kept out of the screen so they can be tested without a renderer.
 */
import type { MobileDeviceRow, PhoneHeartbeat } from './api';

export type SettingsSection = 'notifications' | 'models' | 'accounts' | 'connections' | 'devices';

export const SETTINGS_SECTIONS: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  'notifications', 'models', 'accounts', 'connections', 'devices',
]);

export const SECTION_TITLES: Record<SettingsSection, string> = {
  notifications: 'Notifications',
  models: 'Models',
  accounts: 'Model accounts',
  connections: 'Connections',
  devices: 'Devices & security',
};

export function sectionFromSearch(search: string): SettingsSection | null {
  const params = new URLSearchParams(search);
  if (params.get('tab') !== 'settings') return null;
  const value = params.get('section');
  return value && SETTINGS_SECTIONS.has(value as SettingsSection) ? value as SettingsSection : null;
}

export function settingsSearch(section: SettingsSection | null): string {
  return section ? `?tab=settings&section=${section}` : '?tab=settings';
}

const STALE_AFTER_DAYS = 14;

export function daysSince(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function relativeDay(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'recently';
  const days = daysSince(iso, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? 's' : ''} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function deviceDisplayName(device: Pick<MobileDeviceRow, 'deviceName' | 'deviceLabel' | 'deviceId'>): string {
  return device.deviceName || device.deviceLabel || device.deviceId;
}

/** This phone first, then the others by recency; the ones nobody has opened
 *  in two weeks are set apart so revoking them is an obvious, safe tidy. */
export function splitDevices(rows: readonly MobileDeviceRow[], now = Date.now()): {
  current: MobileDeviceRow | null;
  active: MobileDeviceRow[];
  stale: MobileDeviceRow[];
} {
  const current = rows.find((d) => d.current) ?? null;
  const others = rows.filter((d) => !d.current).slice().sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
  const active = others.filter((d) => daysSince(d.lastSeenAt, now) < STALE_AFTER_DAYS);
  const stale = others.filter((d) => daysSince(d.lastSeenAt, now) >= STALE_AFTER_DAYS);
  return { current, active, stale };
}

export function devicesSummary(rows: readonly MobileDeviceRow[] | undefined, now = Date.now()): string {
  if (!rows) return '';
  const { active, stale } = splitDevices(rows, now);
  const others = active.length + stale.length;
  const head = others === 0 ? 'Only this phone is signed in' : `This phone and ${others} other${others === 1 ? '' : 's'}`;
  return stale.length ? `${head} · ${stale.length} not seen in weeks` : head;
}

export interface ConnectionRowLike { id: string; name: string; kind: string; state: 'ok' | 'warn' | 'err'; cause: string | null }

export function groupConnections<T extends ConnectionRowLike>(rows: readonly T[]): { apps: T[]; tools: T[] } {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return {
    apps: rows.filter((r) => r.kind !== 'cli').slice().sort(byName),
    tools: rows.filter((r) => r.kind === 'cli').slice().sort(byName),
  };
}

export function connectionsSummary(rows: readonly ConnectionRowLike[] | undefined): string {
  if (!rows) return '';
  if (rows.length === 0) return 'Nothing connected yet';
  const { apps, tools } = groupConnections(rows);
  const attention = rows.filter((r) => r.state !== 'ok').length;
  const parts = [
    apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'}` : '',
    tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'} on your Mac` : '',
  ].filter(Boolean);
  const head = parts.join(' · ');
  return attention ? `${head} · ${attention} need${attention === 1 ? 's' : ''} a look` : head;
}

/** What a tool's health means in the owner's words, never the probe's. */
export function connectionStateWords(row: ConnectionRowLike): string {
  if (row.state === 'ok') return row.cause ?? 'Connected';
  if (row.cause) return row.cause;
  return row.state === 'warn' ? 'Needs attention' : 'Unavailable';
}

/**
 * One line for the Notifications row: does anything reach THIS phone, and what.
 * `registered` is whether a live push destination is bound to this device.
 */
export function notificationsSummary(input: {
  registered: boolean | undefined;
  heartbeats: readonly PhoneHeartbeat[] | undefined;
}): string {
  if (input.registered === undefined) return '';
  if (!input.registered) return 'Not reaching this phone yet';
  const pushing = (input.heartbeats ?? []).filter((h) => h.enabled && h.notify === 'push').map((h) => h.title);
  if (pushing.length === 0) return 'Questions and finished work reach this phone';
  return `Questions, finished work and ${joinWords(pushing)} reach this phone`;
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Why push would not reach a phone today, in the owner's terms; empty when it would. */
export function phonePushCaveat(readiness: PhoneHeartbeat['phonePush'] | undefined, native: boolean): string {
  if (!readiness || readiness.ready) return '';
  if (readiness.reason === 'apns_key_missing') return 'This Mac has no Apple push key yet, so these stay in the app for now.';
  return native
    ? 'Allow notifications for Clem in iOS Settings, then reopen the app; until then these stay in the app.'
    : 'Open the Clem app on your phone and allow notifications; until then these stay in the app.';
}
