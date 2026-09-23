/**
 * Read-only feeds for Home that are not the command center: Today (the
 * calendar watch's last read) and the summaries of the Spaces on Home (the
 * phone's projection). Both are projections of durable state; neither makes a
 * provider or model call.
 */
import { apiGet } from './api';
import { usePoll } from './poll';

export interface HomeTodayEvent {
  key: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  needsReply: boolean;
  attendeeCount: number;
  location?: string;
}
export interface HomeToday {
  connected: boolean;
  asOf: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  events: HomeTodayEvent[];
}

export interface HomeField { label: string; value: string }
export interface HomeSpaceSummary {
  id: string;
  title: string;
  objective: string | null;
  lastRefreshedAt: string | null;
  freshness: string;
  headline: HomeField[];
  recordLabel: string | null;
  total: number;
  records: Array<{ key: string; primary: string; fields: HomeField[] }>;
  breakdown: { label: string; entries: Array<{ label: string; value: string; ratio: number }> } | null;
  sources: Array<{ id: string; ok: boolean; refreshedAt: string | null; error: string | null }>;
  issues: string[];
}

/**
 * How a Space shows on Home. The owner's choice wins; a Space they have not
 * decided about shows its summary — unless it has none to give (its numbers
 * live in its own page), when its page is the honest default.
 */
export function effectiveSpaceView(
  chosen: 'summary' | 'full' | undefined,
  summary: HomeSpaceSummary | undefined,
): 'summary' | 'full' {
  if (chosen) return chosen;
  return summary && summary.headline.length === 0 && summary.records.length === 0 && !summary.breakdown ? 'full' : 'summary';
}

export const getHomeToday = () => apiGet<HomeToday>('/api/console/home/today');
export const useHomeToday = (enabled = true) => usePoll(['home-today'], getHomeToday, 60_000, { enabled });

export const getSpaceSummaries = (ids: readonly string[]) =>
  apiGet<{ summaries: HomeSpaceSummary[] }>(`/api/console/home/space-summaries?ids=${encodeURIComponent(ids.join(','))}`)
    .then((r) => r.summaries);
export const useSpaceSummaries = (ids: readonly string[]) =>
  usePoll(['home-space-summaries', ids.join(',')], () => getSpaceSummaries(ids), 30_000, { enabled: ids.length > 0 });
