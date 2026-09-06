import { Pin, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';

/**
 * The run's masthead: what it is, where it came from, how it is going, and the
 * one control that matters while it is going.
 *
 * Stop is rendered only when the caller resolved an exactly-identified
 * cancellation authority. A greyed-out Stop would say "this run can be
 * stopped, just not by you", which is not the situation.
 */
export function RunHeader({
  title,
  originLabel,
  status,
  steps,
  elapsed,
  pinned,
  onTogglePin,
  onStop,
  stopping,
}: {
  title: string;
  originLabel: string;
  status: { label: string; tone: Tone };
  /** "4 steps · 1 still running", when this run is more than one session.
   *  Said out loud so a multi-step run cannot be mistaken for a single one. */
  steps?: string | null;
  elapsed: string;
  pinned: boolean;
  onTogglePin: () => void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  return (
    <header className="border-b border-border bg-surface px-5 py-3">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-h3 text-fg">{title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            <span className="text-caption text-muted">{originLabel}</span>
            {steps && (
              <>
                <span className="text-caption text-faint" aria-hidden>·</span>
                <span className="text-caption text-muted">{steps}</span>
              </>
            )}
            {elapsed && (
              <>
                <span className="text-caption text-faint" aria-hidden>·</span>
                <span className="text-caption text-muted">{elapsed}</span>
              </>
            )}
          </div>
        </div>
        {onStop && (
          <Button size="sm" variant="secondary" onClick={onStop} disabled={stopping}>
            <Square className="h-3.5 w-3.5" aria-hidden />
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={pinned ? 'Unpin' : 'Pin'}
          onClick={onTogglePin}
        >
          <Pin className={cn('h-4 w-4', pinned && 'fill-primary text-primary')} />
        </Button>
      </div>
    </header>
  );
}
