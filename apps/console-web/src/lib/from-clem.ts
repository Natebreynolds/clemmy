/** From Clem on Home: what the heartbeats brought the owner, as one stream
 *  (server: src/dashboard/from-clem.ts). */
import { apiGet } from './api';
import { usePoll } from './poll';

export interface FromClemRow {
  key: string;
  heartbeat: string;
  heartbeatTitle: string;
  at: string;
  asks: boolean;
  text: string;
  detail?: string;
  answer?: { kind: 'words'; questionId: string } | { kind: 'yes_no'; planProposalId: string };
  done?: { notificationId: string };
}

export interface FromClemPulse {
  heartbeat: string;
  title: string;
  enabled: boolean;
  lastAt?: string;
  summary?: string;
}

export interface FromClem {
  rows: FromClemRow[];
  pulses: FromClemPulse[];
  covers: { questionIds: string[]; planProposalIds: string[]; notificationIds: string[] };
}

export const getFromClem = () => apiGet<FromClem>('/api/console/home/from-clem');
export const useFromClem = (enabled = true) => usePoll(['home-from-clem'], getFromClem, 20_000, { enabled });

/** Home's other lists, without what From Clem already shows. */
export function withoutFromClem<T extends { questionId?: string; planProposalId?: string; notifId?: string }>(
  items: readonly T[],
  covers: FromClem['covers'] | undefined,
): T[] {
  if (!covers) return [...items];
  const questions = new Set(covers.questionIds);
  const plans = new Set(covers.planProposalIds);
  const notifications = new Set(covers.notificationIds);
  return items.filter((item) => !(item.questionId && questions.has(item.questionId))
    && !(item.planProposalId && plans.has(item.planProposalId))
    && !(item.notifId && notifications.has(item.notifId)));
}

/** The heartbeats Clem runs that have looked at anything, newest look first. */
export function recentPulses(pulses: readonly FromClemPulse[]): FromClemPulse[] {
  return pulses.filter((pulse) => pulse.enabled && pulse.lastAt)
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}
