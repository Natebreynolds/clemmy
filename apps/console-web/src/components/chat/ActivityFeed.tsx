/**
 * Shared, presentational row primitives for the "watch the team work" surfaces —
 * the inline chat strip (TurnActivity) and the board drawer's full-height live
 * feed (LiveFeed) both render ActivityItem rows THROUGH these, so a tool call, a
 * spawned agent, a run_batch meter, or a plain-human effect ("Sent a message to
 * …") reads identically wherever it appears. One vocabulary, one set of icons.
 */
import { useEffect, useState } from 'react';
import { Wrench, Users, Check, X, Zap, Send, AlertCircle, CheckCircle2, Radio, Dot } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';

export const PROVIDER_DOT: Record<NonNullable<ActivityItem['provider']>, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  byo: '#4f8fc0',
  glm: '#7c6cf0',
  unknown: '#8a8f98',
};

const TONE_TEXT: Record<NonNullable<ActivityItem['tone']>, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  live: 'text-primary',
  muted: 'text-faint',
};

export function StatusIcon({ status }: { status: ActivityItem['status'] }) {
  if (status === 'running') {
    return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary/80" aria-hidden />;
  }
  if (status === 'failed') return <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />;
  return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />;
}

export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 1) return '';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
}

/** Tick once a second while `active`, else stay quiescent (no interval). */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** One run_batch as a live meter: label, thin progress bar, honest counts. */
export function BatchRow({ a, now, live }: { a: ActivityItem; now: number; live: boolean }) {
  const b = a.batch ?? { done: 0, total: 0, failed: 0 };
  const pct = b.total > 0 ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0;
  const running = live && a.status === 'running';
  return (
    <li className="flex flex-col gap-1 py-0.5 text-caption">
      <div className="flex items-center gap-2">
        <Zap className="h-3 w-3 shrink-0 text-primary" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', running ? 'text-fg' : 'text-muted')}>{a.label}</span>
        <span className="shrink-0 tabular-nums text-faint">
          {b.done}/{b.total}
          {b.failed > 0 && <span className="text-danger"> · {b.failed} failed</span>}
          {running && b.throttled && <span className="text-warning"> · throttled, backing off…</span>}
          {running && elapsedLabel(a.startedAt, now) && <span> · {elapsedLabel(a.startedAt, now)}</span>}
        </span>
        <StatusIcon status={a.status} />
      </div>
      <div className="ml-5 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60" role="progressbar" aria-valuenow={b.done} aria-valuemin={0} aria-valuemax={b.total}>
          <div
            className={cn('h-full rounded-full transition-all duration-300', a.status === 'failed' ? 'bg-danger' : 'bg-primary', running && 'animate-pulse')}
            style={{ width: `${pct}%` }}
          />
        </div>
        {running && a.detail && <span className="max-w-40 shrink-0 truncate text-faint">→ {a.detail}</span>}
      </div>
    </li>
  );
}

/** The leading glyph for a kind 'event' row — a real effect or a lifecycle beat.
 *  Driven by `tone`/`variant`, not `status`, so it's meaningful even when the row
 *  carries no running/done semantics. */
function EventIcon({ a }: { a: ActivityItem }) {
  const color = TONE_TEXT[a.tone ?? 'muted'];
  if (a.variant === 'program') return <Zap className={cn('h-3 w-3 shrink-0', color)} aria-hidden />;
  if (a.status === 'failed' || a.tone === 'danger') return <X className={cn('h-3.5 w-3.5 shrink-0', color)} aria-hidden />;
  if (a.tone === 'warning') return <AlertCircle className={cn('h-3.5 w-3.5 shrink-0', color)} aria-hidden />;
  if (a.variant === 'write') return <Send className={cn('h-3 w-3 shrink-0', color)} aria-hidden />;
  if (a.tone === 'success') return <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', color)} aria-hidden />;
  if (a.tone === 'live') return <Radio className={cn('h-3 w-3 shrink-0 animate-breathe', color)} aria-hidden />;
  return <Dot className={cn('h-4 w-4 shrink-0', color)} aria-hidden />;
}

/** One non-batch activity row (tool / agent / trust check / effect-or-lifecycle
 *  event). `showDetails` reveals the demoted power-user detail (an agent's model
 *  id) — the plain-human label is always the default. */
export function ActivityRow({ a, now, live, showDetails = false }: {
  a: ActivityItem;
  now: number;
  live: boolean;
  showDetails?: boolean;
}) {
  const running = live && a.status === 'running';
  const elapsed = running ? elapsedLabel(a.startedAt, now) : '';
  const isEvent = a.kind === 'event';
  const detailVisible = a.detail && (a.kind === 'tool' || a.kind === 'check' || isEvent || (a.kind === 'agent' && showDetails));
  return (
    <li className="flex items-center gap-2 text-caption">
      {a.kind === 'agent' ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
      ) : a.kind === 'check' ? (
        <Check className={cn('h-3 w-3 shrink-0', a.status === 'failed' ? 'text-warning' : 'text-success')} aria-hidden />
      ) : isEvent ? (
        <EventIcon a={a} />
      ) : (
        <Wrench className="h-3 w-3 shrink-0 text-faint" aria-hidden />
      )}
      <span className={cn('min-w-0 truncate', running || (isEvent && a.tone && a.tone !== 'muted') ? 'text-fg' : 'text-muted')}>{a.label}</span>
      {detailVisible && (
        <span className="min-w-0 flex-1 truncate text-faint">→ {a.detail}</span>
      )}
      {!detailVisible && <span className="flex-1" />}
      {elapsed && <span className="shrink-0 tabular-nums text-faint">{elapsed}</span>}
      {!isEvent && <StatusIcon status={a.status} />}
    </li>
  );
}

/**
 * The board drawer's unified live feed: ONE chronological column (tools, agents,
 * batch meters, external-write effects, code-mode programs, and lifecycle beats),
 * newest at the bottom. Unlike the chat strip it does NOT own a scroller — it
 * grows and lets the drawer's single overflow column scroll (so the panel scrolls
 * as a whole, and the drawer can keep it pinned to the bottom while live).
 */
export function LiveFeed({ items, live, showDetails }: {
  items: ActivityItem[];
  live: boolean;
  showDetails: boolean;
}) {
  const now = useNowTick(live && items.some((a) => a.status === 'running'));
  if (items.length === 0) {
    return <p className="text-body text-faint">No activity yet — it streams in as the agent works.</p>;
  }
  // Turn's over → a still-'running' row reads as done (no perpetual spinners).
  const view = live ? items : items.map((a) => (a.status === 'running' ? { ...a, status: 'done' as const } : a));
  const agents = view.filter((a) => a.kind === 'agent');
  const doneAgents = agents.filter((a) => a.status !== 'running').length;
  return (
    <div>
      {agents.length > 1 && (
        <div className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-faint">
          <Users className="h-3.5 w-3.5" aria-hidden />
          {live && doneAgents < agents.length ? `${doneAgents} of ${agents.length} done` : `${agents.length} agents`}
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {view.map((a) => (a.kind === 'batch'
          ? <BatchRow key={a.id} a={a} now={now} live={live} />
          : <ActivityRow key={a.id} a={a} now={now} live={live} showDetails={showDetails} />))}
      </ul>
    </div>
  );
}
