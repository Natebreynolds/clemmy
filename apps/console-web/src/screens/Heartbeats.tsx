/**
 * Heartbeats: everything Clementine checks on her own, in one place.
 *
 * Each card says what the heartbeat is for, how often it looks, when it last
 * did, what it found, and what is open. The owner shapes it here: on or off,
 * how often, whether its items stay in the app or push, and rules in their own
 * words that Jev applies to every item before it surfaces. "Refine with
 * Clementine" opens chat about the heartbeat; she has a tool that edits the
 * same contract, so a sentence in chat and a rule typed here land in the same
 * place.
 */
import { heartbeatStateWords, heartbeatLastCheckWords, workflowDisplayName } from '@clem/chat-engine';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { HeartPulse, Loader2, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, Tag } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoticingThinking } from '@/components/noticing/NoticingThinking';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  addHeartbeatRule, cadenceChoices, cadenceWords, listHeartbeats, patchHeartbeat, phonePushCaveat, refineHeartbeatPrompt, removeHeartbeatRule, tickHeartbeat,
  type HeartbeatItem, type HeartbeatStatus,
} from '@/lib/heartbeats';

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

function inWords(iso?: string): string {
  if (!iso) return '';
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (!Number.isFinite(min)) return '';
  if (min <= 0) return 'any moment';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

const KIND_WORDS: Record<string, string> = {
  proposal: 'Proposal',
  proposal_for_goal: 'For a goal',
  run_failed: 'Failed run',
  run_waiting: 'Still waiting',
  chat_waiting: 'Still waiting',
  draft_unsent: 'Unsent draft',
  cancelled: 'Cancelled',
  removed: 'Removed',
  conflict: 'Double-booked',
  invite_unanswered: 'Reply needed',
  moved: 'Moved',
  starting_soon: 'Starting soon',
};

export function Heartbeats() {
  const q = usePoll(['heartbeats'], listHeartbeats, 30_000);
  const list = q.data?.heartbeats ?? [];
  return (
    <Page
      title="Check-ins"
      subtitle="Choose what Clem checks on her own and how often. Decisions arrive in your Inbox."
    >
      {q.isLoading && list.length === 0 ? (
        <Skeleton className="h-64" />
      ) : q.isError && list.length === 0 ? (
        <QueryUnavailable title="Heartbeats are unavailable" description="Clementine couldn’t load them, so this is not an empty list. Nothing has been turned off." onRetry={() => { void q.refetch(); }} />
      ) : (
        <div className="grid gap-4">
          {(q.isError || (q.data?.unavailable?.length ?? 0) > 0) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 px-4 py-3 text-small">
            <p className="min-w-0 flex-1 text-fg">{q.isError ? 'These are the last loaded settings. Refresh before relying on their status.' : `${q.data?.unavailable?.map(item => item.title).join(', ')} status could not be loaded. Nothing has been turned off.`}</p>
            <Button variant="secondary" size="sm" onClick={() => { void q.refetch(); }}>Retry</Button>
          </div>}
          <p className="text-small text-muted"><Link to="/inbox?tab=needs" className="font-semibold text-primary hover:underline">Open Inbox</Link> to answer a suggestion or continue the conversation.</p>
          {list.length === 0 && !q.isError && !(q.data?.unavailable?.length) && <EmptyState title="No check-ins available" description="Ask Clem what she can keep an eye on for you." action={<Link to={`/chat?prompt=${encodeURIComponent('Help me choose what you should check on for me.')}`}><Button>Set up with Clem</Button></Link>} />}
          {list.map((h) => <HeartbeatCard key={h.id} heartbeat={h} />)}
        </div>
      )}
    </Page>
  );
}

function HeartbeatCard({ heartbeat: h }: { heartbeat: HeartbeatStatus }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleText, setRuleText] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['heartbeats'] }); void qc.invalidateQueries({ queryKey: ['command-center'] }); };
  const run = async (what: string, fn: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(what); setError(null); setNote(null);
    try { await fn(); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const checkNow = () => run('tick', async () => {
    const r = await tickHeartbeat(h.id);
    setNote(r.tick.summary);
  });
  const addRule = () => {
    const text = ruleText.trim();
    if (!text) return;
    void run('rule', async () => { await addHeartbeatRule(h.id, text); setRuleText(''); });
  };
  const open = h.openItems;

  return (
    <Card className="p-0">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">{h.title}</h3>
<StatusPill tone={h.running ? 'live' : h.presentation?.state === 'failed' || h.presentation?.state === 'partial' ? 'warning' : 'neutral'}>{heartbeatStateWords(h.presentation)}</StatusPill>
          </div>
          <p className="mt-1 max-w-3xl text-small text-muted">{h.purpose}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch checked={h.enabled} onChange={(v) => { void run('enabled', () => patchHeartbeat(h.id, { enabled: v })); }} label={`${h.title} on or off`} disabled={busy !== null} />
          <span className="text-small text-fg">{h.enabled ? 'On' : 'Off'}</span>
        </div>
      </div>

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-muted">
            <label className="inline-flex items-center gap-2">
              Looks
              <select
                aria-label={`${h.title} cadence`}
                className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
                value={h.cadenceMinutes}
                disabled={busy !== null}
                onChange={(e) => { void run('cadence', () => patchHeartbeat(h.id, { cadenceMinutes: Number(e.target.value) })); }}
              >
                {cadenceChoices(h.cadenceRange, h.cadenceMinutes).map((m) => <option key={m} value={m}>{cadenceWords(m)}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-2">
              Items
              <select
                aria-label={`${h.title} delivery`}
                className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
                value={h.contract.notify}
                disabled={busy !== null}
                onChange={(e) => { void run('notify', () => patchHeartbeat(h.id, { notify: e.target.value as 'quiet' | 'push' })); }}
              >
                <option value="quiet">stay in the app</option>
                <option value="push">reach my phone</option>
              </select>
            </label>
            <span>{heartbeatLastCheckWords(h.presentation)}{h.presentation?.lastCheck.at ? ` ${ago(h.presentation.lastCheck.at)}` : ''}{h.presentation?.nextCheckAt ? ` · next ${inWords(h.presentation.nextCheckAt)}` : ''}</span>
          </div>
          {h.contract.notify === 'push' && phonePushCaveat(h.phonePush) ? (
            <p className="text-caption text-warning">{phonePushCaveat(h.phonePush)}</p>
          ) : null}

          <div className="rounded-md border border-border bg-subtle px-3 py-2 text-small">
            <span className="text-muted">Last recorded result: </span>
            <span className="text-fg">{h.lastFinding ? h.lastFinding.summary : 'none yet'}</span>
            {h.lastError && h.presentation?.lastCheck.state !== 'recorded' ? <p className="mt-1 text-danger">{h.lastError.reason}</p> : null}
            <details className="mt-2 text-caption text-muted"><summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Check history</summary><div className="mt-1">
              {h.metrics.ticks} checks · {h.metrics.quietTicks} quiet · {h.metrics.itemsProduced} raised · {h.metrics.itemsAcknowledged} seen by you · {h.metrics.itemsRetired} resolved on their own · {h.metrics.modelCalls} model calls{h.metrics.modelVetoes ? ` (${h.metrics.modelVetoes} judged routine)` : ''}
            </div></details>
          </div>

          <section>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-label text-fg">Open now{open.length > 0 && <><span className="mr-auto text-caption font-normal text-muted">{open.length} {open.length === 1 ? 'item' : 'items'}</span><Link to="/inbox?tab=needs" className="text-small font-semibold text-primary hover:underline">Review in Inbox</Link></>}</div>
            {open.length === 0 ? (
              <p className="text-small text-muted">Nothing open.</p>
            ) : (
              <CheckInOpenItems items={open} />
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={checkNow} disabled={busy !== null || h.running}>
              {busy === 'tick' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <HeartPulse size={16} aria-hidden />}
              {h.running ? 'Checking…' : 'Check now'}
            </Button>
            <Link to={`/chat?prompt=${encodeURIComponent(refineHeartbeatPrompt(h.title))}`}>
              <Button variant="ghost" size="sm">
                <MessageSquare size={16} aria-hidden />
                Refine with Clementine
              </Button>
            </Link>
            {note ? <span className="text-caption text-muted" role="status">{note}</span> : null}
            {error ? <span className="text-caption text-danger" role="alert">{error}</span> : null}
          </div>
        </div>

        <aside className="min-w-0">
          <div className="mb-1.5 text-label text-fg">{h.rulesApply ? 'Your rules' : 'Your saved preferences'}</div>
          <p className="mb-2 text-caption text-muted">
            {h.rulesApply
              ? 'In your own words. Clementine applies them to every item before it reaches you.'
              : 'Saved preferences only: this check does not apply your rules automatically yet. Clem can read them when you discuss it.'}
          </p>
          {h.contract.rules.length === 0 ? (
            <p className="mb-2 text-small text-muted">No owner rules saved. Built-in relevance and delivery limits still apply.</p>
          ) : (
            <ul className="mb-2 space-y-1.5">
              {h.contract.rules.map((rule, i) => (
                <li key={rule.id} className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-small">
                  <span className="text-faint">{i + 1}.</span>
                  <span className="min-w-0 flex-1 text-fg">
                    {rule.text}
                    <span className="block text-caption text-faint">{rule.by === 'clementine' ? 'Added by Clementine, from what you said' : 'Added by you'} · {ago(rule.createdAt)}</span>
                  </span>
                  <button
                    type="button"
                    aria-label="Remove this rule"
                    className={cn('shrink-0 rounded-sm p-1 text-faint hover:bg-subtle hover:text-danger cursor-pointer', busy !== null && 'opacity-50')}
                    disabled={busy !== null}
                    onClick={() => { void run('remove', () => removeHeartbeatRule(h.id, rule.id)); }}
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
              placeholder="e.g. Skip anything from test or fixture workflows."
              aria-label={`Add a rule to ${h.title}`}
              disabled={busy !== null}
            />
            <Button size="sm" variant="secondary" onClick={addRule} disabled={busy !== null || !ruleText.trim()} aria-label="Add rule">
              {busy === 'rule' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Plus size={16} aria-hidden />}
            </Button>
          </div>
        </aside>
      </div>
      {h.id === 'noticing' ? <NoticingThinking /> : null}
    </Card>
  );
}

export function CheckInOpenItems({ items }: { items: HeartbeatItem[] }) {
  const rows = (list: HeartbeatItem[]) => <ul className="space-y-1.5">{list.map(item => <li key={item.key} className="border-b border-border py-2 text-small last:border-b-0">
    <div className="flex flex-wrap items-center gap-2">
      <Tag>{KIND_WORDS[item.kind] ?? item.kind}</Tag>
      <span className="min-w-0 flex-1 break-words font-medium text-fg">{workflowDisplayName(item.subject)}</span>
      <span className="text-caption text-faint">{ago(item.createdAt)}{item.acknowledgedAt ? ' · seen' : ''}</span>
    </div>
    {item.handoff?.sessionId && <Link className="font-semibold text-primary hover:underline" to={`/chat/${encodeURIComponent(item.handoff.sessionId)}`}>Open conversation</Link>}
    {item.handoff?.reason && <p className="mt-1 text-caption text-warning">{item.handoff.reason}</p>}
    {item.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-caption text-muted">{item.detail}</p>}
  </li>)}</ul>;
  return <>
    {rows(items.slice(0, 8))}
    {items.length > 8 && <details className="group mt-2">
      <summary className="cursor-pointer rounded-sm text-small font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span className="group-open:hidden">Show {items.length - 8} more {items.length - 8 === 1 ? 'item' : 'items'}</span><span className="hidden group-open:inline">Show fewer items</span>
      </summary>
      {rows(items.slice(8))}
    </details>}
  </>;
}
