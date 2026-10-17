/**
 * What Clem can see: every source the owner has handed Clem to keep an eye on.
 *
 * Owner, 2026-10-17: giving Clem access to an inbox, a Drive folder or a Slack
 * channel should feel like giving it to a real assistant, and what she learns
 * from each should compound. Each card says what she watches, what she looks
 * for, how often, what she found (and whether it reached the owner), and what
 * she learned. The owner shapes a watch here (on or off, phone or app, rules
 * in their own words) or in chat; setting one up is a conversation.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, Loader2, MessageSquare, Play, Plus, Trash2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, Tag } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { humanizeCron } from '@/lib/cron';
import { runWorkflow, setWorkflowEnabled } from '@/lib/automate';
import {
  addWatchRule, heldWords, listWatches, NEW_WATCH_PROMPT, refineWatchPrompt, removeWatchRule, setWatchNotify,
  type WatchRow,
} from '@/lib/watches';

function ago(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function howOften(watch: WatchRow): string {
  if (watch.onEvents) return 'As things arrive';
  if (watch.schedule) return humanizeCron(watch.schedule, watch.timezone);
  return 'When you ask';
}

function lastCheckWords(watch: WatchRow): string {
  const run = watch.lastRun;
  if (!run) return 'Not checked yet';
  if (run.report === 'missing') return `Checked ${ago(run.at)}, but the check didn’t return what it found`;
  if (run.findings === 0) return `Checked ${ago(run.at)}: nothing new`;
  return `Checked ${ago(run.at)}: ${run.findings} new, ${run.surfaced} told you`;
}

export function Watches() {
  const q = usePoll(['watches'], listWatches, 30_000);
  const list = q.data?.watches ?? [];
  return (
    <Page
      title="What Clem can see"
      subtitle="The sources you’ve handed Clem to keep an eye on. What she finds reaches you in From Clem, and what she learns makes her better at your work."
      actions={(
        <Link to={`/chat?prompt=${encodeURIComponent(NEW_WATCH_PROMPT)}`}>
          <Button size="sm"><Plus size={16} aria-hidden /> Watch something new</Button>
        </Link>
      )}
    >
      {q.isLoading && list.length === 0 ? (
        <Skeleton className="h-64" />
      ) : q.isError && list.length === 0 ? (
        <QueryUnavailable title="Watches are unavailable" description="Clementine couldn’t load them, so this is not an empty list. Nothing has been turned off." onRetry={() => { void q.refetch(); }} />
      ) : list.length === 0 ? (
        <Card className="px-5 py-6">
          <div className="flex items-start gap-3">
            <Eye size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 space-y-2">
              <h3 className="text-h3 text-fg">Nothing to watch yet</h3>
              <p className="max-w-2xl text-small text-muted">
                Hand Clem a source the way you would a personal assistant: an inbox or label, a Slack channel, a Drive folder, a CRM view.
                Tell her what matters there, and she’ll keep an eye on it and tell you when something comes up.
              </p>
              <p className="text-small text-muted">For example: “Keep an eye on #platform-49 and tell me if a client sounds unhappy.”</p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4">
          {q.isError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 px-4 py-3 text-small">
              <p className="min-w-0 flex-1 text-fg">These are the last loaded watches. Refresh before relying on their status.</p>
              <Button variant="secondary" size="sm" onClick={() => { void q.refetch(); }}>Retry</Button>
            </div>
          ) : null}
          {list.map((watch) => <WatchCard key={watch.slug} watch={watch} />)}
        </div>
      )}
    </Page>
  );
}

function WatchCard({ watch: w }: { watch: WatchRow }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleText, setRuleText] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['watches'] }); void qc.invalidateQueries({ queryKey: ['from-clem'] }); };
  const run = async (what: string, fn: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(what); setError(null); setNote(null);
    try { await fn(); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const checkNow = () => run('run', async () => {
    await runWorkflow(w.name);
    setNote('Checking now. What she finds will show here and in From Clem.');
  });
  const addRule = () => {
    const text = ruleText.trim();
    if (!text) return;
    void run('rule', async () => { await addWatchRule(w.slug, text); setRuleText(''); });
  };
  const broken = w.lastRun?.report === 'missing';

  return (
    <Card className="p-0">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">{w.source}</h3>
            <StatusPill tone={!w.enabled ? 'neutral' : broken ? 'warning' : 'live'}>
              {!w.enabled ? 'Paused' : broken ? 'Needs a look' : w.purpose === 'learn' ? 'Learning' : 'Watching'}
            </StatusPill>
          </div>
          <p className="mt-1 max-w-3xl text-small text-muted">
            {w.purpose === 'learn' ? 'Learns from it, and tells you only when you ask.' : <>Looks for <span className="text-fg">{w.lookFor}</span>.</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch checked={w.enabled} onChange={(v) => { void run('enabled', () => setWorkflowEnabled(w.name, v)); }} label={`${w.source} watch on or off`} disabled={busy !== null} />
          <span className="text-small text-fg">{w.enabled ? 'On' : 'Off'}</span>
        </div>
      </div>

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-muted">
            <span>{howOften(w)}</span>
            {w.purpose === 'tell_me' ? (
              <label className="inline-flex items-center gap-2">
                Tell me
                <select
                  aria-label={`${w.source} delivery`}
                  className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
                  value={w.notify}
                  disabled={busy !== null}
                  onChange={(e) => { void run('notify', () => setWatchNotify(w.slug, e.target.value as 'quiet' | 'push')); }}
                >
                  <option value="quiet">in the app</option>
                  <option value="push">on my phone too</option>
                </select>
              </label>
            ) : null}
            <span>{lastCheckWords(w)}</span>
          </div>
          {broken ? (
            <p className="text-caption text-warning">
              Its last check finished without saying what it found. <Link className="font-semibold text-primary hover:underline" to={`/chat?prompt=${encodeURIComponent(`${refineWatchPrompt(w)}its last check didn’t report what it found. Please fix it.`)}`}>Ask Clem to fix it</Link>
            </p>
          ) : null}

          <section>
            <div className="mb-1.5 text-label text-fg">What she found</div>
            {w.findings.length === 0 ? (
              <p className="text-small text-muted">{w.lastRun ? 'Nothing new yet.' : 'She hasn’t checked yet.'}</p>
            ) : (
              <ul className="space-y-1.5">
                {w.findings.map((finding) => (
                  <li key={`${finding.key}-${finding.at}`} className="rounded-md border border-border bg-surface px-3 py-2 text-small">
                    <div className="flex flex-wrap items-center gap-2">
                      <Tag>{heldWords(finding)}</Tag>
                      <span className="min-w-0 flex-1 font-medium text-fg">{finding.title}</span>
                      <span className="text-caption text-faint">{ago(finding.at)}</span>
                    </div>
                    {finding.detail ? <p className="mt-0.5 line-clamp-2 text-caption text-muted" title={finding.detail}>{finding.detail}</p> : null}
                    {finding.link && /^https?:\/\//i.test(finding.link) ? (
                      <a className="text-caption font-semibold text-primary hover:underline" href={finding.link} target="_blank" rel="noreferrer">Open</a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-1.5 text-label text-fg">What she learned</div>
            {w.learned.length === 0 ? (
              <p className="text-small text-muted">Nothing yet. What she learns here goes into her memory, so her suggestions get better at your work.</p>
            ) : (
              <ul className="space-y-1 text-small text-fg">
                {w.learned.map((entry) => (
                  <li key={`${entry.text}-${entry.at}`} className="flex items-start gap-2">
                    <span className="text-faint">•</span>
                    <span className="min-w-0 flex-1">{entry.text}</span>
                    <span className="shrink-0 text-caption text-faint">{ago(entry.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={checkNow} disabled={busy !== null || !w.enabled}>
              {busy === 'run' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Play size={16} aria-hidden />}
              Check now
            </Button>
            <Link to={`/chat?prompt=${encodeURIComponent(refineWatchPrompt(w))}`}>
              <Button variant="ghost" size="sm">
                <MessageSquare size={16} aria-hidden />
                Change with Clementine
              </Button>
            </Link>
            {note ? <span className="text-caption text-muted" role="status">{note}</span> : null}
            {error ? <span className="text-caption text-danger" role="alert">{error}</span> : null}
          </div>
        </div>

        <aside className="min-w-0">
          <div className="mb-1.5 text-label text-fg">Your rules</div>
          <p className="mb-2 text-caption text-muted">In your own words. Clementine applies them to everything this watch finds before it reaches you.</p>
          {w.rules.length === 0 ? (
            <p className="mb-2 text-small text-muted">No rules yet.</p>
          ) : (
            <ul className="mb-2 space-y-1.5">
              {w.rules.map((rule, i) => (
                <li key={rule.id} className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-small">
                  <span className="text-faint">{i + 1}.</span>
                  <span className="min-w-0 flex-1 text-fg">{rule.text}</span>
                  <button
                    type="button"
                    aria-label="Remove this rule"
                    className={cn('shrink-0 rounded-sm p-1 text-faint hover:bg-subtle hover:text-danger cursor-pointer', busy !== null && 'opacity-50')}
                    disabled={busy !== null}
                    onClick={() => { void run('remove', () => removeWatchRule(w.slug, rule.id)); }}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={ruleText}
              onChange={(e) => setRuleText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } }}
              placeholder="e.g. Only during work hours."
              aria-label={`Add a rule to the ${w.source} watch`}
              disabled={busy !== null}
            />
            <Button size="sm" variant="secondary" onClick={addRule} disabled={busy !== null || !ruleText.trim()} aria-label="Add rule">
              {busy === 'rule' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Plus size={16} aria-hidden />}
            </Button>
          </div>
        </aside>
      </div>
    </Card>
  );
}
