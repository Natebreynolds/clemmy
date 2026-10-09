import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Play, Wrench, Zap } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { feedTime, type SpaceFeed } from '@/lib/spaces';

/**
 * What fills this Space, in one line under its title: the workflow, how its
 * last run went, when it runs next, and Run now. A failed run offers Clem's
 * help; she reads the engine's reason and explains it in her own words, so the
 * line never shows engine text. Renders nothing for a Space no workflow feeds.
 */
export function SpaceFeedLine({
  feeds,
  running,
  busy,
  onRunNow,
  onAskClemToFix,
}: {
  feeds: SpaceFeed[];
  /** The feed's run is in progress right now. */
  running: boolean;
  busy: boolean;
  onRunNow: (feed: SpaceFeed) => void;
  onAskClemToFix: (feed: SpaceFeed) => void;
}) {
  const navigate = useNavigate();
  const feed = feeds.find((f) => f.role === 'primary') ?? feeds[0];
  if (!feed) return null;
  const others = feeds.length - 1;
  const last = feed.lastRun;
  const failed = !running && last?.state === 'failed';
  const lastText = running || last?.state === 'running'
    ? 'running now'
    : !last
      ? 'hasn’t run yet'
      : last.state === 'failed'
        ? `last run failed ${feedTime(last.at)}`
        : last.state === 'waiting'
          ? `waiting on you since ${feedTime(last.at)}`
          : `updated ${feedTime(last.finishedAt ?? last.at)}`;
  const nextText = !feed.enabled
    ? 'turned off'
    : feed.nextRunAt
      ? `next ${feedTime(feed.nextRunAt)}`
      : 'runs when started';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface px-4 py-2 text-small">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
        {running
          ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          : <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        Fed by
        <button
          type="button"
          onClick={() => navigate(`/automate?workflow=${encodeURIComponent(feed.title)}`)}
          title={feed.description || 'Open this workflow'}
          className="min-w-0 max-w-[18rem] truncate font-medium text-fg hover:text-primary hover:underline"
        >
          {feed.title}
        </button>
        {others > 0 && <span className="text-faint">+{others} more</span>}
      </span>
      <span className={failed ? 'inline-flex items-center gap-1 text-warning' : 'text-muted'}>
        {failed && <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
        {lastText}
      </span>
      <span className="text-faint">· {nextText}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {failed && (
          <Button size="sm" variant="secondary" onClick={() => onAskClemToFix(feed)}>
            <Wrench className="h-3.5 w-3.5" aria-hidden /> Ask Clem to fix
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy || running || !feed.enabled} onClick={() => onRunNow(feed)}>
          <Play className="h-3.5 w-3.5" aria-hidden /> Run now
        </Button>
      </div>
    </div>
  );
}
