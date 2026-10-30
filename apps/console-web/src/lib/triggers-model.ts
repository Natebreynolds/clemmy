/**
 * The Triggers screen's one timeline: what fires next across every kind,
 * soonest first, and each kind's rows. Pure, so the ordering is pinned.
 */
import type { TriggersView, TriggerWorkflowRow, ReminderRow } from './triggers';
import type { WatchRow } from './watches';
import { workflowDisplayName } from '@clem/chat-engine';
import { humanizeCron } from './cron';

export type TriggerKind = 'schedule' | 'once' | 'interval' | 'webhook' | 'event' | 'watch' | 'reminder';

export interface NextUpItem {
  key: string;
  kind: TriggerKind;
  at: string;
  title: string;
  detail: string;
  href?: string;
  technicalDetail?: string;
}

export function workflowKinds(row: TriggerWorkflowRow): TriggerKind[] {
  const kinds: TriggerKind[] = [];
  if (row.schedule) kinds.push('schedule');
  if (row.onceAt) kinds.push('once');
  if (row.interval) kinds.push('interval');
  if (row.webhookPath) kinds.push('webhook');
  if (row.events.length > 0) kinds.push('event');
  return kinds;
}

/** Everything with a known future moment, soonest first, within `horizonMs`. */
export function nextUp(view: TriggersView, now: number = Date.now(), horizonMs: number = 7 * 86_400_000): NextUpItem[] {
  const items: NextUpItem[] = [];
  const paused = new Set(view.workflows.filter((row) => !row.enabled).flatMap((row) => [row.name, row.slug]));
  for (const occurrence of view.upcoming) {
    const at = Date.parse(occurrence.at);
    if (!Number.isFinite(at) || at <= now || at - now > horizonMs || paused.has(occurrence.workflowName)) continue;
    const workflow = view.workflows.find(row => row.name === occurrence.workflowName || row.slug === occurrence.workflowName);
    const name = workflow?.name ?? occurrence.workflowName;
    const schedule = occurrence.schedule || workflow?.schedule;
    items.push({ key: `workflow:${occurrence.workflowName}:${occurrence.at}`, kind: 'schedule', at: occurrence.at,
      title: workflowDisplayName(name, workflow?.description), detail: schedule ? humanizeCron(schedule, workflow?.timezone ?? undefined) : 'Scheduled run',
      href: `/automate/${encodeURIComponent(name)}`, technicalDetail: schedule ?? undefined });
  }
  for (const row of view.workflows) {
    if (!row.enabled || !row.onceAt) continue;
    const at = Date.parse(row.onceAt);
    if (!Number.isFinite(at) || at <= now || at - now > horizonMs) continue;
    items.push({ key: `once:${row.name}`, kind: 'once', at: row.onceAt, title: workflowDisplayName(row.name, row.description), detail: 'One-time run', href: `/automate/${encodeURIComponent(row.name)}` });
  }
  for (const reminder of view.reminders) {
    const at = Date.parse(reminder.fireAt);
    if (!Number.isFinite(at) || at - now > horizonMs) continue;
    items.push({ key: `reminder:${reminder.id}`, kind: 'reminder', at: reminder.fireAt, title: reminder.message, detail: 'reminder' });
  }
  return items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.title.localeCompare(right.title));
}

export function scheduledWorkflows(view: TriggersView): TriggerWorkflowRow[] {
  return view.workflows.filter((row) => row.schedule || row.onceAt || row.interval);
}
export function webhookWorkflows(view: TriggersView): TriggerWorkflowRow[] {
  return view.workflows.filter((row) => row.webhookPath);
}
export function eventWorkflows(view: TriggersView): TriggerWorkflowRow[] {
  return view.workflows.filter((row) => row.events.length > 0);
}
export function activeWatches(view: TriggersView): WatchRow[] {
  return [...view.watches].sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.source.localeCompare(right.source));
}
export function pendingReminders(view: TriggersView): ReminderRow[] {
  return [...view.reminders].sort((left, right) => Date.parse(left.fireAt) - Date.parse(right.fireAt));
}

/** "in 12 min", "tomorrow 09:00", "Thu 14:30". */
export function whenLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.round((at - now) / 60_000);
  if (mins < 1) return 'any moment';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} h`;
  const date = new Date(at);
  const dayLabel = hours < 48 ? 'tomorrow' : date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${dayLabel} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** The address a service holds: it starts this one workflow and nothing else. */
export function webhookAddress(view: Pick<TriggersView, 'webhookBase'>, row: Pick<TriggerWorkflowRow, 'webhookPath' | 'webhookKey'>): string {
  return `${view.webhookBase}${row.webhookPath ?? ''}${row.webhookKey ? `?key=${row.webhookKey}` : ''}`;
}
