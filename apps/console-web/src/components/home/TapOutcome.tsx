import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { getFromClemOutcome, tapOutcomeHeadline, type FromClemTurnOutcome } from '@/lib/from-clem';
import { unifiedChatSessionId } from '@/lib/last-session';
import { cn } from '@/lib/cn';
import { PaneCard, PaneRow } from './HomeSection';

/** One "do it" the owner just gave on an item outside a chat. */
export interface RecentTap {
  /** The item's key, which the tap is found by. */
  key: string;
  /** The item, as it read. */
  title: string;
  /** What the owner tapped or typed. */
  reply: string;
  /** When they did, so an earlier reply to the same item is not read. */
  since: string;
}

const POLL_MS = 3_000;
/** Past this, a turn still running is shown as working until it settles. */
const SETTLED: ReadonlySet<FromClemTurnOutcome['state']> = new Set(['done', 'needs_you', 'stopped', 'not_found']);

const toneClass = {
  info: 'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
} as const;

function TapOutcomeRow({ tap, onDismiss }: { tap: RecentTap; onDismiss: () => void }) {
  const outcome = useQuery({
    queryKey: ['from-clem-outcome', tap.key, tap.since],
    queryFn: () => getFromClemOutcome(tap.key, tap.reply, tap.since),
    refetchInterval: (query) => (query.state.data && SETTLED.has(query.state.data.state) ? false : POLL_MS),
  });
  const data = outcome.data;
  const headline = tapOutcomeHeadline(data);
  const words = data && 'text' in data ? data.text : '';
  const sessionId = data && 'sessionId' in data ? data.sessionId : null;
  return (
    <PaneRow className="items-start" aria-live="polite">
      <div className="min-w-0 flex-1">
        <div className="text-small text-muted">
          <span className="font-medium text-fg">{tap.reply}</span>
          <span> · {tap.title}</span>
        </div>
        <div className={cn('mt-0.5 text-small font-semibold', toneClass[headline.tone])}>{headline.text}</div>
        {words && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-body text-fg">{words}</p>}
        {sessionId && (
          <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(sessionId))}`} className="mt-1 inline-block text-small font-semibold text-primary hover:underline">
            {data?.state === 'needs_you' ? 'Answer in the conversation' : 'Open the conversation'}
          </Link>
        )}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss"
        className="rounded-sm p-1 text-faint hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </PaneRow>
  );
}

/** What came of the owner's recent taps, shown where they tapped instead of
 *  only "Started a conversation." */
export function TapOutcomes({ taps, onDismiss }: { taps: readonly RecentTap[]; onDismiss: (tap: RecentTap) => void }) {
  if (taps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-faint">Just now</h3>
      <PaneCard>
        {taps.map((tap) => <TapOutcomeRow key={`${tap.key}@${tap.since}`} tap={tap} onDismiss={() => onDismiss(tap)} />)}
      </PaneCard>
    </div>
  );
}
