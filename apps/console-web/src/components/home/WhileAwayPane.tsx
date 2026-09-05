import { Link } from 'react-router-dom';
import { AlertCircle, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { awayMeta, awayOutcome, awayTarget, clockLabel, type HomeFeedItem } from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 6;

/**
 * WHILE YOU WERE AWAY — the durable results feed (settled writes, delivered
 * reports, finished tasks). Never inferred from chat prose: every row is a
 * record the daemon wrote when the work actually finished.
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
          <QuietLine>Nothing new yet — finished work lands here.</QuietLine>
        ) : (
          visible.map((item, index) => {
            const outcome = awayOutcome(item);
            const href = awayTarget(item);
            const meta = awayMeta(item);
            const time = clockLabel(item.createdAt);
            const body = (
              <>
                <span
                  className={cn('inline-flex shrink-0', outcome === 'success' ? 'text-success' : 'text-warning')}
                  aria-label={outcome === 'success' ? 'Done' : 'Needs a look'}
                  role="img"
                >
                  {outcome === 'success'
                    ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
                    : <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
                </span>
                <span className="min-w-0 shrink-0 max-w-[55%] truncate text-body font-medium text-fg" title={item.title}>
                  {item.title ?? 'Finished'}
                </span>
                {meta && <span className="min-w-0 flex-1 truncate text-body text-muted" title={meta}>{meta}</span>}
                {time && <span className="ml-auto shrink-0 text-caption text-faint">{time}</span>}
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
