import { apiDelete, apiGet, apiPost } from './api';

/** One finding a watch saw, as the host retained it. */
export interface WatchFinding {
  key: string;
  title: string;
  detail?: string;
  link?: string;
  at: string;
  surfaced: boolean;
  heldBy?: 'rule' | 'learn_only';
}

export interface WatchRow {
  slug: string;
  name: string;
  source: string;
  lookFor: string;
  purpose: 'learn' | 'tell_me';
  enabled: boolean;
  schedule?: string;
  timezone?: string;
  onEvents: boolean;
  lastRun?: { runId: string; at: string; report: 'ok' | 'missing'; findings: number; surfaced: number; learned: number };
  findings: WatchFinding[];
  learned: Array<{ text: string; at: string }>;
  notify: 'quiet' | 'push';
  rules: Array<{ id: string; text: string }>;
  totals: { runs: number; findings: number; raised: number; learned: number };
}

export const listWatches = () => apiGet<{ watches: WatchRow[] }>('/api/console/watches');
export const setWatchNotify = (slug: string, mode: 'quiet' | 'push') =>
  apiPost<{ notify: 'quiet' | 'push' }>(`/api/console/watches/${encodeURIComponent(slug)}/notify`, { mode });
export const addWatchRule = (slug: string, text: string) =>
  apiPost<{ rules: WatchRow['rules'] }>(`/api/console/watches/${encodeURIComponent(slug)}/rules`, { text });
export const removeWatchRule = (slug: string, ruleId: string) =>
  apiDelete<{ rules: WatchRow['rules'] }>(`/api/console/watches/${encodeURIComponent(slug)}/rules/${encodeURIComponent(ruleId)}`);

/** What to say to Clem to start a new watch from chat. */
export const NEW_WATCH_PROMPT = 'I want you to keep an eye on something for me. ';

/** The chat prompt that opens a conversation about one watch. */
export function refineWatchPrompt(watch: Pick<WatchRow, 'source' | 'lookFor'>): string {
  return `About my ${watch.source} watch (you look for ${watch.lookFor}): `;
}

/** Why a finding did not reach the owner, in plain words. */
export function heldWords(finding: Pick<WatchFinding, 'surfaced' | 'heldBy'>): string {
  if (finding.surfaced) return 'Told you';
  if (finding.heldBy === 'rule') return 'Held by your rules';
  if (finding.heldBy === 'learn_only') return 'Learned, not raised';
  return 'Not raised';
}
