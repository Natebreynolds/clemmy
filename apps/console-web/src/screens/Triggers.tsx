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
import { CalendarClock, Clock, Webhook, Zap, Eye, Bell, Play, Copy, Trash2, Loader2, ArrowRight } from 'lucide-react';
import { workflowDisplayName } from '@clem/chat-engine';
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
  activeWatches, eventWorkflows, nextUp, pendingReminders, scheduledWorkflows, webhookAddress, webhookWorkflows, whenLabel, type TriggerKind,
} from '@/lib/triggers-model';
import { useState } from 'react';
import { usePendingCommit } from '@/lib/pending-commit';
import { performAutomationAction, type AutomationFeedback } from '@/lib/automation-actions';
import { AutomationRefreshNotice } from '@/components/automate/AutomationRefreshNotice';

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
  const commit = usePendingCommit('schedule-actions');
  const [feedback, setFeedback] = useState<AutomationFeedback | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['triggers'] });
  const view = q.data;
  const act = (key: string, request: () => Promise<unknown>, workflow?: string) => performAutomationAction({ commit, key, request, workflow, pending: setBusy, feedback: setFeedback, refresh });
  const copy = async (text: string) => {
    try { if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.'); await navigator.clipboard.writeText(text); setFeedback({ text: 'Webhook address copied.' }); }
    catch { setFeedback({ error: true, text: 'Could not copy the address. Select and copy the address shown in this row.' }); }
  };
  const nextItems = view ? nextUp(view) : [];
  const hasSources = Boolean(view && (view.workflows.length || view.watches.length || view.reminders.length));
  const setupHref = `/chat?prompt=${encodeURIComponent('Help me set up a schedule, event trigger, watch, or reminder. Ask what I want to happen and when.')}`;

  return (
    <Page
      title="Schedule & events"
      subtitle="See what happens next. Pause a schedule, run it now, or ask Clem to set up something new."
      actions={<Link to={setupHref}><Button size="sm">Set up with Clem</Button></Link>}
    >
      {feedback && <div role={feedback.error ? 'alert' : 'status'} className={`mb-4 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-small ${feedback.error ? 'border-warning/40 text-fg' : 'border-border text-muted'}`}>
        <p className="min-w-0 flex-1">{feedback.text}</p>
        {feedback.href && <Link className="font-semibold text-primary hover:underline" to={feedback.href}>{feedback.label}</Link>}
        {feedback.error && <Button variant="ghost" size="sm" onClick={() => { void q.refetch(); }}>Refresh status</Button>}
      </div>}
      {q.isError && (view ? <AutomationRefreshNotice className="mb-4" title="Showing last loaded schedules and events" description="Refresh before relying on their status." onRetry={() => { void q.refetch(); }} /> : <QueryUnavailable title="Triggers are unavailable" description={q.error instanceof Error ? q.error.message : undefined} onRetry={() => { void q.refetch(); }} />)}
      {!view && !q.isError && <Skeleton className="h-40" />}
      {view && (
        <div className="flex flex-col gap-6">
          <section>
            <h2 className="mb-2 text-h2 text-fg">Next up</h2>
            {nextItems.length === 0
              ? hasSources ? <p className="text-small text-muted">Nothing due in the next week. Event-driven work still runs when its trigger arrives.</p>
                : <EmptyState title="Let Clem handle the timing" description="Set a schedule, watch for an event, or ask for a reminder. Everything that happens next will appear here." action={<Link to={setupHref}><Button>Set up with Clem</Button></Link>} />
              : (
                <Card>
                  <ul className="divide-y divide-border">
                    {nextItems.slice(0, 12).map((item) => {
                      const Icon = KIND_ICON[item.kind];
                      return (
                        <li key={item.key} className="flex items-start gap-3 py-3">
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                          <span className="w-28 shrink-0 text-small text-muted">{whenLabel(item.at)}</span>
                          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-1">
                            {item.href ? <Link to={item.href} className="inline-flex min-w-0 items-center gap-1.5 font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"><span className="break-words">{item.title}</span><ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></Link> : <span className="min-w-0 break-words text-fg">{item.title}</span>}
                            <span className="ml-auto text-small text-muted" title={item.technicalDetail}>{item.detail}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
          </section>

          {scheduledWorkflows(view).length > 0 && <section>
            <h2 className="mb-2 text-h2 text-fg">On a schedule</h2>
            {scheduledWorkflows(view).length === 0
              ? <EmptyState title="No schedules yet" description="Tell Clem: “every weekday at 8, send me the brief.”" />
              : scheduledWorkflows(view).map((row) => (
                <Card key={row.name} className="mb-2">
                  <div className="flex items-center gap-3">
                    <Switch checked={row.enabled} disabled={busy !== null}
                      onChange={(enabled: boolean) => { void act(`pause:${row.name}`, () => setWorkflowEnabled(row.name, enabled)); }}
                      label={row.enabled ? `Pause ${workflowDisplayName(row.name, row.description)}` : `Resume ${workflowDisplayName(row.name, row.description)}`} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">{workflowDisplayName(row.name, row.description)}</Link>
                      <div className="text-small text-muted">
                        {row.schedule ? humanizeCron(row.schedule, row.timezone ?? undefined) : row.onceAt ? `Once, ${whenLabel(row.onceAt)}` : 'On an interval'}
                        {!row.enabled && ' · paused'}
                      </div>
                    </div>
                    <StatusPill tone={outcomeTone(row)}>{lastRunWords(row)}</StatusPill>
                    <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => act(`run:${row.name}`, () => runWorkflow(row.name), row.name)} aria-label={`Run ${workflowDisplayName(row.name, row.description)} now`}>
                      {busy === `run:${row.name}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                      Run now
                    </Button>
                  </div>
                </Card>
              ))}
          </section>}

          {webhookWorkflows(view).length > 0 && <section>
            <h2 className="mb-2 text-h2 text-fg">When something calls in</h2>
            {webhookWorkflows(view).length === 0
              ? <EmptyState title="No webhooks yet" description="Tell Clem: “when my form tool posts a new lead, start the intake workflow.”" />
              : webhookWorkflows(view).map((row) => {
                const url = webhookAddress(view, row);
                return (
                  <Card key={row.name} className="mb-2">
                    <div className="flex items-center gap-3">
                      <Webhook className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">{workflowDisplayName(row.name, row.description)}</Link>
                        <div className="select-text break-all text-small text-muted" title={url}>POST {url}{!row.enabled && ' · paused'}</div>
                        <div className="text-small text-muted">Paste this address into the service that should call it. It starts this one workflow and nothing else, so keep it between you and that service.</div>
                      </div>
                      <StatusPill tone={outcomeTone(row)}>{lastRunWords(row)}</StatusPill>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => copy(url)} aria-label={`Copy the address for ${row.name}`}><Copy className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  </Card>
                );
              })}
          </section>}

          {(eventWorkflows(view).length > 0 || activeWatches(view).length > 0) && <section>
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
                          <Link to={`/automate/${encodeURIComponent(row.name)}`} className="block truncate font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">{workflowDisplayName(row.name, row.description)}</Link>
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
          </section>}

          {pendingReminders(view).length > 0 && <section>
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
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act(`cancel:${reminder.id}`, () => cancelReminder(reminder.id))} aria-label={`Cancel the reminder ${reminder.message}`}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </Card>
              ))}
          </section>}
        </div>
      )}
    </Page>
  );
}
