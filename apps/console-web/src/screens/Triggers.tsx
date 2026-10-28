/**
 * Triggers: everything that makes Clem act without you typing, on one
 * screen. What fires next, soonest first; then each kind with its own
 * controls, in plain words: schedules (pause, run now), webhooks (the
 * address to call), things that happen in your apps, what Clem watches,
 * and reminders (cancel). Setting one up is a conversation; this screen is
 * where you see and steer them.
 */
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock, Webhook, Zap, Eye, Bell, Play, Copy, Trash2, Loader2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { humanizeCron } from '@/lib/cron';
import { runWorkflow, setWorkflowEnabled } from '@/lib/automate';
import { cancelReminder, getTriggers, type TriggerWorkflowRow } from '@/lib/triggers';
import {
  activeWatches, eventWorkflows, nextUp, pendingReminders, scheduledWorkflows, webhookWorkflows, whenLabel, type TriggerKind,
} from '@/lib/triggers-model';
import { useState } from 'react';

const KIND_ICON: Record<TriggerKind, typeof Clock> = {
  schedule: Clock, once: CalendarClock, interval: Clock, webhook: Webhook, event: Zap, watch: Eye, reminder: Bell,
};

function lastRunWords(row: TriggerWorkflowRow): string {
  if (!row.lastRun) return 'Not run yet';
  const when = row.lastRun.at ? whenAgo(row.lastRun.at) : '';
  const how = row.lastRun.outcome ?? row.lastRun.status ?? '';
  return [how ? `Last run ${how}` : 'Last run', when].filter(Boolean).join(' ');
}
function whenAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function outcomeTone(row: TriggerWorkflowRow): 'success' | 'warning' | 'danger' | 'neutral' {
  const outcome = row.lastRun?.outcome ?? row.lastRun?.status ?? '';
  if (/succeeded|completed/.test(outcome)) return 'success';
  if (/blocked|partial|awaiting/.test(outcome)) return 'warning';
  if (/failed|error|cancelled/.test(outcome)) return 'danger';
  return 'neutral';
}

export function Triggers() {
  const q = usePoll(['triggers'], getTriggers, 30_000);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['triggers'] });
  const view = q.data;
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try { await run(); } finally { setBusy(null); await refresh(); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

  return (
    <Page
      title="Triggers"
      subtitle="Everything that makes Clem act without you typing: schedules, webhooks, things that happen in your apps, what she watches, and reminders. Set one up in chat; steer it here."
    >
      {q.isError && <QueryUnavailable title="Triggers are unavailable" description={q.error instanceof Error ? q.error.message : undefined} onRetry={() => { void q.refetch(); }} />}
      {!view && !q.isError && <Skeleton className="h-40" />}
      {view && (
        <div className="flex flex-col gap-6">
          <section>
            <h2 className="mb-2 text-h2 text-fg">Next up</h2>
            {nextUp(view).length === 0
              ? <EmptyState title="Nothing scheduled in the next week" description="Ask Clem to run something every morning, remind you later, or act when something arrives." />
              : (
                <Card>
                  <ul className="divide-y divide-border">
                    {nextUp(view).slice(0, 12).map((item) => {
                      const Icon = KIND_ICON[item.kind];
                      return (
                        <li key={item.key} className="flex items-center gap-3 py-2">
                          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                          <span className="w-28 shrink-0 text-small text-muted">{whenLabel(item.at)}</span>
                          {item.href ? <Link to={item.href} className="truncate text-fg hover:underline">{item.title}</Link> : <span className="truncate text-fg">{item.title}</span>}
                          <span className="ml-auto shrink-0 text-small text-muted">{item.detail}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
          </section>

          <section>
            <h2 className="mb-2 text-h2 text-fg">On a schedule</h2>
            {scheduledWorkflows(view).length === 0
              ? <EmptyState title="No schedules yet" description="Tell Clem: “every weekday at 8, send me the brief.”" />
              : scheduledWorkflows(view).map((row) => (
                <Card key={row.name} className="mb-2">
                  <div className="flex items-center gap-3">
                    <Switch checked={row.enabled} disabled={busy === `pause:${row.name}`}
                      onChange={(enabled: boolean) => { void act(`pause:${row.name}`, () => setWorkflowEnabled(row.name, enabled)); }}
                      label={row.enabled ? `Pause ${row.name}` : `Resume ${row.name}`} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-fg hover:underline">{row.name}</Link>
                      <div className="text-small text-muted">
                        {row.schedule ? humanizeCron(row.schedule, row.timezone ?? undefined) : row.onceAt ? `Once, ${whenLabel(row.onceAt)}` : 'On an interval'}
                        {!row.enabled && ' · paused'}
                      </div>
                    </div>
                    <StatusPill tone={outcomeTone(row)}>{lastRunWords(row)}</StatusPill>
                    <Button variant="ghost" size="sm" disabled={busy === `run:${row.name}`} onClick={() => act(`run:${row.name}`, () => runWorkflow(row.name))} aria-label={`Run ${row.name} now`}>
                      {busy === `run:${row.name}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                    </Button>
                  </div>
                </Card>
              ))}
          </section>

          <section>
            <h2 className="mb-2 text-h2 text-fg">When something calls in</h2>
            {webhookWorkflows(view).length === 0
              ? <EmptyState title="No webhooks yet" description="Tell Clem: “when my form tool posts a new lead, start the intake workflow.”" />
              : webhookWorkflows(view).map((row) => {
                const url = `${view.webhookBase}${row.webhookPath}`;
                return (
                  <Card key={row.name} className="mb-2">
                    <div className="flex items-center gap-3">
                      <Webhook className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-fg hover:underline">{row.name}</Link>
                        <div className="truncate text-small text-muted" title={url}>POST {url}{!row.enabled && ' · paused'}</div>
                        <div className="text-small text-muted">Send it with your Clementine token (Connect → Your phone & tools).</div>
                      </div>
                      <StatusPill tone={outcomeTone(row)}>{lastRunWords(row)}</StatusPill>
                      <Button variant="ghost" size="sm" onClick={() => copy(url)} aria-label={`Copy the address for ${row.name}`}><Copy className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  </Card>
                );
              })}
          </section>

          <section>
            <h2 className="mb-2 text-h2 text-fg">When something happens in an app</h2>
            {eventWorkflows(view).length === 0 && activeWatches(view).length === 0
              ? <EmptyState title="Nothing event-driven yet" description="Tell Clem: “when a new email from a client arrives, draft a reply for me.”" />
              : (
                <>
                  {eventWorkflows(view).map((row) => (
                    <Card key={row.name} className="mb-2">
                      <div className="flex items-center gap-3">
                        <Zap className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-fg hover:underline">{row.name}</Link>
                          <div className="truncate text-small text-muted">{row.events.join(', ')}{!row.enabled && ' · paused'}</div>
                        </div>
                        <StatusPill tone={outcomeTone(row)}>{lastRunWords(row)}</StatusPill>
                      </div>
                    </Card>
                  ))}
                  {activeWatches(view).map((watch) => (
                    <Card key={watch.slug} className="mb-2">
                      <div className="flex items-center gap-3">
                        <Eye className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <Link to="/watching" className="block truncate font-medium text-fg hover:underline">{watch.source}</Link>
                          <div className="truncate text-small text-muted">
                            {watch.onEvents ? 'As things arrive' : watch.schedule ? humanizeCron(watch.schedule, watch.timezone) : 'When you ask'} · {watch.lookFor}{!watch.enabled && ' · off'}
                          </div>
                        </div>
                        <StatusPill tone="neutral">{watch.lastRun ? `Checked ${whenAgo(watch.lastRun.at)}` : 'Not checked yet'}</StatusPill>
                      </div>
                    </Card>
                  ))}
                </>
              )}
          </section>

          <section>
            <h2 className="mb-2 text-h2 text-fg">Reminders</h2>
            {pendingReminders(view).length === 0
              ? <EmptyState title="No reminders pending" description="Tell Clem: “remind me Thursday at 9 to send the invoice.”" />
              : pendingReminders(view).map((reminder) => (
                <Card key={reminder.id} className="mb-2">
                  <div className="flex items-center gap-3">
                    <Bell className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-fg">{reminder.message}</div>
                      <div className="text-small text-muted">{whenLabel(reminder.fireAt)} · {new Date(reminder.fireAt).toLocaleString()}</div>
                    </div>
                    <Button variant="ghost" size="sm" disabled={busy === `cancel:${reminder.id}`} onClick={() => act(`cancel:${reminder.id}`, () => cancelReminder(reminder.id))} aria-label={`Cancel the reminder ${reminder.message}`}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </Card>
              ))}
          </section>
        </div>
      )}
    </Page>
  );
}
