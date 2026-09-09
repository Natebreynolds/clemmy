/**
 * ActivityCard — the ONE build log. Owner, 2026-09-08 (approved mockup):
 * "seeing what Clem is doing while she's doing it is key". A turn, a Space
 * build and a background task all render their ActivityItem rows through this
 * card: a head with a live pulse and a m:ss clock, a stepped list on a thin
 * rail (icon, plain label, mono detail, mono elapsed), helpers as their own
 * rows with the steps they report nested underneath, the rolling thinking line
 * inside the card while live, and a results-first one-liner once settled.
 * Batch meters and the read-result peek keep the shared row primitives.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, X, AlertCircle, Send, Zap, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';
import { BatchRow, PROVIDER_DOT, useNowTick } from '@/components/chat/ActivityFeed';
import { narrateActivity, settleTerminalActivity, type ActivityTerminalOutcome } from '@/lib/activity-presentation';
import { activityCardHead, clockLabel, groupActivityByParent, stepElapsed } from '@/lib/activity-card';

function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary/30 border-t-primary', className)} aria-hidden />;
}

function StepIcon({ a, live }: { a: ActivityItem; live: boolean }) {
  if (a.kind === 'agent') {
    return (
      <span className="relative flex h-[18px] w-[18px] items-center justify-center rounded-full bg-surface">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
        {live && a.status === 'running' && <span className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />}
      </span>
    );
  }
  const shell = 'flex h-[18px] w-[18px] items-center justify-center rounded-full bg-surface';
  if (a.status === 'running' && live) return <span className={shell}><Spinner /></span>;
  if (a.status === 'failed' || a.tone === 'danger') return <span className={shell}><X className="h-3 w-3 text-danger" strokeWidth={2.25} aria-hidden /></span>;
  if (a.status === 'interrupted' || a.tone === 'warning') return <span className={shell}><AlertCircle className="h-3 w-3 text-warning" strokeWidth={2.25} aria-hidden /></span>;
  if (a.kind === 'event' && a.variant === 'write') return <span className={shell}><Send className="h-3 w-3 text-success" strokeWidth={2.25} aria-hidden /></span>;
  if (a.kind === 'event' && a.variant === 'program') return <span className={shell}><Zap className="h-3 w-3 text-primary" strokeWidth={2.25} aria-hidden /></span>;
  return <span className={shell}><Check className="h-3 w-3 text-success" strokeWidth={2.25} aria-hidden /></span>;
}

function StepRow({ a, now, live, nested }: { a: ActivityItem; now: number; live: boolean; nested?: boolean }) {
  const running = live && a.status === 'running';
  const [peek, setPeek] = useState<boolean | null>(null);
  const showExcerpt = Boolean(a.excerpt) && (peek ?? live);
  const elapsed = stepElapsed(a, now, live);
  const right = elapsed || (a.repeats && a.repeats > 1 ? `×${a.repeats}` : '');
  return (
    <li className={cn('grid grid-cols-[18px_1fr_auto] items-start gap-x-2.5 py-1.5', nested && 'ml-7')}>
      <StepIcon a={a} live={live} />
      <span className="min-w-0">
        <span className={cn('block truncate text-body', running ? 'font-semibold text-fg' : a.kind === 'agent' ? 'font-medium text-fg' : 'text-muted')}>{a.label}</span>
        {a.detail && <span className="block truncate font-mono text-caption text-faint">{a.detail}</span>}
        {showExcerpt && (
          <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-sm bg-subtle px-2.5 py-2 font-sans text-caption leading-relaxed text-muted">{a.excerpt}</pre>
        )}
      </span>
      <span className="flex items-center gap-2 pt-0.5 font-mono text-caption tabular-nums text-faint">
        {a.excerpt && (
          <button type="button" onClick={() => setPeek(!showExcerpt)} aria-expanded={showExcerpt} className="font-sans transition-colors hover:text-muted">{showExcerpt ? 'hide' : 'peek'}</button>
        )}
        {right}
      </span>
    </li>
  );
}

export function ActivityCard({
  items,
  live,
  terminalOutcome,
  progress,
  title,
  traceHref,
  footer,
  defaultOpen,
  className,
}: {
  items: ActivityItem[];
  live: boolean;
  terminalOutcome?: ActivityTerminalOutcome;
  /** The engine's rolling human line ("Reading your calendar…") — rendered
   *  inside the card as the thinking line while live. */
  progress?: string;
  /** Overrides the derived head title (a Space build says "Building the Space"). */
  title?: string;
  traceHref?: string;
  footer?: ReactNode;
  /** Settled cards collapse to their one-liner unless told to stay open. */
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const anyRunning = live && items.some((a) => a.status === 'running');
  const now = useNowTick(live && (anyRunning || items.length === 0));
  const view = items.length > 0
    ? settleTerminalActivity(narrateActivity(items, { live }), live ? undefined : (terminalOutcome ?? 'interrupted'))
    : [];
  if (!live && view.length === 0) return null;
  const head = activityCardHead(view, live, now);
  const expanded = live || (open ?? defaultOpen ?? false);
  const { top, children } = groupActivityByParent(view);
  const clock = live ? clockLabel(head.startedAt, now) : (head.totalMs !== undefined ? clockLabel(0, head.totalMs) : '');
  const failed = !live && terminalOutcome === 'failed';

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('flex w-full items-center gap-2 text-left text-caption text-faint transition-colors hover:text-muted', className)}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-success')} aria-hidden />
        <span className="min-w-0 truncate">{head.title}</span>
        {clock && <span className="shrink-0 font-mono tabular-nums">{clock}</span>}
        <span className="shrink-0" aria-hidden>· show</span>
      </button>
    );
  }

  return (
    <section aria-live={live ? 'polite' : 'off'} aria-label="What Clementine is doing" className={cn('overflow-hidden rounded-lg border border-border bg-surface shadow-xs', className)}>
      <header className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        {live
          ? <span className="h-2 w-2 shrink-0 animate-breathe rounded-full bg-primary shadow-[0_0_0_3px_var(--primary-tint)]" aria-hidden />
          : <span className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-success')} aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg">{title ?? head.title}</span>
        {head.helpers > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-caption text-faint" title={`${head.helpers} helper${head.helpers > 1 ? 's' : ''}`}>
            <Users className="h-3.5 w-3.5" aria-hidden />{head.helpers}
          </span>
        )}
        {clock && <span className="shrink-0 font-mono text-caption tabular-nums text-faint">{clock}</span>}
      </header>
      {view.length > 0 && (
        <ol className="relative mx-4 mb-1 list-none p-0 before:absolute before:bottom-3 before:left-[8.5px] before:top-2 before:w-px before:bg-border-strong/60">
          {top.map((a) => (
            a.kind === 'batch'
              ? <BatchRow key={a.id} a={a} now={now} live={live} />
              : (
                <li key={a.id} className="list-none">
                  <ol className="list-none p-0"><StepRow a={a} now={now} live={live} /></ol>
                  {children.get(a.id) && (
                    <ol className="list-none p-0">
                      {children.get(a.id)!.map((c) => <StepRow key={c.id} a={c} now={now} live={live} nested />)}
                    </ol>
                  )}
                </li>
              )
          ))}
        </ol>
      )}
      {live && (progress || view.length === 0) && (
        <p className="flex items-start gap-2.5 px-4 pb-3 pt-1 text-body italic text-muted">
          <Spinner className="mt-1.5" />
          <span className="min-w-0">{progress ?? 'Thinking…'}</span>
        </p>
      )}
      {(footer || traceHref || (!live && open)) && (
        <footer className="flex items-center gap-3 border-t border-border/60 px-4 py-2 text-caption text-faint">
          <span className="min-w-0 flex-1 truncate">{footer}</span>
          {traceHref && (
            <Link to={traceHref} className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary transition-colors hover:text-primary/80">
              Full trace <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
          {!live && open && (
            <button type="button" onClick={() => setOpen(false)} className="shrink-0 transition-colors hover:text-muted">hide</button>
          )}
        </footer>
      )}
    </section>
  );
}
