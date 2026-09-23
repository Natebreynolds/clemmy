import { Link } from 'react-router-dom';
import { AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { awayMeta, awayOutcome, awayTarget, clockLabel, plainText, type HomeFeedItem } from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 5;

/**
 * WHAT CAME BACK — durable updates, including informational notices, as a
 * list (a tile) or a timeline down the page (Briefing). Notification delivery
 * must not be presented as task completion.
 */
export function WhileAwayPane({
  items,
  loading,
  error,
  onRetry,
  headingId,
  variant = 'list',
}: {
  items: readonly HomeFeedItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
  variant?: 'list' | 'timeline';
}) {
  const visible = items.slice(0, MAX_ROWS);
  if (variant === 'timeline' && !loading && !error && visible.length > 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
        <SectionHeader
          id={headingId}
          label="What came back"
          aside={<Link to="/inbox?tab=notifications" className="rounded-sm font-semibold text-primary hover:underline">All updates</Link>}
        />
        <ol className="relative flex flex-col gap-3.5 rounded-md border border-border bg-surface px-5 py-4 before:absolute before:bottom-6 before:left-[7rem] before:top-6 before:w-px before:bg-border-strong">
          {visible.map((item, index) => {
            const outcome = awayOutcome(item);
            const href = awayTarget(item);
            const meta = awayMeta(item);
            const key = item.notifId ?? item.taskId ?? item.targetRunId ?? `${index}:${item.title ?? ''}`;
            const text = (
              <span className="min-w-0 flex-1 text-body">
                <span className="font-semibold text-fg">{plainText(item.title, 160) || 'Update from Clem'}</span>
                {meta && <span className="text-muted"> — {plainText(meta, 200)}</span>}
              </span>
            );
            return (
              <li key={key} className="relative flex items-baseline gap-4">
                <span className="w-[4.5rem] shrink-0 text-caption tabular-nums text-faint">{clockLabel(item.createdAt)}</span>
                <span
                  className={cn('relative z-10 mt-1 h-2.5 w-2.5 shrink-0 self-start rounded-full border-2 bg-surface', outcome === 'update' ? 'border-border-strong' : 'border-warning')}
                  aria-label={outcome === 'update' ? 'Update' : 'Needs a look'}
                  role="img"
                />
                {href ? <Link to={href} className="min-w-0 flex-1 hover:[&_span.font-semibold]:text-primary">{text}</Link> : text}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="What came back"
        aside={
          <Link to="/inbox?tab=notifications" className="rounded-sm font-semibold text-primary hover:underline">
            All updates
          </Link>
        }
      />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={3} />
        ) : error ? (
          <LoadFailedLine what="recent results" onRetry={onRetry} />
        ) : visible.length === 0 ? (
          <QuietLine>Nothing new yet — updates land here.</QuietLine>
        ) : (
          visible.map((item, index) => {
            const outcome = awayOutcome(item);
            const href = awayTarget(item);
            const meta = awayMeta(item);
            const time = clockLabel(item.createdAt);
            const body = (
              <>
                <span
                  className={cn('inline-flex shrink-0 self-start pt-1', outcome === 'update' ? 'text-muted' : 'text-warning')}
                  aria-label={outcome === 'update' ? 'Update' : 'Needs a look'}
                  role="img"
                >
                  {outcome === 'update'
                    ? <Info className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
                    : <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
                </span>
                {/* Title over meta: side by side in a third of the window,
                    the meta got two or three characters ("- cle…"). */}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-medium text-fg" title={item.title}>
                    {plainText(item.title, 160) || 'Update from Clem'}
                  </span>
                  {meta && <span className="truncate text-small text-muted" title={meta}>{plainText(meta, 200)}</span>}
                </span>
                {time && <span className="shrink-0 self-start pt-0.5 text-caption text-faint">{time}</span>}
              </>
            );
            const key = item.notifId ?? item.taskId ?? item.targetRunId ?? `${index}:${item.title ?? ''}`;
            return href ? (
              <Link
                key={key}
                to={href}
                className="flex items-center gap-3 border-t border-border px-4 py-3 transition-colors first:border-t-0 hover:bg-hover"
              >
                {body}
              </Link>
            ) : (
              <PaneRow key={key}>{body}</PaneRow>
            );
          })
        )}
      </PaneCard>
    </section>
  );
}
