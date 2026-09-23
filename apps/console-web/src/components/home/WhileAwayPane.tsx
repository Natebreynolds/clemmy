import { Link } from 'react-router-dom';
import { AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { awayMeta, awayOutcome, awayTarget, clockLabel, plainText, type HomeFeedItem } from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 5;

/**
 * WHILE YOU WERE AWAY — durable updates, including informational notices.
 * Notification delivery must not be presented as task completion.
 */
export function WhileAwayPane({
  items,
  loading,
  error,
  onRetry,
  headingId,
}: {
  items: readonly HomeFeedItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
}) {
  const visible = items.slice(0, MAX_ROWS);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="While you were away"
        aside={
          <Link to="/inbox?tab=notifications" className="rounded-sm font-semibold text-primary hover:underline">
            All in Inbox
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
