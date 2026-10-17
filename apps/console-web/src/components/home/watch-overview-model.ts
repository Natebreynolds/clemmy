import type { WatchRow } from '../../lib/watches';

export type WatchOverviewQueryState = 'loaded' | 'loading' | 'error';
export type WatchOverviewStatus = WatchOverviewQueryState | 'stale' | 'unconfirmed';

export interface WatchOverviewInput {
  watches: readonly WatchRow[];
  state: WatchOverviewQueryState;
  dataUpdatedAt: number;
  nowMs: number;
}

export interface WatchOverviewRow {
  slug: string;
  name: string;
  source: string;
  lookFor: string;
  enabled: boolean;
  href: '/watching';
  stateLabel: 'Enabled' | 'Paused' | 'Last loaded enabled' | 'Last loaded paused';
  reportStatus: 'retained' | 'unconfirmed' | 'none';
  reportLabel: 'Retained report' | 'Report unconfirmed' | 'No retained report';
  /** Only a confirmed retained report with a valid, nonfuture time has a report time. */
  reportAt: string | null;
  reportTimeLabel: string | null;
}

export interface WatchOverview {
  href: '/watching';
  status: WatchOverviewStatus;
  label: string;
  detail: string;
  freshnessLabel: string | null;
  /** Counts describe a fresh, successful loaded list, never current execution or lifetime coverage. */
  currentCounts: { total: number; enabled: number } | null;
  rows: WatchOverviewRow[];
}

const HOME_WATCH_LIMIT = 3;
// Watches poll every 30 seconds. A suspended tab can still have a successful
// query, so query success alone does not make an old snapshot current.
const CURRENT_SNAPSHOT_MAX_AGE_MS = 90_000;

function validPastMs(value: number, nowMs: number): boolean {
  return Number.isFinite(value) && Number.isFinite(nowMs) && value >= 0 && value <= nowMs;
}

function retainedReportMs(watch: WatchRow, nowMs: number): number | null {
  if (watch.lastRun?.report !== 'ok') return null;
  // Host timestamps are ISO instants. Date.parse alone also accepts bare
  // numbers and rolls impossible calendar dates forward into another month.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(watch.lastRun.at);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  const parsed = Date.parse(watch.lastRun.at);
  return validPastMs(parsed, nowMs) ? parsed : null;
}

function ageLabel(atMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function samePresentedWatch(a: WatchRow, b: WatchRow): boolean {
  return a.name === b.name && a.source === b.source && a.lookFor === b.lookFor && a.enabled === b.enabled
    && a.purpose === b.purpose && a.schedule === b.schedule && a.timezone === b.timezone
    && a.onEvents === b.onEvents && a.notify === b.notify
    && a.rules.length === b.rules.length && a.rules.every((rule, index) => rule.id === b.rules[index].id && rule.text === b.rules[index].text)
    && a.lastRun?.runId === b.lastRun?.runId && a.lastRun?.at === b.lastRun?.at && a.lastRun?.report === b.lastRun?.report;
}

/**
 * A bounded Home view of the host's retained watch list. Enabled is a saved
 * setting, not evidence of a running check, a connected source, or future work.
 * Findings and learned-entry counts do not establish unread items or memory
 * persistence, so they deliberately do not participate in this presentation.
 */
export function buildWatchOverview(input: WatchOverviewInput): WatchOverview {
  const { watches, state, dataUpdatedAt, nowMs } = input;
  const unique = new Map<string, { watch: WatchRow; index: number; conflicting: boolean }>();
  for (const [index, watch] of watches.entries()) {
    const existing = unique.get(watch.slug);
    if (!existing) unique.set(watch.slug, { watch, index, conflicting: false });
    else if (!samePresentedWatch(existing.watch, watch)) existing.conflicting = true;
  }
  const hasConflicts = [...unique.values()].some((entry) => entry.conflicting);
  const retained = [...unique.values()].filter((entry) => !entry.conflicting);
  const loadTimeValid = dataUpdatedAt > 0 && validPastMs(dataUpdatedAt, nowMs);
  const snapshotFresh = loadTimeValid && nowMs - dataUpdatedAt <= CURRENT_SNAPSHOT_MAX_AGE_MS;
  const current = state === 'loaded' && snapshotFresh && !hasConflicts;
  const status: WatchOverviewStatus = state !== 'loaded' ? state
    : hasConflicts || !loadTimeValid ? 'unconfirmed'
      : snapshotFresh ? 'loaded' : 'stale';

  let label: string;
  let detail: string;
  if (current) {
    label = retained.length === 0 ? 'No watches to show' : `${retained.length} ${retained.length === 1 ? 'watch' : 'watches'} in view`;
    const enabled = retained.filter(({ watch }) => watch.enabled).length;
    detail = retained.length === 0 ? 'Give Clem something to keep in view.' : `${enabled} enabled · ${retained.length - enabled} paused`;
  } else if (state === 'error') {
    label = watches.length === 0 ? 'Watches unavailable' : 'Watches need a refresh';
    detail = watches.length > 0 ? 'Showing last loaded watches. Their current settings aren’t confirmed.'
      : loadTimeValid ? 'The last loaded list was empty. Clem couldn’t refresh it.'
        : 'Clem couldn’t load your watches. Try again to see what’s here.';
  } else if (state === 'loading') {
    label = 'Loading watches';
    detail = watches.length > 0 ? 'Showing last loaded watches while Clem refreshes them.'
      : loadTimeValid ? 'The last loaded list was empty. Refreshing it now.'
        : 'Clem is loading what you’ve asked her to keep in view.';
  } else if (hasConflicts) {
    label = 'Some watches are unconfirmed';
    detail = 'Conflicting watch details were left out. Open your watches to check them.';
  } else {
    label = 'Watches need a refresh';
    detail = watches.length > 0 ? 'Showing last loaded watches. Refresh to confirm their current settings.'
      : 'The last loaded list was empty. Refresh to see what’s here now.';
  }
  if (hasConflicts && state !== 'loaded') detail += ' Conflicting watch details were left out.';

  const hasSnapshot = state === 'loaded' || watches.length > 0 || dataUpdatedAt > 0;
  const freshnessLabel = !hasSnapshot ? null
    : loadTimeValid ? `${current ? 'Loaded' : 'Last loaded'} ${ageLabel(dataUpdatedAt, nowMs)}`
      : 'Last loaded time unavailable';

  const rows = retained
    .map((entry) => ({ ...entry, reportMs: retainedReportMs(entry.watch, nowMs) }))
    .sort((a, b) => (b.reportMs ?? -Infinity) - (a.reportMs ?? -Infinity) || a.index - b.index)
    .slice(0, HOME_WATCH_LIMIT)
    .map(({ watch, reportMs }): WatchOverviewRow => {
      const reportStatus = !watch.lastRun ? 'none' : watch.lastRun.report === 'ok' ? 'retained' : 'unconfirmed';
      return {
        slug: watch.slug,
        name: watch.name,
        source: watch.source,
        lookFor: watch.lookFor,
        enabled: watch.enabled,
        href: '/watching',
        stateLabel: current ? watch.enabled ? 'Enabled' : 'Paused'
          : watch.enabled ? 'Last loaded enabled' : 'Last loaded paused',
        reportStatus,
        reportLabel: reportStatus === 'none' ? 'No retained report' : reportStatus === 'retained' ? 'Retained report' : 'Report unconfirmed',
        reportAt: reportMs === null ? null : watch.lastRun!.at,
        reportTimeLabel: reportStatus !== 'retained' ? null : reportMs === null ? 'Time unavailable' : ageLabel(reportMs, nowMs),
      };
    });

  return {
    href: '/watching',
    status,
    label,
    detail,
    freshnessLabel,
    currentCounts: current ? { total: retained.length, enabled: retained.filter(({ watch }) => watch.enabled).length } : null,
    rows,
  };
}
